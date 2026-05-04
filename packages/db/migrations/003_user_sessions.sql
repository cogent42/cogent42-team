-- /me dashboard auth: short-lived magic links + sessions.
-- A magic link is generated when the user runs `/me` in their bot. They click
-- it, the server marks it `used_at = now()`, mints a fresh `session` row,
-- and sets a cookie containing the new raw token. Both rows live in this one
-- table, distinguished by `kind`. We store sha256(raw_token) only — the
-- raw token only exists in the magic-link URL or the cookie, never on disk.
--
-- Both kinds are intentionally short-lived (10 minutes default). No
-- background pruner; rows are tiny (<200B) and a periodic sweep can come
-- later if needed.
CREATE TABLE IF NOT EXISTS user_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('magic_link','session')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,                          -- magic_link: redeemed.  session: logged-out.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_sessions_token_idx ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx  ON user_sessions(user_id, kind);
