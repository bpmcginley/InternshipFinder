// Dormant, bounded observation only. No provider snapshot isolation, grant or database write.
import { stripe } from "./billing.js";
import { decideTopup } from "./topup-decisions.js";
const pending = () => ({ status: "pending" });
const ref = (value) => (typeof value === "string" ? value : value?.id);
const identifier = (value, prefix) =>
  typeof value === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,250}$").test(value);
export const REVERSAL_BOUNDS = Object.freeze({
  pageSize: 100,
  pages: 4,
  requests: 18,
  bodyBytes: 262144,
  totalBytes: 1048576,
  timeoutMs: 10000,
});
const initial = () => ({
  deleted: false,
  fullRefund: false,
  loss: false,
  held: false,
  heldDisputeIds: [],
});
const fail = () => {
  throw new Error("unavailable");
};

// evidence is a fresh internal #278 paid_evidence, not a browser-supplied assertion.
// timeoutMs may only shorten the hard deadline (also useful in synthetic timeout tests).
export async function readTopupReversalEvidence(
  env,
  evidence,
  fetchImpl,
  timeoutMs = REVERSAL_BOUNDS.timeoutMs,
) {
  const e = { ...evidence },
    cap = REVERSAL_BOUNDS;
  if (
    typeof env?.STRIPE_SECRET_KEY !== "string" ||
    !env.STRIPE_SECRET_KEY ||
    typeof fetchImpl !== "function" ||
    e.status !== "paid_evidence" ||
    !identifier(e.paymentId, "pi") ||
    !identifier(e.chargeId, "ch") ||
    !identifier(e.checkoutId, "cs") ||
    e.currency !== "usd" ||
    typeof e.livemode !== "boolean" ||
    !Number.isSafeInteger(e.capturedAmount) ||
    e.capturedAmount < 300 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > cap.timeoutMs
  )
    return pending();
  const config = { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY },
    controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let stopped = false,
    bytes = 0,
    requests = 0,
    timer;
  const live = () => {
    if (stopped || performance.now() >= deadline) fail();
  };
  async function body(response) {
    const reader = response.body?.getReader();
    if (!reader) fail();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    let size = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        live();
        const chunk = await reader.read();
        live();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail();
        size += chunk.value.byteLength;
        bytes += chunk.value.byteLength;
        if (size > cap.bodyBytes || bytes > cap.totalBytes) fail();
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      cancel();
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  async function get(path) {
    live();
    if (++requests > cap.requests) fail();
    const value = await stripe(
      config,
      path,
      {},
      async (url, options) => {
        const response = await fetchImpl(url, {
          ...options,
          redirect: "manual",
          signal: controller.signal,
        });
        if (stopped) {
          void response.body?.cancel().catch(() => {});
          fail();
        }
        live();
        if (response.ok !== true) {
          void response.body?.cancel().catch(() => {});
          fail();
        }
        // Non-OK responses never reach billing's private-path/error logger; successful bodies are bounded.
        return { ok: true, text: () => body(response) };
      },
      null,
      "GET",
    );
    live();
    return value;
  }
  async function charge() {
    const c = await get("charges/" + encodeURIComponent(e.chargeId));
    if (
      c?.object !== "charge" ||
      c.id !== e.chargeId ||
      ref(c.payment_intent) !== e.paymentId ||
      c.currency !== e.currency ||
      c.livemode !== e.livemode ||
      c.status !== "succeeded" ||
      c.paid !== true ||
      c.captured !== true ||
      c.amount !== e.capturedAmount ||
      c.amount_captured !== e.capturedAmount ||
      !Number.isSafeInteger(c.amount_refunded) ||
      c.amount_refunded < 0 ||
      c.amount_refunded > e.capturedAmount ||
      typeof c.refunded !== "boolean" ||
      typeof c.disputed !== "boolean"
    )
      fail();
    if (c.refunded !== (c.amount_refunded === e.capturedAmount)) fail();
    return { refundedAmount: c.amount_refunded, refunded: c.refunded, disputed: c.disputed };
  }
  async function list(kind) {
    const records = [],
      seen = new Set();
    let cursor = "";
    for (let page = 0; page < cap.pages; page++) {
      const query = new URLSearchParams({ charge: e.chargeId, limit: String(cap.pageSize) });
      if (cursor) query.set("starting_after", cursor);
      const data = await get(kind + "?" + query);
      if (
        data?.object !== "list" ||
        data.url !== "/v1/" + kind ||
        typeof data.has_more !== "boolean" ||
        !Array.isArray(data.data) ||
        data.data.length > cap.pageSize ||
        (!data.data.length && (page > 0 || data.has_more))
      )
        fail();
      for (const item of data.data) {
        if (
          item?.object !== (kind === "refunds" ? "refund" : "dispute") ||
          !identifier(item.id, kind === "refunds" ? "re" : "du") ||
          seen.has(item.id) ||
          ref(item.charge) !== e.chargeId ||
          (item.payment_intent != null && ref(item.payment_intent) !== e.paymentId) ||
          item.currency !== e.currency ||
          (kind === "disputes" && item.livemode !== e.livemode) ||
          typeof item.status !== "string" ||
          item.status.length > 64 ||
          !Number.isSafeInteger(item.amount) ||
          item.amount <= 0 ||
          item.amount > e.capturedAmount
        )
          fail();
        seen.add(item.id);
        records.push({
          id: item.id,
          status: item.status,
          amount: item.amount,
          currency: item.currency,
        });
      }
      if (!data.has_more) return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      cursor = data.data.at(-1).id; // Local validated ID only; never follow a provider-supplied URL.
    }
    fail();
  }
  async function pass() {
    const snapshot = {
      paymentId: e.paymentId,
      checkoutId: e.checkoutId,
      capturedAmount: e.capturedAmount,
      currency: e.currency,
      refunds: await list("refunds"),
      disputes: await list("disputes"),
      refundsComplete: true,
      disputesComplete: true,
    };
    // Reuse exact policy statuses/normalization/bounds, but discard this provisional disposition.
    // A future transactional caller supplies the actual committed prior state and revision.
    if (decideTopup({ ...snapshot, previous: initial() }).disposition === "retry") fail();
    return snapshot;
  }
  async function run() {
    const before = await charge(),
      first = await pass(),
      second = await pass(),
      after = await charge();
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(first) !== JSON.stringify(second)
    )
      fail();
    let succeeded = 0,
      described = 0;
    for (const refund of second.refunds) {
      if (refund.status === "succeeded") succeeded += refund.amount;
      if (refund.status !== "failed" && refund.status !== "canceled")
        described += Math.min(e.capturedAmount - described, refund.amount);
    }
    // Only successful or in-flight refunds may explain the aggregate; failed/canceled cannot.
    // Do not assume whether pending/requires_action already contribute to Stripe's aggregate.
    if (
      succeeded > after.refundedAmount ||
      after.refundedAmount > described ||
      (after.disputed && second.disputes.length === 0)
    )
      fail();
    live();
    return { status: "reversal_evidence", chargeId: e.chargeId, livemode: e.livemode, ...second };
  }
  try {
    return await Promise.race([
      run().catch(pending),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          stopped = true;
          controller.abort();
          resolve(pending());
        }, timeoutMs);
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  }
}
