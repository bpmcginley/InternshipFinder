-- Dormant digest-only queue; no transport, router or cron consumes it yet.
CREATE TABLE IF NOT EXISTS follow_digest_days (
  marker TEXT PRIMARY KEY CHECK (length(marker) = 64),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS follow_digest_outbox (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES follow_subscribers(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  payload TEXT,
  created TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','attempting','accepted','uncertain','cancelled')),
  lease_token TEXT,
  lease_until TEXT,
  attempted_at TEXT,
  accepted_at TEXT,
  UNIQUE (subscriber_id, day),
  CHECK ((state IN ('queued','leased','attempting') AND payload IS NOT NULL) OR
    (state IN ('accepted','uncertain','cancelled') AND payload IS NULL)),
  CHECK ((state IN ('leased','attempting') AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
    (state NOT IN ('leased','attempting') AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS follow_digest_outbox_due ON follow_digest_outbox (state, lease_until);
-- Cancelling every outstanding aggregate is conservative: no removed-scope roles can be sent.
-- Already accepted mail cannot be recalled. The independent daily marker has no subscriber FK.
CREATE TRIGGER IF NOT EXISTS follow_scope_cancel_digest AFTER DELETE ON follow_subscriptions
BEGIN
  UPDATE follow_digest_outbox SET state='cancelled', payload=NULL, lease_token=NULL, lease_until=NULL
    WHERE subscriber_id=OLD.subscriber_id AND state IN ('queued','leased','attempting');
END;
