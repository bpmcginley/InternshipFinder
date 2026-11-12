-- Explicit scoped consent only. No session identifier is retained.
ALTER TABLE follow_confirmation_outbox ADD COLUMN owner_user_hash TEXT
  CHECK(owner_user_hash IS NULL OR (length(owner_user_hash)=64 AND owner_user_hash NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX IF NOT EXISTS follow_confirmation_owner ON follow_confirmation_outbox(owner_user_hash)
  WHERE owner_user_hash IS NOT NULL;

-- Consuming a claimed link token also retires its exact pending consent, including a
-- confirmed scope whose confirmed_at does not change. Different/unclaimed jobs survive.
CREATE TRIGGER IF NOT EXISTS follow_link_consumed AFTER DELETE ON follow_tokens
WHEN OLD.purpose='confirm' AND OLD.owner_user_hash IS NOT NULL
BEGIN
  DELETE FROM follow_confirmation_outbox WHERE subscriber_id=OLD.subscriber_id
    AND scope_key=OLD.scope_key AND owner_user_hash=OLD.owner_user_hash
    AND expires_at=OLD.expires_at AND claim_id IS NOT NULL;
END;

-- Transient input only: this view has no rows or backing table. One INSERT executes
-- the entire request at one SQLite step's UTC instant. Session proof is never retained.
CREATE VIEW IF NOT EXISTS follow_link_requests AS
  SELECT NULL AS subscriber_id,NULL AS email,NULL AS scope_key,NULL AS job_id,
    NULL AS session_id,NULL AS owner_user_hash WHERE 0;
CREATE TRIGGER IF NOT EXISTS follow_link_request INSTEAD OF INSERT ON follow_link_requests
WHEN EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND user_hash=NEW.owner_user_hash
       AND julianday(expires)>julianday('now'))
  AND NOT EXISTS(SELECT 1 FROM follow_subscriptions s JOIN follow_subscribers u ON u.id=s.subscriber_id
    WHERE u.email=NEW.email AND s.scope_key=NEW.scope_key AND s.owner_user_hash IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM follow_confirmation_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
    WHERE u.email=NEW.email AND q.scope_key=NEW.scope_key
      AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND q.owner_user_hash IS NOT NEW.owner_user_hash)
  AND NOT EXISTS(SELECT 1 FROM follow_tokens t JOIN follow_subscribers u ON u.id=t.subscriber_id
    WHERE u.email=NEW.email AND t.scope_key=NEW.scope_key AND t.purpose='confirm'
      AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND t.owner_user_hash IS NOT NEW.owner_user_hash)
BEGIN
  INSERT INTO follow_subscribers(id,email,created)
    VALUES(NEW.subscriber_id,NEW.email,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(email) DO NOTHING;
  DELETE FROM follow_tokens WHERE purpose='confirm' AND scope_key=NEW.scope_key
    AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND subscriber_id IN(SELECT id FROM follow_subscribers WHERE email=NEW.email);
  DELETE FROM follow_confirmation_outbox WHERE scope_key=NEW.scope_key
    AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND subscriber_id IN(SELECT id FROM follow_subscribers WHERE email=NEW.email);
  INSERT INTO follow_subscriptions(subscriber_id,scope_key,created)
    SELECT id,NEW.scope_key,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM follow_subscribers WHERE email=NEW.email
    ON CONFLICT(subscriber_id,scope_key) DO UPDATE SET created=excluded.created
    WHERE confirmed_at IS NULL AND created<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days');
  INSERT INTO follow_confirmation_outbox(id,subscriber_id,scope_key,queued_at,expires_at,owner_user_hash)
    SELECT NEW.job_id,s.subscriber_id,s.scope_key,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      CASE WHEN s.confirmed_at IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ',s.created,'+7 days')
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days') END,NEW.owner_user_hash
    FROM follow_subscriptions s JOIN follow_subscribers u ON u.id=s.subscriber_id
    WHERE u.email=NEW.email AND s.scope_key=NEW.scope_key ON CONFLICT(subscriber_id,scope_key) DO NOTHING;
END;
