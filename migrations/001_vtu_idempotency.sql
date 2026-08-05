-- ═══════════════════════════════════════════════════════════════════════════
-- TopFlowNG migration 001 — VTU idempotency schema (Phase 4C)
--
-- Adds OPTIONAL idempotency fields to vtu_orders so a future phase can provide
-- client idempotency keys. All new columns are nullable: existing rows and
-- existing clients that send no key remain valid. No data is modified.
--
-- Rollback SQL:
--   DROP INDEX IF EXISTS idx_vtu_orders_idempotency_scope;
--   DROP INDEX IF EXISTS idx_vtu_orders_user_status;
--   ALTER TABLE vtu_orders
--     DROP COLUMN IF EXISTS idempotency_key,
--     DROP COLUMN IF EXISTS request_fingerprint,
--     DROP COLUMN IF EXISTS response_snapshot,
--     DROP COLUMN IF EXISTS idempotency_key_created_at,
--     DROP COLUMN IF EXISTS idempotency_key_last_used_at;
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Optional idempotency fields (all nullable → legacy-compatible)
ALTER TABLE vtu_orders
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS response_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS idempotency_key_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key_last_used_at TIMESTAMPTZ;

-- 2) Partial unique index scoping a non-null idempotency key to one user.
--    Different users may reuse the same client-generated key; one user cannot
--    duplicate a request. NULL keys are ignored (legacy + keyless clients).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vtu_orders_idempotency_scope
  ON vtu_orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3) Supporting index justified by the existing getPendingVtuOrders query
--    (WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC):
--    a user+status composite directly serves owner-scoped status lookups and
--    the pending-reconciliation query.
CREATE INDEX IF NOT EXISTS idx_vtu_orders_user_status
  ON vtu_orders (user_id, status);