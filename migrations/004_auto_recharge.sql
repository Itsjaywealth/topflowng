-- TopFlowNG — migration 004: auto-recharge settings.
--
-- Users can set a wallet threshold below which an automatic top-up is triggered
-- via Paystack (using their last saved payment method).

CREATE TABLE IF NOT EXISTS auto_recharges (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  threshold         NUMERIC(12,2) NOT NULL CHECK (threshold >= 100),
  amount            NUMERIC(12,2) NOT NULL CHECK (amount >= 100 AND amount <= 1000000),
  active            BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_auto_recharges_active
  ON auto_recharges (user_id) WHERE active = true;
