-- Dormant enqueue metadata; no email, rendered facts or permanent watermark advancement.
CREATE INDEX IF NOT EXISTS follow_confirmed_scopes
  ON follow_subscriptions (subscriber_id, scope_key) WHERE confirmed_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS follow_pending_progress (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES follow_digest_outbox(id) ON DELETE CASCADE,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest)=64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  snapshot_at TEXT NOT NULL CHECK (length(snapshot_at)=24),
  advances TEXT NOT NULL CHECK (json_valid(advances) AND json_type(advances)='array'
    AND json_array_length(advances)>0 AND length(CAST(advances AS BLOB))<=32768)
);
CREATE TRIGGER IF NOT EXISTS follow_pending_immutable BEFORE UPDATE ON follow_pending_progress
BEGIN
  SELECT RAISE(ABORT, 'follow_pending_immutable');
END;
-- Existing cancellation, uncertainty, acceptance and expiry paths already erase the payload.
-- Erase its pending metadata in the same statement; scope watermarks remain recoverable.
CREATE TRIGGER IF NOT EXISTS follow_pending_terminal AFTER UPDATE OF state ON follow_digest_outbox
WHEN NEW.state IN ('accepted','uncertain','cancelled')
BEGIN
  DELETE FROM follow_pending_progress WHERE job_id=NEW.id;
END;
