-- TopFlowNG — migration 005: scheduled purchases.
--
-- Users can schedule recurring airtime/data/electricity purchases at fixed
-- intervals (daily, weekly, monthly) or on specific dates.

DO $$ BEGIN
  CREATE TYPE schedule_frequency AS ENUM ('daily', 'weekly', 'monthly', 'once');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS scheduled_purchases (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_type      TEXT NOT NULL CHECK (service_type IN ('airtime','data','electricity','cable')),
  plan_code         TEXT,
  phone             TEXT,
  identifier        TEXT,
  network           TEXT,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount >= 50),
  frequency         schedule_frequency NOT NULL DEFAULT 'once',
  next_run_at       TIMESTAMPTZ NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  last_run_at       TIMESTAMPTZ,
  run_count         INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_purchases_due
  ON scheduled_purchases (next_run_at) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_scheduled_purchases_user
  ON scheduled_purchases (user_id, active);
