-- Explicit scoped consent only. No session identifier is retained.
ALTER TABLE follow_confirmation_outbox ADD COLUMN owner_user_hash TEXT
  CHECK(owner_user_hash IS NULL OR (length(owner_user_hash)=64 AND owner_user_hash NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX IF NOT EXISTS follow_confirmation_owner ON follow_confirmation_outbox(owner_user_hash)
  WHERE owner_user_hash IS NOT NULL;
