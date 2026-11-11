-- Dormant P-2.2a: immutable purchase identity and isolated grant, not payment authorization.
-- Claims retain only opaque provider-reference fingerprints and state after future deletion.
CREATE TABLE IF NOT EXISTS topup_claims (
  payment_hash TEXT PRIMARY KEY NOT NULL CHECK(length(payment_hash) = 64),
  checkout_hash TEXT NOT NULL UNIQUE CHECK(length(checkout_hash) = 64),
  state TEXT NOT NULL CHECK(state IN ('granted', 'deleted', 'retired'))
);
CREATE TABLE IF NOT EXISTS topup_purchases (
  payment_hash TEXT PRIMARY KEY NOT NULL REFERENCES topup_claims(payment_hash),
  payment_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  user_hash TEXT NOT NULL CHECK(length(user_hash) = 64),
  offer_version TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount > 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  granted INTEGER NOT NULL CHECK(typeof(granted) = 'integer' AND granted > 0),
  available INTEGER NOT NULL CHECK(typeof(available) = 'integer' AND available >= 0),
  held INTEGER NOT NULL DEFAULT 0 CHECK(typeof(held) = 'integer' AND held >= 0),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(consumed) = 'integer' AND consumed >= 0),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revoked) = 'integer' AND revoked >= 0),
  created TEXT NOT NULL,
  CHECK(available + held + consumed + revoked = granted)
);
CREATE INDEX IF NOT EXISTS topup_purchases_user ON topup_purchases(user_hash, created, payment_hash);
