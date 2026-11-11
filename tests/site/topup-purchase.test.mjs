import test from "node:test";
import assert from "node:assert/strict";
import {
  createTopupActions,
  topupEligible,
  topupCheckoutUrl,
} from "../../docs/js/app/allowance.mjs";
const base = "https://worker.test";
const offer = { enabled: true, offer: { amount: 300, currency: "usd", units: 25 } };
const checkout = {
  status: "open",
  url: "https://checkout.stripe.com/c/pay/cs_test_synthetic#fixture",
};
function reply(url, value, opts = {}) {
  const r = new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status: opts.status || 200,
    headers: { "cache-control": "no-store", ...opts.headers },
  });
  Object.defineProperty(r, "url", { value: url });
  return r;
}
function harness({ fetch, deadlineMs = 1000 } = {}) {
  let now = 0;
  const ctx = { eligible: true, token: "iss_synthetic_A", generation: 0, workerUrl: base };
  const states = [],
    calls = [],
    visits = [],
    lock = { current: null };
  const browser = {
    setTimeout,
    clearTimeout,
    performance: { now: () => now },
    location: { assign: (u) => visits.push(u) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetch ? fetch(url, options) : reply(url, url.endsWith("/offer") ? offer : checkout);
    },
  };
  const actions = createTopupActions(browser, {
    context: () => ctx,
    update: (s) => states.push(s),
    lock,
    deadlineMs,
  });
  return {
    actions,
    ctx,
    states,
    calls,
    visits,
    lock,
    tick: (n) => {
      now += n;
    },
  };
}
test("capability is only an exhausted current-session panel hint", () => {
  const c = {
    open: true,
    auth: { token: "iss_synthetic", cfg: { topups: true } },
    cfgStatus: "ready",
    meStatus: "ready",
    allowance: { exhausted: true },
  };
  assert.equal(topupEligible(c), true);
  for (const patch of [
    { open: false },
    { cfgStatus: "error" },
    { meStatus: "loading" },
    { auth: { token: "id-token", cfg: { topups: true } } },
    { auth: { token: "iss_a", cfg: {} } },
    { allowance: { exhausted: false } },
    { allowance: { exhausted: true, disabled: true } },
    { allowance: { exhausted: true, unlimited: true } },
  ])
    assert.equal(topupEligible({ ...c, ...patch }), false);
});
test("verified offer then one bodyless POST, strict native request privacy and URL", async () => {
  const h = harness();
  await h.actions.load();
  assert.deepEqual(h.states.at(-1), { status: "ready", verified: true });
  await Promise.all([h.actions.buy(), h.actions.buy()]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.visits, [checkout.url]);
  assert.deepEqual(
    h.calls.map((x) => x.options.method),
    ["GET", "POST"],
  );
  for (const { options } of h.calls) {
    assert.deepEqual(options.headers, { Authorization: "Bearer iss_synthetic_A" });
    assert.equal(options.body, undefined);
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.referrerPolicy, "no-referrer");
  }
  await h.actions.buy();
  assert.equal(h.calls.length, 2);
});
test("missing eligibility performs zero requests and shared checkout lock blocks purchase", async () => {
  const h = harness();
  h.ctx.eligible = false;
  await h.actions.load();
  await h.actions.buy();
  assert.equal(h.calls.length, 0);
  h.ctx.eligible = true;
  await h.actions.load();
  h.lock.current = {};
  await h.actions.buy();
  assert.equal(h.calls.length, 1);
});
test("offer values, no-store, redirects and streamed bounds fail closed", async () => {
  for (const bad of [
    { ...offer, enabled: false },
    { enabled: true, offer: { ...offer.offer, amount: 301 } },
    { enabled: true, offer: { ...offer.offer, currency: "USD" } },
    { enabled: true, offer: { ...offer.offer, units: 26 } },
    "x".repeat(16385),
    "not json",
  ]) {
    const h = harness({ fetch: async (url) => reply(url, bad) });
    await h.actions.load();
    assert.equal(h.states.at(-1).status, "error");
    await h.actions.buy();
    assert.equal(h.calls.length, 1);
  }
  for (const opts of [
    { status: 202 },
    { headers: { "cache-control": "max-age=0" } },
    { headers: { "content-length": "17000" } },
  ]) {
    const h = harness({ fetch: async (url) => reply(url, offer, opts) });
    await h.actions.load();
    assert.equal(h.states.at(-1).status, "error");
  }
  const h = harness({ fetch: async () => reply("https://elsewhere.test/offer", offer) });
  await h.actions.load();
  assert.equal(h.states.at(-1).status, "error");
});
test("Stripe URL only allows the existing HTTPS checkout shape without userinfo", () => {
  assert.equal(topupCheckoutUrl(checkout.url), checkout.url);
  for (const u of [
    "https://checkout.stripe.com.evil/c/pay/cs_a",
    "http://checkout.stripe.com/c/pay/cs_a",
    "https://checkout.stripe.com:8443/c/pay/cs_a",
    "https://@checkout.stripe.com/c/pay/cs_a",
    "https://x@checkout.stripe.com/c/pay/cs_a",
    "https://checkout.stripe.com/pay/cs_a",
    "https://checkout.stripe.com/c/pay/cs_a\n",
    "https://checkout.stripe.com\\@evil/c/pay/cs_a",
  ])
    assert.equal(topupCheckoutUrl(u), null, u);
});
test("checkout 202, error and unverified URLs never imply payment or navigate; retry re-verifies", async () => {
  for (const result of [
    { status: "pending" },
    { status: "open", url: "https://evil.test/" },
    { status: "paid", url: checkout.url },
  ]) {
    const h = harness({
      fetch: async (url) => reply(url, url.endsWith("/offer") ? offer : result),
    });
    await h.actions.load();
    await h.actions.buy();
    assert.equal(h.states.at(-1).status, "error");
    assert.deepEqual(h.visits, []);
    await h.actions.buy();
    assert.equal(h.calls.length, 2);
    await h.actions.load();
    assert.equal(h.calls.length, 3);
  }
});
test("late offer and checkout results are fenced after auth A-B-A or panel dismissal", async () => {
  for (const action of ["offer", "checkout"])
    for (const change of ["auth", "close"]) {
      let resolve;
      const h = harness({
        fetch: (url) =>
          url.endsWith("/" + action)
            ? new Promise((r) => {
                resolve = () => r(reply(url, action === "offer" ? offer : checkout));
              })
            : Promise.resolve(reply(url, offer)),
      });
      if (action === "checkout") await h.actions.load();
      const pending = action === "offer" ? h.actions.load() : h.actions.buy();
      if (change === "auth") h.ctx.generation += 2;
      else {
        h.ctx.eligible = false;
        h.actions.cancel();
      }
      resolve();
      await pending;
      assert.deepEqual(h.visits, []);
      assert.notEqual(h.states.at(-1).status, "ready");
    }
});
test("absolute deadline survives delayed timers and no second request occurs", async () => {
  let h;
  h = harness({
    fetch: async (url) => {
      h.tick(1001);
      return reply(url, offer);
    },
  });
  await h.actions.load();
  assert.equal(h.states.at(-1).status, "error");
  await h.actions.buy();
  assert.equal(h.calls.length, 1);
});
test("stalled fetch and stalled body time out and retry releases the action latch", async () => {
  for (const body of [false, true]) {
    let count = 0;
    const h = harness({
      deadlineMs: 15,
      fetch: async (url) => {
        if (count++) return reply(url, offer);
        if (!body) return new Promise(() => {});
        const r = new Response(new ReadableStream({ start() {} }), {
          headers: { "cache-control": "no-store" },
        });
        Object.defineProperty(r, "url", { value: url });
        return r;
      },
    });
    await h.actions.load();
    assert.equal(h.states.at(-1).status, "error");
    await h.actions.load();
    assert.equal(h.states.at(-1).status, "ready");
  }
});

test("top-up interest counts only accepted clicks through the existing once-per-page counter", async () => {
  const { createAllowance } = await import("../../docs/js/app/allowance.mjs");
  const events = [],
    seen = new Set();
  const { countArrivalOnce } = createAllowance({}, { IS: { count: (e) => events.push(e) } });
  let checkoutCount = 0;
  const ctx = { eligible: true, token: "iss_synthetic", generation: 1, workerUrl: base };
  const browser = {
    setTimeout,
    clearTimeout,
    performance,
    location: { assign() {} },
    fetch: async (url) => {
      if (url.endsWith("/checkout")) checkoutCount++;
      return reply(url, url.endsWith("/offer") ? offer : { status: "pending" });
    },
  };
  const lock = { current: null };
  const a = createTopupActions(browser, {
    context: () => ctx,
    update() {},
    lock,
    onPurchase: () => countArrivalOnce(seen, "out_of_runs_topup"),
  });
  await a.buy();
  await a.load();
  assert.deepEqual(events, []);
  lock.current = {};
  await a.buy();
  assert.deepEqual(events, []);
  lock.current = null;
  await Promise.all([a.buy(), a.buy()]);
  assert.deepEqual(events, ["out_of_runs_topup"]);
  assert.equal(checkoutCount, 1);
  await a.load();
  assert.deepEqual(events, ["out_of_runs_topup"]);
  await a.buy();
  assert.equal(checkoutCount, 2);
  assert.deepEqual(events, ["out_of_runs_topup"]);
});

test("stalled checkout clears the shared lock, never navigates late, and requires a fresh offer", async () => {
  let release;
  const h = harness({
    deadlineMs: 15,
    fetch: async (url) =>
      url.endsWith("/offer")
        ? reply(url, offer)
        : new Promise((resolve) => {
            release = () => resolve(reply(url, checkout));
          }),
  });
  await h.actions.load();
  await h.actions.buy();
  assert.equal(h.states.at(-1).status, "error");
  assert.equal(h.lock.current, null);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.visits, []);
  await h.actions.buy();
  assert.equal(h.calls.length, 2);
  await h.actions.load();
  assert.equal(h.states.at(-1).status, "ready");
});
