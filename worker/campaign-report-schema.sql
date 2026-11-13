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
