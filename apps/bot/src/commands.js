// Slash commands the bot handles directly (no Claude round-trip).
//   /done       — flush current session for extraction immediately
//   /forget X   — soft-delete the top-N matching facts owned by this user
//   /private ID — flip a fact's ACL to private
//   /recent     — last 10 extracted facts for this user

import { pool, audit } from "@cogent42-team/db";
import { flushSession } from "./session.js";

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

    case "/help":
      return [
        "/done — flush current session for knowledge extraction",
        "/recent — last 10 extracted facts",
        "/forget <text> — delete facts matching text",
        "/private <id> — flip a fact to private (use prefix from /recent)",
      ].join("\n");

    default:
      return null; // let the regular text handler take it
  }
}
