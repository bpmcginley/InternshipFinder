-- Dormant resolution evidence prerequisite. No backfill, sweep or financial-policy changes.
CREATE TABLE IF NOT EXISTS topup_retention (
  payment_hash TEXT PRIMARY KEY NOT NULL REFERENCES topup_purchases(payment_hash) ON DELETE CASCADE,
  resolved_at TEXT CHECK(resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at) IS resolved_at),
  resolved_zero_since TEXT CHECK(resolved_zero_since IS NULL OR
    (resolved_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',resolved_zero_since) IS resolved_zero_since
      AND resolved_zero_since >= resolved_at))
);
