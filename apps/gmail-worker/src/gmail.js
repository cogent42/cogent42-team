// Gmail API helpers — strictly SENT-only by default.
// Modes:
//   'sent_only'         — labelIds=SENT
//   'sent_plus_threads' — sent messages + the full threads they belong to (so context comes along)
//   'labeled_only'      — only messages with a specific user-applied label
//   'full_inbox'        — opt-in widening (still excludes drafts/chats)

import { promises as fs } from "node:fs";
import path from "node:path";

import { google } from "googleapis";
import { pool } from "@cogent42-team/db";
import { decryptString, encryptString } from "@cogent42-team/shared/crypto";

// Where downloaded PDF/image attachments are staged. Same path is bind-mounted
// into the extractor-worker via a named volume in docker-compose so the
// extractor can Read-tool them. Per-message subdirs let us delete cleanly after
// extraction.
const ATTACHMENT_ROOT = "/var/lib/cogent42-attachments";

// Conservative allowlist on first cut — PDFs (Read tool reads natively) and
// images (Read uses vision). Everything else (.docx, .xlsx, .zip, archives)
// silently skipped: handling them needs a conversion step we don't have yet.
const ALLOWED_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_ATTACHMENT_BYTES     = 5 * 1024 * 1024;   // bigger PDFs blow up extraction cost
const MAX_ATTACHMENTS_PER_MSG  = 3;                 // cap blast radius on a noisy email

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

async function getAuthedClientForUser(userId) {
  const { rows } = await pool.query(`SELECT * FROM user_secrets WHERE user_id = $1`, [userId]);
  if (rows.length === 0 || !rows[0].gmail_refresh_token_enc) {
    throw new Error("user has no gmail refresh token");
  }
  const refresh = decryptString(rows[0].gmail_refresh_token_enc);
  const oauth = makeOAuthClient();
  oauth.setCredentials({ refresh_token: refresh });

  // Persist refreshed access tokens so consecutive ticks don't re-mint them.
  oauth.on("tokens", async (tokens) => {
    if (!tokens.access_token) return;
    const exp = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    await pool.query(
      `UPDATE user_secrets
          SET gmail_access_token_enc = $2, gmail_token_expires_at = $3, updated_at = now()
        WHERE user_id = $1`,
      [userId, encryptString(tokens.access_token), exp]
    ).catch(() => {});
  });
  return oauth;
}

function buildQuery(mode, labelId) {
  // We always exclude drafts and chats as a hard rule.
  switch (mode) {
    case "sent_only":         return { q: "in:sent -in:drafts -in:chats", labelIds: ["SENT"] };
    case "sent_plus_threads": return { q: "in:sent -in:drafts -in:chats", labelIds: ["SENT"], expandThreads: true };
    case "labeled_only":      return { q: "-in:drafts -in:chats", labelIds: labelId ? [labelId] : [] };
    case "full_inbox":        return { q: "-in:drafts -in:chats", labelIds: [] };
    default:                  return { q: "in:sent -in:drafts -in:chats", labelIds: ["SENT"] };
  }
}

function decodeBody(payload) {
  // Walk MIME parts, prefer text/plain, fall back to text/html (stripped).
  if (!payload) return "";
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.parts) p.parts.forEach(walk);
    else if (p.body && p.body.data) parts.push({ mime: p.mimeType, data: p.body.data });
  };
  walk(payload);
  if (payload.body && payload.body.data) parts.push({ mime: payload.mimeType, data: payload.body.data });

  const plain = parts.find((p) => p.mime === "text/plain");
  const html  = parts.find((p) => p.mime === "text/html");
  const chosen = plain || html;
  if (!chosen) return "";
  const buf = Buffer.from(chosen.data, "base64");
  let text = buf.toString("utf8");
  if (chosen.mime === "text/html") text = text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

/**
 * Walk the MIME tree looking for attached files (NOT inline body parts). Gmail
 * sets `body.attachmentId` on parts whose contents have to be fetched separately
 * via users.messages.attachments.get; that's our signal an attachment exists.
 */
function walkAttachments(payload) {
  const found = [];
  const walk = (p) => {
    if (!p) return;
    if (p.parts) p.parts.forEach(walk);
    if (p.body && p.body.attachmentId && p.mimeType && p.filename) {
      found.push({
        attachmentId: p.body.attachmentId,
        mime:         p.mimeType,
        filename:     p.filename,
        size:         p.body.size || 0,
      });
    }
  };
  walk(payload);
  return found;
}

function safeFilename(name) {
  return (name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "attachment";
}

/**
 * Filter to allowed mime + size, cap count, download each, return [{path, mime, name}].
 * Failures on individual attachments are logged and skipped — we don't fail the whole
 * message just because one PDF fetch errored.
 */
async function downloadAttachments({ gmail, messageId, raw }) {
  const accepted = raw
    .filter((a) => ALLOWED_ATTACHMENT_MIMES.has(a.mime))
    .filter((a) => a.size > 0 && a.size <= MAX_ATTACHMENT_BYTES)
    .slice(0, MAX_ATTACHMENTS_PER_MSG);
  if (accepted.length === 0) return [];

  const dir = path.join(ATTACHMENT_ROOT, messageId);
  await fs.mkdir(dir, { recursive: true });

  const out = [];
  for (const a of accepted) {
    try {
      const res = await gmail.users.messages.attachments.get({
        userId: "me", messageId, id: a.attachmentId,
      });
      const data = res.data?.data;
      if (!data) continue;
      // Gmail returns url-safe base64. Buffer.from accepts "base64" but the URL
      // alphabet (uses `-` and `_`) needs the explicit "base64url" encoding.
      const buf = Buffer.from(data, "base64url");
      const filePath = path.join(dir, safeFilename(a.filename));
      await fs.writeFile(filePath, buf);
      out.push({ path: filePath, mime: a.mime, name: a.filename, bytes: buf.length });
    } catch (err) {
      console.error(`[gmail] attachment download failed for ${messageId}/${a.filename}:`, err.message);
    }
  }
  return out;
}

export async function fetchSentMessages({ userId, mode, labelId, max = 25 }) {
  const auth = await getAuthedClientForUser(userId);
  const gmail = google.gmail({ version: "v1", auth });

  const { q, labelIds, expandThreads } = buildQuery(mode, labelId);

  // Recent sent messages — capped at `max`.
  const list = await gmail.users.messages.list({
    userId: "me",
    q: q + " newer_than:7d",                  // bounded backfill on first tick; subsequent ticks rely on dedup
    labelIds: labelIds.length ? labelIds : undefined,
    maxResults: max,
  });

  const messageIds = (list.data.messages || []).map((m) => m.id);
  const out = [];
  const seenIds = new Set();

  for (const id of messageIds) {
    if (seenIds.has(id)) continue;
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const m = msg.data;
    seenIds.add(m.id);
    const attachments = await downloadAttachments({
      gmail, messageId: m.id, raw: walkAttachments(m.payload),
    });
    out.push({
      id: m.id,
      threadId: m.threadId,
      subject: header(m.payload.headers, "Subject"),
      from: header(m.payload.headers, "From"),
      to: header(m.payload.headers, "To"),
      date: header(m.payload.headers, "Date"),
      body: decodeBody(m.payload),
      attachments,
    });

    if (expandThreads && m.threadId) {
      const thread = await gmail.users.threads.get({ userId: "me", id: m.threadId, format: "full" });
      for (const tm of thread.data.messages || []) {
        if (seenIds.has(tm.id)) continue;
        seenIds.add(tm.id);
        const tAttachments = await downloadAttachments({
          gmail, messageId: tm.id, raw: walkAttachments(tm.payload),
        });
        out.push({
          id: tm.id,
          threadId: tm.threadId,
          subject: header(tm.payload.headers, "Subject"),
          from: header(tm.payload.headers, "From"),
          to: header(tm.payload.headers, "To"),
          date: header(tm.payload.headers, "Date"),
          body: decodeBody(tm.payload),
          attachments: tAttachments,
        });
      }
    }
  }

  return out;
}
