-- Dormant existing-subscriber management requests; no credential, address copy or send state.
CREATE TABLE IF NOT EXISTS follow_management_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  subscriber_id TEXT NOT NULL UNIQUE REFERENCES follow_subscribers(id) ON DELETE CASCADE,
  queued_at TEXT NOT NULL CHECK(length(queued_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',queued_at,'+0 days') IS queued_at),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at,'+0 days') IS expires_at
    AND expires_at>queued_at AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',queued_at,'+7 days'))
);
CREATE INDEX IF NOT EXISTS follow_management_outbox_expiry ON follow_management_outbox(expires_at);
