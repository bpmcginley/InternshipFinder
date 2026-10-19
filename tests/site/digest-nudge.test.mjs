import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CORE = readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8");
const APP = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
const memory = () => {
  const map = new Map();
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
};
function load(local = memory()) {
  const ctx = {
    CONFIG: {}, localStorage: local, sessionStorage: memory(),
    addEventListener() {}, postMessage() {}, setTimeout, clearTimeout, AbortController, URLSearchParams,
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash: "" },
    document: { documentElement: { dataset: {} } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  return { IS: ctx.IS, local, ctx };
}
const eligible = { enabled: true, manual: true };

test("a cached pre-invitation core leaves the optional prompt disabled without breaking rendering", () => {
  const start = APP.indexOf("    const digestPrompt = useRef(null);");
  const end = APP.indexOf("    const [digestNudge", start);
  assert.ok(start > -1 && end > start);
  const ref = { current: null };
  const ctx = { IS: {}, useRef: () => ref };
  vm.createContext(ctx);
  assert.doesNotThrow(() => vm.runInContext(APP.slice(start, end), ctx));
  assert.equal(ref.current.claim("interested", eligible), false);
  assert.doesNotThrow(() => ref.current.shown());
  assert.doesNotThrow(() => ref.current.finish("dismissed"));
});

test("contextual email invitation waits for a deliberate useful action and never consumes a blocked opportunity", () => {
  const { IS, local } = load();
  const prompt = IS.createDigestNudge();
  for (const action of ["render", "applied", "sync", "profile-import", "queued", undefined]) assert.equal(prompt.claim(action, eligible), false);
  assert.equal(prompt.claim("interested", { enabled: true }), false, "a background status update is not a manual action");
  assert.equal(prompt.claim("profile", { ...eligible, blocked: true }), false, "another prompt keeps priority");
  assert.equal(prompt.claim("profile", { manual: true }), false, "disabled email signup stays hidden");
  assert.equal(local.map.size, 0);
  assert.equal(prompt.claim("interested", eligible), true);
  assert.equal(local.getItem(IS.DIGEST_NUDGE_KEY), null, "not used up until it is actually on screen");
  assert.equal(IS.createDigestNudge().claim("interested", eligible), true, "a reload before it showed can still offer it");
  prompt.shown();
  assert.equal(local.getItem(IS.DIGEST_NUDGE_KEY), "shown");
  assert.equal(prompt.claim("profile", eligible), false);
  assert.equal(IS.createDigestNudge().claim("interested", eligible), false, "a reload cannot repeat the invitation");
  assert.deepEqual([...local.map.keys()], [IS.DIGEST_NUDGE_KEY], "no listing, profile or email is stored");
});

test("dismissal and opening persist without treating either as a subscription", () => {
  for (const how of ["dismissed", "opened"]) {
    const { IS, local } = load();
    const prompt = IS.createDigestNudge();
    assert.equal(prompt.claim("profile", eligible), true);
    prompt.shown();
    prompt.finish(how);
    assert.equal(local.getItem(IS.DIGEST_NUDGE_KEY), how);
    assert.equal(IS.createDigestNudge().claim("profile", eligible), false);
  }
});

test("blocked, full or non-persistent storage suppresses the invitation without breaking student actions", () => {
  for (const storage of [
    { getItem() { throw Error("SecurityError"); }, setItem() { throw Error("SecurityError"); } },
    { getItem() { return null; }, setItem() { throw Error("QuotaExceededError"); } },
    { getItem() { return null; }, setItem() {} },
  ]) {
    const { IS } = load();
    const prompt = IS.createDigestNudge(storage);
    assert.equal(prompt.claim("profile", eligible), false);
    assert.doesNotThrow(() => prompt.finish("dismissed"));
  }
});

test("a browser that denies access to localStorage itself can still create the controller", () => {
  const { IS, ctx } = load();
  Object.defineProperty(ctx, "localStorage", { get() { throw Error("SecurityError"); } });
  let prompt;
  assert.doesNotThrow(() => { prompt = IS.createDigestNudge(); });
  assert.equal(prompt.claim("interested", eligible), false);
  assert.doesNotThrow(() => prompt.finish("dismissed"));
});

test("deleting dashboard data removes the local email invitation preference", async () => {
  const { IS, local } = load();
  IS.createDigestNudge().claim("profile", eligible);
  await IS.deleteMyData(null);
  assert.equal(local.getItem(IS.DIGEST_NUDGE_KEY), null);
});

// Run the actual UI action adapter against a tiny tracker, rather than simulating a second
// copy of its policy. Queue updates retain setAppState; only the rendered row uses this wrapper.
test("the manual status adapter preserves tracking and only offers on a new Interested selection", () => {
  const start = APP.indexOf("    const offerDigestNudgeRef =");
  const end = APP.indexOf("    const upd =", start);
  assert.ok(start > -1 && end > start);
  const offers = [], updates = [], current = { a: "interested" };
  const ctx = {
    appStatesRef: { current }, offerDigestNudge: v => offers.push(v),
    setAppState: (id, v) => { updates.push([id, v]); current[id] = v; },
    useRef: v => ({ current: v }), useCallback: (fn, deps) => { ctx.deps = deps; return fn; },
  };
  vm.createContext(ctx);
  vm.runInContext(APP.slice(start, end) + "globalThis.change = setManualAppState;", ctx);
  ctx.change("a", "interested");
  ctx.change("b", "applied");
  ctx.change("c", "none");
  ctx.change("d", "interested");
  assert.deepEqual(offers, ["interested"]);
  assert.deepEqual(updates, [["a", "interested"], ["b", "applied"], ["c", "none"], ["d", "interested"]]);
  assert.match(APP, /onState: setManualAppState/);
  assert.deepEqual([...ctx.deps], [ctx.setAppState], "a stable handler, so memoized rows don't all redraw");
  assert.match(APP, /addedIds\.has\(String\(r\.id\)\).*setAppState\(r\.id, "interested"\)/);
  assert.match(APP, /j\.status === "submitted".*setAppState\(id, "applied"\)/);
});

test("first manual profile save gives an existing invite priority; later edits never ask", () => {
  const start = APP.indexOf("    function saveProfile(d) {");
  const end = APP.indexOf("    // Focus goes back", start);
  assert.ok(start > -1 && end > start);
  for (const [profile, invite, expected] of [[null, true, []], [null, false, ["profile"]], [{ majors: [] }, false, []]]) {
    const offers = [], saved = [], counted = [];
    const ctx = {
      p: profile, PAGE: 150, IS: { count: x => counted.push(x), saveProfile: d => { saved.push(d); return d; } },
      offerNudge: () => invite, offerDigestNudge: action => offers.push(action),
      setP() {}, setSetupOpen() {}, setLimit() {}, setF() {}, setNote() {}, setTimeout() {},
    };
    vm.createContext(ctx);
    vm.runInContext(APP.slice(start, end), ctx);
    const data = { majors: ["Nursing"], fields: ["nursing"] };
    ctx.saveProfile(data);
    assert.deepEqual(offers, expected);
    assert.deepEqual(saved, [data], "the profile still saves normally");
    assert.deepEqual(counted, profile ? [] : ["profile"]);
  }
});
