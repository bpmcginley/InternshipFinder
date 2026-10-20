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
