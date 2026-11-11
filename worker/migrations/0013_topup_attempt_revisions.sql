-- Dormant pre-provider fence. Consumed on settlement; removed with an erased attempt.
CREATE TABLE IF NOT EXISTS topup_attempt_revisions (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES topup_checkout_attempts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991)
);
