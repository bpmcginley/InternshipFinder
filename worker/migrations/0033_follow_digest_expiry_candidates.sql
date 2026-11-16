CREATE INDEX IF NOT EXISTS follow_digest_outbox_created ON follow_digest_outbox (created);
CREATE INDEX IF NOT EXISTS follow_digest_outbox_expiry ON follow_digest_outbox (state, expires_at);
