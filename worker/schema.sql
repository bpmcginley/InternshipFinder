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

-- What one account has cost this month, in cents, so one account cannot spend the whole budget.
-- Dropped when the month ends.
CREATE TABLE IF NOT EXISTS spend (
  user_hash TEXT NOT NULL,
  month TEXT NOT NULL,
  cents REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_hash, month)
);

-- Token totals for the whole deployment, per month. Numbers only; cached / prompt is the cache hit rate.
CREATE TABLE IF NOT EXISTS tokens (
  month TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  prompt INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0
);

-- Accounts that pressed "Delete my data" in `month`. Their counters for that month are kept until it
-- ends, so deleting cannot reset a limit; the daily cron then removes them and this row.
CREATE TABLE IF NOT EXISTS forget (
  user_hash TEXT PRIMARY KEY,
  month TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_month ON usage (month);
CREATE INDEX IF NOT EXISTS spend_month ON spend (month);
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

-- Referral credits (src/referral.js, REFERRAL in src/config.js). Hashed ids and counts only, like the
-- rest of this file. A student's own invite code: random, so it says nothing about who owns it.
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL
);

-- One row per account that joined through an invite, naming the inviter by the same hashed id, and
-- whether the inviter was rewarded (they stop being rewarded after REFERRAL.maxRewards). "Delete my
-- data" empties `referrer` but keeps the row, so one account can only ever claim one invite.
CREATE TABLE IF NOT EXISTS referrals (
  invitee TEXT PRIMARY KEY,
  referrer TEXT NOT NULL,
  rewarded INTEGER NOT NULL DEFAULT 0,
  claimed TEXT NOT NULL
);

-- Extra units per task from invites. They don't reset monthly: src/limits.js admit() spends one only
-- after the month's allowance for that task is used up.
CREATE TABLE IF NOT EXISTS bonus (
  user_hash TEXT NOT NULL,
  task TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_hash, task)
);

-- When the Worker first saw an account, so only an account in its first week can claim an invite.
CREATE TABLE IF NOT EXISTS accounts (
  user_hash TEXT PRIMARY KEY,
  first TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer);
