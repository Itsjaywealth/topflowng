-- TopFlowNG — Automation & integration tables (011)
--
-- Backing store for the outbound event bus (n8n delivery), RAG-safe support
-- data, BizFlowNG expense sync, support escalations, renewal metadata and the
-- audit log. All additive; no existing table is altered.

-- ── Outbound event log ──────────────────────────────────────────────────────
-- Immutable record of every domain event emitted by the backend. Events are
-- the audit source of truth; webhook_deliveries tracks per-endpoint fan-out.
CREATE TABLE IF NOT EXISTS automation_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_events_type_created
  ON automation_events (type, created_at DESC);

-- ── Webhook endpoints (n8n / automation subscribers) ───────────────────────
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,
  events     TEXT[] NOT NULL DEFAULT '{}', -- empty array = receive all events
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At-least-once delivery ledger. UNIQUE(endpoint_id, event_id) makes retries
-- idempotent: a redelivery never duplicates a row for the same event.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id         UUID NOT NULL REFERENCES automation_events(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|dead
  attempts         INT NOT NULL DEFAULT 0,
  last_status_code INT,
  last_error       TEXT,
  next_retry_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries (status, next_retry_at);

-- ── BizFlowNG account links (explicit, per-customer opt-in) ────────────────
CREATE TABLE IF NOT EXISTS bizflow_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bizflow_business_id TEXT NOT NULL,
  bizflow_base_url    TEXT,
  api_key_enc         TEXT NOT NULL,        -- AES-256-GCM at rest
  key_fingerprint     TEXT NOT NULL,        -- sha256 prefix for display/verify
  status              TEXT NOT NULL DEFAULT 'unverified', -- unverified|active|paused|revoked
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at         TIMESTAMPTZ
);

-- BizFlowNG expense sync queue. reference is UNIQUE — one sync per TopFlowNG
-- transaction, ever. BizFlowNG dedupes on the same reference.
CREATE TABLE IF NOT EXISTS bizflow_syncs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference          TEXT NOT NULL UNIQUE,
  category           TEXT NOT NULL,        -- electricity|airtime|data|cable|other
  amount             NUMERIC(14,2) NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'queued', -- queued|synced|failed|skipped
  bizflow_expense_id TEXT,
  attempts           INT NOT NULL DEFAULT 0,
  last_error         TEXT,
  next_retry_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bizflow_syncs_status ON bizflow_syncs (status, next_retry_at);

-- ── Support escalations (chat → human handoff) ─────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  message       TEXT,
  txn_reference TEXT,
  status        TEXT NOT NULL DEFAULT 'open', -- open|resolved
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Renewal reminder metadata ───────────────────────────────────────────────
-- validity_days / renewal_due_at are only set when derived from catalogue
-- data (data-plan names). Never guessed: uncertain catalogues stay NULL.
CREATE TABLE IF NOT EXISTS renewal_meta (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference      TEXT NOT NULL UNIQUE,
  service_type   TEXT NOT NULL,
  provider       TEXT,
  plan_label     TEXT,
  plan_code      TEXT,
  validity_days  INT,
  renewal_due_at TIMESTAMPTZ,
  reminded_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_renewal_meta_due
  ON renewal_meta (renewal_due_at) WHERE renewal_due_at IS NOT NULL;

-- ── Audit log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_type  TEXT NOT NULL,                -- system|customer|admin|automation
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_type, actor_id);
