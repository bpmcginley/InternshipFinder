// Paid listings ("placements") on the dashboard (2026-10-14, B2 plan section 5.4; rows S5 and S6). The rule
// these tests hold the code to: payment never changes any score, order, filter, count or what Auto-Apply
// does. docs/js/core.js, docs/js/placements.js and docs/js/app.js are loaded the way the page loads them,
// against a stand-in `window`; T1 runs on real listing files from docs/data/listings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const CORE_SRC = read("docs/js/core.js");
const PLACE_SRC = read("docs/js/placements.js");
const APP_SRC = read("docs/js/app.js");

function context(extra = {}) {
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = {
    CONFIG: { dataUrl: "./data/" }, fetch: () => new Promise(() => {}), localStorage: store(), sessionStorage: store(),
    addEventListener() {}, postMessage() {}, setTimeout, clearTimeout, AbortController, TextDecoder, URLSearchParams,
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash: "" },
    document: { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} }, console, ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return ctx;
}
// The clock stands still inside the context: IS.score's freshness part counts milliseconds, so two calls a
// moment apart would differ in the last decimal place for reasons that have nothing to do with placements.
const FROZEN = Date.parse("2026-11-03T12:00:00Z");
const freezeClock = ctx => vm.runInContext(`{ const D = Date; Date = class extends D { constructor(...a) { super(...(a.length ? a : [${FROZEN}])); } static now() { return ${FROZEN}; } }; }`, ctx);
function loadBoth(extra) {
  const ctx = context(extra);
  freezeClock(ctx);
  vm.runInContext(CORE_SRC, ctx);
  vm.runInContext(PLACE_SRC, ctx);
  return { IS: ctx.IS, P: ctx.ISPlace, ctx };
}
// core.js runs in its own vm context: spread its arrays into this one before deepEqual compares them.
const plain = v => JSON.parse(JSON.stringify(v));

// ---------- fixtures ----------
const DAY = "2026-11-03";
let realCache = null;
function realRows() {
  if (realCache) return realCache;
  const dir = new URL("../../docs/data/listings/", import.meta.url);
  const byId = new Map();
  for (const f of ["MA.json", "NY.json", "CA.json", "TX.json", "remote.json"]) {
    if (!readdirSync(dir).includes(f)) continue;
    for (const x of JSON.parse(readFileSync(new URL(f, dir), "utf8"))) if (x && x.id != null && !byId.has(x.id)) byId.set(x.id, x);
  }
  return (realCache = [...byId.values()]);
}
const deepFreeze = o => { Object.values(o).forEach(v => v && typeof v === "object" && !Object.isFrozen(v) && deepFreeze(v)); return Object.freeze(o); };
const BASE_F = { q: "", fields: [], states: [], company: [], where: "", stage: "", year: "", sector: "", status: "open", app_state: "", new_only: false, eligible: false, sort: "new", hide_citizen: false, paid: "" };
const MAJORS = JSON.parse(read("docs/data/majors.json"));
const PROFILE = { majors: ["Computer Science"], class_year: "junior", grad_term: "Spring 2028", states: ["MA", "NY"], work_auth: "visa", terms: ["Summer 2027"], stages: ["internship"] };
function envFor(IS, p, all) {
  const { direct, related } = IS.profileFields(p, MAJORS);
  const ctx = { p, direct, related, keys: new Set(IS.profileKeys(p)), anywhere: !(p && p.states && p.states.length) };
  const m = new WeakMap();
  const scoreOf = x => { let v = m.get(x); if (!v) { v = IS.score(x, ctx); m.set(x, v); } return v; };
  return { ctx, scoreOf, p, elig: p ? { needs_sponsorship: true } : null, blockers: (x, e) => e && e.needs_sponsorship && IS.citizenRule(x) ? ["For U.S. citizens"] : [],
    appStates: { [all[0].id]: "applied" }, jobs: { [String(all[1].id)]: { status: "queued" } } };
}
const FILTER_STATES = [
  {}, { q: "software" }, { q: "boston nursing" }, { q: "data analyst", sort: "company" }, { q: "engineer", sort: "comp" },
  { fields: ["swe"] }, { fields: ["nursing", "health"], sort: "score" }, { fields: ["swe"], hide_citizen: true }, { fields: ["swe"], eligible: true },
  { fields: ["business"], paid: "no_unpaid", where: "remote" }, { q: "research", status: "" }, { fields: ["swe"], app_state: "applied" },
];
const placementFor = (x, extra) => ({ id: "p-" + x.id, listing_id: String(x.id), apply_url: x.apply_url, employer: x.company_name, start: "2026-11-01", end: "2026-12-01", ...extra });

// ---------- T1: a placement cannot change any row, order or score ----------
test("T1: with or without placements, every row, its order and its score are the same", () => {
  const { IS, P } = loadBoth();
  // A write to a listing would throw. core.js keeps two caches on each listing (hidden _regs and _keys
  // properties, from IS.regs and IS.shardKeys), so they are filled in first; any other write fails the test.
  const listings = structuredClone(realRows());
  listings.forEach(x => { IS.regs(x); IS.shardKeys(x); });
  deepFreeze(listings);
  assert.ok(listings.length > 500, "listing files should be in docs/data/listings");
  const words = IS.placeWords(listings);
  let picked = 0;
  for (const prof of [null, PROFILE]) {
    const env0 = envFor(IS, prof, listings);
    for (const extra of FILTER_STATES) {
      const f = { ...BASE_F, ...extra };
      const env = { ...env0, cq: IS.compileQuery(f.q, f.q.trim() ? words : null) };
      const before = IS.listRows(listings, f, env);
      const snap = plain([before.rows.map(x => String(x.id)), before.rows.map(x => IS.score(x, env.ctx))]);
      const open = before.rows.filter(x => x.status === "open" && x.apply_url);
      const matching = open.slice(0, 5).map(x => placementFor(x));
      const failing = [
        ...listings.filter(x => !before.rows.includes(x)).slice(0, 3).map(x => placementFor(x)),
        ...open.slice(0, 2).map(x => placementFor(x, { apply_url: "https://elsewhere.example/" + x.id })),
        ...open.slice(0, 2).map(x => placementFor(x, { start: "2026-12-01", end: "2027-01-01" })),
      ];
      const malformed = P.clean({ placements: [null, 7, { id: "bad id!" }, { id: "x", listing_id: "1", apply_url: "http://x", start: "2026", end: "2027" }] });
      for (const placements of [[], matching, failing, malformed]) {
        for (const rand of [() => 0, () => 0.99]) {
          if (P.pick({ placements, rows: Object.freeze(before.rows.slice()), rel: before.rel, ranked: before.ranked, fieldsSet: f.fields.length > 0,
            appState: f.app_state, loading: false, day: DAY, exclude: () => false, hidden: false, prev: null, rand })) picked++;
          const after = IS.listRows(listings, f, env);
          assert.deepEqual(plain([after.rows.map(x => String(x.id)), after.rows.map(x => IS.score(x, env.ctx))]), snap,
            `${prof ? "profile" : "no profile"}, ${JSON.stringify(extra)}, ${placements.length} placements`);
          assert.equal(after.ranked, before.ranked);
        }
      }
    }
  }
  assert.ok(picked > 20, `the box was really chosen in many of these cases (${picked})`);
});

test("T1b: the ranking code has no way in", () => {
  // listRows and score take no placements argument and never name them ("paid" is the pay filter, so the
  // code is named "placement" and the guard greps for that).
  const { IS } = loadBoth();
  assert.doesNotMatch(CORE_SRC, /placement|ISPlace/i);
  assert.equal(IS.listRows.length, 3);
  assert.equal(IS.score.length, 2);
  // app.js builds the list from the same six inputs as before, and only after that is the pick made.
  assert.match(APP_SRC, /IS\.listRows\(inView, f, \{ cq, scoreOf, p, elig, blockers, appStates, jobs \}\)/);
  assert.ok(APP_SRC.indexOf("IS.listRows(") < APP_SRC.indexOf("PL.pick("));
  // Nothing in placements.js writes to a listing or to the rows (T1 also passes them frozen).
  assert.doesNotMatch(PLACE_SRC, /rows\.(push|splice|sort|reverse|unshift|fill)\(|\bx\.[a-z_]+\s*=[^=]/);
});

// ---------- T2: every filter passes through ----------
test("T2: a placement whose listing isn't in the student's rows, or fails a check, is never picked", () => {
  const { IS, P } = loadBoth();
  const listings = realRows();
  const words = IS.placeWords(listings);
  const env0 = envFor(IS, null, listings);
  const base = { loading: false, day: DAY, exclude: () => false, hidden: false, prev: null, rand: () => 0, appState: "" };
  for (const extra of FILTER_STATES.filter(e => !e.app_state)) {
    const f = { ...BASE_F, ...extra };
    const r = IS.listRows(listings, f, { ...env0, cq: IS.compileQuery(f.q, f.q.trim() ? words : null) });
    const inRows = new Set(r.rows);
    const outside = listings.filter(x => !inRows.has(x) && x.status === "open").slice(0, 20);
    // Forced past the context gate, so only the "in the rows" check can stop it.
    for (const x of outside) assert.equal(P.pick({ ...base, placements: [placementFor(x)], rows: r.rows, rel: r.rel || new Map(), ranked: r.ranked, fieldsSet: true }), null, JSON.stringify(extra));
  }
  // One row that passes, then each failing case on its own.
  const x = { id: "a1", company_name: "Acme", title: "Software Intern", apply_url: "https://jobs.example/a1", status: "open", insights: {} };
  const rows = [x], ok = { ...base, rows, rel: new Map(), ranked: false, fieldsSet: true };
  assert.equal(P.pick({ ...ok, placements: [placementFor(x)] }).x, x);
  assert.equal(P.pick({ ...ok, placements: [placementFor(x, { apply_url: "https://jobs.example/a1/" })] }).x, x, "a trailing slash is the same link");
  const fails = {
    "closed": [{ ...ok, rows: [{ ...x, status: "closed" }] }, placementFor(x)],
    "deadline passed": [{ ...ok, rows: [{ ...x, insights: { deadline: "2026-11-02" } }] }, placementFor(x)],
    "not started": [ok, placementFor(x, { start: "2026-11-04" })],
    "ended (end day is exclusive)": [ok, placementFor(x, { end: DAY })],
    "apply link changed": [ok, placementFor(x, { apply_url: "https://jobs.example/other" })],
    "no search and no field": [{ ...ok, ranked: false, fieldsSet: false }, placementFor(x)],
    "Your progress is set": [{ ...ok, appState: "applied" }, placementFor(x)],
    "files still loading": [{ ...ok, loading: true }, placementFor(x)],
    "the profile hides it": [{ ...ok, exclude: () => true }, placementFor(x)],
  };
  for (const [name, [inp, pl]] of Object.entries(fails)) assert.equal(P.pick({ ...inp, placements: [pl] }), null, name);
  // A deadline today still shows; it passes tomorrow.
  assert.ok(P.pick({ ...ok, rows: [{ ...x, insights: { deadline: DAY } }], placements: [placementFor(x)] }));
});

// ---------- T3: relevance floor ----------
test("T3: with a search, a paid listing must already be in the top 50 by relevance, whatever the sort", () => {
  const { IS, P } = loadBoth();
  const mk = (i, extra) => ({ id: "s" + i, company_name: "Co " + String.fromCharCode(66 + (i % 20)) + i, title: "Software Intern " + i, apply_url: "https://jobs.example/" + i,
    status: "open", field_tags: ["cs"], location_raw: "Boston, MA", regions: ["MA"], insights: {}, ...extra });
  const title = Array.from({ length: 60 }, (_, i) => mk(i));
  // "software" only in the description, and a company name that sorts first.
  const weak = mk(99, { title: "Operations Intern", company_name: "Aardvark", description: "You will use software every day." });
  const listings = [...title, weak];
  const env = { ...envFor(IS, null, listings), cq: IS.compileQuery("software", null) };
  for (const sort of ["new", "company", "score", "comp"]) {
    const r = IS.listRows(listings, { ...BASE_F, q: "software", sort }, env);
    assert.ok(r.rows.includes(weak), "the weak match is in the list");
    if (sort === "company") assert.equal(r.rows[0], weak, "the company sort puts it first, so rows[49] would be the wrong yardstick");
    const inp = { placements: [placementFor(weak)], rows: r.rows, rel: r.rel, ranked: r.ranked, fieldsSet: false, appState: "", loading: false, day: DAY, exclude: () => false, hidden: false, prev: null, rand: () => 0 };
    assert.equal(P.pick(inp), null, sort);
    // A title match is among the 50 best and may show.
    assert.equal(P.pick({ ...inp, placements: [placementFor(title[59])] }).x, title[59], sort);
  }
  // With fewer than 50 matches the floor is the last one, so every match can show.
  const few = [...title.slice(0, 10), weak];
  const r = IS.listRows(few, { ...BASE_F, q: "software" }, env);
  assert.equal(P.pick({ placements: [placementFor(weak)], rows: r.rows, rel: r.rel, ranked: true, fieldsSet: false, appState: "", loading: false, day: DAY, exclude: () => false, hidden: false, prev: null, rand: () => 0 }).x, weak);
});

// ---------- the app.js components, in a stand-in React ----------
function uiHarness() {
  const slots = []; let cursor = 0, pending = [];
  const react = {
    Fragment: "fragment", memo: fn => fn,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(x => x != null && x !== false) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useId() { return "id" + cursor++; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((x, j) => x !== old.deps[j])) { slots[i] = { deps }; pending.push(fn); } },
  };
  const ctx = context({ React: react, CONFIG: {} });
  vm.runInContext(CORE_SRC, ctx);
  vm.runInContext(PLACE_SRC, ctx);
  vm.runInContext(APP_SRC.replace('ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
    'window.components = { ListTable, Row, Why, factsLine, matchControl };'), ctx);
  return { c: ctx.components, P: ctx.ISPlace, IS: ctx.IS, h: react.createElement,
    render(component, props) { cursor = 0; pending = []; const tree = component(props); pending.forEach(fn => fn()); return tree; },
    reset() { slots.length = 0; } };
}
const nodes = (tree, pred) => !tree || typeof tree !== "object" ? [] : [...(pred(tree) ? [tree] : []), ...tree.children.flatMap(c => nodes(c, pred))];
const text = n => typeof n === "string" || typeof n === "number" ? String(n) : n && typeof n === "object" ? n.children.map(text).join("") : "";
const ROW = { id: 7, company_name: "Acme Robotics", title: "Software Engineering Intern", apply_url: "https://boards.greenhouse.io/acme/jobs/1", ats: "greenhouse", status: "open",
  field_tags: ["cs"], location_raw: "Austin, TX", regions: ["TX"], term: "Summer 2027", insights: {}, salary: "$28/hr" };
function boxFor(H, extra = {}) {
  const { c, h } = H;
  return h(H.P.PaidBox, { x: ROW, phone: false, facts: c.factsLine(ROW, new Set(["TX"])),
    renderMatch: (open, toggle, panelId) => c.matchControl({ r: ROW, sc: { score: 86, parts: {} }, scored: true, open, onToggle: toggle, onRank() {}, panelId }),
    renderWhy: close => h(c.Why, { r: ROW, sc: { score: 86, parts: {} }, ctx: { p: {}, direct: new Set(), related: new Set() }, elig: null, patterns: null, onClose: close }),
    onHide() {}, ...extra });
}
const renderBox = (H, extra) => { const el = boxFor(H, extra); return H.render(el.type, el.props); };

// ---------- T4: counts ----------
test("T4: the list, its counts and its end line are the same with and without the paid box", () => {
  const H = uiHarness();
  const mkRows = n => Array.from({ length: n }, (_, i) => ({ id: "r" + i }));
  const renderRow = r => ({ type: "ROW", props: { key: r.id }, children: [] });
  for (const n of [0, 1, 2, 3, 5, 150]) {
    const shown = mkRows(n), rows = mkRows(n + 40);
    for (const phone of [false, true]) {
      const props = { shown, rows, head: { type: "thead", props: {}, children: [] }, renderRow, phone, onMore() {} };
      const without = H.render(H.c.ListTable, { ...props, box: null });
      const box = boxFor(H);
      const withBox = H.render(H.c.ListTable, { ...props, box });
      const summary = t => ({ rows: nodes(t, x => x.type === "ROW").length, end: text(nodes(t, x => x.props.id === "list-end")[0]),
        more: text(nodes(t, x => x.props.className === "more")[0] || null), skip: nodes(t, x => x.props.className === "skip inline").length });
      assert.deepEqual(summary(withBox), summary(without), `${n} rows, ${phone ? "phone" : "desktop"}`);
      assert.equal(summary(without).rows, n);
      assert.equal(summary(without).end, `End of the ${n.toLocaleString()} listings shown`);
      assert.equal(nodes(without, x => x === box).length, 0);
      // At most one box (MAX_PER_PAGE), and where it goes.
      const at = nodes(withBox, x => x === box);
      assert.equal(at.length, n ? 1 : (phone ? 0 : 1));
      const tbody = nodes(withBox, x => x.type === "tbody")[0];
      if (phone && n) {
        const i = tbody.children.findIndex(k => k.props.className === "paid-row");
        assert.equal(i, Math.min(3, n), "after the third card, or after the last when there are fewer");
        assert.equal(tbody.children[i].children[0].props.colSpan, 5);
      } else {
        assert.equal(nodes(tbody, x => x === box).length, 0, "on a wide screen the box is outside the table");
      }
    }
  }
  assert.equal(H.P.MAX_PER_PAGE, 1);
  // Every count and the selection in app.js come from rows and shown, never from the box.
  const lines = APP_SRC.split(/\r?\n/);
  for (const re of [/const shown = rows\.slice\(0, limit\)/, /const liveText = /, /listings shown`/, /shown\.length\.toLocaleString\(\)\} of \$\{rows\.length/, /className: "countline"/, /const selectable = /, /const allChecked = /, /const moreCount = /]) {
    const hits = lines.filter(l => re.test(l));
    assert.ok(hits.length, String(re));
    for (const l of hits) assert.doesNotMatch(l, /plac|ISPlace|PL\./i, l.trim());
  }
  assert.match(APP_SRC, /const selectable = shown\.filter\(/);
});

// ---------- T5 and T8: what the box has, and what it never has ----------
test("T5: the paid box has no checkbox, no status, no Auto-Apply button and no data-aa", () => {
  const H = uiHarness();
  for (const phone of [false, true]) {
    const tree = renderBox(H, { phone });
    assert.equal(nodes(tree, n => n.type === "input").length, 0);
    assert.equal(nodes(tree, n => n.type === "select").length, 0);
    assert.equal(nodes(tree, n => /Auto-Apply/.test(text(n)) && (n.type === "button" || n.type === "a")).length, 0);
    assert.equal(nodes(tree, n => "data-aa" in n.props).length, 0);
    assert.equal(nodes(tree, n => n.props.onCheck || n.props.onAuto).length, 0);
  }
  assert.doesNotMatch(PLACE_SRC.replace(/^\s*\/\/.*$/gm, ""), /data-aa|applicationBatch|selectRows|autoApply|ext\.call/);
});

test("T8: headed Paid listing, Ad before the company name, and a sponsored link", () => {
  const H = uiHarness();
  for (const phone of [false, true]) {
    const tree = renderBox(H, { phone });
    assert.equal(tree.type, "section");
    assert.equal(tree.props["aria-label"], "Paid listing, not part of the ranked results");
    const heads = nodes(tree, n => /^h[1-6]$/.test(n.type));
    assert.equal(text(heads[0]), "Paid listing");
    const all = text(tree);
    assert.ok(all.indexOf("Paid listing") < all.indexOf("Ad"));
    const head = nodes(tree, n => n.props.className === "li-head")[0];
    assert.equal(head.children[0].props.className, "ad");
    assert.equal(text(head.children[0]), "Ad");
    assert.ok(text(head).indexOf("Ad") < text(head).indexOf("Acme Robotics"));
    const links = nodes(tree, n => n.type === "a" && n.props.href === ROW.apply_url);
    assert.equal(links.length, 1);
    assert.equal(links[0].props.rel, "sponsored noopener");
    assert.equal(links[0].props.target, "_blank");
    assert.match(text(links[0]), /^Open posting/);
    // The Match control is the row's own (matchControl), with the same score.
    assert.match(text(tree), /Match 86/);
    assert.match(all, phone ? /Also in the list at its usual place\./ : /Also in the results below at its usual place\./);
  }
  // Never the words the plan rules out.
  assert.doesNotMatch(PLACE_SRC.replace(/^\s*\/\/.*$/gm, ""), /Sponsored|Promoted|Featured/);
  // The same words as the landing pages' box (backend/internscout/seo_pages.py placement_box).
  const seo = read("backend/internscout/seo_pages.py");
  for (const w of ["Paid listing", '"ad">Ad<', "Why am I seeing this?", "Open posting", 'rel="sponsored noopener"']) assert.ok(seo.includes(w), w);
  for (const w of ['"Paid listing"', '"Ad"', '"Why am I seeing this?"', '"Open posting"', '"sponsored noopener"']) assert.ok(PLACE_SRC.includes(w), w);
  // Both boxes link to the ad disclosure, #paid-listings, never #paid (the paid plans section).
  assert.match(seo, /href="\/privacy\.html#paid-listings">Why am I seeing this\?/);
  assert.deepEqual([...PLACE_SRC.replace(/^\s*\/\/.*$/gm, "").match(/privacy\.html#[a-z-]+/g)], ["privacy.html#paid-listings"]);
  const privacy = read("docs/privacy.html");
  assert.match(privacy, /<h2 id="paid-listings">Paid listings<\/h2>/);
});

test("Why am I seeing this? opens inline, and the Why panel opens inside the box", () => {
  const H = uiHarness();
  let hidden = 0;
  let tree = renderBox(H, { onHide: () => hidden++ });
  const btn = name => nodes(tree, n => n.type === "button" && text(n).startsWith(name))[0];
  assert.equal(btn("Why am I seeing this?").props["aria-expanded"], false);
  btn("Why am I seeing this?").props.onClick(); tree = renderBox(H, { onHide: () => hidden++ });
  assert.equal(btn("Why am I seeing this?").props["aria-expanded"], true);
  const about = nodes(tree, n => n.props.className === "paid-about")[0];
  assert.match(text(about), /An employer paid to show this listing here\. Paying doesn't change match scores, order or filters\./);
  assert.match(text(about), /Your saved profile can hide a paid listing that doesn't fit you, but it is never used to pick one, and it stays in your browser\./);
  assert.equal(btn("Why am I seeing this?").props["aria-controls"], about.props.id);
  btn("Match").props.onClick(); tree = renderBox(H, { onHide: () => hidden++ });
  const why = nodes(tree, n => n.props.className === "paid-why")[0];
  assert.ok(why, "the Why panel opens in the box");
  assert.equal(btn("Match").props["aria-controls"], why.props.id);
  assert.notEqual(why.props.id, "why-" + ROW.id, "not the organic row's panel id");
  btn("Hide paid listings").props.onClick();
  assert.equal(hidden, 1);
  // No em dash in anything a student reads.
  assert.doesNotMatch(text(tree), /—/);
});

// ---------- T6: what selection reads ----------
test("T6: pick reads only its own inputs, and placements.js never touches the extension, sign-in or marks", () => {
  const { P } = loadBoth();
  const allowed = new Set(["placements", "rows", "rel", "ranked", "fieldsSet", "appState", "loading", "day", "exclude", "hidden", "prev", "rand"]);
  const x = { id: "a1", apply_url: "https://jobs.example/a1", status: "open", insights: {} };
  const inp = { placements: [placementFor(x)], rows: [x], rel: new Map(), ranked: false, fieldsSet: true, appState: "", loading: false, day: DAY, exclude: () => false, hidden: false, prev: null, rand: () => 0 };
  const guard = new Proxy(inp, { get(t, k) { if (typeof k === "string" && !allowed.has(k)) throw new Error("pick read " + k); return t[k]; } });
  assert.equal(P.pick(guard).x, x);
  const code = PLACE_SRC.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /IS\.ext|bridgeProfile|storedToken|SESSION_KEY|loadProfile|appstate\.v1|localStorage|sessionStorage|window\.IS\b|IS\.ls|document\.cookie|postMessage|navigator\./);
  // The only network request is the one same-origin data file.
  assert.equal((code.match(/fetch\(/g) || []).length, 1);
  assert.match(code, /fetch\(\(C\.dataUrl \|\| "\.\/data\/"\) \+ FILE/);
});

// ---------- hiding, stickiness, loading ----------
test("Hide paid listings: pick returns nothing, and the setting is never a filter, a saved search or an address", () => {
  const { P, IS } = loadBoth();
  const x = { id: "a1", apply_url: "https://jobs.example/a1", status: "open", insights: {} };
  const inp = { placements: [placementFor(x)], rows: [x], rel: new Map(), ranked: true, fieldsSet: true, appState: "", loading: false, day: DAY, exclude: () => false, hidden: true, prev: null, rand: () => 0 };
  assert.equal(P.pick(inp), null);
  assert.equal(P.HIDE_KEY, "internscout.placements.hidden.v1");
  // Not in the filters: the URL names, the More filters count and the saved searches are all built from `f`.
  assert.ok(!IS.FILTER_PARAMS || !JSON.stringify(IS.FILTER_PARAMS).includes("plac"));
  assert.doesNotMatch(APP_SRC, /upd\("plac|f\.plac|placeHidden[^\n]*keepSaved|keepSaved[^\n]*placeHidden/);
  const moreCount = APP_SRC.split(/\r?\n/).filter(l => /moreCount = |\+ \(f\.hide_citizen !== defaults/.test(l)).join("\n");
  assert.doesNotMatch(moreCount, /plac/i);
  // The More filters switch exists, and only once there are placements to show.
  assert.match(APP_SRC, /placements\.length > 0 && h\("label", \{ className: "field toggle"[^\n]*\n[^\n]*checked: !placeHidden[^\n]*"Show paid listings"\)/);
});

test("stickiness: the last pick stays while it still fits, without drawing again", () => {
  const { P } = loadBoth();
  const xs = Array.from({ length: 4 }, (_, i) => ({ id: "a" + i, apply_url: "https://jobs.example/a" + i, status: "open", insights: {} }));
  const pls = xs.map(x => placementFor(x));
  const base = { placements: pls, rows: xs, rel: new Map(), ranked: false, fieldsSet: true, appState: "", loading: false, day: DAY, exclude: () => false, hidden: false };
  const first = P.pick({ ...base, prev: null, rand: () => 0.6 });
  assert.equal(first.pl.id, "p-a2");
  const again = P.pick({ ...base, prev: first, rand: () => { throw new Error("rand called"); } });
  assert.equal(again.pl.id, "p-a2");
  // Once it no longer fits, another is drawn, each with an equal chance.
  const next = P.pick({ ...base, rows: xs.filter(x => x.id !== "a2"), prev: first, rand: () => 0 });
  assert.equal(next.pl.id, "p-a0");
  const seen = new Set();
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) seen.add(P.pick({ ...base, prev: null, rand: () => r }).pl.id);
  assert.deepEqual([...seen].sort(), ["p-a0", "p-a1", "p-a2", "p-a3"]);
});

test("load: one same-origin fetch, nothing on a missing or bad file, and none at all when switched off", async () => {
  const body = { day: DAY, placements: [placementFor({ id: "a1", apply_url: "https://jobs.example/a1", company_name: "Acme" }), { id: "bad id" }] };
  const calls = [];
  const run = async (fetchImpl, config = { dataUrl: "./data/" }) => {
    calls.length = 0;
    const { P } = loadBoth({ CONFIG: config, fetch: (u, o) => { calls.push([u, o]); return fetchImpl(u); } });
    const a = await P.load(), b = await P.load();
    assert.equal(a, b);
    return plain(a);
  };
  assert.deepEqual(await run(() => Promise.resolve({ ok: true, json: async () => body })), [placementFor({ id: "a1", apply_url: "https://jobs.example/a1", company_name: "Acme" })]);
  assert.deepEqual(calls.map(c => c[0]), ["./data/placements.json"]);
  assert.deepEqual(await run(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) })), []);
  assert.deepEqual(await run(() => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError("bad"); } })), []);
  assert.deepEqual(await run(() => Promise.reject(new Error("offline"))), []);
  assert.deepEqual(await run(() => Promise.resolve({ ok: true, json: async () => ({ placements: "nope" }) })), []);
  assert.deepEqual(await run(() => { throw new Error("should not fetch"); }, { dataUrl: "./data/", placements: false }), []);
  assert.equal(calls.length, 0);
  // The page's config has the switch, on.
  assert.match(read("docs/index.html"), /placements: true,/);
});

test("index.html loads placements.js between core.js and app.js, deferred", () => {
  const html = read("docs/index.html");
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => m[0]);
  const at = s => srcs.findIndex(t => t.includes(s));
  assert.ok(at("js/core.js") < at("js/placements.js") && at("js/placements.js") < at("js/app.js"));
  assert.match(srcs[at("js/placements.js")], /\sdefer\b/);
});

// ---------- colours ----------
test("the box's text pairs pass WCAG AA in light and dark", () => {
  const css = read("docs/index.html");
  const tok = (block, k) => (block.match(new RegExp("--" + k + ":(#[0-9a-f]{6})")) || [])[1];
  const light = css.slice(css.indexOf(":root{"), css.indexOf("}", css.indexOf(":root{")));
  const darkAt = css.indexOf("@media (prefers-color-scheme:dark){:root{");
  const dark = css.slice(darkAt, css.indexOf("}", darkAt));
  const lum = hex => { const n = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, block] of [["light", light], ["dark", dark]]) {
    for (const fg of ["ink", "ink2", "ink3", "accent"]) assert.ok(ratio(tok(block, fg), tok(block, "sunk")) >= 4.5, `${name} ${fg} on sunk`);
    assert.ok(ratio(tok(block, "ink3"), tok(block, "sunk")) >= 3, `${name} the Ad badge's edge`);
  }
  assert.match(css, /\.paid\{[^}]*background:var\(--sunk\)/);
  assert.match(css, /\.ad\{[^}]*color:var\(--ink2\)/);
});

// Legal review (2026-10-14): nothing from the extension may decide whether a paid listing is hidden.
test("the paid listing's hide check uses the dashboard profile only, never the extension's", () => {
  const ex = APP_SRC.match(/const exclude = useCallback\(([\s\S]*?)\]\);/);
  assert.ok(ex, "exclude found");
  assert.doesNotMatch(ex[1], /\belig\b|extProfile/, "exclude never reads elig or extProfile");
  assert.match(ex[1], /blockers\(x, placeElig\)/);
  assert.match(APP_SRC, /const placeElig = useMemo\(\(\) => \(p \? eligOf\(p, null\) : null\), \[p\]\);/);
  // The row list's own eligibility check still uses both, as before.
  assert.match(APP_SRC, /const elig = useMemo\(\(\) => \(!p && !extProfile \? null : eligOf\(p, extProfile\)\), \[p, extProfile\]\);/);
});
