-- AI-driven knowledge consolidation: throttle field + source enum extension.
--
-- Throttling: consolidation is expensive (one Sonnet call against ~1.5k facts);
-- we run it at most once every 6h per user. last_consolidated_at on `users`
-- holds the most-recent run timestamp.
--
-- Source extension: when consolidation merges N facts into one canonical row,
-- the new row's `source` is 'consolidated' so admins can tell at a glance which
-- entries came from the AI sweep vs. raw chat/gmail extraction.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_consolidated_at TIMESTAMPTZ;

ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_source_check;
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_source_check
  CHECK (source IN ('chat','gmail','manual','imported','consolidated'));
