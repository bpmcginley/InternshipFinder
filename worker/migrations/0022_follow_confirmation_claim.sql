-- A pending job can issue credentials once. This nonce is independent of every capability.
ALTER TABLE follow_confirmation_outbox ADD COLUMN claim_id TEXT;
