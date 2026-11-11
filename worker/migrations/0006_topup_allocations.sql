-- One purchased unit per existing run identity; retain receipts independently of runs cleanup.
CREATE TABLE IF NOT EXISTS topup_allocations (
  user_hash TEXT NOT NULL CHECK(length(user_hash)=64),
  month TEXT NOT NULL CHECK(length(month)=7),
  task TEXT NOT NULL CHECK(task='autofill'),
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 64),
  payment_hash TEXT NOT NULL REFERENCES topup_purchases(payment_hash) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('allocated','restored','revoked')),
  PRIMARY KEY(user_hash,month,task,run_id)
);
CREATE INDEX IF NOT EXISTS topup_allocations_purchase ON topup_allocations(payment_hash);
