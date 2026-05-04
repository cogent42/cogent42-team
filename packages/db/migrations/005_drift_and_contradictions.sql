-- Drift + contradiction handling.
--
-- Three new columns on knowledge_entries:
--
--   evidence_count    — incremented every time the same fact is re-asserted by
--                        another extraction. Drift signal: a fact backed by 7
--                        independent extractions is far more trustworthy than
--                        a fact mentioned exactly once 90 days ago. Used as
--                        a retrieval rank boost (capped) in prompt.js.
--
--   last_validated_at — distinct from last_seen_at. last_seen_at is set whenever
--                        a row is touched (read at retrieval time, written, or
--                        reinforced). last_validated_at is set ONLY when an
--                        extraction event positively confirms the fact still
--                        holds — i.e. on insert and on reinforcement. Useful
--                        for a future periodic re-validation sweep that targets
--                        rows with low last_validated_at relative to age.
--
--   validation_status — 'active' | 'stale' | 'contradicted' | 'resolved'.
--                        Today the writer flips a row to 'contradicted' when a
--                        newer extraction directly conflicts with it. The same
--                        write sets superseded_by + deleted_at so retrieval
--                        already excludes it; the status column is the
--                        machine-readable reason. 'stale' and 'resolved' are
--                        reserved for the periodic re-validation sweep + the
--                        admin/user review UI we'll layer on later.

ALTER TABLE knowledge_entries
  ADD COLUMN IF NOT EXISTS evidence_count INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'knowledge_entries' AND column_name = 'validation_status'
  ) THEN
    ALTER TABLE knowledge_entries
      ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'active'
        CHECK (validation_status IN ('active','stale','contradicted','resolved'));
  END IF;
END $$;

-- Backfill last_validated_at for rows that existed before this migration: the
-- best signal we have for their last positive confirmation is when they were
-- written/touched. Falls back to created_at for very old rows.
UPDATE knowledge_entries
   SET last_validated_at = COALESCE(last_validated_at, last_seen_at, created_at)
 WHERE last_validated_at IS NULL;

-- Active retrieval excludes contradicted/stale fast. Partial index keeps it lean.
CREATE INDEX IF NOT EXISTS ke_validation_idx
  ON knowledge_entries (owner_user_id, validation_status, last_seen_at)
  WHERE deleted_at IS NULL;
