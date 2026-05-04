// System-prompt builder for the per-user bot.
// Replaces cogent42's loadFallbackEntries() filesystem walk with a hybrid SQL query
// over knowledge_entries (own facts + team-shared facts), ranked by BM25 + embedding cosine.

import { pool } from "@cogent42-team/db";
import { embed, toPgVector } from "@cogent42-team/shared/embeddings";
import { MAX_INJECTED_ENTRIES } from "@cogent42-team/shared/categories";

const FRESHNESS_DAYS = parseInt(process.env.KNOWLEDGE_FRESHNESS_DAYS || "90", 10);

/**
 * Returns the string to append to the Claude Code system prompt for this turn.
 * Hybrid-retrieves the top-N most relevant facts the bot's owner is allowed to see.
 */
export async function buildSystemPrompt({ userId, prompt, botName }) {
  const parts = [];

  parts.push(
    [
      `You are ${botName}, a personal AI agent for one human owner running inside cogent42-team — a self-hosted, multi-user Telegram-to-Claude system. The user reaches you only over Telegram; you are NOT running inside the Claude Code CLI. Do not suggest \`/mcp\`, IDE settings, login flows, MCP servers, or any UI that belongs to Claude Code itself — none of that is reachable from where the user is sitting.`,
      `You're part of a team. Other teammates have their own bots, and you share certain facts (projects, decisions, server info, workflows) but never share private preferences, personal details, or rules. When a fact below is tagged \`[from <person>]\`, it came from someone else's bot — treat it as second-hand and attribute it if you act on it.`,
      `cogent42-team handles a few things itself, outside this conversation. Do not try to do these yourself — point the user at the right place:`,
      `- Slash commands intercepted by the bot before they reach you: \`/done\` (flush this conversation for extraction), \`/recent\` (last 10 facts saved for this user), \`/forget <text>\` (soft-delete facts matching the text), \`/private <id-prefix>\` (flip a fact to private), \`/help\` (list these). If the user types one of these, it never gets to you — don't acknowledge or simulate them.`,
      `- External integrations (Gmail, etc.) are wired up by an admin in the cogent42-team admin UI, not by you. If the user wants to connect Gmail, tell them to ask their admin to click "Connect Gmail" on their user row in the admin UI; it kicks off an OAuth flow whose callback writes the encrypted refresh token to the database.`,
      `- Knowledge extraction happens in a separate worker after the conversation goes idle for 60s or the user sends \`/done\`. You don't have to summarize or save anything — facts get extracted automatically.`,
    ].join("\n\n")
  );

  // Always-injected RULES (private to this owner)
  const { rows: rules } = await pool.query(
    `SELECT fact FROM knowledge_entries
      WHERE owner_user_id = $1 AND category = 'rule'
        AND deleted_at IS NULL AND superseded_by IS NULL
      ORDER BY importance DESC, created_at DESC
      LIMIT 50`,
    [userId]
  );
  if (rules.length > 0) {
    parts.push(
      `RULES — always follow these, no exceptions:\n` +
      rules.map((r) => `- ${r.fact}`).join("\n")
    );
  }

  // Hybrid retrieval — own + team-visible facts ranked against the current prompt
  let queryEmbedding = null;
  try { queryEmbedding = await embed(prompt); } catch (e) { console.error("embed failed:", e.message); }

  const { rows: ctx } = await retrieveContext({ userId, prompt, queryEmbedding, limit: MAX_INJECTED_ENTRIES });

  if (ctx.length > 0) {
    const lines = ctx.map((e) => {
      const tag = e.is_own
        ? `[${e.category}]`
        : `[${e.category} from ${e.owner_email || e.owner_name || "team"}]`;
      return `- ${tag} ${e.fact}`;
    });
    parts.push(
      `Persistent context from prior sessions across the team (${ctx.length} most relevant):\n` +
      lines.join("\n") +
      `\n\nWhen the user asks about anything in your knowledge base — a project, a service, a file, a workflow — always check the actual server files first before searching the web.`
    );
  }

  return parts.join("\n\n");
}

async function retrieveContext({ userId, prompt, queryEmbedding, limit }) {
  // BM25-only path when we couldn't get an embedding.
  if (!queryEmbedding) {
    return pool.query(
      `SELECT ke.id, ke.fact, ke.category, ke.acl, ke.owner_user_id,
              u.email AS owner_email, u.name AS owner_name,
              (ke.owner_user_id = $1) AS is_own
         FROM knowledge_entries ke
         JOIN users u ON u.id = ke.owner_user_id
        WHERE ke.deleted_at IS NULL AND ke.superseded_by IS NULL
          AND ke.last_seen_at > now() - ($3::int || ' days')::interval
          AND ke.category NOT IN ('preference','rule','personal')
          AND (ke.owner_user_id = $1 OR ke.acl IN ('team','org'))
          AND ke.fact_tsv @@ plainto_tsquery('simple', $2)
        ORDER BY ts_rank(ke.fact_tsv, plainto_tsquery('simple', $2)) DESC
        LIMIT $4`,
      [userId, prompt, FRESHNESS_DAYS, limit]
    );
  }

  // Hybrid: BM25 score + (1 - cosine distance) + own-knowledge bonus + permanent bonus.
  return pool.query(
    `SELECT ke.id, ke.fact, ke.category, ke.acl, ke.owner_user_id,
            u.email AS owner_email, u.name AS owner_name,
            (ke.owner_user_id = $1) AS is_own
       FROM knowledge_entries ke
       JOIN users u ON u.id = ke.owner_user_id
      WHERE ke.deleted_at IS NULL AND ke.superseded_by IS NULL
        AND ke.last_seen_at > now() - ($4::int || ' days')::interval
        AND ke.category NOT IN ('preference','rule','personal')
        AND (ke.owner_user_id = $1 OR ke.acl IN ('team','org'))
        AND (
          ke.fact_tsv @@ plainto_tsquery('simple', $2)
          OR (ke.embedding IS NOT NULL AND (ke.embedding <=> $3::vector) < 0.45)
        )
      ORDER BY (
        COALESCE(ts_rank(ke.fact_tsv, plainto_tsquery('simple', $2)), 0)
        + CASE WHEN ke.embedding IS NULL THEN 0 ELSE (1 - (ke.embedding <=> $3::vector)) END
        + CASE WHEN ke.owner_user_id = $1 THEN 0.2 ELSE 0 END
        + CASE WHEN ke.importance = 'permanent' THEN 0.1 ELSE 0 END
      ) DESC
      LIMIT $5`,
    [userId, prompt, toPgVector(queryEmbedding), FRESHNESS_DAYS, limit]
  );
}
