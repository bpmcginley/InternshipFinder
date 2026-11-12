// Dormant authenticated-event association. No coverage authority or balance transition.
import { topupReversalObject } from "./topup-reversal-events.js";
import { readTopupAssociation, readHistoricalTopupTarget } from "./topup-stripe.js";
import { readVerifiedTopupPayment } from "./topup-purchase-recovery.js";
import { PAYMENT_EVIDENCE_BOUNDS } from "./topup-payment-evidence.js";
import { referenceHash } from "./topup-ledger.js";
import { observeTopupHistory } from "./topup-history-observation.js";
const pending = () => ({ status: "pending" });
const id = (v, prefix) =>
  typeof v === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(v);
const validVersion = (v) => typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v);
const ref = (v, kind, mode) =>
  typeof v === "string" ? v : v?.object === kind && v.livemode === mode ? v.id : null;
const fail = () => {
  throw new Error("History association unavailable");
};

// Caller authenticates the event/account and explicitly supplies supported historical schemas.
// Discovery never authorizes observation. Verification captures before all authoritative reads.
export async function observeVerifiedTopupEvent(db, env, event, options = {}) {
  if (options.enabled !== true) return { status: "disabled" };
  const {
    fetchImpl,
    resolveOffer,
    livemode,
    apiVersions,
    timeoutMs = PAYMENT_EVIDENCE_BOUNDS.timeoutMs,
  } = options;
  let e, object, kind, paymentId, chargeId, config;
  try {
    const eventVersion = Object.getOwnPropertyDescriptor(event, "api_version");
    if (
      !eventVersion?.enumerable ||
      !Object.hasOwn(eventVersion, "value") ||
      !validVersion(eventVersion.value) ||
      !Array.isArray(apiVersions) ||
      !apiVersions.length ||
      apiVersions.length > 4
    )
      fail();
    const versions = [];
    for (let i = 0; i < apiVersions.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(apiVersions, i);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        !validVersion(descriptor.value) ||
        versions.includes(descriptor.value)
      )
        fail();
      versions.push(descriptor.value);
    }
    const secret = env?.STRIPE_SECRET_KEY,
      price = env?.STRIPE_PRICE_TOPUP;
    if (typeof secret !== "string" || !secret || (price !== undefined && typeof price !== "string"))
      fail();
    config = Object.freeze({ STRIPE_SECRET_KEY: secret, STRIPE_PRICE_TOPUP: price });
    e = structuredClone(event);
    object = e.data?.object;
    kind = topupReversalObject(e.type);
    if (
      !kind ||
      e.object !== "event" ||
      !id(e.id, "evt") ||
      typeof livemode !== "boolean" ||
      e.livemode !== livemode ||
      e.account != null ||
      e.context != null ||
      !validVersion(e.api_version) ||
      !versions.includes(e.api_version) ||
      object?.object !== kind ||
      !id(object.id, { refund: "re", dispute: "du", charge: "ch" }[kind]) ||
      (kind !== "refund" && object.livemode !== livemode) ||
      (object.livemode !== undefined && object.livemode !== livemode) ||
      typeof fetchImpl !== "function" ||
      typeof resolveOffer !== "function" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > PAYMENT_EVIDENCE_BOUNDS.timeoutMs
    )
      fail();
    paymentId = ref(object.payment_intent, "payment_intent", livemode);
    chargeId = kind === "charge" ? object.id : ref(object.charge, "charge", livemode);
    if (
      (object.payment_intent != null && !id(paymentId, "pi")) ||
      (object.charge != null && !id(chargeId, "ch")) ||
      (!paymentId && !id(chargeId, "ch"))
    )
      fail();
  } catch {
    return pending();
  }
  const controller = new AbortController(),
    deadline = performance.now() + timeoutMs;
  const cancels = new Set();
  let stopped = false,
    requests = 0,
    timer;
  const live = () => {
    if (stopped || performance.now() >= deadline) fail();
  };
  const stop = () => {
    stopped = true;
    controller.abort();
    for (const cancel of cancels) cancel();
  };
  // Existing readers retain their streamed limits. This owner adds one shared deadline,
  // cancellation and a request ceiling: one discovery + three paid reads + one target.
  const get = async (url, init) => {
    live();
    if (
      init?.method !== "GET" ||
      init.body != null ||
      init.redirect !== "manual" ||
      ++requests > 2 + PAYMENT_EVIDENCE_BOUNDS.requests
    )
      fail();
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.any([controller.signal, init.signal]),
    });
    const discard = () => {
      try {
        void Promise.resolve(response?.body?.cancel()).catch(() => {});
      } catch {}
    };
    let reader;
    try {
      live();
      if (
        !(response instanceof Response) ||
        response.status !== 200 ||
        response.redirected ||
        response.url !== url
      )
        fail();
      live();
      reader = response.body?.getReader();
      if (!reader) fail();
    } catch {
      discard();
      fail();
    }
    const cancel = () => {
      const release = () => {
        try {
          reader.releaseLock();
        } catch {}
      };
      void reader.cancel().then(release, release);
      release();
      cancels.delete(cancel);
    };
    cancels.add(cancel);
    return new Response(
      new ReadableStream(
        {
          async pull(out) {
            try {
              live();
              const chunk = await reader.read();
              live();
              if (chunk.done) {
                cancel();
                out.close();
              } else out.enqueue(chunk.value);
            } catch {
              cancel();
              out.error(new Error("History association unavailable"));
            }
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      { status: 200, headers: response.headers },
    );
  };
  async function run() {
    if (!paymentId) {
      const c = await readTopupAssociation(config, "charges", chargeId, get);
      live();
      if (c?.object !== "charge" || c.id !== chargeId || c.livemode !== livemode) return pending();
      paymentId = ref(c.payment_intent, "payment_intent", livemode);
      if (!id(paymentId, "pi")) return pending();
    }
    const hash = await referenceHash("payment", livemode, paymentId);
    live();
    const rows = await db.batch([
      db
        .prepare(
          "SELECT c.state,p.offer_version FROM topup_claims c LEFT JOIN topup_purchases p ON p.payment_hash=c.payment_hash WHERE c.payment_hash=? LIMIT 2",
        )
        .bind(hash),
    ]);
    live();
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0]?.success !== true ||
      !Array.isArray(rows[0].results) ||
      rows[0].results.length !== 1
    )
      return pending();
    const claim = rows[0].results[0];
    if (["deleted", "retired"].includes(claim?.state)) return { status: "inactive" };
    if (claim?.state !== "granted") return pending();
    const offer = await resolveOffer(claim.offer_version, livemode);
    live();
    if (offer?.version !== claim.offer_version || offer?.livemode !== livemode) return pending();
    const verified = await readVerifiedTopupPayment(db, config, hash, offer, get);
    live();
    if (verified.status !== "verified_payment") return pending();
    const { captured, payment } = verified;
    if (
      payment.paymentId !== paymentId ||
      payment.livemode !== livemode ||
      (chargeId && payment.chargeId !== chargeId)
    )
      return pending();
    if (kind !== "charge") {
      const target = await readHistoricalTopupTarget(config, kind + "s", object.id, get);
      live();
      if (
        target?.object !== kind ||
        target.id !== object.id ||
        ref(target.charge, "charge", livemode) !== payment.chargeId ||
        (target.payment_intent != null &&
          ref(target.payment_intent, "payment_intent", livemode) !== paymentId) ||
        (kind === "dispute" && target.livemode !== livemode) ||
        (target.livemode !== undefined && target.livemode !== livemode)
      )
        return pending();
    }
    live();
    return observeTopupHistory(
      db,
      {
        eventId: e.id,
        paymentId,
        checkoutId: captured.checkout_id,
        livemode,
        revision: captured.revision,
      },
      { enabled: true },
    );
  }
  try {
    const result = await Promise.race([
      run(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          stop();
          resolve({ status: "unavailable" });
        }, timeoutMs);
      }),
    ]);
    live();
    return result;
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
    stop();
  }
}
