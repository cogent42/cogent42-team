// Persist extracted facts: embed → dedup vs existing → insert (with supersede chain).

import { pool } from "@cogent42-team/db";
import { embed, toPgVector } from "@cogent42-team/shared/embeddings";
import { CATEGORIES, defaultAclFor, MAX_KNOWLEDGE_ENTRIES } from "@cogent42-team/shared/categories";
import { consolidateIfOver } from "./consolidate.js";

// Cosine-distance threshold under which a new fact is treated as a paraphrase
// of an existing one (the old gets `superseded_by` the new). 0.10 was too
// strict — across multiple sent emails, the same business fact often gets
// extracted with subtly different phrasings ("Expected payout volume: 7-10k…"
// vs "Expected payout volume for RazorpayX: 7,000–10,000 payouts…") and slipped
// past the threshold. 0.20 is a calibrated loosening: catches paraphrase pairs
// in the live RazorpayX/IDFC corpus without collapsing genuinely distinct facts
// (e.g. "onboarding doc checklist" vs "onboarding process flow" sit ≥0.30 apart).
const DEDUP_COSINE_DISTANCE = 0.20;

/** Resolve category to an allowed value; fallback to 'project'. */
function normalizeCategory(c) {
  return CATEGORIES.includes(c) ? c : "project";
}

/** Resolve the user's per-row default ACL given category + their share_to_team flag. */
async function resolveAcl(userId, category) {
  const def = defaultAclFor(category);
  if (def === "private") return "private";
  // Respect per-user kill switch — if user opted out of team sharing, all chat facts stay private.
  const { rows } = await pool.query(`SELECT share_to_team FROM users WHERE id = $1`, [userId]);
  if (rows.length === 0 || rows[0].share_to_team === false) return "private";
  return def;
}

export async function writeFacts({ userId, source, sourceRef, facts }) {
  const written = [];
  for (const raw of facts) {
    if (!raw || !raw.fact) continue;
    const fact       = String(raw.fact).trim().slice(0, 1000);
    const category   = normalizeCategory(raw.category);
    const importance = raw.importance === "permanent" ? "permanent" : "normal";
    const acl        = await resolveAcl(userId, category);

    let embedding = null;
    try { embedding = await embed(fact); } catch (e) { console.error("embed failed:", e.message); }

    // Dedup against this user's existing active facts.
    if (embedding) {
      const dup = await pool.query(
        `SELECT id, fact FROM knowledge_entries
          WHERE owner_user_id = $1 AND deleted_at IS NULL AND superseded_by IS NULL
            AND embedding IS NOT NULL
            AND (embedding <=> $2::vector) < $3
          ORDER BY (embedding <=> $2::vector) ASC LIMIT 1`,
        [userId, toPgVector(embedding), DEDUP_COSINE_DISTANCE]
      );
      if (dup.rows.length > 0) {
        // Insert new + mark old as superseded.
        const inserted = await insertEntry({ userId, fact, category, importance, acl, source, sourceRef, embedding, supersedesId: dup.rows[0].id });
        await pool.query(
          `UPDATE knowledge_entries SET superseded_by = $2 WHERE id = $1`,
          [dup.rows[0].id, inserted.id]
        );
        written.push(inserted);
        continue;
      }
    }

    const inserted = await insertEntry({ userId, fact, category, importance, acl, source, sourceRef, embedding, supersedesId: null });
    written.push(inserted);
  }

  await prune(userId);
  return written;
}

async function insertEntry({ userId, fact, category, importance, acl, source, sourceRef, embedding, supersedesId }) {
  // No ON CONFLICT — a single source (chat session, gmail thread) legitimately
  // produces N facts. Job-level idempotency lives on extraction_jobs.status;
  // semantic-duplicate prevention lives on the cosine-distance check above.
  const { rows } = await pool.query(
    `INSERT INTO knowledge_entries
       (owner_user_id, fact, category, importance, acl, source, source_ref, embedding, supersedes_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
     RETURNING id, fact, category, acl`,
    [userId, fact, category, importance, acl, source, sourceRef, toPgVector(embedding), supersedesId]
  );
  return rows[0];
}

/**
 * Keep a user's active fact count manageable. Two-step:
 *   1. AI-driven consolidation: above 80% of cap, ask Sonnet to merge
 *      paraphrase groups into canonical rows (throttled to 6h/user).
 *   2. Hard fallback: if still above the hard cap after consolidation
 *      (or if consolidation is throttled / errored), soft-delete the
 *      oldest non-permanent rows.
 */
async function prune(userId) {
  await consolidateIfOver(userId).catch((e) =>
    console.error(`[prune ${userId.slice(0, 8)}] consolidate failed:`, e.message)
  );

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM knowledge_entries
      WHERE owner_user_id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  const n = rows[0].n;
  if (n <= MAX_KNOWLEDGE_ENTRIES) return;

  const overflow = n - MAX_KNOWLEDGE_ENTRIES;
  await pool.query(
    `UPDATE knowledge_entries
        SET deleted_at = now()
      WHERE id IN (
        SELECT id FROM knowledge_entries
         WHERE owner_user_id = $1 AND deleted_at IS NULL AND importance = 'normal'
         ORDER BY last_seen_at ASC LIMIT $2
      )`,
    [userId, overflow]
  );
}
