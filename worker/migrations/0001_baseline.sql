-- InternScout Worker D1 schema.
-- was: -- Only hashed ids, months, tasks, run ids, counters, states and spend. Never prompts, replies, emails or tokens.
-- Hashed ids, months, tasks, run ids, counters, states and spend; a fingerprint (sha256) of each sign-in
-- session token; and, for a student who saves their Deep Dive to their account, that profile encrypted.
-- Never prompts, replies, emails or tokens themselves. The one exception is `employer_leads` (2026-10-13):
-- the contact details a recruiter types into the employer interest form, kept so they can be answered.
-- was: -- Never prompts, replies, emails or tokens themselves.

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

-- The same totals by task and model, with what they cost (added 2026-09-30). The month's row above
-- could not say which task the spend went on or whether the cache was being hit, which is what every
-- cost change has to be judged by. Totals only, like `tokens`: no user, no content.
CREATE TABLE IF NOT EXISTS task_tokens (
  month TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  prompt INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cents REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (month, task, model)
);

-- Exact page-load totals per day (added 2026-09-30; src/visits.js), because Cloudflare Web Analytics
-- samples about one load in ten. `page` is a kind (dashboard, landing, install, legal, digest, other) and
-- `source` where the load came from (direct, search, social, email, extension, other, or internal for
-- a load from another page of the site). `visits` leaves out the internal ones, as Cloudflare does.
-- Totals only: no visitor, address, cookie or full referrer.
CREATE TABLE IF NOT EXISTS visit_counts (
  day TEXT NOT NULL,
  page TEXT NOT NULL,
  source TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, page, source)
);

-- The `social` loads above once more by site (added 2026-10-05; src/visits.js channelOf()): youtube,
-- tiktok, x, facebook, reddit, instagram, bluesky, mastodon (and linkedin, threads, discord), from the
-- link's utm_source or else the referring host. The dashboard and growth/metrics.py keep adding up
-- source = 'social'; the weekly scorecard reads this to tell the channels apart. A day's rows never
-- add up to more than its `social` row in visit_counts, and they are under the same daily cap. A new
-- table rather than a column on visit_counts, because CREATE TABLE IF NOT EXISTS never adds a column
-- to a table that is already live. Totals only, like visit_counts.
CREATE TABLE IF NOT EXISTS visit_channels (
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel)
);

-- Steps toward using InternScout per day (added 2026-10-01; src/visits.js EVENTS): install_click,
-- signin_start, signin, profile, autoapply, checkout, by the page kind they happened on. Counts only,
-- like visit_counts: nothing about who did them.
-- Since 2026-10-04 also posting_click from the site, and steps only the Worker sees (SERVER_EVENTS:
-- new_account, ext_signin, first_autofill, cap_hit, paid), whose `page` is the client ("extension",
-- "dashboard"), the task (cap_hit), the plan (paid) or "worker".
-- Since 2026-10-06 also digest_signup, a weekly email sign-up form sent, on page "dashboard", "landing"
-- or "digest" (the /digest/ page, a page kind of its own since then in visit_counts too). It's a count
-- of forms sent; the address goes from the browser to Buttondown and never reaches the Worker.
-- Since 2026-10-15 also finite digest_<view|click|submit>_<placement> totals (visits.js). These are
-- invitation exposures and attempts, never confirmed subscriptions. No schema migration is needed.
-- Since 2026-10-13 also apply_offer_shown and apply_offer_click (docs/js/offer.js): the "Add to Chrome"
-- bar shown after opening a posting Auto-Apply fills, and its store link pressed. No schema change.
-- Since 2026-10-13 also employer_interest (a server step: src/leads.js stored a lead from /employers/),
-- page "employers". "employers" is also a page kind in visit_counts since then.
CREATE TABLE IF NOT EXISTS event_counts (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  page TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, page)
);

-- 2026-10-27: anonymous campaign totals for three browser-observed conversion intents. Values are
-- bounded slugs from UTM tags and grouped by day; there is no visitor id, cookie, email or order id.
-- These rows mean store click, digest form submit and employer order submit, not provider-confirmed
-- install, subscription or payment. Revert: drop the table after reverting src/visits.js/count.js.
CREATE TABLE IF NOT EXISTS event_attribution (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  page TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, page, source, channel, campaign, content)
);

-- How many calls runs took, kept when the daily cron drops a past month's `runs` (added 2026-10-04;
-- src/limits.js cleanup()). `n` runs of `task` in `month` took a number of calls in `bucket`: "1", "2",
-- "3-4", "5-8", "9-15", "16-30" or "31+". Counts only: no account, no run id.
CREATE TABLE IF NOT EXISTS run_hist (
  month TEXT NOT NULL,
  task TEXT NOT NULL,
  bucket TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, task, bucket)
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

-- 2026-10-23: W2 reservations survive request loss and distinguish unresolved extra subscriptions.
-- Revert: revert billing callers first; keep these rows until every provider outcome is reconciled.
CREATE TABLE IF NOT EXISTS student_checkouts (
  user_hash TEXT PRIMARY KEY,
  attempt TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  form TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating', 'open', 'completed', 'expired')),
  session TEXT,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS student_billing_recovery (
  subscription TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL,
  customer TEXT,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('cancel_pending', 'refund_pending', 'resolved')),
  invoice TEXT,
  refund TEXT,
  refund_started TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS student_billing_recovery_user ON student_billing_recovery (user_hash, state);

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

-- "Stay signed in" (src/session.js). One row per signed-in device. `id` is sha256 hex of the session token
-- the device keeps, so a copy of this table can't be used to sign in. `tier` is fixed when the session is
-- made from a provider ID token. `expires` is a year after `last_used`, and both move forward at most once
-- per UTC day of use. At most 20 per account (the least recently used goes). Sign-out deletes the row;
-- "Delete my data" deletes all of an account's rows; the daily cron deletes expired ones. No email.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL,
  tier TEXT NOT NULL,
  provider TEXT NOT NULL,
  created TEXT NOT NULL,
  last_used TEXT NOT NULL,
  expires TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_hash);

-- A session the extension made from the dashboard's (POST /session/copy, src/session.js copySession,
-- 2026-10-14), so the two sign out separately. Both ids are sessions.id (sha256 of a token). A session
-- is copied at most once, and a copy is never copied, so a stolen session token can make one more at
-- most. Deleted with the account's sessions (Delete my data), and by the daily cron once neither
-- session is left.
CREATE TABLE IF NOT EXISTS session_copies (
  source TEXT PRIMARY KEY,
  copy TEXT NOT NULL UNIQUE,
  user_hash TEXT NOT NULL,
  created TEXT NOT NULL
);

-- The Deep Dive saved to the student's account (src/profile.js), on by default and switched off by the
-- student. `data` is base64(iv(12) || AES-GCM-256 ciphertext) of the profile JSON, under a key derived
-- from the PROFILE_KEY secret and this row's user_hash, so neither the database alone nor a row moved to
-- another account reads as anything. The six demographic answers, files, saved logins and API keys are
-- never in it. `updated` is the client's time for its latest edit (ISO); `bytes` the plaintext size.
-- Turning the switch off and "Delete my data" both delete the row.
CREATE TABLE IF NOT EXISTS profiles (
  user_hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated TEXT NOT NULL,
  bytes INTEGER NOT NULL
);

-- What employers sent through the interest form on internscout.org/employers/ (added 2026-10-13;
-- src/leads.js). The one table here that holds names and email addresses: they are a recruiter's own
-- work contact details, typed in to be contacted about InternScout for employers, and used for nothing
-- else. `wants` is a comma list of placement, board, details and other (the form's
-- boxes since 2026-10-14); rows from before then may hold featured, promoted or majors_schools, which
-- are still accepted from a cached page but no longer offered. No IP address is kept:
-- the per-address daily limit counts in `rate` under a salted hash, swept by the daily cron. Rows older
-- than a year are deleted by the daily cron (leads.js dropOldLeads; docs/privacy.html#employers).
-- Read with: npx wrangler d1 execute internscout --remote --command "SELECT * FROM employer_leads ORDER BY created DESC"
CREATE TABLE IF NOT EXISTS employer_leads (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  hiring_for TEXT NOT NULL DEFAULT '',
  wants TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS employer_leads_created ON employer_leads (created);

-- Paid listings (added 2026-10-14; src/placements.js). One row per placement Bruce agreed with an
-- employer: which listing, which days, and its status. It names a listing by the id the pipeline gives
-- it (backend normalize.listing_id) and never adds anything to the listing, so no score, order, filter or
-- count can read it. No student data, and no recruiter name or email: `lead_id` points back to the
-- employer_leads row it started from, which keeps its own one-year deletion (so it is not a foreign key:
-- a placement record has to outlive its lead for accounts and refunds). `paid_ref` ("pilot" or Bruce's
-- invoice number) and `note` are private: GET /placements never returns them. There is no price column;
-- the amount is on Bruce's own invoice and `paid_ref` only finds it.
-- Dates are UTC days, start inclusive and end exclusive. A placement shows only while status = 'on'
-- and start_day <= today < end_day; the daily cron sets status 'ended' once end_day has passed.
-- page_cap is held at 1 by its CHECK: raising it needs a migration PR, on purpose.
-- Read with: npx wrangler d1 execute internscout --remote --command "SELECT * FROM placements ORDER BY start_day DESC"
CREATE TABLE IF NOT EXISTS placements (
  id TEXT PRIMARY KEY,                       -- "p-2026-11-acme-1": public, in /data/placements.json
  lead_id INTEGER,                           -- employer_leads.id, or NULL (by email); not a foreign key
  employer TEXT NOT NULL,                    -- as the listing names it; public
  listing_id TEXT NOT NULL CHECK (length(listing_id) = 16 AND listing_id NOT GLOB '*[^0-9a-f]*'),
  apply_url TEXT NOT NULL CHECK (apply_url LIKE 'https://%'),
  start_day TEXT NOT NULL CHECK (start_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_day TEXT NOT NULL CHECK (end_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND end_day > start_day),
  page_cap INTEGER NOT NULL DEFAULT 1 CHECK (page_cap = 1),   -- placement boxes per page; 1 at launch
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'checked', 'on', 'paused', 'ended', 'refused')),
  checks TEXT NOT NULL DEFAULT '',           -- comma list of sponsor checks done (src/placements.js CHECKS)
  checked_day TEXT,                          -- when they were done
  unpaid_ok INTEGER NOT NULL DEFAULT 0 CHECK (unpaid_ok IN (0, 1)),  -- 1 only for a nonprofit or government role Bruce confirmed
  paid_ref TEXT NOT NULL DEFAULT '',         -- private: "pilot" or an invoice number; never public
  note TEXT NOT NULL DEFAULT '',             -- private
  ended_reason TEXT NOT NULL DEFAULT '',     -- dates, role_closed, listing_gone, removed, refunded
  created TEXT NOT NULL,
  created_by TEXT NOT NULL,                  -- a short label Bruce passes ("bruce"), never an email
  updated TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS placements_live ON placements (status, end_day);

-- Every change to a placement, written in the same batch as the change itself, so the history can be
-- read back ("who switched this on, when, and what did it say before"). `before` and `after` are the
-- row as JSON; `reason` is what Bruce gave for a pause, end or refusal. Kept as long as the placement row.
CREATE TABLE IF NOT EXISTS placement_log (
  id INTEGER PRIMARY KEY,
  placement TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  action TEXT NOT NULL,                      -- create, update, check, on, pause, end, refuse, cron_end
  reason TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT
);

CREATE INDEX IF NOT EXISTS placement_log_placement ON placement_log (placement, at);

-- How many times a day each paid listing's box was shown and opened (added 2026-10-14; S9, src/visits.js
-- countPlacementHit, the employer report in src/placements.js placementReport). Counts only, like
-- event_counts: nothing about who. A browser sends only the placement id, "shown" (the box was at least
-- half on screen, once per page load) or "open" (its posting link was pressed, once per page load) and the
-- page's path, which becomes a page kind ("dashboard" or "landing"); nothing else is stored. A row is
-- added only for a placement that is on and inside its dates, so a made-up id adds nothing. `day` is a
-- UTC day (YYYY-MM-DD); after 400 days the daily cron folds a placement's days into one row for the month
-- (`day` is then YYYY-MM) and deletes the daily rows. Reports read whole calendar months only.
-- Read with: npx wrangler d1 execute internscout --remote --command "SELECT * FROM placement_counts ORDER BY day DESC LIMIT 50"
CREATE TABLE IF NOT EXISTS placement_counts (
  day TEXT NOT NULL,
  placement TEXT NOT NULL,
  page TEXT NOT NULL CHECK (page IN ('dashboard', 'landing')),
  event TEXT NOT NULL CHECK (event IN ('shown', 'open')),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, placement, page, event)
);

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

-- What the site build did with each live paid listing, per UTC day (added 2026-10-14), so refunds for
-- unused days can be worked out. The pages workflow writes it over the D1 HTTP API after each build
-- (backend/internscout/placements.py record_runs): `shown` is how many builds that day kept the
-- placement, `dropped` how many dropped it while it was live, `reason` the latest drop's reason
-- (placements.py REASONS) and `updated` when a build last wrote the row. Drops for "dates" (not started
-- yet) and "duplicate" are not recorded. GET /admin/placements reads it as `runs`. Nothing about visitors.
CREATE TABLE IF NOT EXISTS placement_runs (
  placement_id TEXT NOT NULL,
  day TEXT NOT NULL,
  shown INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated TEXT,
  PRIMARY KEY (placement_id, day)
);

-- Paid listings bought on the site (added 2026-10-19; src/orders.js, worker/ORDERS.md). New tables only:
-- this file runs on every deploy and CREATE TABLE IF NOT EXISTS never changes a live one.
--
-- One row per order. Private, like employer_leads: the buyer's name, work email and the company they
-- typed, which terms version they accepted and when (the clickwrap), the Stripe ids and the amounts in
-- cents. Kept 7 years as the business record of a sale (docs/privacy.html#employers). An order never
-- confirmed (`unverified`) is deleted by the daily cron after 7 days. The email link is kept only as the
-- SHA-256 (hex) of its token. Status: unverified -> verified (email confirmed) -> paid (Stripe or a pilot
-- code) -> approved or refused (Bruce's one decision). `price` is the list price at order time (0 for a
-- pilot); `paid_amount` what Stripe says was paid (after any promotion code). GET /admin/orders never
-- returns the name or the email.
-- Read with: npx wrangler d1 execute internscout --remote --command "SELECT id, created, status, company FROM employer_orders ORDER BY created DESC"
CREATE TABLE IF NOT EXISTS employer_orders (
  id TEXT PRIMARY KEY,                       -- "o-" + 16 hex
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unverified', 'verified', 'paid', 'approved', 'refused')),
  package TEXT NOT NULL CHECK (package IN ('one', 'three')),
  public_body INTEGER NOT NULL DEFAULT 0 CHECK (public_body IN (0, 1)),   -- claimed nonprofit or public body
  start_day TEXT NOT NULL,                   -- as asked; approval moves the placements if it has passed
  employer_key TEXT NOT NULL,                -- the role index's employer key
  employer TEXT NOT NULL,                    -- the role index's company name
  company TEXT NOT NULL,                     -- as the buyer typed it
  name TEXT NOT NULL,                        -- private
  email TEXT NOT NULL,                       -- private: the work address the link went to
  email_domain TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  terms_box TEXT NOT NULL DEFAULT '',        -- the clickwrap box's words as the buyer saw them
  terms_at TEXT NOT NULL,
  token_hash TEXT,                           -- sha256 hex of the email link's token
  token_expires TEXT,
  verified_at TEXT,
  pilot_code TEXT,
  price INTEGER NOT NULL,
  checkout_session TEXT,                     -- the latest Checkout opened, and when (the field cap holds it 35 minutes)
  checkout_url TEXT,
  checkout_at TEXT,
  paid_session TEXT,
  payment_intent TEXT,
  paid_ref TEXT,                             -- "stripe:pi_..." or "pilot:CODE", copied to each placement's paid_ref
  paid_amount INTEGER,
  paid_at TEXT,
  review_sent_at TEXT,                       -- empty: the daily cron sends Bruce's review email again
  reminder_sent_at TEXT,
  decided_at TEXT,
  decided_reason TEXT,                       -- a refusal's reason, as the employer was told
  refund_id TEXT,
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  disputed_at TEXT
);

CREATE INDEX IF NOT EXISTS employer_orders_status ON employer_orders (status, created);
CREATE INDEX IF NOT EXISTS employer_orders_payment ON employer_orders (payment_intent);

-- The roles of an order as the site's role index showed them when it was made (/data/roles/<shard>.json),
-- and the placement made for each once it was paid. `fields` is the comma list of field tags ("other" when
-- the listing had none), which the per-field cap counts.
CREATE TABLE IF NOT EXISTS employer_order_roles (
  order_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  employer_key TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  apply_url TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT 'other',
  unpaid INTEGER NOT NULL DEFAULT 0 CHECK (unpaid IN (0, 1)),
  placement_id TEXT,                         -- placements.id, once made
  PRIMARY KEY (order_id, listing_id)
);

CREATE INDEX IF NOT EXISTS employer_order_roles_placement ON employer_order_roles (placement_id);

-- What a role that closed early still had unused (the daily cron), and what the employer chose: a refund
-- of `amount` cents, or a one-time Stripe promotion code worth it. No answer in 30 days becomes a refund
-- (`chosen_by` "default"). The email link is kept only as the SHA-256 of its token.
CREATE TABLE IF NOT EXISTS employer_credits (
  id TEXT PRIMARY KEY,                       -- "c-" + 16 hex
  order_id TEXT NOT NULL,
  placement_id TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  amount INTEGER NOT NULL,
  unused_days INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  offer_sent_at TEXT,                        -- empty: the daily cron sends the offer again
  status TEXT NOT NULL CHECK (status IN ('offered', 'refund', 'credit')),
  chosen_at TEXT,
  chosen_by TEXT,                            -- "employer" or "default"
  refund_id TEXT,
  promotion_code TEXT
);

CREATE INDEX IF NOT EXISTS employer_credits_status ON employer_credits (status, created);

-- The free pilot: at most 5 codes ever (src/orders.js PILOT_MAX), made with
-- `node scripts/placement.mjs pilot-code`. `order_id` is the order using it; a refused order frees it.
CREATE TABLE IF NOT EXISTS pilot_codes (
  code TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  order_id TEXT,
  used_at TEXT
);

-- The field tags of a placement made by hand (scripts/placement.mjs), looked up in the site's role index,
-- so it counts toward the per-field cap like an order's roles (src/orders.js FIELD_CAP; terms.html says at
-- most five paid listings in a field, however they were bought; legal review round 4, 2026-10-19).
-- `fields` is a comma list; "other" when the role has no field tags or isn't in the index.
CREATE TABLE IF NOT EXISTS placement_fields (
  placement_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,                  -- the listing the lookup was for; a moved placement is looked up again
  fields TEXT NOT NULL,
  looked_up TEXT NOT NULL
);

-- Atomic daily field capacity, including Checkouts not yet returned by Stripe. A single INSERT
-- generated from JSON reserves every role/day or rolls the entire transaction back.
CREATE TABLE IF NOT EXISTS employer_capacity_reservations (
  order_id TEXT NOT NULL, listing_id TEXT NOT NULL, field TEXT NOT NULL, day TEXT NOT NULL,
  expires_at TEXT, checked_at TEXT NOT NULL,
  PRIMARY KEY (order_id, listing_id, field, day)
);
CREATE INDEX IF NOT EXISTS employer_capacity_field ON employer_capacity_reservations (field, day);
CREATE INDEX IF NOT EXISTS employer_capacity_listing ON employer_capacity_reservations (listing_id, day);
CREATE TRIGGER IF NOT EXISTS employer_capacity_limit
BEFORE INSERT ON employer_capacity_reservations
WHEN NOT EXISTS (SELECT 1 FROM employer_capacity_reservations WHERE order_id = NEW.order_id
  AND listing_id = NEW.listing_id AND field = NEW.field AND day = NEW.day)
BEGIN
  SELECT RAISE(ABORT, 'employer_capacity_full') WHERE
    (SELECT COUNT(*) FROM employer_capacity_reservations WHERE field = NEW.field AND day = NEW.day
      AND (expires_at IS NULL OR expires_at > NEW.checked_at)) >= 5;
  SELECT RAISE(ABORT, 'employer_listing_taken') WHERE NEW.order_id NOT LIKE 'manual:%' AND EXISTS
    (SELECT 1 FROM employer_capacity_reservations WHERE listing_id = NEW.listing_id AND day = NEW.day
      AND order_id != NEW.order_id AND (expires_at IS NULL OR expires_at > NEW.checked_at));
END;

-- Financial decisions are immutable claims. Unknown/crashed operations require reconciliation,
-- never a new choice or an automatic repeat after Stripe's idempotency window expires.
CREATE TABLE IF NOT EXISTS employer_decisions (
  order_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK (action IN ('approve', 'refuse')),
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'unknown')),
  created TEXT NOT NULL, updated TEXT NOT NULL, alerted_at TEXT
);
CREATE TABLE IF NOT EXISTS employer_credit_jobs (
  credit_id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('refund', 'credit')),
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'unknown')),
  created TEXT NOT NULL, updated TEXT NOT NULL, alerted_at TEXT
);

-- Append to schema.sql before deploying order-mail.js. Sent rows keep only the order/kind/date,
-- preventing duplicate receipt/decision emails while discarding their contact details and contents.
CREATE TABLE IF NOT EXISTS employer_order_mail (
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'approved', 'refused')),
  created TEXT NOT NULL,
  to_address TEXT,
  subject TEXT,
  body TEXT,
  reply_to TEXT,
  sent_at TEXT,
  attempted_at TEXT,
  sending_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, kind)
);
CREATE INDEX IF NOT EXISTS employer_order_mail_pending ON employer_order_mail(sent_at, sending_until);

-- 2026-10-23: was: employer checkout had no durable aggregate conversion counts. Count a transition
-- in the same transaction, once per order/step, without copying contacts to analytics. Existing orders
-- are not backfilled or presented as today's sales. Revert: drop employer_funnel_* triggers and marks.
CREATE TABLE IF NOT EXISTS employer_funnel_marks (
  order_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('employer_order_created', 'employer_email_verified', 'employer_paid',
    'employer_pilot', 'employer_comped', 'employer_repeat_paid')),
  created TEXT NOT NULL,
  package TEXT NOT NULL CHECK (package IN ('one', 'three')),
  PRIMARY KEY (order_id, step)
);
CREATE TRIGGER IF NOT EXISTS employer_funnel_count AFTER INSERT ON employer_funnel_marks
BEGIN
  INSERT INTO event_counts (day, event, page, n) VALUES (substr(NEW.created, 1, 10), NEW.step, NEW.package, 1)
    ON CONFLICT(day, event, page) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS employer_funnel_created AFTER INSERT ON employer_orders
WHEN NEW.status = 'unverified'
BEGIN
  INSERT OR IGNORE INTO employer_funnel_marks VALUES (NEW.id, 'employer_order_created', NEW.created, NEW.package);
END;
CREATE TRIGGER IF NOT EXISTS employer_funnel_verified AFTER UPDATE OF status ON employer_orders
WHEN OLD.status = 'unverified' AND NEW.status = 'verified'
BEGIN
  INSERT OR IGNORE INTO employer_funnel_marks VALUES (NEW.id, 'employer_email_verified', COALESCE(NEW.verified_at, NEW.updated), NEW.package);
END;
CREATE TRIGGER IF NOT EXISTS employer_funnel_paid AFTER UPDATE OF status ON employer_orders
WHEN OLD.status = 'verified' AND NEW.status = 'paid'
BEGIN
  INSERT OR IGNORE INTO employer_funnel_marks VALUES (NEW.id,
    CASE WHEN COALESCE(NEW.pilot_code, '') != '' THEN 'employer_pilot'
      WHEN NEW.paid_amount > 0 THEN 'employer_paid' ELSE 'employer_comped' END, COALESCE(NEW.paid_at, NEW.updated), NEW.package);
  INSERT OR IGNORE INTO employer_funnel_marks
    SELECT NEW.id, 'employer_repeat_paid', NEW.paid_at, NEW.package
    WHERE NEW.paid_amount > 0 AND COALESCE(NEW.pilot_code, '') = '' AND EXISTS
      (SELECT 1 FROM employer_orders WHERE id != NEW.id AND employer_key = NEW.employer_key
        AND paid_amount > 0 AND paid_at IS NOT NULL AND paid_at <= NEW.paid_at);
END;
CREATE TRIGGER IF NOT EXISTS employer_funnel_forget AFTER DELETE ON employer_orders
BEGIN
  DELETE FROM employer_funnel_marks WHERE order_id = OLD.id;
END;
-- 2026-10-23: finished self-serve campaigns get one durable transactional results message per role.
-- was: only an admin-requested monthly report; provider failures lost an automatic end report.
-- Revert: disable processCampaignReports in cron; retain this table to avoid duplicate deliveries.
-- Successful, skipped and exhausted messages retain only their business idempotency record. Delivery
-- content is erased on success/cancellation and after at most 30 queued days. Delete linked rows before
-- seven-year employer order retention deletes the corresponding order. No visitor identity is stored.
CREATE TABLE IF NOT EXISTS employer_campaign_reports (
  placement_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  start_day TEXT NOT NULL,
  end_day TEXT NOT NULL,
  created TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sent', 'skipped')),
  sent_at TEXT,
  terminal_at TEXT,
  skipped_reason TEXT,
  attempted_at TEXT,
  sending_until TEXT,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  to_address TEXT,
  subject TEXT,
  body TEXT,
  reply_to TEXT
);
CREATE INDEX IF NOT EXISTS employer_campaign_reports_order ON employer_campaign_reports (order_id);
CREATE INDEX IF NOT EXISTS employer_campaign_reports_due
  ON employer_campaign_reports (state, next_attempt_at, sending_until);
