import { finishQuickProfileAction, saveQuickProfileAction } from "../../docs/js/app/setup.mjs";
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
    CONFIG: {},
    location: { search: "" },
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
  return { ...components, IS: ctx.IS, storage };
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
const majors = {
  majors: [
    { name: "Psychology", level: "undergrad" },
    { name: "MS Computer Science", level: "grad" },
  ],
};

test("quick choices persist the selected major while preserving every existing profile preference", () => {
  const H = harness();
  const original = {
    ...plain(H.IS.emptyProfile()),
    majors: ["Nursing"],
    minors: ["Biology"],
    fields: ["health"],
    class_year: "junior",
    grad_term: "Fall 2027",
    stages: ["research"],
    terms: ["Spring 2027"],
    paid_only: true,
    states: ["CA", "ON"],
    remote: false,
    work_auth: "visa",
    extra: { keep: true },
  };
  const saved = H.IS.saveProfile(H.quickProfile(original, { majors: ["Psychology"] }));
  assert.deepEqual(plain(H.IS.loadProfile()), plain(saved));
  for (const key of Object.keys(original).filter((k) => k !== "majors"))
    assert.deepEqual(plain(saved[key]), original[key], key);
  assert.deepEqual(original.majors, ["Nursing"]);
  const updated = H.quickProfile(H.quickProfile(saved, { class_year: "senior" }), {
    states: ["MA"],
  });
  assert.equal(updated.class_year, "senior");
  assert.deepEqual(plain(updated.states), ["MA"]);
  assert.deepEqual(plain(updated.stages), ["research"], "year choice never replaces chosen stages");
});

test("a first major starts the existing profile shape without inventing optional answers", () => {
  const H = harness(),
    p = H.quickProfile(null, { majors: ["Psychology"] });
  assert.deepEqual(plain(p), { ...plain(H.IS.emptyProfile()), majors: ["Psychology"] });
  assert.equal(p.class_year, "");
  assert.deepEqual(plain(p.states), []);
});

test("quick panel asks optional questions only after a major and allows finishing without them", () => {
  const H = harness(),
    changes = [];
  let finished = 0;
  const props = {
    profile: null,
    majors,
    majorsReady: true,
    onChange: (patch) => changes.push(plain(patch)),
    onDone: () => finished++,
    onSetup() {},
  };
  let tree = H.QuickProfile(props);
  assert.equal(nodes(tree, (n) => n.type === H.MultiSelect).length, 1);
  assert.doesNotMatch(text(tree), /Class year/);
  nodes(tree, (n) => n.type === H.MultiSelect)[0].props.onChange(["Psychology"]);
  assert.deepEqual(changes, [{ majors: ["Psychology"] }]);
  tree = H.QuickProfile({ ...props, profile: H.quickProfile(null, changes[0]) });
  assert.match(text(tree), /Class year \(optional\)/);
  assert.equal(nodes(tree, (n) => n.type === H.MultiSelect).length, 2);
  nodes(tree, (n) => n.type === "button" && text(n) === "Done")[0].props.onClick();
  assert.equal(finished, 1);
  assert.equal(changes.length, 1, "skipping does not invent a year or state");
});

test("major loading and failure remain distinct and full setup is always reachable", () => {
  const H = harness();
  let opened = 0;
  const props = { profile: null, majors: null, majorsReady: false, onSetup: () => opened++ };
  const pending = H.QuickProfile(props),
    failed = H.QuickProfile({ ...props, majorsReady: true });
  assert.match(text(pending), /Loading the list of majors/);
  assert.doesNotMatch(text(pending), /didn't load/);
  assert.match(text(failed), /didn't load.*Open profile setup/);
  for (const tree of [pending, failed]) {
    assert.equal(nodes(tree, (n) => n.type === H.MultiSelect).length, 0);
    nodes(tree, (n) => n.type === "button" && text(n) === "Open profile setup")[0].props.onClick();
  }
  assert.equal(opened, 2);
});

test("unscored rows and Details omit repeated ranking prompts but keep Details and scored controls", () => {
  const H = harness(),
    r = { id: "test", company_name: "Example", title: "Intern", status: "open", insights: {} };
  let toggles = 0;
  const common = {
    r,
    sc: { score: 80, parts: {} },
    open: false,
    onToggle: () => toggles++,
    panelId: "why-test",
  };
  const unscored = H.matchControl({ ...common, scored: false });
  assert.doesNotMatch(text(unscored), /Rank for my major/);
  const details = nodes(unscored, (n) => n.type === "button")[0];
  assert.equal(details.props["aria-label"], "Details: Example, Intern");
  details.props.onClick();
  assert.equal(toggles, 1);
  assert.match(text(H.matchControl({ ...common, scored: true })), /Match 80/);
  const why = H.Why({
    r,
    sc: common.sc,
    ctx: { p: null, direct: new Set(), related: new Set(), keys: new Set() },
    onRank() {},
  });
  assert.doesNotMatch(text(why), /Rank for my major/);
  assert.match(text(why), /No match score yet/);
});

test("quick save preserves filters and defers the existing first-profile invitation until Done", () => {
  const H = harness(),
    offers = [],
    counted = [];
  let filters = { q: "Engineer", states: ["NY"], fields: ["swe"], sort: "new" };
  const ctx = {
    IS: { ...H.IS, count: (event) => counted.push(event) },
    quickProfile: H.quickProfile,
    prefill: null,
    PAGE: 150,
    profileRef: { current: null },
    quickFirstSave: { current: false },
    setP() {},
    setLimit() {},
    setQuickMessage() {},
    setQuickOpen() {},
    setTimeout() {},
    setF: (update) => {
      filters = update(filters);
    },
    offerNudge: () => false,
    offerDigestNudge: (action) => offers.push(action),
  };
  ctx.saveQuickProfile = patch => saveQuickProfileAction(ctx, patch);
  ctx.finishQuickProfile = () => finishQuickProfileAction({ ...ctx, browser: ctx });
  ctx.saveQuickProfile({ majors: ["Psychology"] });
  ctx.saveQuickProfile({ class_year: "junior" });
  assert.deepEqual(plain(filters), {
    q: "Engineer",
    states: ["NY"],
    fields: ["swe"],
    sort: "score",
  });
  assert.deepEqual(counted, ["profile", "major_quick_set"]);
  assert.deepEqual(offers, [], "typing optional answers never interrupts with an invitation");
  ctx.finishQuickProfile();
  ctx.finishQuickProfile();
  assert.deepEqual(offers, ["profile"], "finishing offers the existing invitation once");
  assert.equal(ctx.quickFirstSave.current, false);
});
