import { billingAction, copyInviteAction, createAskExtension, createLoadMe, openInviteAction } from "../../docs/js/app/allowance.mjs";
import { createTestApp } from "./app-fixture.mjs";
import { installCore } from "./core-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";

function harness() {
  const storage = new Map();
  const React = {
    Fragment: "fragment",
    memo: (f) => f,
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat().filter((x) => x != null && x !== false),
    }),
    useMemo: (f) => f(),
    useRef: (current) => ({ current }),
    useEffect() {},
  };
  const ctx = {
    React,
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    CONFIG: {},
    location: {
      search: "",
      href: "https://site.test/?upgrade=pro&q=biology&campaign=fixture#listings",
    },
    history: {
      state: { keep: true },
      replaceState(state, unused, path) {
        this.changed = { state, path };
      },
    },
    addEventListener() {},
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    document: { documentElement: { dataset: {} } },
  };
  ctx.window = ctx;
  installCore(ctx);
  const components = createTestApp(ctx);
  return { ...components, IS: ctx.IS, storage, ctx };
}

const plain = (x) => JSON.parse(JSON.stringify(x));
const nodes = (n, predicate) =>
  !n || typeof n !== "object"
    ? []
    : [...(predicate(n) ? [n] : []), ...n.children.flatMap((c) => nodes(c, predicate))];
const text = (n) =>
  typeof n === "string" || typeof n === "number"
    ? String(n)
    : n && typeof n === "object"
      ? n.children.map(text).join("")
      : "";
const cfg = {
  payments: {
    enabled: true,
    plans: [{ plan: "pro", label: "Pro", price: "fixture price", multiplier: 2 }],
  },
};
const account = (a, extra = {}) => ({ allowance: { autofill: a }, ...extra });
test("upgrade arrival must name an actually configured plan; generic marker requires exactly 1", () => {
  const H = harness();
  for (const search of [
    "?upgrade=supporter",
    "?upgrade=unknown",
    "?out_of_runs=true",
    "?out_of_runs=01",
  ])
    assert.deepEqual(plain(H.allowanceArrival(search, cfg)), { plan: "", generic: false });
  assert.deepEqual(plain(H.allowanceArrival("?upgrade=pro&out_of_runs=1", cfg)), {
    plan: "pro",
    generic: true,
  });
  assert.equal(
    H.allowanceArrival("?upgrade=pro", { payments: { ...cfg.payments, enabled: false } }).plan,
    "",
  );
  assert.equal(H.allowanceArrival("?upgrade=pro", null).plan, "");
});
test("consuming arrival removes only named keys and preserves history, filters and hash", () => {
  const H = harness();
  H.clearArrivalKeys(["upgrade"]);
  assert.deepEqual(plain(H.ctx.history.changed), {
    state: { keep: true },
    path: "/?q=biology&campaign=fixture#listings",
  });
});
test("sign-in return flag contains only intent and expiry, is one-use and expires", () => {
  const H = harness(),
    data = new Map(),
    storage = {
      getItem: (k) => data.get(k) || null,
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    };
  H.arrivalFlag("save", storage, 1000);
  const value = JSON.parse([...data.values()][0]);
  assert.deepEqual(value, { show: true, expiresAt: 601000 });
  assert.equal(H.arrivalFlag("take", storage, 2000), true);
  assert.equal(data.size, 0);
  assert.equal(H.arrivalFlag("take", storage, 2000), false);
  H.arrivalFlag("save", storage, 1000);
  assert.equal(H.arrivalFlag("take", storage, 601000), false);
  H.arrivalFlag("save", storage, 1000);
  H.arrivalFlag("clear", storage, 1001);
  assert.equal(data.size, 0);
  Object.defineProperty(H.ctx, "sessionStorage", {
    get() {
      throw Error("blocked");
    },
  });
  assert.equal(H.arrivalFlag("take"), false);
  assert.equal(H.arrivalFlag("save"), false);
  storage.setItem("internscout.allowance.return.v1", "bad json");
  assert.equal(H.arrivalFlag("take", storage, 2000), false);
  assert.equal(data.size, 0);
});
test("allowance keeps bonus-aware remaining separate from monthly usage and handles null first", () => {
  const H = harness();
  const value = H.runAllowance(account({ used: 27, limit: 30, bonus: 3 }));
  assert.equal(value.left, 3);
  assert.equal(value.summary, "27 Auto-Apply runs used this month; 3 runs left in your allowance.");
  assert.equal(value.bonus, 3);
  const unlimited = H.runAllowance(account({ used: 27, limit: null }));
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.exhausted, false);
  assert.equal(unlimited.left, null);
  assert.equal(H.runAllowance(account({ used: 0, limit: 0 })).disabled, true);
  assert.equal(H.runAllowance(account({ used: 5, limit: 5 })).exhausted, true);
  assert.equal(H.runAllowance(account({ used: 5, limit: 5 }, { paused: true })).exhausted, false);
  for (const a of [{ used: 1 }, { used: -1, limit: 5 }, { used: 1, limit: "5" }])
    assert.equal(H.runAllowance(account(a)), null);
});
test("invite eligibility distinguishes the inviter cap and exposes a real copy action", () => {
  const H = harness(),
    invite = {
      link: "https://site.test/?ref=abcdefgh",
      rewarded: 2,
      max: 2,
      bonus: { autofill: 3 },
    },
    copies = [];
  assert.equal(H.validInvite(invite), true);
  assert.equal(H.validInvite({ ...invite, link: "javascript:alert(1)" }), false);
  const tree = H.InviteBlock({ invite, status: "ready", note: "", onCopy: () => copies.push(1) });
  assert.match(text(tree), /will not receive more invite rewards/);
  assert.doesNotMatch(text(tree), /You each get/);
  nodes(tree, (n) => n.type === "button" && text(n) === "Copy link")[0].props.onClick();
  assert.equal(copies.length, 1);
  assert.match(
    text(H.InviteBlock({ invite: { ...invite, rewarded: 1 }, status: "ready" })),
    /You each get 3 extra Auto-Apply runs/,
  );
  assert.match(
    text(H.InviteBlock({ invite: null, status: "error" })),
    /Retry invite link.*Couldn't load/,
  );
});
test("panel loading/error never claims exhaustion or starts checkout; a plan click is explicit", () => {
  const H = harness(),
    calls = [],
    base = {
      signedIn: true,
      me: null,
      status: "loading",
      cfgStatus: "ready",
      allowance: null,
      plans: cfg.payments.plans,
      onCheckout: (p) => calls.push(p),
    };
  assert.match(text(H.AllowancePanel(base)), /Your Auto-Apply allowance.*Loading your allowance/);
  assert.doesNotMatch(text(H.AllowancePanel(base)), /No Auto-Apply runs left/);
  assert.equal(calls.length, 0);
  const a = account({ used: 27, limit: 30, bonus: 3 }),
    tree = H.AllowancePanel({ ...base, me: a, status: "ready", allowance: H.runAllowance(a) });
  nodes(tree, (n) => n.type === "button" && text(n).startsWith("Pro"))[0].props.onClick();
  assert.deepEqual(calls, ["pro"]);
  assert.match(
    text(H.AllowancePanel({ ...base, status: "error" })),
    /Couldn't load your allowance.*Retry allowance/,
  );
  assert.doesNotMatch(text(tree), /top.up|30.*month|used.*of/);
});
function loadHarness() {
  const H = harness(),
    pending = [],
    updates = [],
    authRef = { current: { token: "account-a", who: {} } },
    meRequest = { current: 0 };
  const ctx = {
    authRef,
    meRequest,
    setMeResult: (v) => updates.push(v),
    bounded: (p) => p,
    runAllowance: H.runAllowance,
    dropToken: () => {},
    IS: { fetchMe: () => new Promise((resolve) => pending.push(resolve)), authOk: () => true },
  };
  ctx.load = createLoadMe(ctx);
  return { ...ctx, pending, updates };
}
test("late account responses cannot replace current account data", async () => {
  const H = loadHarness(),
    a = H.load();
  H.authRef.current = { token: "account-b", who: {} };
  const b = H.load();
  H.pending[1](account({ used: 2, limit: 10 }));
  await b;
  H.pending[0](account({ used: 90, limit: 90 }));
  assert.equal(await a, null);
  assert.equal(H.updates.at(-1).token, "account-b");
  assert.equal(H.updates.at(-1).data.allowance.autofill.used, 2);
});
test("retry supersedes an earlier same-account request", async () => {
  const H = loadHarness(),
    old = H.load(),
    fresh = H.load();
  H.pending[1](account({ used: 1, limit: null }));
  await fresh;
  H.pending[0](null);
  await old;
  assert.equal(H.updates.at(-1).status, "ready");
  assert.equal(H.updates.at(-1).data.allowance.autofill.limit, null);
});

test("serialized disabled base with prior usage and bonus is not an invite remedy", () => {
  const H = harness(),
    cfg = { allowance: { edu: { autofill: 0 }, general: { autofill: 1 }, pro: { autofill: 0 } } };
  const free = account({ used: 5, limit: 8, bonus: 3 }, { plan: "free", tier: "edu" });
  const disabled = H.runAllowance(free, cfg);
  assert.equal(disabled.left, 3);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.exhausted, false);
  const tree = H.AllowancePanel({
    signedIn: true,
    me: free,
    status: "ready",
    cfgStatus: "ready",
    allowance: disabled,
    plans: [],
    inviteBlock: "INVITE REMEDY",
  });
  assert.match(text(tree), /currently unavailable/);
  assert.doesNotMatch(text(tree), /INVITE REMEDY/);
  assert.equal(
    H.runAllowance({ ...free, plan: "pro", tier: "general" }, cfg).disabled,
    false,
    "paid edu table must not be applied to general accounts",
  );
  assert.equal(H.runAllowance({ ...free, plan: "pro", tier: "edu" }, cfg).disabled, true);
  assert.equal(
    H.runAllowance(free, null).disabled,
    false,
    "missing exact table cannot invent a disabled base",
  );
  const paused = { ...free, paused: true };
  assert.doesNotMatch(
    text(
      H.AllowancePanel({
        signedIn: true,
        me: paused,
        status: "ready",
        cfgStatus: "ready",
        allowance: H.runAllowance(paused),
        plans: [],
        inviteBlock: "INVITE REMEDY",
      }),
    ),
    /INVITE REMEDY/,
  );
});

test("unanswered account requests reach a bounded error path", async () => {
  const H = harness();
  let timeout;
  H.ctx.setTimeout = (fn) => {
    timeout = fn;
    return 1;
  };
  H.ctx.clearTimeout = () => {};
  const result = H.bounded(new Promise(() => {}));
  timeout();
  assert.equal(await result, null);
});
test("old-account invite responses and clipboard failures cannot affect the new account", async () => {
  const H = harness(),
    pending = [],
    updates = [],
    notes = [],
    authRef = { current: { token: "account-a" } },
    inviteRequest = { current: 0 };
  const ctx = {
    inviteStatus: "idle",
    authRef,
    inviteRequest,
    inviteOffer: {},
    bounded: (p) => p,
    validInvite: H.validInvite,
    setInviteNote: (v) => notes.push(v),
    setInviteState: (v) => updates.push(v),
    setNudge: () => {},
    IS: {
      fetchInvite: () => new Promise((resolve) => pending.push(resolve)),
      markInviteNudge: () => {},
      count: () => {},
    },
  };
  ctx.openInvite = retry => openInviteAction(ctx, retry);
  const a = ctx.openInvite(true);
  authRef.current.token = "account-b";
  const b = ctx.openInvite(true);
  const info = {
    link: "https://site.test/?ref=bcdefghj",
    max: 2,
    rewarded: 0,
    bonus: { autofill: 3 },
  };
  pending[1](info);
  await b;
  pending[0]({ ...info, link: "https://site.test/?ref=abcdefgh" });
  await a;
  assert.equal(updates.at(-1).token, "account-b");
  assert.equal(updates.at(-1).data.link, info.link);
  let rejectCopy,
    focus = 0;
  ctx.invite = info;
  ctx.inviteState = { token: "account-b" };
  ctx.navigator = {
    clipboard: {
      writeText: () =>
        new Promise((_, reject) => {
          rejectCopy = reject;
        }),
    },
  };
  ctx.document = { getElementById: () => ({ focus: () => focus++, select: () => {} }) };
  ctx.copyInvite = () => copyInviteAction({ ...ctx, browser: ctx });
  const copy = ctx.copyInvite(),
    noteCount = notes.length;
  authRef.current.token = "account-c";
  rejectCopy(Error("denied"));
  await copy;
  assert.equal(focus, 0);
  assert.equal(notes.length, noteCount);
});

test("arrival interest counters are once per page and contain only the named event", () => {
  const H = harness(),
    seen = new Set(),
    events = [];
  H.IS.count = (...args) => events.push(args);
  for (const name of ["out_of_runs_view", "out_of_runs_invite", "out_of_runs_plan"]) {
    H.countArrivalOnce(seen, name);
    H.countArrivalOnce(seen, name);
  }
  assert.deepEqual(events, [["out_of_runs_view"], ["out_of_runs_invite"], ["out_of_runs_plan"]]);
});

test("an older extension sign-in request cannot replace a newer page sign-in", async () => {
  let resolve;
  const authRef = { current: { token: null, source: "page" } },
    updates = [];
  const ctx = {
    authRef,
    IS: {
      ext: {
        call: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
      authOk: () => true,
    },
    setAuth: (v) => updates.push(v),
    signedIn: () => {},
  };
  ctx.ask = createAskExtension(ctx);
  const pending = ctx.ask();
  authRef.current = { token: "new-page-session", source: "page" };
  resolve({ token: "older-extension-session" });
  await pending;
  assert.equal(updates.length, 0);
});

test("allowance loading, failure and ready updates share a persistent polite atomic status", () => {
  const H = harness(),
    a = account({ used: 27, limit: 30, bonus: 3 }),
    base = { signedIn: true, me: a, cfgStatus: "ready", plans: [] };
  for (const state of [
    { status: "loading", allowance: null },
    { status: "error", allowance: null },
    { status: "ready", allowance: H.runAllowance(a) },
  ]) {
    const status = nodes(
      H.AllowancePanel({ ...base, ...state }),
      (n) => n.props.id === "allowance-status",
    )[0];
    assert.equal(status.props.role, "status");
    assert.equal(status.props["aria-live"], "polite");
    assert.equal(status.props["aria-atomic"], true);
    assert.ok(text(status).length);
  }
});
test("bounded billing clears busy on timeout, requires explicit retry and ignores late-account results", async () => {
  const busy = [],
    notes = [],
    redirects = [],
    pending = [];
  let timedOut = true;
  const ctx = {
    authRef: { current: { token: "account-a" } },
    meResult: { token: "account-a" },
    meStatus: "ready",
    upgrades: [{ plan: "pro" }],
    billingRequest: { current: 0 },
    countArrival: () => {},
    IS: { count: () => {}, billingUrl: () => new Promise((resolve) => pending.push(resolve)) },
    bounded: (p) => (timedOut ? Promise.resolve(null) : p),
    setBusy: (v) => busy.push(v),
    setNote: (v) => notes.push(v),
    location: { assign: (v) => redirects.push(v) },
  };
  ctx.billing = (...args) => billingAction({ ...ctx, browser: ctx }, ...args);
  await ctx.billing("checkout", "pro", true);
  assert.equal(busy.at(-1), "");
  assert.match(notes.at(-1), /Couldn't open billing/);
  assert.equal(pending.length, 1);
  assert.equal(redirects.length, 0);
  timedOut = false;
  const retry = ctx.billing("checkout", "pro", true);
  pending[0]({ url: "https://late.fixture.test" });
  assert.equal(redirects.length, 0);
  pending[1]({ url: "https://chosen.fixture.test" });
  await retry;
  assert.deepEqual(redirects, ["https://chosen.fixture.test"]);
  const stale = ctx.billing("checkout", "pro", true);
  ctx.authRef.current.token = "account-b";
  pending[2]({ url: "https://wrong-account.fixture.test" });
  await stale;
  assert.equal(redirects.length, 1);
});

test("asynchronously revealed arrival never takes focus or scroll from an active control", () => {
  const H = harness(),
    calls = [],
    panel = { focus: () => calls.push("focus"), scrollIntoView: () => calls.push("scroll") };
  H.ctx.document.body = {};
  H.ctx.document.activeElement = { id: "q" };
  assert.equal(H.focusArrival(panel), false);
  assert.deepEqual(calls, []);
  H.ctx.document.activeElement = H.ctx.document.body;
  assert.equal(H.focusArrival(panel), true);
  assert.deepEqual(calls, ["focus", "scroll"]);
});

test("first insertion compensates only a still-focused visible control's measured shift", () => {
  const H = harness(),
    scrolls = [];
  let top = 500;
  const input = { isConnected: true, getBoundingClientRect: () => ({ top, bottom: top + 44 }) };
  H.ctx.innerHeight = 1000;
  H.ctx.scrollBy = (value) => scrolls.push(plain(value));
  H.ctx.document.activeElement = input;
  const anchor = H.visibleFocusAnchor();
  top = 900;
  H.restoreArrivalAnchor(anchor);
  assert.deepEqual(scrolls, [{ top: 400, behavior: "instant" }]);
  H.ctx.document.activeElement = {};
  H.restoreArrivalAnchor(anchor);
  assert.equal(scrolls.length, 1);
  H.ctx.document.activeElement = input;
  top = 1500;
  assert.equal(H.visibleFocusAnchor(), null);
});
test("config failure does not claim that no upgrade exists", () => {
  const H = harness(),
    a = account({ used: 1, limit: 4 });
  const tree = H.AllowancePanel({
    signedIn: true,
    me: a,
    status: "ready",
    cfgStatus: "error",
    allowance: H.runAllowance(a),
    plans: [],
  });
  assert.match(text(tree), /Plan options could not be loaded/);
  assert.doesNotMatch(text(tree), /No plan upgrade is available/);
});
