import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const rows = JSON.parse(
  readFileSync(
    new URL("../../notes/product/screenshots/P-1.3/listings-fixture.json", import.meta.url),
  ),
);
function harness() {
  const slots = [];
  let cursor = 0;
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
    useState: (initial) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (v) => {
          slots[i] = typeof v === "function" ? v(slots[i]) : v;
        },
      ];
    },
  };
  const ctx = {
    React,
    URLSearchParams,
    CONFIG: {},
    location: { search: "" },
    addEventListener() {},
    setTimeout() {},
    document: { documentElement: { dataset: {} } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8"), ctx);
  const app = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
  vm.runInContext(
    app.replace(
      'ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
      "window.parts = { Loc, compactLocation, postedTime, CompanyTile, factsLine, Row, Why };",
    ),
    ctx,
  );
  return {
    ...ctx.parts,
    render: (fn, props) => {
      cursor = 0;
      return fn(props);
    },
  };
}
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
const context = { p: null, direct: new Set(), related: new Set(), keys: new Set() };
const rowProps = (r) => ({
  r,
  sc: { score: 80, parts: {} },
  ctx: context,
  keys: new Set(),
  state: "none",
  onState() {},
  onCheck() {},
  onWhy() {},
  onOpen() {},
  onAnswer() {},
});

test("location presentation retains chosen region, count, original tooltip and source data", () => {
  const H = harness(),
    r = rows[0],
    before = JSON.stringify(r);
  const first = H.Loc({ r, keys: new Set(["RI"]) });
  assert.equal(text(first), "North Kingstown, RI +1 more");
  assert.equal(first.props.title, r.regions.map((g) => g.loc).join("; "));
  assert.equal(text(H.Loc({ r, keys: new Set(["MA"]) })), "Boston, MA +1 more");
  assert.equal(JSON.stringify(r), before);
});

test("only known suffixes compact; Canada, remote restrictions and city names remain", () => {
  const H = harness();
  for (const [g, raw, expected] of [
    [{ kind: "us", state: "NY" }, "New York, New York, United States", "New York, NY"],
    [{ kind: "us", state: "WA" }, "Washington, WA", "Washington, WA"],
    [{ kind: "canada", state: "QC" }, "Montréal, Québec, Canada", "Montréal, QC, Canada"],
    [
      { kind: "canada", state: "ON", remote: true },
      "Toronto, Ontario, Canada (remote)",
      "Toronto, ON, Canada (remote)",
    ],
    [{ kind: "us", state: "TX", remote: true }, "Remote, Texas, USA", "Remote, TX"],
    [{ kind: "remote" }, "Worldwide", "Worldwide (remote)"],
    [{ kind: "other" }, "Paris, France", "Paris, France"],
  ])
    assert.equal(H.compactLocation(g, raw), expected);
  assert.equal(text(H.Loc({ r: {}, keys: new Set() })), "Location not listed");
  assert.equal(
    text(H.Loc({ r: { location_raw: "Somewhere, District" }, keys: new Set() })),
    "Somewhere, District",
  );
});

test("posted dates use calendar days with full accessible dates and honest future/invalid fallbacks", () => {
  const H = harness(),
    now = new Date(2026, 10, 10, 1);
  for (const [value, visible] of [
    ["2026-11-10", "Posted today"],
    ["2026-11-09", "Posted yesterday"],
    ["2026-11-08", "Posted 2 days ago"],
  ]) {
    const node = H.postedTime(value, now);
    assert.equal(node.type, "time");
    assert.equal(node.props.dateTime, value);
    assert.equal(text(node.children[0]), visible);
    assert.equal(node.children[0].props["aria-hidden"], true);
    assert.match(node.props.title, /2026/);
    assert.equal(text(node.children[1]), "Posted " + node.props.title);
  }
  const future = H.postedTime("2026-11-12", now);
  assert.equal(text(future.children[0]), "Posted " + future.props.title);
  for (const value of [null, "bad date", "2026-02-30"])
    assert.equal(H.postedTime(value, now), null);
});

test("listed salary, stipend and unpaid retain their meaning; rejected and unknown pay stay plain", () => {
  const H = harness();
  for (const [r, expected] of [
    [rows[0], "$25 - $30/hour"],
    [rows[1], "Stipend"],
    [rows[2], "Unpaid"],
  ]) {
    const badge = nodes(H.factsLine(r, new Set()), (n) => n.props.className?.includes("pay-badge"));
    assert.equal(badge.length, 1);
    assert.equal(text(badge[0]), expected);
  }
  for (const salary of [null, "$0", "-$30/hour", "$1/year"]) {
    const facts = H.factsLine({ ...rows[3], salary }, new Set());
    assert.equal(nodes(facts, (n) => n.props.className?.includes("pay-badge")).length, 0);
    assert.match(text(facts), /Pay not listed/);
  }
});

test("company initials preserve Unicode graphemes, are decorative, and have stable bounded colors", () => {
  const H = harness();
  for (const [name, initial] of [
    ["Acme", "A"],
    ["E\u0301lan", "É"],
    ["\u{1F469}\u200D\u{1F4BB} Studio", "\u{1F469}\u200D\u{1F4BB}"],
    ["", "?"],
  ]) {
    const tile = H.CompanyTile({ name }),
      hue = tile.props.style["--company-hue"];
    assert.equal(text(tile), initial);
    assert.equal(tile.props["aria-hidden"], true);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
    assert.equal(hue, H.CompanyTile({ name: name.toUpperCase() }).props.style["--company-hue"]);
  }
});

test("job-board labels move into Details and Other is absent", () => {
  const H = harness(),
    props = rowProps(rows[0]);
  assert.doesNotMatch(text(H.render(H.Row, props)), /Ashby/);
  assert.match(text(H.Why(props)), /Job board: Ashby/);
  for (const ats of ["other", "Other", " OTHER ", ""])
    assert.doesNotMatch(text(H.Why(rowProps({ ...rows[0], ats }))), /Job board:/);
  for (const field_tags of [["swe", "other"], ["other"]]) {
    const r = { ...rows[0], ats: "other", field_tags };
    const facts = text(H.factsLine(r, new Set()));
    assert.match(facts, field_tags.length > 1 ? /Software, Other/ : /Other/);
    assert.doesNotMatch(facts, /Not tagged/);
    assert.deepEqual(r.field_tags, field_tags, "taxonomy labels and source tags are preserved");
  }
});

test("Auto-Apply keeps its action, busy state, access note and disclosure controls", () => {
  const H = harness(),
    calls = [],
    props = { ...rowProps(rows[0]), canAuto: true, onAuto: (r) => calls.push(r) };
  let tree = H.render(H.Row, props);
  let button = nodes(tree, (n) => n.type === "button" && n.props.className === "rowbtn")[0];
  assert.match(button.props.title, /review and submit/);
  button.props.onClick();
  assert.equal(calls[0][0], rows[0]);
  tree = H.render(H.Row, { ...props, queueBusy: true });
  assert.equal(nodes(tree, (n) => n.props.className === "rowbtn")[0].props.disabled, true);
  tree = H.render(H.Row, { ...props, r: { ...rows[0], ats: "other" } });
  assert.match(text(tree), /asks for site access/);
  const trying = { ...props, canAuto: false, canTry: true };
  tree = H.render(H.Row, trying);
  button = nodes(tree, (n) => n.props.className === "rowbtn try")[0];
  assert.equal(button.props["aria-expanded"], false);
  button.props.onClick();
  tree = H.render(H.Row, trying);
  assert.equal(
    nodes(tree, (n) => n.props.className === "rowbtn try")[0].props["aria-expanded"],
    true,
  );
  assert.match(text(tree), /You review it and press Submit yourself/);
});
