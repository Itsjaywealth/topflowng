-- TopFlowNG — migration 009: in-app notifications.
--
-- A lightweight notification centre backed by real product events. Notifications
-- are always tied to a user and carry an optional deep link into the app
-- (e.g. a transaction reference) so the UI can jump straight to context.

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL DEFAULT 'transaction'
              CHECK (category IN ('transaction','wallet','service','schedule','security','system')),
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id) WHERE read_at IS NULL;