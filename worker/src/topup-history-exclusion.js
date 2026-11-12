// Internal positive evidence only. The caller has validated a supported event and no claim.
import { readEmployerHistoryObject, readHistoricalTopupTarget } from "./topup-stripe.js";
import { referenceHash, validTopupCheckoutId } from "./topup-ledger.js";
const pending = () => ({ status: "pending" });
const fields = "id,status,price,paid_amount,paid_session,payment_intent,paid_ref,paid_at";
const id = (v, prefix) =>
  typeof v === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(v);
const amount = (v) => Number.isSafeInteger(v) && v >= 0;
const ref = (v, kind, mode) =>
  typeof v === "string" ? v : v?.object === kind && v.livemode === mode ? v.id : null;
const clear = (o) =>
  (o?.metadata === undefined ||
    (o.metadata !== null && typeof o.metadata === "object" && !Array.isArray(o.metadata))) &&
  o?.metadata?.kind !== "autofill_topup" &&
  ["attempt_id", "user_hash", "offer_version", "units"].every(
    (k) => !Object.hasOwn(o?.metadata ?? {}, k),
  );
const receipt = (r) => r?.success === true && r.meta?.changes === 0 && Array.isArray(r.results);

export async function excludeVerifiedEmployerPayment(
  db,
  { event, kind, paymentId, paymentHash, chargeId, livemode, config, get, live },
) {
  if (!clear(event.data.object)) return pending();
  const select = () =>
    db
      .prepare(`SELECT ${fields} FROM employer_orders WHERE payment_intent=? LIMIT 2`)
      .bind(paymentId);
  const initial = await db.batch([select()]);
  live();
  if (
    !Array.isArray(initial) ||
    initial.length !== 1 ||
    !receipt(initial[0]) ||
    initial[0].results.length !== 1
  )
    return pending();
  const order = initial[0].results[0];
  if (
    !order ||
    Object.keys(order).sort().join(",") !== fields.split(",").sort().join(",") ||
    typeof order.id !== "string" ||
    !/^o-[a-f0-9]{16}$/.test(order.id) ||
    !["paid", "approved", "refused"].includes(order.status) ||
    !amount(order.price) ||
    order.price === 0 ||
    !amount(order.paid_amount) ||
    order.paid_amount === 0 ||
    !validTopupCheckoutId(order.paid_session) ||
    order.payment_intent !== paymentId ||
    order.paid_ref !== "stripe:" + paymentId ||
    typeof order.paid_at !== "string" ||
    !Number.isFinite(Date.parse(order.paid_at)) ||
    new Date(order.paid_at).toISOString() !== order.paid_at
  )
    return pending();
  const consistent = (o) =>
    clear(o) &&
    (o?.metadata?.kind == null || o.metadata.kind === "listing") &&
    (o?.metadata?.order == null || o.metadata.order === order.id);
  if (!consistent(event.data.object)) return pending();
  // All reads reuse the caller's pinned credential, shared request count and deadline.
  if (kind !== "charge") {
    const target = await readHistoricalTopupTarget(config, kind + "s", event.data.object.id, get);
    live();
    const targetCharge = ref(target?.charge, "charge", livemode);
    if (
      target?.object !== kind ||
      target.id !== event.data.object.id ||
      !consistent(target) ||
      !id(targetCharge, "ch") ||
      (chargeId && targetCharge !== chargeId) ||
      (target.payment_intent != null &&
        ref(target.payment_intent, "payment_intent", livemode) !== paymentId) ||
      (kind === "dispute" && target.livemode !== livemode) ||
      (target.livemode !== undefined && target.livemode !== livemode) ||
      target.currency !== "usd" ||
      !amount(target.amount) ||
      target.amount === 0 ||
      target.amount > order.paid_amount
    )
      return pending();
    chargeId = targetCharge;
  }
  if (!id(chargeId, "ch")) return pending();
  const charge = await readEmployerHistoryObject(config, "charges", chargeId, get);
  live();
  const same = (o, type, key) =>
    o?.object === type &&
    o.id === key &&
    o.livemode === livemode &&
    o.currency === "usd" &&
    consistent(o);
  if (
    !same(charge, "charge", chargeId) ||
    ref(charge.payment_intent, "payment_intent", livemode) !== paymentId ||
    charge.status !== "succeeded" ||
    charge.paid !== true ||
    charge.captured !== true ||
    charge.amount !== order.paid_amount ||
    charge.amount_captured !== order.paid_amount
  )
    return pending();
  const intent = await readEmployerHistoryObject(config, "payment_intents", paymentId, get);
  live();
  const listing = (o) => o?.metadata?.kind === "listing" && o.metadata.order === order.id;
  if (
    !same(intent, "payment_intent", paymentId) ||
    !listing(intent) ||
    ref(intent.latest_charge, "charge", livemode) !== chargeId ||
    intent.status !== "succeeded" ||
    intent.amount !== order.paid_amount ||
    intent.amount_received !== order.paid_amount ||
    intent.amount_capturable !== 0
  )
    return pending();
  const session = await readEmployerHistoryObject(
    config,
    "checkout/sessions",
    order.paid_session,
    get,
  );
  live();
  const list = session?.line_items,
    item = list?.data?.[0],
    totals = session?.total_details;
  if (
    !same(session, "checkout.session", order.paid_session) ||
    !listing(session) ||
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.client_reference_id !== order.id ||
    session.recovered_from !== null ||
    ref(session.payment_intent, "payment_intent", livemode) !== paymentId ||
    session.amount_subtotal !== order.price ||
    session.amount_total !== order.paid_amount ||
    list?.object !== "list" ||
    list.url !== "/v1/checkout/sessions/" + order.paid_session + "/line_items" ||
    list.has_more !== false ||
    !Array.isArray(list.data) ||
    list.data.length !== 1 ||
    item?.object !== "item" ||
    !id(item.id, "li") ||
    item.quantity !== 1 ||
    item.currency !== "usd" ||
    item.amount_subtotal !== order.price ||
    item.amount_total !== order.paid_amount ||
    item.price?.object !== "price" ||
    !id(item.price.id, "price") ||
    item.price.id === config.STRIPE_PRICE_TOPUP ||
    item.price.type !== "one_time" ||
    item.price.livemode !== livemode ||
    item.price.currency !== "usd" ||
    item.price.unit_amount !== order.price ||
    !amount(totals?.amount_discount) ||
    totals.amount_discount > order.price ||
    !amount(totals.amount_tax) ||
    totals.amount_shipping !== 0 ||
    order.price - totals.amount_discount + totals.amount_tax !== order.paid_amount
  )
    return pending();
  const checkoutHash = await referenceHash("checkout", livemode, order.paid_session);
  live();
  const final = await db.batch([
    select(),
    db
      .prepare(
        "SELECT 1 AS present FROM topup_claims WHERE payment_hash=? OR checkout_hash=? UNION ALL SELECT 1 FROM topup_checkout_attempts WHERE checkout_id=? LIMIT 1",
      )
      .bind(paymentHash, checkoutHash, order.paid_session),
  ]);
  live();
  if (
    !Array.isArray(final) ||
    final.length !== 2 ||
    !receipt(final[0]) ||
    !receipt(final[1]) ||
    final[0].results.length !== 1 ||
    final[1].results.length !== 0 ||
    Object.keys(final[0].results[0] ?? {})
      .sort()
      .join(",") !== fields.split(",").sort().join(",") ||
    fields.split(",").some((k) => final[0].results[0][k] !== order[k])
  )
    return pending();
  return { status: "excluded" };
}
