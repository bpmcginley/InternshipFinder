-- Dormant top-up checkout reservation; unresolved attempts never expire by local timer.
CREATE TABLE IF NOT EXISTS topup_checkout_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
  user_hash TEXT NOT NULL CHECK(length(user_hash)=64),
  offer_version TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  units INTEGER NOT NULL CHECK(typeof(units)='integer' AND units>0),
  created TEXT NOT NULL,
  checkout_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('creating','open','expired','settled')),
  CHECK(state!='open' OR checkout_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS topup_checkout_one_active ON topup_checkout_attempts(user_hash)
  WHERE state IN ('creating','open');
