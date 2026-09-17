-- InternScout Worker D1 schema.
-- Only hashed ids, months, tasks, run ids, counters, states and spend. Never prompts, replies, emails or tokens.

CREATE TABLE IF NOT EXISTS usage (
  user_hash TEXT NOT NULL,
  month TEXT NOT NULL,
  task TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_hash, month, task)
);

CREATE TABLE IF NOT EXISTS runs (
  user_hash TEXT NOT NULL,
  month TEXT NOT NULL,
  task TEXT NOT NULL,
  run_id TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_hash, month, task, run_id)
);

-- bucket is "m:2026-09-14T10:05" (minute) or "d:2026-09-14" (day)
CREATE TABLE IF NOT EXISTS rate (
  user_hash TEXT NOT NULL,
  bucket TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_hash, bucket)
);

-- states is a JSON array of USPS codes and "REMOTE"; seen is the last signed-in request
CREATE TABLE IF NOT EXISTS demand (
  user_hash TEXT PRIMARY KEY,
  states TEXT NOT NULL,
  updated TEXT NOT NULL,
  seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget (
  month TEXT PRIMARY KEY,
  spend_cents REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS usage_month ON usage (month);
CREATE INDEX IF NOT EXISTS runs_month ON runs (month);
CREATE INDEX IF NOT EXISTS rate_bucket ON rate (bucket);
CREATE INDEX IF NOT EXISTS demand_seen ON demand (seen);

-- Supporter plan. Stripe keeps the card, the name and the email; these are ids and a status only.
CREATE TABLE IF NOT EXISTS plans (
  user_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'none',
  customer TEXT,
  subscription TEXT,
  period_end TEXT,
  updated TEXT NOT NULL
);

-- Seen webhook event ids, so a Stripe retry cannot apply the same change twice
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plans_subscription ON plans (subscription);
CREATE INDEX IF NOT EXISTS stripe_events_seen ON stripe_events (seen);
