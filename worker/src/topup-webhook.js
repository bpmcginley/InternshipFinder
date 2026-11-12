// Called only after existing raw-body signature verification and receipt acquisition.
import { recoverVerifiedTopupCheckoutEvent } from "./topup-checkout-events.js";
import {
  recoverVerifiedTopupReversalEvent,
  snapshotTopupHistoryPolicy,
} from "./topup-reversal-events.js";
import {
  topupRecoveryConfigured,
  historicalTopupOffer,
  readTopupAssociation,
} from "./topup-stripe.js";

const pending = () => ({ status: "pending" });
const marked = (o) => o?.metadata?.kind === "autofill_topup";
const id = (v, prefix) =>
  typeof v === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(v);
const objectTypes = new Map([
  ...["refund.created", "refund.updated", "refund.failed", "charge.refund.updated"].map((t) => [
    t,
    "refund",
  ]),
  ["charge.refunded", "charge"],
  ...["created", "updated", "closed", "funds_withdrawn", "funds_reinstated"].map((t) => [
    "charge.dispute." + t,
    "dispute",
  ]),
]);
const reference = (value, kind, mode) =>
  typeof value === "string"
    ? value
    : value?.object === kind && value.livemode === mode
      ? value.id
      : null;

// Capture before receipt/discovery awaits. Only this top-up branch receives the pinned env.
export function snapshotTopupHistoryInput(env, event, historyPolicy) {
  if (historyPolicy?.enabled !== true || !objectTypes.has(event?.type))
    return { historyPolicy: null };
  let policy;
  try {
    policy = snapshotTopupHistoryPolicy(historyPolicy);
    if (!policy) throw new Error("Invalid history policy");
  } catch {
    policy = Object.freeze({ enabled: true }); // Invalid opt-in must not become legacy recovery.
  }
  return {
    event: structuredClone(event),
    historyPolicy: policy,
    env: Object.freeze({
      STRIPE_SECRET_KEY: env?.STRIPE_SECRET_KEY,
      STRIPE_PRICE_TOPUP: env?.STRIPE_PRICE_TOPUP,
    }),
  };
}

// null means positively outside this boundary. pending MUST release the existing receipt
// for retry, never fall through to employer/subscription handling or acknowledge success.
export async function topupWebhook({ db, env, event, fetchImpl, clock, historyPolicy }) {
  try {
    const captured = snapshotTopupHistoryInput(env, event, historyPolicy);
    historyPolicy = captured.historyPolicy;
    event = captured.event ?? event;
    env = captured.env ?? env;
  } catch {
    return pending();
  }
  const o = event?.data?.object,
    checkout = typeof event?.type === "string" && event.type.startsWith("checkout.session."),
    expected = objectTypes.get(event?.type),
    tagged = marked(o);
  if (!checkout && !expected) return tagged ? { status: "ignored" } : null;
  if (!topupRecoveryConfigured(env)) return tagged ? pending() : null;
  if (
    event.object !== "event" ||
    !id(event.id, "evt") ||
    typeof event.livemode !== "boolean" ||
    event.account != null ||
    event.context != null
  )
    return pending();
  const mode = event.livemode;
  const args = {
    db,
    env,
    event,
    fetchImpl,
    clock,
    historyPolicy,
    resolveOffer: (version, livemode) => historicalTopupOffer(env, version, livemode),
  };
  try {
    if (checkout) {
      const result = await recoverVerifiedTopupCheckoutEvent(args);
      return result.status === "unclassified" ? (tagged ? pending() : null) : result;
    }
    if (
      o?.object !== expected ||
      !id(o.id, { refund: "re", charge: "ch", dispute: "du" }[expected]) ||
      (expected !== "refund" && o.livemode !== mode) ||
      (o.livemode !== undefined && o.livemode !== mode)
    )
      return pending();
    let paymentId = reference(o.payment_intent, "payment_intent", mode),
      positive = tagged;
    if (o.payment_intent != null && !id(paymentId, "pi")) return pending();
    if (!paymentId) {
      const chargeId = expected === "charge" ? o.id : reference(o.charge, "charge", mode);
      if (!id(chargeId, "ch")) return pending();
      const charge = await readTopupAssociation(env, "charges", chargeId, fetchImpl);
      if (charge?.object !== "charge" || charge.id !== chargeId || charge.livemode !== mode)
        return pending();
      positive ||= marked(charge);
      paymentId = reference(charge.payment_intent, "payment_intent", mode);
      if (charge.payment_intent == null) return positive ? pending() : null;
      if (!id(paymentId, "pi")) return pending();
    }
    // Add only the verified association. No event status/amount becomes financial evidence.
    const associated = {
      ...event,
      data: { ...event.data, object: { ...o, payment_intent: paymentId } },
    };
    const result = await recoverVerifiedTopupReversalEvent({ ...args, event: associated });
    if (result.status !== "unclassified") return result;
    if (positive) return pending(); // includes refund-before-first-grant
    // A durable employer payment association needs no extra provider discovery.
    if (
      await db
        .prepare("SELECT 1 AS known FROM employer_orders WHERE payment_intent=? LIMIT 1")
        .bind(paymentId)
        .first()
    )
      return null;
    const intent = await readTopupAssociation(env, "payment_intents", paymentId, fetchImpl);
    if (intent?.object !== "payment_intent" || intent.id !== paymentId || intent.livemode !== mode)
      return pending();
    if (marked(intent)) return pending();
    const attemptId = intent.metadata?.attempt_id;
    if (
      typeof attemptId === "string" &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(attemptId) &&
      (await db
        .prepare("SELECT 1 AS known FROM topup_checkout_attempts WHERE id=?")
        .bind(attemptId)
        .first())
    )
      return pending();
    return null;
  } catch {
    return pending();
  }
}
