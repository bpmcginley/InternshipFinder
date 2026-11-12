-- Dormant management removal admits once at SQLite UTC; the view retains no request data.
CREATE VIEW IF NOT EXISTS follow_management_removals AS
SELECT CAST(NULL AS TEXT) AS token_hash, CAST(NULL AS TEXT) AS scope_key, CAST(NULL AS TEXT) AS admitted_at WHERE 0;
CREATE TRIGGER IF NOT EXISTS follow_management_remove
INSTEAD OF INSERT ON follow_management_removals
WHEN EXISTS (
  SELECT 1 FROM follow_tokens t JOIN follow_subscriptions s
    ON s.subscriber_id=t.subscriber_id AND s.scope_key=NEW.scope_key
  WHERE t.token_hash=NEW.token_hash AND t.purpose='manage'
    AND t.expires_at>NEW.admitted_at
    AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
BEGIN
  DELETE FROM follow_tokens WHERE purpose='confirm' AND scope_key=NEW.scope_key
    AND subscriber_id IN (SELECT subscriber_id FROM follow_tokens WHERE token_hash=NEW.token_hash);
  DELETE FROM follow_subscriptions WHERE scope_key=NEW.scope_key
    AND subscriber_id IN (SELECT subscriber_id FROM follow_tokens WHERE token_hash=NEW.token_hash);
  DELETE FROM follow_subscribers
    WHERE id IN (SELECT subscriber_id FROM follow_tokens WHERE token_hash=NEW.token_hash)
      AND NOT EXISTS (SELECT 1 FROM follow_subscriptions WHERE subscriber_id=follow_subscribers.id);
END;
