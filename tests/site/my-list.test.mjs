import { installCore } from "./core-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const APP = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));
function harness() {
  const storage = new Map(),
    focus = [];
  const React = {
    Fragment: "fragment",
    memo: (fn) => fn,
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat().filter((x) => x != null && x !== false),
    }),
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useRef: (current) => ({ current }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect() {},
  };
  const ctx = {
    React,
    URLSearchParams,
    CONFIG: {},
    location: { search: "" },
    addEventListener() {},
    document: { documentElement: { dataset: {} } },
    setTimeout: (fn) => fn(),
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  installCore(ctx);
  vm.runInContext(
    APP.replace(
      'ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
      "window.parts = { readMyList, publicRole, savedRoleRows, sinceVisit, resolveSavedRoles, writeLocal, Row };",
    ),
    ctx,
  );
  return {
    ...ctx.parts,
    ctx,
    storage,
    focus,
    render(props) {
      const tree = ctx.parts.Row({
        r: role("a"),
        sc: { score: 0, parts: {} },
        ctx: { p: null },
        keys: new Set(),
        state: "none",
        onWhy() {},
        ...props,
      });
      for (const node of nodes(tree, (n) => n.props.ref))
        node.props.ref.current = { focus: () => focus.push(node.props["aria-label"]) };
      return tree;
    },
  };
}
const role = (id, extra = {}) => ({
  id,
  company_name: "Fixture Company",
  title: "Research Intern",
  status: "open",
  apply_url: "https://jobs.example.com/" + id,
  regions: [{ kind: "us", state: "MA", loc: "Boston, MA" }],
  ...extra,
});
const nodes = (n, match) =>
  !n || typeof n !== "object"
    ? []
    : [...(match(n) ? [n] : []), ...n.children.flatMap((c) => nodes(c, match))];
const text = (n) =>
  typeof n === "string" || typeof n === "number"
    ? String(n)
    : n && typeof n === "object"
      ? n.children.map(text).join("")
      : "";

test("legacy statuses migrate once without repurposing statuses or named searches", () => {
  const H = harness(),
    states = {
      a: "interested",
      b: "applied",
      c: "interviewing",
      d: "rejected",
      e: "offer",
      f: "none",
    };
  const searches = [{ name: "Boston research", f: { q: "research", states: ["MA"] } }];
  H.storage.set("internscout.appstate.v1", JSON.stringify(states));
  H.storage.set("internscout.saved.v1", JSON.stringify(searches));
  const book = H.readMyList(null, states);
  assert.deepEqual(Object.keys(book.roles), ["a", "b", "c", "d", "e"]);
  assert.ok(Object.values(book.roles).every((r) => r.saved));
  book.roles.b.saved = false;
  H.writeLocal("internscout.mylist.v1", book);
  const reload = H.readMyList(JSON.parse(H.storage.get("internscout.mylist.v1")), states);
  assert.equal(
    reload.roles.b.saved,
    false,
    "Applied does not resurrect an explicit unsave on reload",
  );
  assert.deepEqual(JSON.parse(H.storage.get("internscout.appstate.v1")), states);
  assert.deepEqual(JSON.parse(H.storage.get("internscout.saved.v1")), searches);
  assert.deepEqual(
    plain(H.readMyList({ version: 1, roles: {} }, states).roles),
    {},
    "an existing empty membership is not migrated again",
  );
});

test("snapshots allow only minimal public identity and safe shard hints", () => {
  const H = harness(),
    snapshot = H.publicRole(
      role("a", {
        description: "do not cache",
        profile: "do not cache",
        salary: "$25/hour",
        apply_url: "javascript:alert(1)",
      }),
    );
  assert.deepEqual(Object.keys(snapshot), ["company", "title", "url", "shards"]);
  assert.equal(snapshot.url, "");
  assert.deepEqual([...snapshot.shards], ["MA"]);
  const restored = H.readMyList(
    {
      version: 1,
      roles: {
        a: {
          saved: true,
          company: "Fixture",
          title: "Intern",
          url: "data:text/html,hello",
          shards: ["MA", "../secret", "remote", 4],
          private: "omit",
        },
      },
    },
    {},
  );
  assert.equal(restored.roles.a.url, "");
  assert.deepEqual([...restored.roles.a.shards], ["MA", "remote"]);
  assert.equal(restored.roles.a.private, undefined);
});

test("current closed rows win; missing IDs remain unknown and never become store records", () => {
  const H = harness(),
    rows = [role("a", { status: "closed" })],
    before = JSON.stringify(rows);
  const roles = {
    a: { saved: true, company: "Old name" },
    old: {
      saved: true,
      company: "Fixture old",
      title: "Old title",
      url: "https://jobs.example.com/old",
    },
    removed: { saved: false },
  };
  const shown = H.savedRoleRows(rows, roles);
  assert.equal(shown[0], rows[0]);
  assert.equal(shown[0].status, "closed");
  assert.equal(shown[1]._savedMissing, true);
  assert.equal(shown[1].status, undefined);
  assert.equal(shown[1].company_name, "Fixture old");
  assert.equal(shown.length, 2);
  assert.equal(JSON.stringify(rows), before);
});

test("cached saved IDs require zero additional shard requests", async () => {
  const H = harness();
  let calls = 0;
  const result = await H.resolveSavedRoles(
    {
      all: () => [role("a")],
      ensure: async () => {
        calls++;
        return [];
      },
    },
    { files: { MA: {}, RI: {} } },
    { a: { saved: true, shards: ["RI"] } },
    () => {},
    () => true,
  );
  assert.equal(calls, 0);
  assert.deepEqual([...result], []);
});

test("hinted in-flight shard is awaited before treating its role as missing", async () => {
  const H = harness(),
    rows = [],
    calls = [];
  let settle,
    paints = 0,
    finished = false;
  const inflight = new Promise((resolve) => {
    settle = () => {
      rows.push(role("a"));
      resolve([]);
    };
  });
  const store = {
    all: () => rows,
    loadedKeys: () => ["MA"],
    ensure: (keys) => {
      calls.push([...keys]);
      return inflight;
    },
  };
  const pending = H.resolveSavedRoles(
    store,
    { files: { MA: {}, RI: {} } },
    { a: { saved: true, shards: ["MA"] } },
    () => paints++,
    () => true,
  ).then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(calls, [["MA"]]);
  settle();
  assert.deepEqual([...(await pending)], []);
  assert.equal(paints, 1);
});

test("unknown legacy IDs resolve progressively in batches of four and stop when found", async () => {
  const H = harness(),
    rows = [],
    calls = [];
  const files = Object.fromEntries(
    ["MA", "RI", "CT", "NY", "CA", "TX", "FL", "WA", "OR"].map((k) => [k, {}]),
  );
  const result = await H.resolveSavedRoles(
    {
      all: () => rows,
      ensure: async (keys) => {
        calls.push([...keys]);
        if (keys.includes("CA")) rows.push(role("legacy"));
        return [];
      },
    },
    { files },
    { legacy: { saved: true } },
    () => {},
    () => true,
  );
  assert.deepEqual(calls, [
    ["MA", "RI", "CT", "NY"],
    ["CA", "TX", "FL", "WA"],
  ]);
  assert.ok(calls.every((batch) => batch.length <= 4));
  assert.deepEqual([...result], []);
});

test("switching away cancels future batches; failures stay distinct from a fully searched missing role", async () => {
  const H = harness();
  let live = true,
    calls = 0;
  const store = {
    all: () => [],
    ensure: async () => {
      calls++;
      live = false;
      return ["MA"];
    },
  };
  const files = Object.fromEntries(["MA", "RI", "CT", "NY", "CA"].map((k) => [k, {}]));
  assert.equal(
    await H.resolveSavedRoles(
      store,
      { files },
      { old: { saved: true } },
      () => assert.fail("cancelled request must not repaint"),
      () => live,
    ),
    null,
  );
  assert.equal(calls, 1);
  store.ensure = async (keys) => (keys.includes("MA") ? ["MA"] : []);
  assert.deepEqual(
    [
      ...(await H.resolveSavedRoles(
        store,
        { files },
        { old: { saved: true } },
        () => {},
        () => true,
      )),
    ],
    ["MA"],
  );
  store.ensure = async () => [];
  assert.deepEqual(
    [
      ...(await H.resolveSavedRoles(
        store,
        { files },
        { old: { saved: true } },
        () => {},
        () => true,
      )),
    ],
    [],
  );
});

test("new-since-visit uses first_seen with a valid prior visit, never posted_at or the scan flag", () => {
  const H = harness(),
    now = Date.parse("2026-11-10T18:00:00Z"),
    previous = now - 86400000;
  const r = role("a", {
    first_seen: "2026-11-10T10:00:00Z",
    posted_at: "2025-01-01",
    is_new: false,
  });
  assert.equal(H.sinceVisit(r, previous, now), true);
  for (const old of [null, undefined, "yesterday", 0, NaN, now + 1])
    assert.equal(H.sinceVisit(r, old, now), false);
  for (const first_seen of [undefined, "invalid", "2026-11-12T10:00:00Z", "2026-11-01T10:00:00Z"])
    assert.equal(
      H.sinceVisit({ ...r, first_seen, posted_at: "2026-11-10", is_new: true }, previous, now),
      false,
    );
  assert.equal(H.sinceVisit({ ...r, status: "closed" }, previous, now), false);
});

test("real application-status updater preserves explicit unsaves for queue and return-prompt updates", () => {
  const H = harness(),
    ctx = H.ctx;
  ctx.useCallback = (fn) => fn;
  ctx.LS_KEY = "internscout.appstate.v1";
  ctx.publicRole = H.publicRole;
  ctx.states = { a: "interested", keep: "offer" };
  ctx.appStatesRef = { current: ctx.states };
  ctx.setAppStates = (next) => {
    ctx.states = typeof next === "function" ? next(ctx.states) : next;
  };
  ctx.roleBookRef = { current: { version: 1, roles: { a: { saved: false } } } };
  ctx.store = { current: { all: () => [role("a"), role("new")] } };
  ctx.keepRoleBook = (next) => {
    ctx.roleBookRef.current = next;
  };
  const start = APP.indexOf("    const setAppState ="),
    end = APP.indexOf("    // Queue updates", start);
  vm.runInContext(APP.slice(start, end) + "globalThis.updateStatus = setAppState;", ctx);
  ctx.updateStatus("a", "applied");
  assert.equal(ctx.states.a, "applied");
  assert.equal(ctx.roleBookRef.current.roles.a.saved, false);
  ctx.updateStatus("new", "interested");
  assert.equal(ctx.roleBookRef.current.roles.new.saved, true);
  assert.equal(ctx.states.keep, "offer");
  assert.equal(ctx.roleBookRef.current.roles.new.company, "Fixture Company");
});

test("batched status then Save retains the latest history and delete/reset clear the canonical ref", () => {
  const H = harness(),
    ctx = H.ctx,
    pending = [];
  Object.assign(ctx, {
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    LS_KEY: "internscout.appstate.v1",
    SAVED_KEY: "internscout.saved.v1",
    MYLIST_KEY: "internscout.mylist.v1",
    VISIT_KEY: "internscout.visit.v1",
    publicRole: H.publicRole,
    appStatesRef: { current: {} },
    roleBookRef: { current: { version: 1, roles: { a: { saved: false } } } },
    store: { current: { all: () => [role("a")] } },
    myList: false,
    setAppStates: (next) => pending.push(next),
    offerDigestNudge: () =>
      assert.fail("saving an Applied role must not offer an Interested nudge"),
    setMySel() {},
    setRoleBook() {},
    setPreviousVisit() {},
    setGhToken() {},
    keepSaved() {},
  });
  ctx.keepRoleBook = (next) => {
    ctx.roleBookRef.current = next;
  };
  const counts = [];
  ctx.IS.count = (...args) => counts.push(args);
  let start = APP.indexOf("    const setAppState ="),
    end = APP.indexOf("    const upd =", start);
  vm.runInContext(APP.slice(start, end) + "globalThis.updateStatus = setAppState;", ctx);
  start = APP.indexOf("    const myListRef =");
  end = APP.indexOf("    const showMyList =", start);
  vm.runInContext(APP.slice(start, end) + "globalThis.toggle = toggleSaved;", ctx);
  ctx.updateStatus("a", "applied");
  ctx.toggle(role("a"));
  let states = {};
  for (const update of pending.splice(0))
    states = typeof update === "function" ? update(states) : update;
  assert.equal(states.a, "applied");
  assert.equal(ctx.appStatesRef.current.a, "applied");
  assert.equal(ctx.roleBookRef.current.roles.a.saved, true);
  ctx.toggle(role("a"));
  ctx.toggle(role("a"));
  assert.equal(ctx.appStatesRef.current.a, "applied");
  assert.deepEqual(
    counts,
    [["save_role"], ["save_role"]],
    "only explicit saves count, with no role payload",
  );
  ctx.setMyList = (on) => {
    ctx.myList = on;
  };
  ctx.setMyLoad = () => {};
  start = APP.indexOf("    const showMyList =");
  end = APP.indexOf('    // "More filters"', start);
  vm.runInContext(APP.slice(start, end) + "globalThis.showList = showMyList;", ctx);
  ctx.showList(true);
  ctx.showList(true);
  ctx.showList(false);
  ctx.showList(true);
  assert.deepEqual(
    counts.slice(2),
    [["mylist_open"], ["mylist_open"]],
    "only entering the view counts",
  );
  ctx.updateStatus("a", "none");
  assert.equal(ctx.appStatesRef.current.a, undefined);
  ctx.updateStatus("a", "offer");
  start = APP.indexOf("    function clearTracker()");
  end = APP.indexOf("    function deleteTracker()", start);
  vm.runInContext(APP.slice(start, end) + "globalThis.clear = clearTracker;", ctx);
  ctx.clear();
  assert.deepEqual(plain(ctx.appStatesRef.current), {});
  assert.deepEqual(plain(ctx.roleBookRef.current.roles), {});
});

test("timezone-less export timestamps are UTC even in a non-UTC browser", () => {
  const previousTZ = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const H = harness(),
      previous = Date.parse("2026-11-10T12:00:00Z"),
      now = Date.parse("2026-11-10T18:00:00Z");
    assert.equal(
      H.sinceVisit(role("a", { first_seen: "2026-11-10T10:00:00" }), previous, now),
      false,
    );
    assert.equal(
      H.sinceVisit(role("a", { first_seen: "2026-11-10T16:00:00.123456" }), previous, now),
      true,
    );
    assert.equal(
      H.sinceVisit(role("a", { first_seen: "2026-11-10T11:00:00-05:00" }), previous, now),
      true,
    );
    assert.equal(H.sinceVisit(role("a", { first_seen: "2026-11-10" }), previous, now), false);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("filtered-out status changes and prompt answers restore focus to the list heading", () => {
  const H = harness();
  H.ctx.document.getElementById = (id) => ({ focus: () => H.focus.push(id) });
  let select;
  let tree = H.render({
    myList: true,
    saved: true,
    state: "interested",
    onState() {
      select.props.ref.current = null;
    },
  });
  select = nodes(tree, (n) => n.type === "select")[0];
  select.props.onChange({ target: { value: "applied" } });
  assert.equal(H.focus.at(-1), "listings");
  tree = H.render({
    myList: true,
    saved: true,
    state: "interested",
    ask: true,
    onAnswer() {
      select.props.ref.current = null;
    },
  });
  select = nodes(tree, (n) => n.type === "select")[0];
  nodes(tree, (n) => n.type === "button" && text(n) === "Mark applied")[0].props.onClick();
  assert.equal(H.focus.at(-1), "listings");
});

test("Browse has an accessible save toggle; status editing and answer focus work in My list", () => {
  const H = harness(),
    saved = [],
    answers = [];
  let tree = H.render({
    saved: false,
    onSave: (r) => saved.push(r.id),
    ask: true,
    onAnswer: (id, applied) => answers.push([id, applied]),
  });
  let button = nodes(tree, (n) => n.props["aria-pressed"] !== undefined)[0];
  assert.equal(button.props["aria-label"], "Save Research Intern at Fixture Company");
  assert.equal(button.props["aria-pressed"], false);
  button.props.onClick();
  assert.deepEqual(saved, ["a"]);
  assert.equal(nodes(tree, (n) => n.type === "select").length, 0);
  nodes(tree, (n) => n.type === "button" && text(n) === "Mark applied")[0].props.onClick();
  assert.deepEqual(answers, [["a", true]]);
  assert.equal(H.focus.at(-1), "Save Research Intern at Fixture Company");
  tree = H.render({ saved: true, myList: true, state: "interested", ask: true, onAnswer() {} });
  button = nodes(tree, (n) => n.props["aria-pressed"] !== undefined)[0];
  assert.equal(button.props["aria-pressed"], true);
  assert.equal(nodes(tree, (n) => n.type === "select").length, 1);
  nodes(tree, (n) => n.type === "button" && text(n) === "Mark applied")[0].props.onClick();
  assert.equal(H.focus.at(-1), "Your status for Research Intern at Fixture Company");
});

test("missing snapshot rows expose no invented closure, facts, match or Auto-Apply", () => {
  const H = harness(),
    r = H.savedRoleRows([], {
      old: {
        saved: true,
        company: "Fixture",
        title: "Old role",
        url: "https://jobs.example.com/old",
      },
    })[0];
  const tree = H.render({
    r,
    saved: true,
    myList: true,
    canAuto: true,
    missingText: "Current posting status unknown.",
  });
  assert.match(text(tree), /Current posting status unknown/);
  assert.doesNotMatch(text(tree), /Closed|Pay not listed|Auto-Apply|Details|Match/);
  assert.equal(nodes(tree, (n) => n.type === "input")[0].props.disabled, true);
  assert.equal(
    nodes(tree, (n) => n.props.className === "open-link")[0].props.href,
    "https://jobs.example.com/old",
  );
});

test("blocked browser storage reports failure without throwing", () => {
  const H = harness();
  H.ctx.localStorage.setItem = () => {
    throw new Error("blocked");
  };
  assert.equal(H.writeLocal("internscout.mylist.v1", { version: 1, roles: {} }), false);
});
