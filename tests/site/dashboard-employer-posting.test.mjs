import { createTestApp } from "./app-fixture.mjs";
import { installCore } from "./core-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

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
    TextEncoder,
    CONFIG: {},
    location: { search: "" },
    addEventListener() {},
    setTimeout() {},
    document: { documentElement: { dataset: {} } },
  };
  ctx.window = ctx;
  installCore(ctx);
  const components = createTestApp(ctx);
  return {
    ...components,
    IS: ctx.IS,
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

const role = (extra = {}) => ({
  id: "synthetic-role",
  company_name: "Example & Research",
  title: "Research Intern",
  status: "open",
  apply_url: "https://jobs.example.test/role",
  ats: "greenhouse",
  employer_key: "example & research",
  field_tags: ["swe"],
  stage: ["internship"],
  regions: [{ kind: "us", state: "MA", loc: "Boston, MA" }],
  ...extra,
});
const posting = (H, r, extra = {}) => {
  const rendered = H.render(H.Row, { ...rowProps(r), ...extra });
  return {
    rendered,
    anchor: nodes(rendered, (n) => n.type === "a" && n.props.className === "open-link")[0],
  };
};
const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, v) =>
      ["data-employer-key", "employer_key"].includes(key) ? undefined : v,
    ),
  );

test("native organic Open posting receives only the staged key without changing presentation or handlers", () => {
  const H = harness();
  for (const status of ["open", "closed"]) {
    const r = role({ status }),
      opened = [];
    const { rendered, anchor } = posting(H, r, { onOpen: (value) => opened.push(value) });
    const absent = posting(H, role({ status, employer_key: undefined })).rendered;
    assert.equal(anchor.props["data-employer-key"], r.employer_key);
    assert.deepEqual(plain(rendered), plain(absent));
    assert.equal(anchor.props.href, r.apply_url);
    assert.equal(anchor.props.target, "_blank");
    assert.equal(anchor.props.rel, "noopener");
    assert.equal(anchor.props["data-aa"], "");
    anchor.props.onClick();
    assert.deepEqual(opened, [r]);
  }
});

test("keys are never inferred and malformed or oversized staged values omit the attribute", () => {
  const H = harness();
  for (const key of [
    undefined,
    null,
    3,
    {},
    "",
    " example",
    "example ",
    "a\n",
    "a\u007f",
    "\ud800",
    "a".repeat(201),
    "é".repeat(101),
    "😀".repeat(51),
  ]) {
    assert.equal(
      posting(H, role({ employer_key: key })).anchor.props["data-employer-key"],
      undefined,
    );
  }
  for (const key of ["a".repeat(200), "é".repeat(100), "😀".repeat(50)]) {
    assert.equal(posting(H, role({ employer_key: key })).anchor.props["data-employer-key"], key);
  }
});

test("unsafe, credentialed or malformed posting targets never borrow a staged key", () => {
  const H = harness();
  for (const apply_url of [
    "/relative",
    "javascript:alert(1)",
    "https://",
    "https://example.test:bad/",
    "https://example.test:99999/",
    "https://user@example.test/",
    "https://:password@example.test/",
    "https://@example.test/",
    "https://example.test/\\path",
    "https://example.test/\tpath",
  ]) {
    const { anchor } = posting(H, role({ apply_url }));
    assert.equal(anchor.props["data-employer-key"], undefined);
    assert.equal(anchor.props.href, apply_url, "existing link presentation is not rewritten");
  }
  assert.equal(
    posting(H, role({ status: "unknown" })).anchor.props["data-employer-key"],
    undefined,
  );
  assert.equal(
    posting(H, role({ apply_url: "http://example.test:8080/role" })).anchor.props[
      "data-employer-key"
    ],
    "example & research",
  );
});

test("saved-only snapshots cannot carry keys; currently resolved saved roles retain the public row", () => {
  const H = harness(),
    r = role();
  const snapshot = H.publicRole(r);
  assert.equal(Object.hasOwn(snapshot, "employer_key"), false);
  const book = H.readMyList(
    { version: 1, roles: { [r.id]: { ...snapshot, saved: true, employer_key: r.employer_key } } },
    {},
  );
  assert.equal(Object.hasOwn(book.roles[r.id], "employer_key"), false);
  const missing = H.savedRoleRows([], book.roles)[0];
  assert.equal(missing._savedMissing, true);
  assert.equal(
    posting(H, { ...missing, status: "open", employer_key: r.employer_key }, { myList: true })
      .anchor.props["data-employer-key"],
    undefined,
  );
  const current = H.savedRoleRows([r], book.roles)[0];
  assert.equal(current, r);
  assert.equal(
    posting(H, current, { myList: true }).anchor.props["data-employer-key"],
    r.employer_key,
  );
});

test("Auto-Apply, install and status controls do not receive employer annotations", () => {
  const H = harness(),
    r = role(),
    auto = [];
  const first = posting(H, r, { canTry: true });
  const button = nodes(
    first.rendered,
    (n) => n.type === "button" && n.props.className === "rowbtn try",
  )[0];
  assert.equal(button.props["data-employer-key"], undefined);
  button.props.onClick();
  const expanded = posting(H, r, { canTry: true }).rendered;
  const links = nodes(expanded, (n) => n.type === "a");
  assert.equal(links.filter((n) => n.props["data-employer-key"] !== undefined).length, 1);
  assert.ok(
    links.some(
      (n) => n.props.href.includes("install") && n.props["data-employer-key"] === undefined,
    ),
  );
  const installed = posting(H, r, { canAuto: true, onAuto: (rows) => auto.push(rows) }).rendered;
  const run = nodes(installed, (n) => n.type === "button" && n.props.className === "rowbtn")[0];
  run.props.onClick();
  assert.deepEqual(auto, [[r]]);
  assert.equal(run.props["data-employer-key"], undefined);
});
