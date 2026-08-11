-- TopFlowNG — migration 007: bizflow user data.
--
-- BizFlow (the business suite) persists invoices, clients, staff and payroll
-- state per-user as a single JSONB document so it survives across devices.
-- One row per user; upserted whenever the client's save() fires.

CREATE TABLE IF NOT EXISTS bizflow_data (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);