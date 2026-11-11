// Dormant P-2.2a storage primitive; no production caller. This does NOT verify a payment.
// A future trusted caller must verify the provider/offer and reconcile refunds, disputes and
// deletion before calling. Never pass browser input or an unverified webhook directly here.
const HEX = /^[a-f0-9]{64}$/;
const fail = (message) => {
  throw new Error(message);
};
const positive = (n) => Number.isSafeInteger(n) && n > 0;
export const validTopupOfferVersion = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
export const validTopupCheckoutId = (value) =>
  typeof value === "string" && /^cs_[A-Za-z0-9_]{1,250}$/.test(value);

export async function referenceHash(kind, live, id) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`internscout:topup:v1:${live ? "live" : "test"}:${kind}:${id}`),
  );
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

// Identity, amount (integer minor currency units), grant and owner are immutable on replay.
// No bonus/usage/run rows are touched. Fingerprints outlive event receipts; future deletion
// must atomically terminalize the claim and erase the linked purchase, never delete the claim.
export async function recordVerifiedTopup(db, input, now = new Date()) {
  input = { ...input };
  if (
    !["paymentId", "checkoutId", "userHash", "offerVersion", "currency"].every(
      (key) => typeof input[key] === "string",
    ) ||
    !/^pi_[A-Za-z0-9_]{1,250}$/.test(input.paymentId) ||
    !validTopupCheckoutId(input.checkoutId) ||
    !HEX.test(input.userHash || "") ||
    typeof input.livemode !== "boolean" ||
    !validTopupOfferVersion(input.offerVersion) ||
    !/^[a-z]{3}$/.test(input.currency || "") ||
    !positive(input.amount) ||
    !positive(input.units) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    fail("Invalid verified top-up record");
  }
  const created = now.toISOString();
  const [paymentHash, checkoutHash] = await Promise.all([
    referenceHash("payment", input.livemode, input.paymentId),
    referenceHash("checkout", input.livemode, input.checkoutId),
  ]);
  const expected = {
    payment_id: input.paymentId,
    checkout_id: input.checkoutId,
    user_hash: input.userHash,
    offer_version: input.offerVersion,
    amount: input.amount,
    currency: input.currency,
    granted: input.units,
  };
  const [claim, , selected] = await db.batch([
    db
      .prepare(
        "INSERT INTO topup_claims (payment_hash, checkout_hash, state) VALUES (?, ?, 'granted') ON CONFLICT DO NOTHING",
      )
      .bind(paymentHash, checkoutHash),
    db
      .prepare(
        "INSERT INTO topup_purchases (payment_hash, payment_id, checkout_id, user_hash, offer_version, amount, currency, granted, available, created) " +
          "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1",
      )
      .bind(
        paymentHash,
        input.paymentId,
        input.checkoutId,
        input.userHash,
        input.offerVersion,
        input.amount,
        input.currency,
        input.units,
        input.units,
        created,
      ),
    db
      .prepare(
        "SELECT c.payment_hash, c.checkout_hash, c.state, p.payment_id, p.checkout_id, p.user_hash, " +
          "p.offer_version, p.amount, p.currency, p.granted, p.available, p.held, p.consumed, p.revoked, p.created " +
          "FROM topup_claims c LEFT JOIN topup_purchases p ON p.payment_hash = c.payment_hash " +
          "WHERE c.payment_hash = ? OR c.checkout_hash = ?",
      )
      .bind(paymentHash, checkoutHash),
  ]);
  const rows = selected.results;
  if (
    rows.length !== 1 ||
    rows[0].payment_hash !== paymentHash ||
    rows[0].checkout_hash !== checkoutHash
  ) {
    fail("Conflicting top-up purchase identity");
  }
  const row = rows[0];
  if (row.state !== "granted" || row.payment_id == null) fail("Top-up purchase is unavailable");
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)) {
    fail("Conflicting top-up purchase record");
  }
  return { granted: claim.meta.changes === 1, purchase: row };
}
