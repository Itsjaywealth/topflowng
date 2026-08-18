-- Durable scheduled-purchase execution identity.
--
-- A schedule occurrence keeps one VTPass request id across retries/restarts.
-- Together with the advisory lock in the database layer, this prevents two
-- workers from fulfilling the same due occurrence with different references.

ALTER TABLE scheduled_purchases
  ADD COLUMN IF NOT EXISTS in_flight_reference TEXT,
  ADD COLUMN IF NOT EXISTS in_flight_for TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_in_flight_reference
  ON scheduled_purchases (in_flight_reference)
  WHERE in_flight_reference IS NOT NULL;
