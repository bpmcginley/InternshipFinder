-- Pending confirmation queue. Credentials and rendered mail are created only at dispatch.
CREATE TABLE IF NOT EXISTS follow_confirmation_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  subscriber_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > queued_at),
  UNIQUE (subscriber_id, scope_key),
  FOREIGN KEY (subscriber_id, scope_key)
    REFERENCES follow_subscriptions(subscriber_id, scope_key) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS follow_confirmation_scope_changed
AFTER UPDATE OF created, confirmed_at ON follow_subscriptions
WHEN NEW.created != OLD.created OR NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
  DELETE FROM follow_confirmation_outbox
    WHERE subscriber_id = OLD.subscriber_id AND scope_key = OLD.scope_key;
END;
