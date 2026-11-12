import { HttpError } from "./http.js";
import { sessionTokenHash, sessionUser } from "./session.js";
import { recoverTopupAttempt } from "./topup-attempt-recovery.js";
import { validTopupCheckoutId } from "./topup-ledger.js";
import {
  historicalTopupOffer,
  readTopupAssociation,
  topupRecoveryConfigured,
} from "./topup-stripe.js";

const pending = () => ({ status: "pending" });

export async function canRecoverAttachedTopup(db, user, token) {
  try {
    const id = await sessionTokenHash(token);
    const attempt = await db
      .prepare(
        "SELECT a.checkout_id FROM topup_checkout_attempts a JOIN sessions s ON s.id=? " +
          "AND s.user_hash=a.user_hash AND julianday(s.expires)>julianday('now') " +
          "WHERE a.user_hash=? AND a.state IN ('creating','open') AND a.state='open'",
      )
      .bind(id, user)
      .first();
    return validTopupCheckoutId(attempt?.checkout_id);
  } catch {
    return false;
  }
}

export async function recoverAttachedTopup(
  db,
  env,
  token,
  fetchImpl,
  clock = () => new Date(),
  { admit, returnUrl } = {},
) {
  let latest = -Infinity;
  const fresh = () => {
    const now = clock();
    const at = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(at) || at < latest) throw new Error("Invalid recovery clock");
    latest = at;
    return new Date(at);
  };
  const readSession = async (expectedUser) => {
    try {
      const session = await sessionUser(db, token, { now: +fresh(), refresh: false });
      if (
        !(Date.parse(session.expires) > +fresh()) ||
        (expectedUser !== undefined && expectedUser !== session.user)
      )
        return { status: "auth" };
      return { status: "authorized", user: session.user };
    } catch (error) {
      return error instanceof HttpError && error.status === 401 && error.code === "auth"
        ? { status: "auth" }
        : pending();
    }
  };

  const initial = await readSession();
  if (initial.status !== "authorized") return initial;
  const { user } = initial;
  if (!topupRecoveryConfigured(env) || typeof fetchImpl !== "function") return pending();
  const config = {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_TOPUP: env.STRIPE_PRICE_TOPUP,
  };
  const sessionFailure = async () => {
    const result = await readSession(user);
    return result.status === "authorized" ? null : result;
  };
  const get = async (url, options) => {
    if (
      options?.method !== "GET" ||
      options.body != null ||
      (await sessionFailure()) ||
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
    const selectionFailure = await sessionFailure();
    if (selectionFailure) return selectionFailure;
    if (!a) return { status: "inactive" };
    if (a.state !== "open" || !validTopupCheckoutId(a.checkout_id)) return pending();
    if (admit) {
      const at = fresh();
      if (!(await admit(user, at))) return (await sessionFailure()) ?? { status: "limited" };
      if (Math.floor(+fresh() / 60000) !== Math.floor(+at / 60000)) return pending();
    }
    const checkout = await readTopupAssociation(config, "checkout/sessions", a.checkout_id, get);
    const checkoutFailure = await sessionFailure();
    if (checkoutFailure) return checkoutFailure;
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
    const session = Object.freeze({ user, id: await sessionTokenHash(token) });
    const result = await recoverTopupAttempt(db, config, a.id, offer, get, {
      candidateCheckoutId: a.checkout_id,
      clock: fresh,
      beforeApply: async () => !(await sessionFailure()),
      session,
      returnUrl,
    });
    if (result.status === "open") return result; // The final SQL read already fenced session and attempt.
    const outcomeFailure = await sessionFailure();
    if (outcomeFailure) return outcomeFailure;
    return ["settled", "expired"].includes(result.status) ? { status: result.status } : pending();
  } catch {
    return (await sessionFailure()) ?? pending();
  }
}
