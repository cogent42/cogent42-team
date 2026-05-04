// Persist extracted facts: embed → dedup vs existing → reinforce / contradict / insert.
//
// Three branches per new fact:
//
//   1. STRICT paraphrase (cosine < 0.20):
//        Existing row is reinforced (evidence_count++, last_seen_at + last_validated_at
//        bumped). The new wording is dropped — at this similarity it carries no
//        new information. No new row is inserted.
//
//   2. LOOSE net (cosine 0.20–0.35 OR BM25 token overlap, candidate older than 7 days):
//        We ask Sonnet to classify each pair. Then per the verdict:
//          - paraphrase    → reinforce existing, drop new (same as strict path)
//          - contradiction → mark old `validation_status='contradicted'`, soft-delete +
//                            supersede with the new. The newer assertion wins; the old
//                            stays in the audit chain. Only fires when the old fact is
//                            >7 days old, so an active conversation refining a topic in
//                            real-time isn't auto-resolved against itself.
//          - unrelated     → fall through and insert normally
//
//   3. NEW fact (no candidates, or all loose candidates classified unrelated):
//        Insert with evidence_count=1, last_validated_at=now(), validation_status='active'.
//
// LLM cost: one batched Sonnet round-trip per writeFacts() invocation, only when ≥1
// new fact has loose-net candidates. Most cold-user jobs make zero classify calls;
// established users make exactly one regardless of how many facts the job extracted.

import { pool, audit } from "@cogent42-team/db";
import { embed, toPgVector } from "@cogent42-team/shared/embeddings";
import { CATEGORIES, defaultAclFor, MAX_KNOWLEDGE_ENTRIES } from "@cogent42-team/shared/categories";
import { consolidateIfOver } from "./consolidate.js";
import { classifyPairs } from "./classify.js";

// Cosine-distance threshold under which a new fact is treated as a strict paraphrase
// of an existing one (existing gets reinforced; new is dropped). 0.20 is calibrated
// against the live RazorpayX/IDFC corpus — catches paraphrase pairs without
// collapsing genuinely distinct facts (e.g. "onboarding doc checklist" vs
// "onboarding process flow" sit ≥0.30 apart).
const STRICT_DEDUP_DISTANCE = 0.20;

// Loose net: candidates within this distance get sent to the LLM for paraphrase /
// contradiction / unrelated classification. 0.35 is wide enough to catch
// contradictions where wording differs ("us-east-1" vs "ap-south-1") but tight
// enough that we don't drown the classifier in noise.
const LOOSE_DEDUP_DISTANCE = 0.35;

// Don't auto-resolve contradictions against very recent facts. An active chat
// session refining a topic ("let's use Postgres… actually MySQL would be better
// for this case") would otherwise have its earlier turn auto-marked contradicted
// by the next. 7 days is a conservative floor — long enough that the older fact
// has "settled" and short enough that real drift gets caught.
const CONTRADICTION_MIN_AGE_DAYS = 7;

const MAX_LOOSE_CANDIDATES = 5;

function normalizeCategory(c) {
  return CATEGORIES.includes(c) ? c : "project";
}

async function resolveAcl(userId, category) {
  const def = defaultAclFor(category);
  if (def === "private") return "private";
  const { rows } = await pool.query(`SELECT share_to_team FROM users WHERE id = $1`, [userId]);
  if (rows.length === 0 || rows[0].share_to_team === false) return "private";
  return def;
}

export async function writeFacts({ userId, source, sourceRef, facts }) {
  // ── Phase 1: prepare each fact + find tight / loose candidate sets ────────
  const items = [];
  for (const raw of facts) {
    if (!raw || !raw.fact) continue;
    const fact       = String(raw.fact).trim().slice(0, 1000);
    const category   = normalizeCategory(raw.category);
    const importance = raw.importance === "permanent" ? "permanent" : "normal";
    const acl        = await resolveAcl(userId, category);

    let embedding = null;
    try { embedding = await embed(fact); } catch (e) { console.error("embed failed:", e.message); }

    let tight = null;
    let loose = [];

    if (embedding) {
      const v = toPgVector(embedding);

      const t = await pool.query(
        `SELECT id, fact, category
           FROM knowledge_entries
          WHERE owner_user_id = $1 AND deleted_at IS NULL AND superseded_by IS NULL
            AND embedding IS NOT NULL
            AND (embedding <=> $2::vector) < $3
          ORDER BY (embedding <=> $2::vector) ASC LIMIT 1`,
        [userId, v, STRICT_DEDUP_DISTANCE]
      );
      if (t.rows.length > 0) {
        tight = t.rows[0];
      } else {
        // Loose net. Order by cosine ASC so the closest candidate is first —
        // contradictions tend to cluster tighter than unrelated facts.
        const l = await pool.query(
          `SELECT id, fact, category
             FROM knowledge_entries
            WHERE owner_user_id = $1
              AND deleted_at IS NULL AND superseded_by IS NULL
              AND created_at < now() - ($4::text || ' days')::interval
              AND embedding IS NOT NULL
              AND (
                ((embedding <=> $2::vector) >= $5 AND (embedding <=> $2::vector) < $6)
                OR fact_tsv @@ plainto_tsquery('simple', $3)
              )
            ORDER BY (embedding <=> $2::vector) ASC
            LIMIT $7`,
          [userId, v, fact, CONTRADICTION_MIN_AGE_DAYS, STRICT_DEDUP_DISTANCE, LOOSE_DEDUP_DISTANCE, MAX_LOOSE_CANDIDATES]
        );
        loose = l.rows;
      }
    }

    items.push({ fact, category, importance, acl, embedding, tight, loose });
  }

  // ── Phase 2: single batched LLM classify across all loose pairs ───────────
  const pairs = [];
  items.forEach((it, idx) => {
    if (it.tight) return; // tight handled deterministically
    it.loose.forEach((cand, jdx) => {
      pairs.push({
        pair_id: `${idx}_${jdx}`,
        newFact: it.fact,
        existingId: cand.id,
        existingCategory: cand.category,
        existingFact: cand.fact,
      });
    });
  });
  const classifications = pairs.length > 0 ? await classifyPairs(pairs) : new Map();

  // ── Phase 3: apply per-fact decision ──────────────────────────────────────
  const written = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];

    // 1. Strict paraphrase → reinforce existing, drop new.
    if (it.tight) {
      const ok = await reinforce(it.tight.id, userId);
      if (ok) {
        written.push({ id: it.tight.id, fact: it.tight.fact, category: it.tight.category, action: "reinforced" });
      }
      continue;
    }

    // 2. Loose net: scan classifications. Paraphrase wins (safer); else contradiction;
    //    else fall through to insert.
    let reinforceId = null;
    let contradictedId = null;

    for (let jdx = 0; jdx < it.loose.length; jdx++) {
      const cls = classifications.get(`${idx}_${jdx}`);
      if (cls === "paraphrase" && !reinforceId) {
        reinforceId = it.loose[jdx].id;
        break; // paraphrase short-circuits — same-claim reinforcement, no need to look at other candidates
      }
      if (cls === "contradiction" && !contradictedId) {
        contradictedId = it.loose[jdx].id;
        // keep scanning — a paraphrase later in the list still wins
      }
    }

    if (reinforceId) {
      const ok = await reinforce(reinforceId, userId);
      if (ok) {
        const cand = it.loose.find((c) => c.id === reinforceId);
        written.push({ id: reinforceId, fact: cand?.fact || it.fact, category: cand?.category || it.category, action: "reinforced_loose" });
      }
      continue;
    }

    // 3. Insert new. If we marked a contradiction, link supersede chain + flag old.
    const inserted = await insertEntry({
      userId, fact: it.fact, category: it.category, importance: it.importance, acl: it.acl,
      source, sourceRef, embedding: it.embedding, supersedesId: contradictedId,
    });

    if (contradictedId) {
      await pool.query(
        `UPDATE knowledge_entries
            SET validation_status = 'contradicted',
                superseded_by = $1,
                deleted_at = now()
          WHERE id = $2 AND owner_user_id = $3 AND deleted_at IS NULL`,
        [inserted.id, contradictedId, userId]
      );
      const oldCand = it.loose.find((c) => c.id === contradictedId);
      await audit({
        actorUserId: userId,
        actorRole: "extractor",
        action: "knowledge.contradicted",
        targetType: "knowledge_entry",
        targetId: contradictedId,
        payload: {
          old_id: contradictedId,
          old_fact: oldCand?.fact?.slice(0, 500),
          new_id: inserted.id,
          new_fact: it.fact.slice(0, 500),
          source,
          source_ref: sourceRef,
        },
      });
      written.push({ ...inserted, action: "contradicted_old" });
    } else {
      written.push({ ...inserted, action: "inserted" });
    }
  }

  await prune(userId);
  return written;
}

async function reinforce(existingId, userId) {
  const { rowCount } = await pool.query(
    `UPDATE knowledge_entries
        SET evidence_count = evidence_count + 1,
            last_seen_at = now(),
            last_validated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL AND superseded_by IS NULL`,
    [existingId, userId]
  );
  return rowCount > 0;
}

async function insertEntry({ userId, fact, category, importance, acl, source, sourceRef, embedding, supersedesId }) {
  const { rows } = await pool.query(
    `INSERT INTO knowledge_entries
       (owner_user_id, fact, category, importance, acl, source, source_ref, embedding,
        supersedes_id, last_validated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, now())
     RETURNING id, fact, category, acl`,
    [userId, fact, category, importance, acl, source, sourceRef, toPgVector(embedding), supersedesId]
  );
  return rows[0];
}

/**
 * Keep a user's active fact count manageable.
 *   1. AI consolidation (above 80% of cap, throttled 6h/user) merges paraphrase
 *      groups into canonical rows.
 *   2. Hard fallback: if still above the cap, soft-delete the oldest non-permanent
 *      rows by last_seen_at — which, with Tier 1's read-driven last_seen_at refresh,
 *      naturally targets unused facts before useful ones.
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
