-- TopFlowNG — migration 006: pending auto-recharge checkout sessions.
--
-- When an auto-recharge triggers, Paystack returns a one-time checkout URL.
-- We persist it so the user can complete the top-up from the app (in addition
-- to the emailed link). Sessions are cleared once the payment is credited (via
-- the Paystack webhook / verify path).

CREATE TABLE IF NOT EXISTS auto_recharge_sessions (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference          TEXT NOT NULL UNIQUE,
  authorization_url  TEXT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL CHECK (amount >= 100 AND amount <= 1000000),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'completed', 'expired')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auto_recharge_sessions_user
  ON auto_recharge_sessions (user_id, status);