-- Approved private unlinked observation receipt. No raw event/payment/account association.
CREATE TABLE IF NOT EXISTS topup_history_receipts (
  event_digest TEXT PRIMARY KEY NOT NULL CHECK(length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at,'+0 days') IS observed_at)
);
CREATE INDEX IF NOT EXISTS topup_history_receipts_expiry ON topup_history_receipts(observed_at,event_digest);
