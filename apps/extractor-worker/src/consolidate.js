// AI-driven knowledge consolidation.
//
// When a user crosses 80% of MAX_KNOWLEDGE_ENTRIES, we don't just hard-delete
// the oldest non-permanent rows — we ask Sonnet to find groups of paraphrased
// facts and merge each group into one canonical row, preserving the supersede
// chain (the merged rows get `superseded_by = <new>` and `deleted_at = now()`).
//
// Triggered from `prune()` in write.js after every fact-write that pushes the
// owner over the threshold. Throttled to ≤1 run per 6h per user via
// `users.last_consolidated_at` so a user with a chatty session can't repeatedly
// burn LLM calls.
//
// If consolidation runs but the user is still over the hard cap afterwards,
// `prune()` falls back to deleting oldest non-permanent rows — the same
// behaviour we had before this file existed.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { pool, audit } from "@cogent42-team/db";
import { embed, toPgVector } from "@cogent42-team/shared/embeddings";
import { CATEGORIES, defaultAclFor, MAX_KNOWLEDGE_ENTRIES } from "@cogent42-team/shared/categories";

const TRIGGER_THRESHOLD     = Math.floor(MAX_KNOWLEDGE_ENTRIES * 0.8);   // 4000 of 5000
const MAX_CANDIDATES        = Math.floor(MAX_KNOWLEDGE_ENTRIES * 0.3);   // up to 1500 / run
const THROTTLE_MS           = 6 * 60 * 60 * 1000;                        // 6 hours
const MIN_CANDIDATES_TO_RUN = 10;

const PROMPT_TEMPLATE = `You are a knowledge base manager for one user's persistent memory.

Below is a list of facts gathered for this user over time. Many will be near-duplicates — same information phrased differently, refined across sessions, or restated. Some are stale or superseded.

Your job: find groups of facts that say essentially the same thing and produce ONE canonical fact for each group. Leave standalone facts alone — they'll be kept as-is.

Output: a JSON array. Each item:
  { "fact": "<canonical text>", "category": "<one of the allowed categories>", "merged_ids": ["id1","id2",...] }

Rules:
- Only output groups that consolidate 2+ facts. Skip single-fact items entirely; do not include them in the output.
- Pick the most informative phrasing as the canonical fact (longer is often better).
- If two facts contradict, prefer the more recent one (later in the list).
- Use the most specific category from the merged group.
- Don't invent. The canonical fact must be supported by the merged group.

Allowed categories: server, project, preference, decision, bug, config, rule, workflow, mistake, personal.

Return ONLY the JSON array. No prose, no markdown.

Facts (id, category, text):
{{FACTS}}`;

export async function consolidateIfOver(userId) {
  // Throttle: even if over threshold, don't run if we ran in the last 6h.
  const { rows: u } = await pool.query(
    `SELECT last_consolidated_at FROM users WHERE id = $1`,
    [userId]
  );
  if (u[0]?.last_consolidated_at) {
    const ageMs = Date.now() - new Date(u[0].last_consolidated_at).getTime();
    if (ageMs < THROTTLE_MS) return { triggered: false, reason: "throttled" };
  }

  // Active fact count.
  const { rows: c0 } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM knowledge_entries
      WHERE owner_user_id = $1 AND deleted_at IS NULL AND superseded_by IS NULL`,
    [userId]
  );
  if (c0[0].n < TRIGGER_THRESHOLD) return { triggered: false, reason: "below_threshold", count: c0[0].n };

  // Candidates: oldest by-recency, non-permanent. Permanent rows are sacred.
  const { rows: candidates } = await pool.query(
    `SELECT id, fact, category
       FROM knowledge_entries
      WHERE owner_user_id = $1
        AND deleted_at IS NULL AND superseded_by IS NULL
        AND importance = 'normal'
      ORDER BY last_seen_at ASC
      LIMIT $2`,
    [userId, MAX_CANDIDATES]
  );
  if (candidates.length < MIN_CANDIDATES_TO_RUN) {
    return { triggered: false, reason: "too_few_candidates", count: c0[0].n };
  }

  const factsBlock = candidates
    .map((c) => `[${c.id}] (${c.category}) ${String(c.fact).replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");
  const prompt = PROMPT_TEMPLATE.replace("{{FACTS}}", factsBlock);

  // Mark the run timestamp BEFORE the LLM call so that even if it fails we
  // don't retry tight-loop on the next fact-write.
  await pool.query(
    `UPDATE users SET last_consolidated_at = now() WHERE id = $1`,
    [userId]
  );

  let resultText = "";
  try {
    for await (const msg of query({
      prompt,
      options: { maxTurns: 1, model: "claude-sonnet-4-6", permissionMode: "plan", allowedTools: [] },
    })) {
      if (msg.type === "result" && msg.subtype === "success") resultText = msg.result || "";
    }
  } catch (err) {
    console.error(`[consolidate ${userId.slice(0, 8)}] sdk error:`, err.message);
    return { triggered: true, error: err.message, count: c0[0].n };
  }

  const m = resultText.match(/\[[\s\S]*\]/);
  if (!m) return { triggered: true, error: "no_json_in_response", count: c0[0].n };

  let groups;
  try { groups = JSON.parse(m[0]); } catch { return { triggered: true, error: "json_parse_failed" }; }
  if (!Array.isArray(groups)) return { triggered: true, error: "not_array" };

  const validIds = new Set(candidates.map((c) => c.id));
  let mergedRows = 0;
  let writtenCanonicals = 0;

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const fact = String(group.fact || "").trim().slice(0, 1000);
    const category = group.category;
    const mergedIds = Array.isArray(group.merged_ids) ? group.merged_ids.filter((id) => validIds.has(id)) : [];
    if (!fact || !CATEGORIES.includes(category) || mergedIds.length < 2) continue;

    let embedding = null;
    try { embedding = await embed(fact); } catch (e) { console.error("[consolidate] embed failed:", e.message); }

    // ACL of the canonical: most-restrictive of the merged group. If any was
    // private, the merged result stays private. Same for `permanent` — if any
    // member was permanent, the result is permanent (sticky retention).
    const { rows: merged } = await pool.query(
      `SELECT BOOL_OR(acl = 'private') AS any_private,
              BOOL_OR(importance = 'permanent') AS any_perm
         FROM knowledge_entries
        WHERE id = ANY($1::uuid[]) AND owner_user_id = $2`,
      [mergedIds, userId]
    );
    const acl        = merged[0]?.any_private ? "private" : defaultAclFor(category);
    const importance = merged[0]?.any_perm ? "permanent" : "normal";

    const { rows: ins } = await pool.query(
      `INSERT INTO knowledge_entries
         (owner_user_id, fact, category, importance, acl, source, embedding)
       VALUES ($1, $2, $3, $4, $5, 'consolidated', $6::vector)
       RETURNING id`,
      [userId, fact, category, importance, acl, toPgVector(embedding)]
    );
    const newId = ins[0].id;

    const { rowCount } = await pool.query(
      `UPDATE knowledge_entries
          SET superseded_by = $1, deleted_at = now()
        WHERE id = ANY($2::uuid[]) AND owner_user_id = $3 AND deleted_at IS NULL`,
      [newId, mergedIds, userId]
    );

    mergedRows += rowCount;
    writtenCanonicals += 1;
  }

  await audit({
    actorUserId: userId,
    actorRole: "extractor",
    action: "knowledge.consolidated",
    targetType: "user",
    targetId: userId,
    payload: {
      candidates: candidates.length,
      groups: groups.length,
      written: writtenCanonicals,
      merged_rows: mergedRows,
      before: c0[0].n,
    },
  });

  console.log(
    `[consolidate ${userId.slice(0, 8)}] candidates=${candidates.length} groups=${groups.length} ` +
    `written=${writtenCanonicals} merged=${mergedRows}`
  );

  return {
    triggered: true,
    candidates: candidates.length,
    written: writtenCanonicals,
    merged: mergedRows,
    before: c0[0].n,
  };
}
