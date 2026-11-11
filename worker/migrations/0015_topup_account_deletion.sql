-- Account deletion is the sole INSERT/UPSERT writer of forget. Monthly cleanup only DELETEs.
-- RAISE aborts deleteUser's whole D1 batch; no new identity or retention is introduced.
CREATE TRIGGER IF NOT EXISTS topup_account_deletion BEFORE INSERT ON forget
BEGIN
  SELECT RAISE(ABORT, 'topup_payment_pending') WHERE EXISTS (
    SELECT 1 FROM topup_checkout_attempts
    WHERE user_hash = NEW.user_hash AND state IN ('creating', 'open')
  );
  UPDATE topup_claims SET state = 'deleted'
    WHERE state = 'granted' AND payment_hash IN (
      SELECT payment_hash FROM topup_purchases WHERE user_hash = NEW.user_hash
    );
  DELETE FROM topup_purchases WHERE user_hash = NEW.user_hash;
  DELETE FROM topup_checkout_attempts
    WHERE user_hash = NEW.user_hash AND state IN ('expired', 'settled');
END;
