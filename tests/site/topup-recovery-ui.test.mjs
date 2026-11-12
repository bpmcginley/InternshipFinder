import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { installCore } from "./core-fixture.mjs";
import {
  createRecoveryActions,
  recoveryEligible,
  RECOVERY_UNAVAILABLE,
  PENDING_TOPUP_DELETION,
} from "../../docs/js/app/allowance.mjs";

const base = "https://worker.test",
  stripe = "https://checkout.stripe.com/c/pay/cs_test_synthetic";
function reply(url, data, status = 200, headers = {}) {
  const response = new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
function harness(fetch, deadlineMs = 1000) {
  let now = 0,
    refreshed = 0;
  const context = { eligible: true, token: "iss_synthetic", generation: 0, workerUrl: base };
  const calls = [],
    states = [],
    visits = [],
    lock = { current: null };
  const browser = {
    setTimeout,
    clearTimeout,
    performance: { now: () => now },
    location: { assign: (url) => visits.push(url) },
    fetch: (url, options) => {
      calls.push({ url, options });
      return fetch
        ? fetch(url, options)
        : Promise.resolve(reply(url, { status: "open", url: stripe }));
    },
  };
  const actions = createRecoveryActions(browser, {
    context: () => context,
    update: (state) => states.push(state),
    lock,
    refresh: () => {
      refreshed++;
    },
    deadlineMs,
  });
  return {
    context,
    calls,
    states,
    visits,
    lock,
    actions,
    refreshed: () => refreshed,
    tick: (n) => {
      now += n;
    },
  };
}
test("only a current exact recovery flag and session exposes recovery, independently of sales", () => {
  assert.equal(
    recoveryEligible({ can_recover_topup: true, paused: true }, "ready", "iss_synthetic"),
    true,
  );
  for (const value of [undefined, null, false, "true", 1, {}, []])
    assert.equal(recoveryEligible({ can_recover_topup: value }, "ready", "iss_synthetic"), false);
  for (const status of ["loading", "error", "idle"])
    assert.equal(recoveryEligible({ can_recover_topup: true }, status, "iss_synthetic"), false);
  assert.equal(recoveryEligible({ can_recover_topup: true }, "ready", "id_token"), false);
});
test("recovery is explicit, bodyless, single flight and never creates a checkout", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  await Promise.all([h.actions.recover(), h.actions.recover()]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, base + "/billing/topup/recover");
  const options = h.calls[0].options;
  assert.equal(options.method, "POST");
  assert.equal(options.body, undefined);
  assert.deepEqual(options.headers, { Authorization: "Bearer iss_synthetic" });
  assert.equal(options.cache, "no-store");
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(options.referrerPolicy, "no-referrer");
  assert.deepEqual(h.visits, [stripe]);
  assert.equal(h.refreshed(), 0);
  assert.equal(h.lock.current, null);
});
test("all terminal outcomes read the fresh balance once and never claim payment success", async () => {
  for (const status of ["settled", "expired", "inactive"]) {
    const h = harness((url) => reply(url, { status }));
    await h.actions.recover();
    assert.equal(h.refreshed(), 1);
    assert.deepEqual(h.visits, []);
    assert.equal(h.states.at(-1).status, "terminal");
    assert.doesNotMatch(h.states.at(-1).message, /payment (successful|confirmed)|runs added/i);
  }
});
test("pending, auth, rate limit and disabled responses stay retryable without a balance or checkout side effect", async () => {
  for (const [code, status, text] of [
    [202, "pending", /still being checked/],
    [401, "auth", /Sign in again/],
    [429, "limited", /Wait a minute/],
    [503, "disabled", /unavailable/],
  ]) {
    const h = harness((url) => reply(url, { status }, code));
    await h.actions.recover();
    await h.actions.recover();
    assert.equal(h.calls.length, 2);
    assert.match(h.states.at(-1).message, text);
    assert.equal(h.refreshed(), 0);
    assert.deepEqual(h.visits, []);
    assert.equal(h.lock.current, null);
  }
});
test("malformed, oversized, non-no-store and unexpected recovery responses fail closed", async () => {
  for (const response of [
    (url) => reply(url, { status: "open", url: "https://evil.test" }),
    (url) => reply(url, { status: "open", url: stripe.replace("https:", "http:") }),
    (url) => reply(url, { status: "settled" }, 202),
    (url) => reply(url, { status: "paid" }),
    (url) => reply(url, "{"),
    (url) => reply(url, " ".repeat(16385)),
    (url) => reply(url, { status: "open", url: stripe }, 200, { "cache-control": "private" }),
    (url) => reply(url + "?redirect", { status: "open", url: stripe }),
  ]) {
    const h = harness(response);
    await h.actions.recover();
    assert.equal(h.states.at(-1).message, RECOVERY_UNAVAILABLE);
    assert.deepEqual(h.visits, []);
    assert.equal(h.refreshed(), 0);
  }
});
test("eligibility and legacy/purchase locks prevent recovery and its ticket blocks other checkout actions", async () => {
  const h = harness();
  h.context.eligible = false;
  await h.actions.recover();
  h.context.eligible = true;
  for (const kind of ["billing", "topup"]) {
    h.lock.current = { kind };
    await h.actions.recover();
  }
  assert.equal(h.calls.length, 0);
  let release;
  const pending = harness(
    (url) =>
      new Promise((resolve) => {
        release = () => resolve(reply(url, { status: "pending" }, 202));
      }),
  );
  const task = pending.actions.recover();
  assert.equal(pending.lock.current.kind, "topup");
  release();
  await task;
  assert.equal(pending.lock.current, null);
});
test("A-B-A auth generation and explicit cancellation reject late open or terminal responses", async () => {
  for (const outcome of [{ status: "open", url: stripe }, { status: "settled" }])
    for (const cancel of [false, true]) {
      let release;
      const h = harness(
        (url) =>
          new Promise((resolve) => {
            release = () => resolve(reply(url, outcome));
          }),
      );
      const task = h.actions.recover();
      if (cancel) h.actions.cancel();
      else h.context.generation += 2;
      release();
      await task;
      assert.deepEqual(h.visits, []);
      assert.equal(h.refreshed(), 0);
      assert.equal(h.states.length, 1);
      assert.equal(h.lock.current, null);
    }
});
test("absolute deadline rejects late fetch even when timer has not fired", async () => {
  const h = harness((url) => {
    h.tick(1001);
    return reply(url, { status: "open", url: stripe });
  });
  await h.actions.recover();
  assert.deepEqual(h.visits, []);
  assert.equal(h.states.at(-1).message, RECOVERY_UNAVAILABLE);
});
test("stalled body times out, releases lock and allows an explicit retry", async () => {
  let first = true;
  const h = harness((url) => {
    if (!first) return reply(url, { status: "inactive" });
    first = false;
    const response = new Response(new ReadableStream({ start() {} }), {
      headers: { "cache-control": "no-store" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }, 10);
  await h.actions.recover();
  assert.equal(h.lock.current, null);
  assert.equal(h.states.at(-1).message, RECOVERY_UNAVAILABLE);
  await h.actions.recover();
  assert.equal(h.refreshed(), 1);
});

const store = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    m,
  };
};
function core(response) {
  const browser = {
    CONFIG: { workerUrl: base, dataUrl: "./data/" },
    fetch: async () => response,
    localStorage: store(),
    sessionStorage: store(),
    addEventListener() {},
    postMessage() {},
    setTimeout,
    clearTimeout,
    Date,
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash: "" },
    history: { replaceState() {} },
    document: { documentElement: { dataset: {} } },
    TextDecoder,
    atob,
    URLSearchParams,
    AbortController,
    console,
  };
  const IS = installCore(browser);
  for (const key of [IS.SESSION_KEY, IS.PROFILE_KEY, "internscout.appstate.v1"])
    browser.localStorage.setItem(key, "synthetic");
  browser.sessionStorage.setItem("internscout.idtoken", "synthetic");
  return { browser, IS };
}
test("real Core preserves every local value on all 409s and classifies only the exact bounded error", async () => {
  for (const data of [
    { error: "topup_payment_pending" },
    { error: "subscription_active" },
    { error: "other", message: "topup_payment_pending" },
    "{",
    " ".repeat(4097),
  ]) {
    const h = core(reply(base + "/me", data, 409));
    const before = [...h.browser.localStorage.m],
      session = [...h.browser.sessionStorage.m];
    const result = await h.IS.deleteMyData("iss_synthetic");
    assert.deepEqual(result, {
      server: false,
      blocked: true,
      ...(data?.error === "topup_payment_pending" ? { reason: "topup_payment_pending" } : {}),
    });
    assert.deepEqual([...h.browser.localStorage.m], before);
    assert.deepEqual([...h.browser.sessionStorage.m], session);
  }
});
test("dashboard deletion refusal uses top-up guidance only for its reason and exits before clearing local state", async () => {
  const source = readFileSync(new URL("../../docs/js/app/dashboard.mjs", import.meta.url), "utf8"),
    start = source.indexOf("async function deleteData() {");
  const end = source.indexOf("setDigestNudge(false)", start);
  const refusal = source.slice(start, end) + "throw Error('unexpected deletion'); }";
  for (const reason of [undefined, "subscription_active", "topup_payment_pending"]) {
    let note;
    const fn = runInNewContext(`(${refusal})`, {
      browser: { confirm: () => true },
      auth: { token: "iss_synthetic", source: "page" },
      IS: { deleteMyData: async () => ({ blocked: true, reason }) },
      setNote: (value) => {
        note = value;
      },
      PENDING_TOPUP_DELETION,
    });
    await fn();
    assert.equal(
      note,
      reason === "topup_payment_pending"
        ? PENDING_TOPUP_DELETION
        : "Cancel your Supporter plan first (Manage plan), then delete. Nothing was deleted.",
    );
  }
});

test("an invalid initial recovery clock cannot issue a request", async () => {
  const h = harness();
  h.tick(NaN);
  await h.actions.recover();
  assert.equal(h.calls.length, 0);
  assert.equal(h.states.at(-1).message, RECOVERY_UNAVAILABLE);
});
