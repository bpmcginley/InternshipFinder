-- Dormant capability for deleting one pending confirmation request.
CREATE TABLE IF NOT EXISTS follow_request_deletions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  confirm_hash TEXT NOT NULL UNIQUE REFERENCES follow_tokens(token_hash) ON DELETE CASCADE
);

-- Only confirmed scopes can be referenced by an outstanding digest.
DROP TRIGGER IF EXISTS follow_scope_cancel_digest;
CREATE TRIGGER IF NOT EXISTS follow_scope_cancel_digest AFTER DELETE ON follow_subscriptions
WHEN OLD.confirmed_at IS NOT NULL
BEGIN
  UPDATE follow_digest_outbox SET state='cancelled', payload=NULL, lease_token=NULL, lease_until=NULL
    WHERE subscriber_id=OLD.subscriber_id AND state IN ('queued','leased','attempting');
END;
