// Slash commands the bot handles directly (no Claude round-trip).
//   /done       — flush current session for extraction immediately
//   /forget X   — soft-delete the top-N matching facts owned by this user
//   /private ID — flip a fact's ACL to private
//   /recent     — last 10 extracted facts for this user
//   /gmail      — DM the owner a Google OAuth consent URL to connect their Gmail
//   /me         — DM the owner a 10-min single-use link to the web dashboard

import { randomBytes, createHash } from "node:crypto";
import { pool, audit } from "@cogent42-team/db";
import { flushSession } from "./session.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// Magic links are short-lived on purpose so a leaked Telegram message (or
// shoulder-glance) is a small attack window.
const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

// We construct the Google OAuth consent URL ourselves rather than pulling in the
// googleapis SDK just for this — only the client_id and redirect_uri are needed
// at URL-mint time. Token exchange happens on the control-plane callback, where
// the SDK is already a dependency.
function buildGmailConsentUrl({ userId, clientId, redirectUri }) {
  const params = new URLSearchParams({
    client_id:              clientId,
    redirect_uri:           redirectUri,
    response_type:          "code",
    scope:                  GMAIL_SCOPE,
    access_type:            "offline",
    prompt:                 "consent",
    state:                  userId,
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function handleSlashCommand({ userId, command }) {
  const [cmd, ...rest] = command.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/start":
      return null; // handled by bot.start()

    case "/done": {
      const flushed = await flushSession(userId, { reason: "done" });
      return flushed ? "Session flushed — I'll extract knowledge from it." : "Nothing to flush.";
    }

    case "/recent": {
      const { rows } = await pool.query(
        `SELECT id, fact, category, acl FROM knowledge_entries
          WHERE owner_user_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 10`,
        [userId]
      );
      if (rows.length === 0) return "No facts yet.";
      return rows.map((r, i) => `${i + 1}. [${r.category}/${r.acl}] ${r.fact}\n   ${r.id.slice(0, 8)}`).join("\n");
    }

    case "/forget": {
      if (!arg) return "Usage: /forget <text fragment>";
      const { rows } = await pool.query(
        `SELECT id, fact FROM knowledge_entries
          WHERE owner_user_id = $1 AND deleted_at IS NULL
            AND fact_tsv @@ plainto_tsquery('simple', $2)
          ORDER BY ts_rank(fact_tsv, plainto_tsquery('simple', $2)) DESC
          LIMIT 3`,
        [userId, arg]
      );
      if (rows.length === 0) return `No facts match "${arg}".`;
      const ids = rows.map((r) => r.id);
      await pool.query(`UPDATE knowledge_entries SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
      for (const id of ids) {
        await audit({ actorUserId: userId, actorRole: "bot", action: "forget", targetType: "knowledge_entry", targetId: id });
      }
      return `Forgot ${rows.length} fact(s):\n` + rows.map((r) => `- ${r.fact}`).join("\n");
    }

    case "/private": {
      if (!arg) return "Usage: /private <fact-id-prefix>";
      const { rows } = await pool.query(
        `UPDATE knowledge_entries SET acl = 'private'
          WHERE owner_user_id = $1 AND id::text LIKE $2 || '%'
          RETURNING id, fact`,
        [userId, arg]
      );
      if (rows.length === 0) return `No fact found with id starting "${arg}".`;
      for (const r of rows) {
        await audit({ actorUserId: userId, actorRole: "bot", action: "acl.private", targetType: "knowledge_entry", targetId: r.id });
      }
      return `Marked private:\n` + rows.map((r) => `- ${r.fact}`).join("\n");
    }

    case "/me": {
      const baseUrl = process.env.CONTROL_PLANE_PUBLIC_URL;
      if (!baseUrl) {
        return "The web dashboard isn't configured on this deployment yet — ask your admin to set CONTROL_PLANE_PUBLIC_URL on the control-plane.";
      }
      // 32 bytes = 256 bits; URL-safe base64 → 43 chars.
      const raw = randomBytes(32).toString("base64url");
      const expires = new Date(Date.now() + MAGIC_LINK_TTL_MS);
      await pool.query(
        `INSERT INTO user_sessions (user_id, token_hash, kind, expires_at)
         VALUES ($1, $2, 'magic_link', $3)`,
        [userId, sha256Hex(raw), expires]
      );
      await audit({
        actorUserId: userId, actorRole: "bot", action: "me.magic_link_minted",
        targetType: "user", targetId: userId,
      });
      const url = `${baseUrl.replace(/\/+$/, "")}/me/login?t=${raw}`;
      return [
        "Open your dashboard:",
        url,
        "",
        "This link expires in 10 minutes and works once. The browser session it issues also expires after 10 minutes — run /me again any time.",
      ].join("\n");
    }

    case "/gmail": {
      const clientId    = process.env.GOOGLE_CLIENT_ID;
      const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
      if (!clientId || !redirectUri) {
        return "Gmail integration isn't configured on this deployment yet — ask your admin to set GOOGLE_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI on the control-plane.";
      }
      const url = buildGmailConsentUrl({ userId, clientId, redirectUri });
      await audit({
        actorUserId: userId, actorRole: "bot", action: "gmail.consent_url_minted",
        targetType: "user", targetId: userId,
      });
      return [
        "Connect your Gmail (signs into your own Google account, grants read-only access):",
        "",
        url,
        "",
        "After you finish the consent flow, your sent emails will start being extracted into your knowledge base within a minute. Run /done any time to flush the current chat too.",
      ].join("\n");
    }

    case "/help":
      return [
        "/me — open your web dashboard (10-min single-use link)",
        "/done — flush current session for knowledge extraction",
        "/recent — last 10 extracted facts",
        "/forget <text> — delete facts matching text",
        "/private <id> — flip a fact to private (use prefix from /recent)",
        "/gmail — connect your Gmail account (read-only, sent folder by default)",
      ].join("\n");

    default:
      return null; // let the regular text handler take it
  }
}
