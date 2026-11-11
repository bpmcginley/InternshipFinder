// Dormant reservation boundary. Trusted configuration and an injected verified adapter only.
// No Stripe request, checkout URL, settlement, recovery or account-deletion caller is wired.
import { validTopupOfferVersion, validTopupCheckoutId } from "./topup-ledger.js";
const active = "state IN ('creating','open')";
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const row = (db, id) => db.prepare("SELECT * FROM topup_checkout_attempts WHERE id=?").bind(id);
const outcome = (attempt) => ({
  status: attempt?.state === "open" ? "open" : "pending",
  attempt: attempt || null,
});

export async function reserveTopupCheckout(db, userHash, capability = {}, now = new Date()) {
  // These are trusted server-owned values, never a request's claimed verification flag.
  const input = capability?.offer;
  if (
    capability?.enabled !== true ||
    input?.verified !== true ||
    typeof capability.create !== "function"
  )
    return { status: "disabled", attempt: null };
  const offer = {
    version: input.version,
    amount: input.amount,
    currency: input.currency,
    units: input.units,
  };
  if (
    !validTopupOfferVersion(offer.version) ||
    !positive(offer.amount) ||
    !positive(offer.units) ||
    typeof offer.currency !== "string" ||
    !/^[a-z]{3}$/.test(offer.currency)
  )
    return { status: "disabled", attempt: null };
  if (typeof userHash !== "string" || !/^[a-f0-9]{64}$/.test(userHash))
    throw new Error("Invalid top-up account");
  const created = now.toISOString(),
    id = crypto.randomUUID(),
    create = capability.create;
  const [inserted, selected] = await db.batch([
    db
      .prepare(
        "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state) " +
          "VALUES(?,?,?,?,?,?,?,'creating') ON CONFLICT DO NOTHING",
      )
      .bind(id, userHash, offer.version, offer.amount, offer.currency, offer.units, created),
    db
      .prepare(`SELECT * FROM topup_checkout_attempts WHERE user_hash=? AND ${active}`)
      .bind(userHash),
  ]);
  const attempt = selected.results[0];
  if (inserted.meta.changes !== 1) return outcome(attempt);
  // A crash before/after this await is deliberately unresolved. Never restart from age alone:
  // provider idempotency retention is shorter than our durable ambiguity/deletion barrier.
  let verified;
  try {
    verified = await create(Object.freeze({ ...attempt, idempotencyKey: "topup-checkout:" + id }));
  } catch {
    return outcome(attempt);
  }
  // The adapter must authenticate mode/price/quantity/owner and return this normalized tuple.
  // Recheck association here, but do not mistake this comparison for provider verification.
  if (
    !verified ||
    verified.status !== "open" ||
    !validTopupCheckoutId(verified.checkoutId) ||
    verified.attemptId !== id ||
    verified.userHash !== userHash ||
    verified.offerVersion !== offer.version ||
    verified.amount !== offer.amount ||
    verified.currency !== offer.currency ||
    verified.units !== offer.units
  )
    return outcome(attempt);
  const [, current] = await db.batch([
    db
      .prepare(
        "UPDATE topup_checkout_attempts SET checkout_id=?,state='open' WHERE id=? AND user_hash=? " +
          "AND state='creating' AND checkout_id IS NULL AND offer_version=? AND amount=? AND currency=? AND units=?",
      )
      .bind(
        verified.checkoutId,
        id,
        userHash,
        offer.version,
        offer.amount,
        offer.currency,
        offer.units,
      ),
    row(db, id),
  ]);
  return outcome(current.results[0]);
}
