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
  return reserve(db, userHash, capability, now);
}

// New dormant entry point for future authenticated top-up routes. Strict first-party token
// shape matches session.js; its SHA-256 is only a transient SQL parameter, never an attempt field.
// Existing ID-token/subscription clients and the trusted internal helper above are unchanged.
export async function reserveSessionTopupCheckout(
  db,
  userHash,
  token,
  capability = {},
  clock = () => new Date(),
) {
  const refused = { status: "auth", attempt: null };
  if (
    typeof token !== "string" ||
    !/^iss_[A-Za-z0-9_-]{43}$/.test(token) ||
    typeof userHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(userHash) ||
    typeof clock !== "function"
  )
    return refused;
  let hash, now;
  try {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    hash = [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
    now = clock(); // Sample after hashing, immediately before constructing the reservation batch.
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return refused;
  } catch {
    return refused;
  }
  return reserve(db, userHash, capability, now, { hash, clock });
}

async function reserve(db, userHash, capability, now, session = null) {
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
    create = capability.create,
    sessionHash = session?.hash;
  const sessionGuard = "EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_hash=? AND expires>?)";
  const proof = sessionHash ? [sessionHash, userHash, created] : [];
  const [inserted, selected] = await db.batch([
    db
      .prepare(
        "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state) " +
          (sessionHash
            ? `SELECT ?,?,?,?,?,?,?,'creating' WHERE ${sessionGuard}`
            : "VALUES(?,?,?,?,?,?,?,'creating')") +
          " ON CONFLICT DO NOTHING",
      )
      .bind(
        id,
        userHash,
        offer.version,
        offer.amount,
        offer.currency,
        offer.units,
        created,
        ...proof,
      ),
    db
      .prepare(
        `SELECT * FROM topup_checkout_attempts WHERE user_hash=? AND ${active}` +
          (sessionHash ? ` AND ${sessionGuard}` : ""),
      )
      .bind(userHash, ...proof),
  ]);
  const attempt = selected.results[0];
  if (sessionHash && !attempt) return { status: "auth", attempt: null };
  if (inserted.meta.changes !== 1) return outcome(attempt);
  // Provider awaits can outlast sign-out or expiry. Recheck before returning any attempt.
  // Verified durable attachment still proceeds, even when this caller is no longer authorized.
  const authorizedRow = () => {
    if (!sessionHash) return row(db, id);
    let at;
    try {
      const current = session.clock();
      if (current instanceof Date) at = current.toISOString();
    } catch {
      /* An invalid clock cannot authorize a response. */
    }
    if (!at) return db.prepare("SELECT * FROM topup_checkout_attempts WHERE 0");
    return db
      .prepare(
        `SELECT * FROM topup_checkout_attempts WHERE id=? AND user_hash=? AND ${sessionGuard}`,
      )
      .bind(id, userHash, sessionHash, userHash, at);
  };
  const response = (value) =>
    sessionHash && !value ? { status: "auth", attempt: null } : outcome(value);
  const ambiguous = async () =>
    sessionHash ? response(await authorizedRow().first()) : outcome(attempt);
  // A crash before/after this await is deliberately unresolved. Never restart from age alone:
  // provider idempotency retention is shorter than our durable ambiguity/deletion barrier.
  let verified;
  try {
    verified = await create(Object.freeze({ ...attempt, idempotencyKey: "topup-checkout:" + id }));
  } catch {
    return ambiguous();
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
    return ambiguous();
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
    authorizedRow(),
  ]);
  return response(current.results[0]);
}
