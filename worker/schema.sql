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

-- was: -- When the Worker first saw an account, so only an account in its first week can claim an invite.
-- When the Worker first saw an account, so only an account in its first week can claim an invite.
-- "Delete my data" keeps this row (a hashed id and a date): removing it let an old account delete,
-- sign in again and count as new.
CREATE TABLE IF NOT EXISTS accounts (
  user_hash TEXT PRIMARY KEY,
  first TEXT NOT NULL
);

-- How many invites have earned this inviter credit, ever. claim() checks REFERRAL.maxRewards against
-- this, not against a COUNT over `referrals`: "Delete my data" blanks `referrer` on those rows, so the
-- count fell whenever the inviter or a rewarded classmate deleted, and the inviter could earn past the
-- cap. "Delete my data" keeps this row (a hashed id and a number). A new table rather than a column,
-- because CREATE TABLE IF NOT EXISTS never adds a column to a table that is already live.
CREATE TABLE IF NOT EXISTS inviters (
  user_hash TEXT PRIMARY KEY,
  rewarded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer);

-- Backfills. `npm run deploy` runs this file before every `wrangler deploy`, so both are written to be
-- repeated: each only ever adds a missing row or moves a value the safe way (a first-seen date
-- earlier, a count higher), and a second run changes nothing. Each reads only small tables once.
--
-- `accounts` appeared with invites (2026-09-24). An account from before then had no row, and claim()
-- or /me gave it first-seen = that day, so every existing .edu student could claim as "new". This dates
-- each account from its earliest trace in the tables that were already there: its oldest usage month
-- (taken as the 1st of that month, the earliest it could have been), when it last set its states, its
-- plan record and its invite code. An account with no row gets the earliest of those. An account that
-- already has one is moved earlier only on proof: a usage month that ended before its first-seen (upto
-- is the 1st of the month after), or a timestamp before it. A usage month that merely matches the
-- first-seen month proves nothing, so a genuinely new student's date is never pulled back to the 1st.
-- (`WHERE` before `ON CONFLICT` also keeps SQLite from reading the upsert as a join.)
INSERT INTO accounts (user_hash, first)
SELECT e.user_hash, MIN(e.t) FROM (
  SELECT user_hash, month || '-01T00:00:00.000Z' AS t, date(month || '-01', '+1 month') AS upto FROM usage
  UNION ALL SELECT user_hash, updated, updated FROM demand
  UNION ALL SELECT user_hash, updated, updated FROM plans
  UNION ALL SELECT user_hash, created, created FROM invite_codes
) AS e LEFT JOIN accounts AS a ON a.user_hash = e.user_hash
WHERE a.user_hash IS NULL OR e.upto <= a.first
GROUP BY e.user_hash
ON CONFLICT(user_hash) DO UPDATE SET first = excluded.first WHERE excluded.first < accounts.first;

-- `inviters` is new with the fix above. Seed it from the referral rows that still name their inviter;
-- rows already blanked by a deletion can't be attributed and are lost to the count. Once seeded, the
-- count only grows (claim() adds to it, nothing takes away), so it is never below this and the
-- `WHERE` keeps a repeat run from touching it.
INSERT INTO inviters (user_hash, rewarded)
SELECT referrer, COUNT(*) FROM referrals WHERE referrer != '' AND rewarded = 1 GROUP BY referrer
ON CONFLICT(user_hash) DO UPDATE SET rewarded = excluded.rewarded WHERE excluded.rewarded > inviters.rewarded;
