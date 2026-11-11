-- Approved #294 lifecycle metadata; old runs remain committed without inferred funding.
CREATE TABLE funded_runs_0018 (
  user_hash TEXT NOT NULL,
  month TEXT NOT NULL,
  task TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation TEXT NOT NULL UNIQUE CHECK(length(generation)=36),
  funding TEXT NOT NULL CHECK(funding IN ('monthly','invite','purchase')),
  accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
  first_autofill_day TEXT,
  first_autofill_due INTEGER NOT NULL DEFAULT 0 CHECK(first_autofill_due IN (0,1)),
  PRIMARY KEY(user_hash,month,task,run_id),
  FOREIGN KEY(user_hash,month,task,run_id) REFERENCES runs(user_hash,month,task,run_id) ON DELETE CASCADE,
  CHECK(first_autofill_due=0 OR first_autofill_day IS NOT NULL)
);
CREATE TABLE funded_run_calls_0018 (
  call_id TEXT PRIMARY KEY CHECK(length(call_id)=36),
  generation TEXT NOT NULL REFERENCES funded_runs_0018(generation) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('reserved','accepted')),
  estimate REAL NOT NULL CHECK(estimate>=0),
  account_metered INTEGER NOT NULL CHECK(account_metered IN (0,1)),
  free_day TEXT,
  free_month INTEGER NOT NULL CHECK(free_month IN (0,1)),
  CHECK((free_day IS NULL AND free_month=0) OR (free_day IS NOT NULL AND length(free_day)=10 AND free_month=1))
);
INSERT INTO funded_runs_0018 SELECT * FROM funded_runs;
INSERT INTO funded_run_calls_0018 SELECT * FROM funded_run_calls;
DROP TABLE funded_run_calls;
DROP TABLE funded_runs;
ALTER TABLE funded_runs_0018 RENAME TO funded_runs;
ALTER TABLE funded_run_calls_0018 RENAME TO funded_run_calls;
CREATE INDEX funded_run_calls_generation ON funded_run_calls(generation);
-- Generation receipts survive run cleanup and follow the original purchase retention.
CREATE TABLE IF NOT EXISTS topup_generation_allocations (
  generation TEXT PRIMARY KEY CHECK(length(generation)=36),
  user_hash TEXT NOT NULL CHECK(length(user_hash)=64),
  month TEXT NOT NULL CHECK(length(month)=7),
  task TEXT NOT NULL CHECK(task='autofill'),
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 64),
  payment_hash TEXT NOT NULL REFERENCES topup_purchases(payment_hash) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('allocated','restored','revoked'))
);
CREATE INDEX IF NOT EXISTS topup_generation_allocations_purchase ON topup_generation_allocations(payment_hash);
