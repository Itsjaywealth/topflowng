-- TopFlowNG — BizFlowNG order intents (015)
--
-- A linked BizFlowNG business can propose a VTU order for its linked user.
-- The user must explicitly confirm before anything is purchased — an intent
-- alone never touches money or the provider.

CREATE TABLE IF NOT EXISTS bizflow_order_intents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bizflow_business  TEXT NOT NULL,
  service_type      TEXT NOT NULL,
  request_payload   JSONB NOT NULL,
  amount            NUMERIC(12,2) NOT NULL,
  description       TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','declined','expired')),
  order_request_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bizflow_intent_idem
  ON bizflow_order_intents (bizflow_business, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_bizflow_intent_user_status
  ON bizflow_order_intents (user_id, status);
