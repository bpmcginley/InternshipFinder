-- Check one subscriber's unresolved attempts without walking global attempt history.
CREATE INDEX IF NOT EXISTS follow_attempting_subscriber
  ON follow_digest_outbox (subscriber_id) WHERE state='attempting';
