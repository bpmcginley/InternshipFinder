import test from "node:test";
import assert from "node:assert/strict";
import {
  createAllowance,
  createLoadMe,
  watchAllowanceReturns,
} from "../../docs/js/app/allowance.mjs";
import { createControls } from "../../docs/js/app/controls.mjs";

const h = (type, props, ...children) => ({
  type,
  props: props || {},
  children: children.flat().filter((v) => v != null && v !== false),
});
const text = (node) =>
  typeof node === "object" && node ? node.children.map(text).join(" ") : String(node ?? "");
const nodes = (node, predicate) =>
  typeof node !== "object" || !node
    ? []
    : [...(predicate(node) ? [node] : []), ...node.children.flatMap((v) => nodes(v, predicate))];
const { runAllowance, AllowancePanel } = createAllowance({}, { IS: {}, h, F: "fragment" });
const account = (values = {}, extra = {}) => ({
  plan: "free",
  tier: "edu",
  allowance: { autofill: { used: 12, limit: 40, bonus: 3, purchased: 25, ...values } },
  ...extra,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function panel(me, status = "ready") {
  return AllowancePanel({
    signedIn: true,
    me,
    status,
    cfgStatus: "ready",
    allowance: runAllowance(me),
    resetDay: "December 1",
    plans: [],
  });
}
test("purchased count is separate from the unchanged finite/unlimited remainder", () => {
  assert.equal(runAllowance(account()).left, 28);
  assert.equal(runAllowance(account({ limit: 15 })).left, 3);
  assert.equal(runAllowance(account({ limit: null })).left, null);
  assert.equal(runAllowance(account({ limit: null })).purchased, 25);
  assert.equal(runAllowance(account({}, { paused: true })).purchased, 25);
  assert.equal(runAllowance(account({ limit: 0 })).disabled, true);
  const content = text(panel(account()));
  assert.match(content, /28 runs left/);
  assert.match(content, /3 extra runs from invites/);
  assert.match(content, /Purchased Auto-Apply runs remaining: 25/);
  assert.match(content, /Service limits and temporary pauses still apply/);
  assert.doesNotMatch(content, /53 runs|payment (confirmed|successful)/i);
});
test("only an optional positive safe integer is displayed; legacy replies remain valid", () => {
  for (const purchased of [
    undefined,
    null,
    0,
    -1,
    1.5,
    "25",
    true,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    {},
  ]) {
    const me = account({ purchased });
    assert.equal(runAllowance(me).purchased, 0);
    assert.equal(runAllowance(me).left, 28);
    assert.doesNotMatch(text(panel(me)), /Purchased Auto-Apply/);
  }
});
test("purchased balance is not advertised from loading/error state", () => {
  for (const status of ["loading", "error"])
    assert.doesNotMatch(text(panel(account(), status)), /Purchased Auto-Apply/);
});
test("Account puts purchased runs outside the monthly reset section", () => {
  const { AccountMenu } = createControls(
    { document: {} },
    {
      h,
      cx: (...v) => v.filter(Boolean).join(" "),
      useState: () => [true, () => {}],
      useRef: () => ({}),
      useEffect() {},
    },
  );
  const tree = AccountMenu({
    allowLines: [
      "Auto-Apply: 28 of 40 left",
      "Includes 3 extra runs from invites. They don't expire.",
    ],
    resetDay: "December 1",
    items: [],
    purchased: 25,
  });
  const sections = nodes(tree, (n) => n.props.className === "acct-sec");
  const monthly = sections.find((n) => text(n).includes("Monthly allowance resets"));
  const purchased = sections.find((n) => text(n).includes("Purchased Auto-Apply runs"));
  assert.notEqual(monthly, purchased);
  assert.doesNotMatch(text(monthly), /Purchased/);
  assert.doesNotMatch(text(purchased), /Resets|This month|from invites/);
  assert.equal(purchased.props["aria-live"], "polite");
});
function loader() {
  const authRef = { current: { token: "iss_a", who: {} } },
    authGeneration = { current: 0 },
    meRequest = { current: 0 },
    pending = [];
  let state = null,
    drops = 0;
  const load = createLoadMe({
    authRef,
    authGeneration,
    meRequest,
    runAllowance,
    bounded: (p) => p,
    dropToken: () => drops++,
    setMeResult: (v) => (state = typeof v === "function" ? v(state) : v),
    IS: { fetchMe: () => new Promise((resolve) => pending.push(resolve)), authOk: () => true },
  });
  return {
    authRef,
    authGeneration,
    pending,
    load,
    get state() {
      return state;
    },
    get drops() {
      return drops;
    },
  };
}
test("fresh absence after hold/revocation replaces the old count; failure clears it", async () => {
  const L = loader();
  let read = L.load();
  L.pending.shift()(account());
  await read;
  assert.equal(L.state.data.allowance.autofill.purchased, 25);
  read = L.load();
  assert.equal(L.state.status, "loading");
  L.pending.shift()(account({ purchased: undefined, limit: 15 }));
  await read;
  assert.equal(runAllowance(L.state.data).purchased, 0);
  assert.equal(runAllowance(L.state.data).left, 3);
  read = L.load();
  L.pending.shift()(null);
  await read;
  assert.equal(L.state.status, "error");
  assert.equal(L.state.data, null);
});
test("same-token auth-generation changes and stale errors cannot restore a prior balance", async () => {
  const L = loader(),
    old = L.load();
  L.authRef.current = { token: "iss_b" };
  L.authGeneration.current++;
  L.authRef.current = { token: "iss_a" };
  L.authGeneration.current++;
  L.pending.shift()(account());
  assert.equal(await old, null);
  const fresh = L.load();
  assert.equal(L.state.data, null);
  L.pending.shift()(account({ purchased: 7 }));
  await fresh;
  assert.equal(L.state.generation, 2);
  assert.equal(runAllowance(L.state.data).purchased, 7);
  const stale = L.load(),
    newer = L.load();
  L.pending[1](account({ purchased: 6 }));
  await newer;
  L.pending[0](null);
  await stale;
  assert.equal(L.state.status, "ready");
  assert.equal(runAllowance(L.state.data).purchased, 6);
});
function lifecycle(load, initialVisibility = "visible") {
  const events = new Map(),
    docEvents = new Map();
  const browser = {
    document: {
      visibilityState: initialVisibility,
      addEventListener: (k, f) => docEvents.set(k, f),
      removeEventListener: (k) => docEvents.delete(k),
    },
    addEventListener: (k, f) => events.set(k, f),
    removeEventListener: (k) => events.delete(k),
  };
  const stop = watchAllowanceReturns(browser, load);
  return {
    stop,
    event: (k, v = {}) => events.get(k)?.(v),
    visibility: (v) => {
      browser.document.visibilityState = v;
      docEvents.get("visibilitychange")?.();
    },
    events,
    docEvents,
  };
}
test("ordinary short return and BFCache each read once; duplicate visible/pageshow events coalesce", async () => {
  let calls = 0;
  const L = lifecycle(async () => calls++);
  await tick();
  assert.equal(calls, 1);
  L.visibility("visible");
  L.event("pageshow", { persisted: false });
  await tick();
  assert.equal(calls, 1);
  L.visibility("hidden");
  L.visibility("visible");
  await tick();
  assert.equal(calls, 2);
  L.event("pagehide");
  L.visibility("hidden");
  L.event("pageshow", { persisted: true });
  L.visibility("visible");
  await tick();
  assert.equal(calls, 3);
  L.event("pagehide");
  L.visibility("hidden");
  L.visibility("visible");
  L.event("pageshow", { persisted: true });
  await tick();
  assert.equal(calls, 4);
  L.stop();
  assert.equal(L.events.size, 0);
  assert.equal(L.docEvents.size, 0);
});
test("in-flight returns coalesce into one trailing fresh read and cleanup prevents it", async () => {
  const pending = [];
  const L = lifecycle(() => new Promise((resolve) => pending.push(resolve)));
  for (let i = 0; i < 3; i++) {
    L.visibility("hidden");
    L.visibility("visible");
  }
  assert.equal(pending.length, 1);
  pending[0]();
  await tick();
  assert.equal(pending.length, 2);
  L.visibility("hidden");
  L.visibility("visible");
  L.stop();
  pending[1]();
  await tick();
  assert.equal(pending.length, 2);
});
test("a failed read does not disable later ordinary return reads", async () => {
  let calls = 0;
  const L = lifecycle(async () => {
    if (++calls === 1) throw Error("synthetic");
  });
  await tick();
  L.visibility("hidden");
  L.visibility("visible");
  await tick();
  assert.equal(calls, 2);
  L.stop();
});

test("a page initially loaded hidden gets a fresh read when first visible", async () => {
  let calls = 0;
  const L = lifecycle(async () => calls++, "hidden");
  await tick();
  assert.equal(calls, 1);
  L.visibility("visible");
  await tick();
  assert.equal(calls, 2);
  L.stop();
});

test("Account monthly reset never labels purchased units as resetting in either creation mode", () => {
  const { AccountMenu } = createControls(
    { document: {} },
    {
      h,
      cx: (...v) => v.filter(Boolean).join(" "),
      useState: () => [true, () => {}],
      useRef: () => ({}),
      useEffect() {},
    },
  );
  for (const limit of [40, 15]) {
    const me = account({ limit });
    const allowance = runAllowance(me);
    const tree = AccountMenu({
      allowLines: [`Auto-Apply: ${allowance.left} of ${limit} left`],
      resetDay: "December 1",
      items: [],
      purchased: allowance.purchased,
    });
    const content = text(tree);
    assert.match(content, new RegExp(`Auto-Apply: ${limit - 12} of ${limit} left`));
    assert.match(content, /Monthly allowance resets December 1/);
    assert.doesNotMatch(content, /This month|Resets December 1/);
    assert.match(content, /25 remaining. Purchased runs do not expire/);
  }
  const loading = AccountMenu({
    allowLines: ["Auto-Apply: 28 of 40 left"],
    resetDay: "December 1",
    items: [],
    purchased: 0,
    hasPurchased: true,
  });
  assert.match(text(loading), /Monthly allowance resets/);
  assert.doesNotMatch(text(loading), /Purchased Auto-Apply runs/);
  const legacy = AccountMenu({
    allowLines: ["Auto-Apply: 3 of 15 left"],
    resetDay: "December 1",
    items: [],
  });
  assert.match(text(legacy), /This month/);
  assert.match(text(legacy), /Resets December 1/);
});
