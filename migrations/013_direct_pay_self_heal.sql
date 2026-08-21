-- TopFlowNG — Direct-pay order columns self-heal (013)
--
-- Migration 010 is recorded as applied in some environments where only part of
-- its effect landed (the file gained request_payload after being applied), so
-- migrate.js skips it and direct-order creation fails with 42703. This
-- migration re-asserts every object 010 promises, idempotently.

ALTER TABLE vtu_orders
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_status   TEXT,
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS request_payload  JSONB;

CREATE INDEX IF NOT EXISTS idx_vtu_orders_payment_reference
  ON vtu_orders(payment_reference);
