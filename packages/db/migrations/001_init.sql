-- cogent42-team — initial schema
-- single-org deployment; multi-tenant is a day-2 migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ────────────────────────────────────────────────────────────────────────────
-- USERS
-- One row per human in the org. Each user maps to one bot container.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,                  -- used in container name
  telegram_user_id   BIGINT,                                -- numeric Telegram user ID (allowed sender)
  telegram_bot_name  TEXT,                                  -- e.g. "alice-cogent-bot"
  role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','provisioning')),
  gmail_mode         TEXT NOT NULL DEFAULT 'sent_plus_threads'
                       CHECK (gmail_mode IN ('disabled','sent_only','sent_plus_threads','labeled_only','full_inbox')),
  gmail_label_id     TEXT,                                  -- used when gmail_mode = 'labeled_only'
  gmail_history_id   TEXT,                                  -- last processed Gmail history cursor
  share_to_team      BOOLEAN NOT NULL DEFAULT TRUE,         -- per-user kill switch for chat→team extraction
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_status_idx ON users(status);

-- ────────────────────────────────────────────────────────────────────────────
-- USER_SECRETS — column-encrypted with MASTER_KEY (libsodium secretbox)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_secrets (
  user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_token_enc       BYTEA,                            -- ciphertext (nonce||ct)
  gmail_refresh_token_enc  BYTEA,
  gmail_access_token_enc   BYTEA,
  gmail_token_expires_at   TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- INSTANCES — per-user bot container, registered by the bot at boot
-- Replaces ~/.cogent42/instances/*.json marker files.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS instances (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  container_id     TEXT,
  container_name   TEXT,
  bot_name         TEXT,                                    -- friendly name shown in [from <bot_name>] attribution
  version          TEXT,
  started_at       TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- KNOWLEDGE_ENTRIES — the team brain
-- Replaces per-instance knowledge.json + cross-instance fallback walk.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fact            TEXT NOT NULL,
  category        TEXT NOT NULL,
  importance      TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal','permanent')),
  acl             TEXT NOT NULL DEFAULT 'team'  CHECK (acl IN ('private','team','org')),
  source          TEXT NOT NULL DEFAULT 'chat'  CHECK (source IN ('chat','gmail','manual','imported')),
  source_ref      TEXT,                                     -- gmail msg id, telegram session id, etc.
  embedding       VECTOR(1024),
  fact_tsv        TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', fact)) STORED,
  supersedes_id   UUID REFERENCES knowledge_entries(id),
  superseded_by   UUID REFERENCES knowledge_entries(id),
  deleted_at      TIMESTAMPTZ,                              -- soft delete
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ke_owner_idx        ON knowledge_entries(owner_user_id);
CREATE INDEX IF NOT EXISTS ke_acl_idx          ON knowledge_entries(acl) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ke_category_idx     ON knowledge_entries(category);
CREATE INDEX IF NOT EXISTS ke_source_idx       ON knowledge_entries(source);
CREATE INDEX IF NOT EXISTS ke_active_idx       ON knowledge_entries(owner_user_id, last_seen_at)
                                                  WHERE deleted_at IS NULL AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS ke_fact_tsv_idx     ON knowledge_entries USING GIN (fact_tsv);
CREATE INDEX IF NOT EXISTS ke_embedding_idx    ON knowledge_entries USING ivfflat (embedding vector_cosine_ops)
                                                  WITH (lists = 100);
CREATE UNIQUE INDEX IF NOT EXISTS ke_source_ref_unique
  ON knowledge_entries(owner_user_id, source, source_ref)
  WHERE source_ref IS NOT NULL AND deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- EXTRACTION_JOBS — bot enqueues, extractor-worker drains
-- Pg-as-queue: SELECT … FOR UPDATE SKIP LOCKED
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS extraction_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('chat','gmail')),
  source_ref    TEXT,                                       -- session id, gmail msg id
  payload       JSONB NOT NULL,                             -- transcript or email contents
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed')),
  attempts      INT NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ej_pending_idx ON extraction_jobs(created_at) WHERE status = 'pending';

-- ────────────────────────────────────────────────────────────────────────────
-- AUDIT_LOG — every read/write/admin action
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   UUID REFERENCES users(id),                -- NULL for system actors
  actor_role      TEXT NOT NULL,                            -- 'admin','bot','extractor','gmail-worker','system'
  action          TEXT NOT NULL,                            -- 'extract','read','redact','provision','purge', etc.
  target_type     TEXT,                                     -- 'user','knowledge_entry','instance'
  target_id       TEXT,
  payload         JSONB,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx  ON audit_log(actor_user_id, at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- CHAT_SESSIONS — bot's working memory for an ongoing Telegram conversation
-- Idle ≥60s OR /done → flushed to extraction_jobs.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  messages      JSONB NOT NULL DEFAULT '[]'::jsonb,          -- [{role, content, at}]
  flushed_at    TIMESTAMPTZ,                                  -- when sent to extraction_jobs
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_msg_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cs_user_open_idx ON chat_sessions(user_id, last_msg_at DESC) WHERE flushed_at IS NULL;
