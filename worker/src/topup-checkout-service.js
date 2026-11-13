// Dormant service. Only a server-owned verified adapter may be supplied; no route or fetch.
import { reserveSessionTopupCheckout } from "./topup-checkout.js";

export async function getSessionTopupCheckout(
  db,
  userHash,
  token,
  adapter = {},
  clock = () => new Date(),
) {
  if (adapter?.enabled !== true || typeof adapter.readOpen !== "function")
    return { status: "disabled" };
  try {
    let latest = -Infinity;
    const fresh = () => {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(+now) || +now < latest)
        throw new Error("Invalid clock");
      latest = +now;
      return new Date(latest);
    };
    const reserved = await reserveSessionTopupCheckout(db, userHash, token, adapter, fresh);
    if (reserved.status !== "open")
      return {
        status: ["disabled", "auth"].includes(reserved.status) ? reserved.status : "pending",
      };
    const a = Object.freeze({ ...reserved.attempt });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const sessionHash = [...new Uint8Array(digest)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    // Same SHA-256/session fence as reservation, without sliding expiry or returning identity.
    const select = (at, revision) =>
      db
        .prepare(
          "SELECT COALESCE(r.revision,0) AS revision, s.expires FROM topup_checkout_attempts a " +
            "LEFT JOIN topup_attempt_revisions r ON r.attempt_id=a.id " +
            "JOIN sessions s ON s.id=? AND s.user_hash=a.user_hash " +
            "WHERE a.id=? AND a.user_hash=? AND a.checkout_id=? AND a.state='open' " +
            "AND a.offer_version=? AND a.amount=? AND a.currency=? AND a.units=? " +
            "AND s.expires>?" +
            (revision === undefined ? "" : " AND COALESCE(r.revision,0)=?"),
        )
        .bind(
          sessionHash,
          a.id,
          userHash,
          a.checkout_id,
          a.offer_version,
          a.amount,
          a.currency,
          a.units,
          at,
          ...(revision === undefined ? [] : [revision]),
        );
    const before = await select(fresh().toISOString()).first();
    if (!before) return { status: "auth" };
    const verified = await adapter.readOpen(a);
    if (adapter.enabled !== true) return { status: "disabled" };
    if (
      !verified ||
      verified.status !== "open" ||
      verified.attemptId !== a.id ||
      verified.userHash !== userHash ||
      verified.checkoutId !== a.checkout_id ||
      verified.offerVersion !== a.offer_version ||
      verified.amount !== a.amount ||
      verified.currency !== a.currency ||
      verified.units !== a.units ||
      typeof verified.url !== "string" ||
      verified.url.length > 8192 ||
      /[\\\s]/.test(verified.url)
    )
      return { status: "unavailable" };
    const url = new URL(verified.url);
    if (
      url.origin !== "https://checkout.stripe.com" ||
      url.username ||
      url.password ||
      url.pathname !== "/c/pay/" + a.checkout_id
    )
      return { status: "unavailable" };
    const current = await select(fresh().toISOString(), before.revision).first();
    // The database await may outlast the exact matched session expiry.
    if (!current || !(Date.parse(current.expires) > +fresh())) return { status: "unavailable" };
    return adapter.enabled === true ? { status: "open", url: url.href } : { status: "disabled" };
  } catch {
    // No provider errors, attempt records, tokens or identifiers cross this service boundary.
    return { status: "unavailable" };
  }
}
