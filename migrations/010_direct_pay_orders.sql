-- TopFlowNG — Direct-pay order payment correlation fields (010)
--
-- Adds columns to vtu_orders to support the per-order direct-payment model
-- (PAYMENT_MODE=direct). These are additive and non-destructive: existing
-- historical rows are untouched and their existing columns remain intact.
-- The stored customer wallet is NOT dropped here — historical wallet/ledger
-- data must be preserved for audit/accounting.

-- payment_reference: the payment-provider (Paystack) transaction reference
--                    tied to this specific order.
-- payment_status:    payment lifecycle: null (wallet mode / not paid),
--                    'pending', 'paid', 'failed', 'refunded'.
-- paid_at:           timestamp when payment was authoritatively confirmed.

ALTER TABLE vtu_orders
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_status   TEXT,
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS request_payload  JSONB;

-- Backfill: historical orders that were settled from the wallet have no
-- payment reference, so payment_status stays NULL (unknown/not-applicable).
-- No destructive change is made to existing rows.

CREATE INDEX IF NOT EXISTS idx_vtu_orders_payment_reference
  ON vtu_orders(payment_reference);
