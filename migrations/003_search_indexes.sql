-- TopFlowNG — migration 003: trigram indexes for fast ILIKE search.
--
-- The admin dashboard now sends ILIKE '%term%' queries against
-- transactions, users, and vtu_orders tables. Without trigram GIN
-- indexes these scans are sequential (O(n)) and degrade quickly once
-- the tables grow past a few thousand rows. The pg_trgm extension
-- enables index-assisted ILIKE, making substring searches logarithmic.
--
-- Requires the pg_trgm extension (superuser). Railway managed Postgres
-- ships it pre-installed; if CREATE EXTENSION fails the app continues
-- to work — just slower on large text searches.

-- Safe: migration runs before server start, no concurrent traffic
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Transactions: search on description and reference.
CREATE INDEX IF NOT EXISTS idx_transactions_description_trgm
  ON transactions USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_reference_trgm
  ON transactions USING gin (reference gin_trgm_ops);

-- Users: search on name, email, phone.
CREATE INDEX IF NOT EXISTS idx_users_name_trgm
  ON users USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_email_trgm
  ON users USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_phone_trgm
  ON users USING gin (phone gin_trgm_ops);

-- VTU orders: search on request_id, description, provider_order_id.
CREATE INDEX IF NOT EXISTS idx_vtu_orders_request_id_trgm
  ON vtu_orders USING gin (request_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_vtu_orders_description_trgm
  ON vtu_orders USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_vtu_orders_provider_order_id_trgm
  ON vtu_orders USING gin (provider_order_id gin_trgm_ops);
