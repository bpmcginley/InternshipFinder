-- Dormant existing-purchase reconciliation; no new identity or provider snapshot fields.
CREATE TABLE IF NOT EXISTS topup_reconciliations (
  payment_hash TEXT PRIMARY KEY NOT NULL REFERENCES topup_purchases(payment_hash) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991),
  loss INTEGER NOT NULL CHECK(loss IN (0, 1)),
  full_refund INTEGER NOT NULL CHECK(full_refund IN (0, 1)),
  hold_ids TEXT NOT NULL CHECK(json_valid(hold_ids) AND json_type(hold_ids) = 'array')
);
