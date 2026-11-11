import { sessionUser } from "./session.js";
import { recoverTopupAttempt } from "./topup-attempt-recovery.js";
import { validTopupCheckoutId } from "./topup-ledger.js";
import {
  historicalTopupOffer,
  readTopupAssociation,
  topupRecoveryConfigured,
} from "./topup-stripe.js";

const pending = () => ({ status: "pending" });

export async function recoverAttachedTopup(db, env, token, fetchImpl, clock = () => new Date()) {
  let latest = -Infinity;
  const fresh = () => {
    const now = clock();
    const at = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(at) || at < latest) throw new Error("Invalid recovery clock");
    latest = at;
    return new Date(at);
  };
  const readSession = async () => {
    const session = await sessionUser(db, token, { now: +fresh(), refresh: false });
    return Date.parse(session.expires) > +fresh() ? session : null;
  };

  let user;
  try {
    user = (await readSession())?.user;
  } catch (error) {
    if (error?.status === 401) return { status: "auth" };
    return pending();
  }
  if (!user) return { status: "auth" };
  if (!topupRecoveryConfigured(env) || typeof fetchImpl !== "function") return pending();
  const config = {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_TOPUP: env.STRIPE_PRICE_TOPUP,
  };
  const authorized = async () => {
    try {
      return (await readSession())?.user === user;
    } catch {
      return false;
    }
  };
  const get = async (url, options) => {
    if (
      options?.method !== "GET" ||
      options.body != null ||
      !(await authorized()) ||
      options.signal?.aborted
    )
      throw new Error("Recovery request refused");
    return fetchImpl(url, options);
  };
  try {
    // The existing partial unique index has at most one active attempt per account.
    const a = await db
      .prepare(
        "SELECT id,offer_version,checkout_id,units,state FROM topup_checkout_attempts " +
          "WHERE user_hash=? AND state IN ('creating','open')",
      )
      .bind(user)
      .first();
    if (!(await authorized())) return { status: "auth" };
    if (!a) return { status: "inactive" };
    if (a.state !== "open" || !validTopupCheckoutId(a.checkout_id)) return pending();
    const checkout = await readTopupAssociation(config, "checkout/sessions", a.checkout_id, get);
    if (!(await authorized())) return { status: "auth" };
    if (
      checkout?.object !== "checkout.session" ||
      checkout.id !== a.checkout_id ||
      checkout.mode !== "payment" ||
      checkout.ui_mode !== "hosted_page" ||
      checkout.client_reference_id !== user ||
      checkout.metadata?.kind !== "autofill_topup" ||
      checkout.metadata.attempt_id !== a.id ||
      checkout.metadata.user_hash !== user ||
      checkout.metadata.offer_version !== a.offer_version ||
      checkout.metadata.units !== String(a.units)
    )
      return pending();
    const offer = historicalTopupOffer(config, a.offer_version, checkout.livemode);
    if (!offer) return pending();
    const result = await recoverTopupAttempt(db, config, a.id, offer, get, {
      candidateCheckoutId: a.checkout_id,
      clock: fresh,
      beforeApply: authorized,
    });
    if (!(await authorized())) return { status: "auth" };
    return ["settled", "expired"].includes(result.status) ? { status: result.status } : pending();
  } catch {
    return (await authorized()) ? pending() : { status: "auth" };
  }
}
