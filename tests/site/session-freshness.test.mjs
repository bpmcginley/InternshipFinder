import test from "node:test";
import assert from "node:assert/strict";
import { installCore } from "./core-fixture.mjs";
import { createAllowance, createLoadMe } from "../../docs/js/app/allowance.mjs";

const DAY = 864e5;
const A = "iss_synthetic_A",
  B = "iss_synthetic_B";
const store = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};
const payload = {
  plan: "free",
  tier: "edu",
  allowance: { autofill: { used: 2, limit: 10, purchased: 5 } },
};
const response = (status, data = payload) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => data,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const pending = [],
    timers = new Map();
  let timerId = 0,
    drops = 0,
    state = null;
  const browser = {
    CONFIG: { workerUrl: "https://worker.test", dataUrl: "./data/" },
    fetch: (url, options) => new Promise((resolve) => pending.push({ url, options, resolve })),
    localStorage: store(),
    sessionStorage: store(),
    addEventListener() {},
    postMessage() {},
    setTimeout: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash: "" },
    history: { replaceState() {} },
    document: { documentElement: { dataset: {} } },
    Date,
    TextDecoder,
    atob,
    URLSearchParams,
    AbortController,
    console,
  };
  const IS = installCore(browser),
    authRef = { current: {} },
    authGeneration = { current: 0 },
    meRequest = { current: 0 };
  const setToken = (token) => {
    const record = {
      token,
      account: "synthetic",
      email: "fixture@example.edu",
      expires: new Date(Date.now() + 30 * DAY).toISOString(),
    };
    browser.localStorage.setItem(IS.SESSION_KEY, JSON.stringify(record));
    authRef.current = { token, who: IS.authInfo(record) };
    authGeneration.current++;
  };
  setToken(A);
  const { bounded, runAllowance } = createAllowance(browser, { IS });
  const load = createLoadMe({
    authRef,
    authGeneration,
    meRequest,
    bounded,
    IS,
    runAllowance,
    setMeResult: (value) => (state = typeof value === "function" ? value(state) : value),
    dropToken: () => {
      drops++;
      IS.signOut();
    },
  });
  return {
    IS,
    browser,
    pending,
    timers,
    authRef,
    authGeneration,
    meRequest,
    load,
    setToken,
    get state() {
      return state;
    },
    get drops() {
      return drops;
    },
    stored: () => JSON.parse(browser.localStorage.getItem(IS.SESSION_KEY)),
    timeout: () => {
      const next = [...timers.values()].at(-1);
      assert(next);
      next();
    },
  };
}
test("real Core plus loader: delayed A 401 cannot reject a newly reused A session", async () => {
  const H = harness(),
    old = H.load();
  H.setToken(B);
  H.setToken(A);
  const fresh = H.load();
  H.pending[1].resolve(response(200));
  await fresh;
  const stored = H.stored();
  H.pending[0].resolve(response(401));
  assert.equal(await old, null);
  assert.deepEqual(H.stored(), stored);
  assert.equal(H.IS.authOk(H.authRef.current.who), true);
  assert.equal(H.IS.storedToken(), A);
  assert.equal(H.drops, 0);
  assert.equal(H.state.status, "ready");
});
test("real Core plus loader: delayed A success cannot refresh a newer A session", async () => {
  const H = harness(),
    old = H.load();
  H.setToken(B);
  H.setToken(A);
  const stored = H.stored();
  H.pending[0].resolve(response(200));
  assert.equal(await old, null);
  assert.deepEqual(H.stored(), stored);
  assert.equal(H.IS.authOk(H.authRef.current.who), true);
});
test("a superseded same-account 401 cannot forget current persisted auth", async () => {
  const H = harness(),
    old = H.load(),
    fresh = H.load();
  H.pending[1].resolve(response(200));
  await fresh;
  H.pending[0].resolve(response(401));
  await old;
  assert.equal(H.IS.storedToken(), A);
  assert.equal(H.IS.authOk(H.authRef.current.who), true);
  assert.equal(H.drops, 0);
});
for (const status of [200, 401])
  test(`timeout closes Core authority before a late ${status}`, async () => {
    const H = harness(),
      stored = H.stored(),
      read = H.load();
    H.timeout();
    assert.equal(await read, null);
    assert.equal(H.state.status, "error");
    H.pending[0].resolve(response(status));
    await tick();
    assert.deepEqual(H.stored(), stored);
    assert.equal(H.IS.authOk(H.authRef.current.who), true);
    assert.equal(H.drops, 0);
    const retry = H.load();
    H.pending[1].resolve(response(200));
    await retry;
    assert.equal(H.state.status, "ready");
    assert.equal(H.IS.storedToken(), A);
  });
test("effect cleanup invalidates Core side effects without requiring a different token", async () => {
  const H = harness(),
    read = H.load();
  H.meRequest.current++;
  H.pending[0].resolve(response(401));
  assert.equal(await read, null);
  assert.equal(H.IS.storedToken(), A);
  assert.equal(H.drops, 0);
});
test("a currently authoritative loader 401 still rejects and drops the session", async () => {
  const H = harness(),
    read = H.load();
  H.pending[0].resolve(response(401));
  assert.equal(await read, null);
  assert.equal(H.stored(), null);
  assert.equal(H.IS.authOk(H.authRef.current.who), false);
  assert.equal(H.drops, 1);
});
test("a currently authoritative success still slides session expiry", async () => {
  const H = harness(),
    before = Date.parse(H.stored().expires),
    read = H.load();
  H.pending[0].resolve(response(200));
  assert.deepEqual(await read, payload);
  assert(Date.parse(H.stored().expires) > before + 100 * DAY);
  assert.equal(H.state.status, "ready");
  assert.equal(H.pending[0].options.headers.Authorization, "Bearer " + A);
});
test("original one-argument fetchMe callers retain rejection and refresh behavior", async () => {
  const success = harness(),
    before = Date.parse(success.stored().expires),
    read = success.IS.fetchMe(A);
  success.pending[0].resolve(response(200));
  assert.deepEqual(await read, payload);
  assert(Date.parse(success.stored().expires) > before + 100 * DAY);
  const rejected = harness(),
    bad = rejected.IS.fetchMe(A);
  rejected.pending[0].resolve(response(401));
  assert.equal(await bad, null);
  assert.equal(rejected.IS.authOk(rejected.authRef.current.who), false);
  assert.equal(rejected.stored(), null);
});
test("closed authority performs no fetch and a late body cannot deliver obsolete data", async () => {
  const H = harness();
  assert.equal(await H.IS.fetchMe(A, () => false), null);
  assert.equal(H.pending.length, 0);
  let allowed = true,
    body;
  const read = H.IS.fetchMe(A, () => allowed);
  H.pending[0].resolve({
    status: 200,
    ok: true,
    json: () => new Promise((resolve) => (body = resolve)),
  });
  await tick();
  allowed = false;
  body(payload);
  assert.equal(await read, null);
});
