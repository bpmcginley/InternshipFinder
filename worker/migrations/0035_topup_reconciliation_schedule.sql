-- Dormant scheduling only. No purchase eligibility or provider-history authority.
CREATE TABLE IF NOT EXISTS topup_reconciliation_cursor (
  mode TEXT PRIMARY KEY NOT NULL CHECK(mode IN ('test','live')),
  after_hash TEXT NOT NULL DEFAULT '' CHECK(after_hash='' OR (length(after_hash)=64 AND after_hash NOT GLOB '*[^0-9a-f]*')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  lease TEXT CHECK(lease IS NULL OR (length(lease)=32 AND lease NOT GLOB '*[^0-9a-f]*')),
  lease_until_ms INTEGER CHECK(lease_until_ms IS NULL OR (typeof(lease_until_ms)='integer' AND lease_until_ms>=0)),
  CHECK((lease IS NULL)=(lease_until_ms IS NULL))
);
CREATE TABLE IF NOT EXISTS topup_reconciliation_observations (
  payment_hash TEXT PRIMARY KEY NOT NULL REFERENCES topup_purchases(payment_hash) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  reservation_revision INTEGER NOT NULL CHECK(typeof(reservation_revision)='integer' AND reservation_revision BETWEEN 1 AND 9007199254740991),
  reserved_at_ms INTEGER NOT NULL CHECK(typeof(reserved_at_ms)='integer' AND reserved_at_ms>=0),
  last_completed_at_ms INTEGER CHECK(last_completed_at_ms IS NULL OR (typeof(last_completed_at_ms)='integer' AND last_completed_at_ms>=0)),
  last_gap_at_ms INTEGER CHECK(last_gap_at_ms IS NULL OR (typeof(last_gap_at_ms)='integer' AND last_gap_at_ms>=0)),
  outcome TEXT NOT NULL CHECK(outcome IN ('pending','completed','missed')),
  CHECK(outcome!='completed' OR last_completed_at_ms IS NOT NULL),
  CHECK(outcome!='missed' OR last_gap_at_ms IS NOT NULL)
);
