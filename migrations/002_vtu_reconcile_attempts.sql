-- ═══════════════════════════════════════════════════════════════════════════
-- TopFlowNG migration 002 — VTU reconciliation attempt tracking (Phase 4E)
--
-- Records how often a pending order has been manually reconciled and when the
-- most recent attempt happened. This makes repeated/excess reconciliation
-- attempts observable and auditable, and backs the invariant that a successful
-- reconciliation debits a wallet at most once. Defaults keep all existing rows
-- valid; no data is modified.
--
-- Rollback SQL:
--   ALTER TABLE vtu_orders
--     DROP COLUMN IF EXISTS reconcile_attempts,
--     DROP COLUMN IF EXISTS last_reconciled_at;
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE vtu_orders
  ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;