// Slash commands the bot handles directly (no Claude round-trip).
//   /done       — flush current session for extraction immediately
//   /forget X   — soft-delete the top-N matching facts owned by this user
//   /private ID — flip a fact's ACL to private
//   /recent     — last 10 extracted facts for this user
//   /gmail      — DM the owner a Google OAuth consent URL to connect their Gmail

import { pool, audit } from "@cogent42-team/db";
import { flushSession } from "./session.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

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
