-- The unique constraint on (owner_user_id, source, source_ref) was intended for
-- idempotency on extraction-job retries, but lives at the wrong layer: a single
-- chat session (or email thread) legitimately produces N independent facts, all
-- with the same source_ref. The original constraint collapsed them into one row
-- via ON CONFLICT DO UPDATE. Idempotency belongs on extraction_jobs.status, not
-- on knowledge_entries — so drop the unique index. Embedding-based dedup
-- (writeFacts: cosine < 0.10 → supersede) still prevents real duplicates.
DROP INDEX IF EXISTS ke_source_ref_unique;

-- Keep the (user, source, source_ref) lookup fast for "show me all facts from
-- session X" queries, just without UNIQUE.
CREATE INDEX IF NOT EXISTS ke_source_ref_idx
  ON knowledge_entries(owner_user_id, source, source_ref)
  WHERE source_ref IS NOT NULL AND deleted_at IS NULL;
