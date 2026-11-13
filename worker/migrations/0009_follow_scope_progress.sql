-- Dormant matching prerequisites. Progress belongs to exactly one confirmed scope lifetime.
CREATE TABLE IF NOT EXISTS follow_scope_progress (
  subscriber_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_generation TEXT NOT NULL UNIQUE,
  watermark TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, scope_key),
  FOREIGN KEY (subscriber_id, scope_key)
    REFERENCES follow_subscriptions(subscriber_id, scope_key) ON DELETE CASCADE
);

-- Legacy confirmed scopes have no surviving first-confirmation token. Give each a new opaque
-- server identity once; preserve the original confirmation instant, including invalid legacy
-- values that the bounded reader must reject rather than silently repairing or advancing.
INSERT INTO follow_scope_progress (subscriber_id,scope_key,scope_generation,watermark)
SELECT s.subscriber_id,s.scope_key,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
  lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  s.confirmed_at
FROM follow_subscriptions s
WHERE s.confirmed_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM follow_scope_progress p
  WHERE p.subscriber_id=s.subscriber_id AND p.scope_key=s.scope_key
);
