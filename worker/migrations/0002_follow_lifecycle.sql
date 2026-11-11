-- Dormant P-2.1a storage: no route, cron or sending path uses these tables yet.
CREATE TABLE IF NOT EXISTS follow_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL,
  confirmed_at TEXT,
  owner_user_hash TEXT,
  last_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS follow_subscribers_owner ON follow_subscribers (owner_user_hash);
CREATE TABLE IF NOT EXISTS follow_subscriptions (
  subscriber_id TEXT NOT NULL REFERENCES follow_subscribers(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  created TEXT NOT NULL,
  confirmed_at TEXT,
  PRIMARY KEY (subscriber_id, scope_key)
);
CREATE TABLE IF NOT EXISTS follow_tokens (
  token_hash TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES follow_subscribers(id) ON DELETE CASCADE,
  -- Management is reserved for the approved next slice; no management helper exists yet.
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm', 'manage', 'unsubscribe')),
  scope_key TEXT NOT NULL,
  generation TEXT NOT NULL,
  expires_at TEXT,
  owner_user_hash TEXT,
  CHECK ((purpose = 'confirm' AND scope_key != '') OR (purpose != 'confirm' AND scope_key = '')),
  CHECK ((purpose = 'unsubscribe' AND expires_at IS NULL) OR (purpose != 'unsubscribe' AND expires_at IS NOT NULL)),
  CHECK (purpose = 'confirm' OR owner_user_hash IS NULL)
);
CREATE INDEX IF NOT EXISTS follow_tokens_subscriber ON follow_tokens (subscriber_id, purpose, scope_key);
