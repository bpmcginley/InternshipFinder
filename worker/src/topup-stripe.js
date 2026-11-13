// Trusted checkout adapter with explicit injected fetch.
import { stripe, siteUrl, paymentsOn, managedPayments } from "./billing.js";
import { validTopupCheckoutId } from "./topup-ledger.js";
import { uniqueJson } from "./topup-history-traversal.js";
const OFFER = Object.freeze({
  verified: true,
  version: "topup-v1",
  amount: 300,
  currency: "usd",
  units: 25,
});
// Historical recovery stays configured when current sales or the Price are inactive.
export function topupRecoveryConfigured(env) {
  return (
    typeof env?.STRIPE_SECRET_KEY === "string" &&
    !!env.STRIPE_SECRET_KEY &&
    typeof env.STRIPE_PRICE_TOPUP === "string" &&
    /^price_[A-Za-z0-9_]{1,250}$/.test(env.STRIPE_PRICE_TOPUP)
  );
}
export function historicalTopupOffer(env, version, livemode) {
  return topupRecoveryConfigured(env) && version === OFFER.version && typeof livemode === "boolean"
    ? { ...OFFER, priceId: env.STRIPE_PRICE_TOPUP, livemode }
    : null;
}
// At most one bounded GET per association step. No arbitrary path or provider writes.
export async function readTopupAssociation(env, kind, id, fetchImpl) {
  const prefix = new Map([
    ["charges", "ch"],
    ["payment_intents", "pi"],
  ]).get(kind);
  if (
    !topupRecoveryConfigured(env) ||
    !(kind === "checkout/sessions"
      ? validTopupCheckoutId(id)
      : prefix &&
        typeof id === "string" &&
        new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(id)) ||
    typeof fetchImpl !== "function"
  )
    throw unavailable();
  return boundedRequest(
    { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY },
    kind + "/" + encodeURIComponent(id),
    {},
    fetchImpl,
    null,
    "GET",
    TOPUP_CHECKOUT_BOUNDS.timeoutMs,
  );
}

// History-only direct target after a fully proven settled payment. No current sales Price gate.
export async function readHistoricalTopupTarget(env, kind, id, fetchImpl) {
  const secret = env?.STRIPE_SECRET_KEY;
  const prefix = new Map([
    ["refunds", "re"],
    ["disputes", "du"],
  ]).get(kind);
  if (
    typeof secret !== "string" ||
    !secret ||
    !prefix ||
    typeof id !== "string" ||
    !new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(id) ||
    typeof fetchImpl !== "function"
  )
    throw unavailable();
  return boundedRequest(
    { STRIPE_SECRET_KEY: secret },
    kind + "/" + encodeURIComponent(id),
    {},
    fetchImpl,
    null,
    "GET",
    TOPUP_CHECKOUT_BOUNDS.timeoutMs,
  );
}

// History-only positive employer proof. Fixed GET paths, no current sales configuration.
export async function readEmployerHistoryObject(env, kind, id, fetchImpl) {
  const prefix = new Map([
    ["charges", "ch"],
    ["payment_intents", "pi"],
    ["refunds", "re"],
    ["disputes", "du"],
  ]).get(kind);
  if (
    typeof env?.STRIPE_SECRET_KEY !== "string" ||
    !env.STRIPE_SECRET_KEY ||
    typeof fetchImpl !== "function" ||
    !(kind === "checkout/sessions"
      ? validTopupCheckoutId(id)
      : prefix &&
        typeof id === "string" &&
        new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(id))
  )
    throw unavailable();
  return boundedRequest(
    { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY },
    kind +
      "/" +
      encodeURIComponent(id) +
      (kind === "checkout/sessions" ? "?expand[]=line_items" : ""),
    {},
    fetchImpl,
    null,
    "GET",
    TOPUP_CHECKOUT_BOUNDS.timeoutMs,
    true,
  );
}

function topupSalesSettings(env) {
  if (env?.TOPUPS_ENABLED !== "1" || !paymentsOn(env)) return null;
  const {
    STRIPE_SECRET_KEY: key,
    STRIPE_WEBHOOK_SECRET: signingKey,
    STRIPE_PRICE_TOPUP: priceId,
    STRIPE_TOPUP_MODE: mode,
  } = env;
  if (
    typeof key !== "string" ||
    !key ||
    typeof signingKey !== "string" ||
    !/^[!-~]+$/.test(signingKey) ||
    typeof priceId !== "string" ||
    !/^price_[A-Za-z0-9_]{1,250}$/.test(priceId) ||
    (mode !== "test" && mode !== "live")
  )
    return null;
  return { key, signingKey, priceId, mode };
}
export function topupConfigured(env) {
  return topupSalesSettings(env) !== null;
}

export function topupDisplayOffer(adapter) {
  if (adapter?.enabled !== true || adapter.offer !== OFFER) return null;
  const { amount, currency, units } = OFFER;
  return { amount, currency, units };
}

const unavailable = () => new Error("Top-up checkout is unavailable");
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
function callback(value, origin) {
  if (typeof value !== "string" || /[\\\s]/.test(value)) throw unavailable();
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw unavailable();
  return url.href;
}
export function checkoutUrl(value, id) {
  if (typeof value !== "string" || value.length > 8192 || /[\\\s]/.test(value)) throw unavailable();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw unavailable();
  }
  if (
    url.origin !== "https://checkout.stripe.com" ||
    url.username ||
    url.password ||
    url.pathname !== "/c/pay/" + id
  )
    throw unavailable();
  return url.href;
}
export const TOPUP_CHECKOUT_BOUNDS = Object.freeze({ timeoutMs: 10000, bodyBytes: 262144 });

// One request per operation. A timed-out POST is ambiguous, never retried here.
async function boundedRequest(
  config,
  path,
  form,
  fetchImpl,
  key,
  method,
  timeoutMs,
  strictJson = false,
) {
  const controller = new AbortController(),
    deadline = performance.now() + timeoutMs;
  let stopped = false,
    timer;
  const live = () => {
    if (stopped || performance.now() >= deadline) throw unavailable();
  };
  const cancel = (body) => {
    try {
      void body?.cancel().catch(() => {});
    } catch {
      /* Best effort, never await cancellation. */
    }
  };
  const bodyText = async (response) => {
    const length = response.headers?.get?.("Content-Length");
    if (
      length != null &&
      (!/^\d+$/.test(length) || Number(length) > TOPUP_CHECKOUT_BOUNDS.bodyBytes)
    ) {
      cancel(response.body);
      throw unavailable();
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const abort = () => cancel(reader);
    controller.signal.addEventListener("abort", abort, { once: true });
    let bytes = 0,
      text = "";
    // Legacy reads retain Response.text decoding. Positive exclusion rejects malformed bytes.
    const decoder = new TextDecoder("utf-8", { fatal: strictJson });
    try {
      for (;;) {
        live();
        const chunk = await reader.read();
        live();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) throw unavailable();
        bytes += chunk.value.byteLength;
        if (bytes > TOPUP_CHECKOUT_BOUNDS.bodyBytes) throw unavailable();
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      if (strictJson) {
        if (length != null && bytes !== Number(length)) throw unavailable();
        uniqueJson(text);
        live();
      }
      return text;
    } finally {
      abort();
      controller.signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  };
  const run = async () => {
    live();
    const result = await stripe(
      config,
      path,
      form,
      async (url, options) => {
        const response = await fetchImpl(url, {
          ...options,
          redirect: "manual",
          signal: controller.signal,
        });
        if (stopped || performance.now() >= deadline || response.ok !== true) {
          cancel(response.body);
          throw unavailable();
        }
        // Only bounded successful content reaches the existing parser, never private error bodies.
        return { ok: true, text: () => bodyText(response) };
      },
      key,
      method,
    );
    live();
    return result;
  };
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          stopped = true;
          controller.abort();
          reject(unavailable());
        }, timeoutMs);
      }),
      run(),
    ]);
  } catch {
    throw unavailable();
  } finally {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  }
}

export async function prepareTopupStripe(
  env,
  callbacks,
  fetchImpl,
  timeoutMs = TOPUP_CHECKOUT_BOUNDS.timeoutMs,
) {
  const sales = topupSalesSettings(env);
  if (
    !sales ||
    typeof fetchImpl !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > TOPUP_CHECKOUT_BOUNDS.timeoutMs
  )
    return { enabled: false };
  // Snapshot private configuration. Price/session paths and raw errors must never reach logs.
  const { key, signingKey, priceId, mode } = sales;
  const config = { STRIPE_SECRET_KEY: key },
    livemode = mode === "live",
    managed = managedPayments(env);
  const current = () => {
    const latest = topupSalesSettings(env);
    return (
      latest?.key === key &&
      latest.signingKey === signingKey &&
      latest.priceId === priceId &&
      latest.mode === mode
    );
  };
  const request = (path, form = {}, key = null, method = "GET") =>
    boundedRequest(config, path, form, fetchImpl, key, method, timeoutMs);
  let success, cancel, price;
  try {
    const site = new URL(siteUrl(env));
    if (
      site.protocol !== "https:" ||
      site.username ||
      site.password ||
      site.pathname !== "/" ||
      site.search ||
      site.hash
    )
      throw unavailable();
    success = callback(callbacks?.success, site.origin);
    cancel = callback(callbacks?.cancel, site.origin);
    price = await request("prices/" + encodeURIComponent(priceId) + "?expand[]=product");
    if (
      !price ||
      price.object !== "price" ||
      price.id !== priceId ||
      price.active !== true ||
      price.type !== "one_time" ||
      price.billing_scheme !== "per_unit" ||
      price.recurring !== null ||
      price.custom_unit_amount !== null ||
      price.transform_quantity !== null ||
      price.currency !== "usd" ||
      price.unit_amount !== 300 ||
      Number(price.unit_amount_decimal) !== 300 ||
      price.tax_behavior !== "exclusive" ||
      price.livemode !== livemode ||
      !current() ||
      price.product?.object !== "product" ||
      price.product.active !== true ||
      price.product.deleted
    )
      throw unavailable();
  } catch {
    return { enabled: false };
  }
  const attemptOk = (a) =>
    a &&
    uuid(a.id) &&
    typeof a.user_hash === "string" &&
    /^[a-f0-9]{64}$/.test(a.user_hash) &&
    a.offer_version === OFFER.version &&
    a.amount === 300 &&
    a.currency === "usd" &&
    a.units === 25;
  const metadata = (a) => ({
    kind: "autofill_topup",
    attempt_id: a.id,
    user_hash: a.user_hash,
    offer_version: OFFER.version,
    units: "25",
  });
  function verified(session, a) {
    const items = session?.line_items,
      item = items?.data?.[0],
      tax = session?.total_details;
    if (
      !session ||
      session.object !== "checkout.session" ||
      !validTopupCheckoutId(session.id) ||
      session.mode !== "payment" ||
      session.status !== "open" ||
      session.payment_status !== "unpaid" ||
      session.livemode !== livemode ||
      session.client_reference_id !== a.user_hash ||
      session.currency !== "usd" ||
      session.amount_subtotal !== 300 ||
      session.success_url !== success ||
      session.cancel_url !== cancel ||
      session.ui_mode !== "hosted_page" ||
      !Object.entries(metadata(a)).every(([k, v]) => session.metadata?.[k] === v) ||
      items?.object !== "list" ||
      items.has_more !== false ||
      !Array.isArray(items.data) ||
      items.data.length !== 1 ||
      !item ||
      item.quantity !== 1 ||
      item.price?.id !== priceId ||
      item.price.unit_amount !== 300 ||
      item.price.currency !== "usd" ||
      item.amount_subtotal !== 300 ||
      item.currency !== "usd" ||
      tax?.amount_discount !== 0 ||
      tax.amount_shipping !== 0 ||
      !Number.isSafeInteger(tax.amount_tax) ||
      tax.amount_tax < 0 ||
      !Number.isSafeInteger(session.amount_total) ||
      session.amount_total !== 300 + tax.amount_tax
    )
      throw unavailable();
    return {
      status: "open",
      checkoutId: session.id,
      attemptId: a.id,
      userHash: a.user_hash,
      offerVersion: a.offer_version,
      amount: a.amount,
      currency: a.currency,
      units: a.units,
      url: checkoutUrl(session.url, session.id),
    };
  }
  return {
    get enabled() {
      return current();
    },
    offer: OFFER,
    async create(a) {
      if (
        !current() ||
        !attemptOk(a) ||
        a.state !== "creating" ||
        a.checkout_id !== null ||
        a.idempotencyKey !== "topup-checkout:" + a.id
      )
        throw unavailable();
      const form = {
        mode: "payment",
        ui_mode: "hosted_page",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        client_reference_id: a.user_hash,
        success_url: success,
        cancel_url: cancel,
        currency: "usd",
        "adaptive_pricing[enabled]": "false",
        "expand[]": "line_items",
      };
      for (const [k, v] of Object.entries(metadata(a))) {
        form[`metadata[${k}]`] = v;
        form[`payment_intent_data[metadata][${k}]`] = v;
      }
      if (managed) form["managed_payments[enabled]"] = "true";
      return verified(await request("checkout/sessions", form, a.idempotencyKey, "POST"), a);
    },
    async readOpen(a) {
      if (!current() || !attemptOk(a) || a.state !== "open" || !validTopupCheckoutId(a.checkout_id))
        throw unavailable();
      const session = await request(
        "checkout/sessions/" + encodeURIComponent(a.checkout_id) + "?expand[]=line_items",
      );
      if (session?.id !== a.checkout_id) throw unavailable();
      return verified(session, a);
    },
  };
}
