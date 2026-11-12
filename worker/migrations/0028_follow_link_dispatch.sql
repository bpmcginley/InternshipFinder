-- Bounded live, unclaimed candidate pages. No retained scheduling state.
CREATE INDEX IF NOT EXISTS follow_confirmation_outbox_dispatch
  ON follow_confirmation_outbox(expires_at,id) WHERE claim_id IS NULL;
CREATE INDEX IF NOT EXISTS follow_management_outbox_dispatch
  ON follow_management_outbox(expires_at,id) WHERE claim_id IS NULL;
