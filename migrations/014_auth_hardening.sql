-- TopFlowNG — auth hardening (014)
--
-- 1. Persisted token revocations: logout survives server restarts. Stores
--    only sha256 hashes of JWTs, never raw tokens. Rows are pruned lazily.
-- 2. TOTP two-factor columns for users (secret encrypted at rest by the app
--    before it ever reaches the database).

CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expiry ON revoked_tokens(expires_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
