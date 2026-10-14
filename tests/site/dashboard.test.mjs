// Dashboard selection, queueing and list order (the PR #94 review's dashboard P2s). core.js is loaded the
// way the page loads it, against a stand-in `window`; the order tests run on the real listing files in
// docs/data/listings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const CORE = readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8");
function loadCore() {
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = {
    CONFIG: {}, fetch: () => new Promise(() => {}), localStorage: store(), sessionStorage: store(),
    addEventListener() {}, postMessage() {}, setTimeout, clearTimeout, AbortController, TextDecoder,
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash: "" },
    document: { documentElement: { dataset: {} } }, console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  return ctx.IS;
}
const IS = loadCore();
const rows = n => Array.from({ length: n }, (_, i) => ({ id: "r" + i, apply_url: "https://jobs.example/" + i }));

test("the header checkbox can always clear what it selected, even when a row past the first 100 is picked", () => {
  const shown = rows(150);
  // The student ticks row 121, then the header.
  let sel = new Set([shown[120].id]);
  assert.equal(IS.headerChecked(shown, sel), false);
  let r = IS.selectRows(sel, shown, true); sel = r.sel;
  assert.equal(sel.size, 100); assert.equal(r.omitted, 50);
  // was: checked only when the first 100 shown were all picked; row 100 is not (row 121 took its place),
  // so the box stayed unchecked and the next click selected again instead of clearing.
  assert.equal(IS.headerChecked(shown, sel), true);
  r = IS.selectRows(sel, shown, false); sel = r.sel;
  assert.equal(sel.size, 0); assert.equal(IS.headerChecked(shown, sel), false);
});

test("the header checkbox is checked when every shown row is picked, and not for a selection made elsewhere", () => {
  const shown = rows(30);
  assert.equal(IS.headerChecked([], new Set()), false);
  assert.equal(IS.headerChecked(shown, new Set(shown.map(r => r.id))), true);
  assert.equal(IS.headerChecked(shown, new Set(shown.slice(1).map(r => r.id))), false);
  // A full selection from another search holds none of these rows: a click has something to say (the limit).
  const elsewhere = new Set(rows(130).slice(30).map(r => r.id));
  assert.equal(IS.headerChecked(shown, elsewhere), false);
  const r = IS.selectRows(elsewhere, shown, true);
  assert.equal(r.sel.size, 100); assert.equal(r.omitted, 30);
  // Clearing the shown rows leaves the rest of the selection alone.
  const mixed = new Set(["x1", "x2", ...shown.map(r => r.id)]);
  assert.deepEqual([...IS.selectRows(mixed, shown, false).sel], ["x1", "x2"]);
});

test("a listing skipped because another listing's job holds its apply link counts as handled", () => {
  const queue = { order: ["j1", "j2"], jobs: {
    j1: { id: "j1", listingId: "A", apply_url: "https://jobs.example/shared", status: "queued" },
    j2: { id: "j2", listingId: "C", apply_url: "https://jobs.example/c", status: "queued" },
  } };
  const batch = [
    { id: "B", apply_url: "https://jobs.example/shared" },  // same link as A, already queued
    { id: "C", apply_url: "https://jobs.example/c" },       // added in this batch
    { id: "D", apply_url: "https://jobs.example/d" },       // neither: stays selected
  ];
  const res = { added: ["j2"], skipped: ["j1"] };
  // was: only the jobs' own listing ids (A and C), so B stayed selected however often it was queued.
  assert.deepEqual(IS.queuedListingIds([...res.added, ...res.skipped], queue), ["C", "A"]);
  assert.deepEqual(IS.handledListingIds(batch, res, queue), ["B", "C"]);
  assert.deepEqual(IS.handledListingIds(batch, res, null), []);
  assert.deepEqual(IS.handledListingIds(batch, {}, queue), []);
});

test("links held by a live job are left out of the header selection; a failed job's link is free again", () => {
  const queue = { jobs: {
    j1: { listingId: "A", apply_url: "https://jobs.example/a", status: "queued" },
    j2: { listingId: "B", apply_url: "https://jobs.example/b", status: "failed" },
    j3: { listingId: "C", apply_url: "https://jobs.example/c", status: "submitted" },
  } };
  assert.deepEqual([...IS.heldUrls(queue)].sort(), ["https://jobs.example/a", "https://jobs.example/c"]);
  assert.equal(IS.heldUrls(null).size, 0);
});

test("the shared apply links the review counted are in the data", () => {
  // Not a fixed number (the data changes daily); the case only has to exist for the fix to matter.
  const all = loadAll();
  const byUrl = new Map();
  for (const x of all) if (x.apply_url) byUrl.set(x.apply_url, (byUrl.get(x.apply_url) || 0) + 1);
  assert.ok([...byUrl.values()].some(n => n > 1));
});

// ---------- list order ----------
let cached = null;
function loadAll() {
  if (cached) return cached;
  const dir = new URL("../../docs/data/listings/", import.meta.url);
  const byId = new Map();
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && !f.endsWith(".desc.json") && f !== "index.json").sort()) {
    const list = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    if (Array.isArray(list)) for (const x of list) if (x && x.id != null && !byId.has(x.id)) byId.set(x.id, x);
  }
  return (cached = [...byId.values()]);
}
// The comparators docs/js/app.js used before IS.sortRows, copied as they were.
function legacySort(r, sort, S, ranked, rel) {
  const R = (a, b) => ranked ? rel.get(b) - rel.get(a) : 0;
  const newer = (a, b) => (b.posted_at ? 1 : 0) - (a.posted_at ? 1 : 0) || (b.posted_at || "").localeCompare(a.posted_at || "") || (b.first_seen || "").localeCompare(a.first_seen || "");
  if (sort === "score") r.sort((a, b) => (S(a).mismatch - S(b).mismatch) || R(a, b) || (S(b).score - S(a).score) || newer(a, b));
  else if (sort === "new") r.sort((a, b) => (S(a).mismatch - S(b).mismatch) || R(a, b) || newer(a, b));
  else if (sort === "company") r.sort((a, b) => a.company_name.localeCompare(b.company_name));
  else if (sort === "comp") r.sort((a, b) => (IS.realSalary(b) ? 1 : 0) - (IS.realSalary(a) ? 1 : 0) || R(a, b) || S(b).score - S(a).score);
  return r;
}
const MAJORS = JSON.parse(readFileSync(new URL("../../docs/data/majors.json", import.meta.url), "utf8"));
const PROFILES = {
  none: null,
  cs: { ...IS.emptyProfile(), majors: ["Computer Science"], class_year: "junior", grad_term: "Spring 2028", states: ["MA", "NY"], work_auth: "citizen" },
  nursing: { ...IS.emptyProfile(), majors: ["Nursing"], class_year: "sophomore", grad_term: "Spring 2029", states: [] },
};
const scorer = p => {
  const { direct, related } = IS.profileFields(p, MAJORS);
  const ctx = { p, direct, related, keys: new Set(IS.profileKeys(p)), anywhere: !(p && p.states && p.states.length) };
  const m = new WeakMap();
  return x => { let v = m.get(x); if (!v) { v = IS.score(x, ctx); m.set(x, v); } return v; };
};
const ids = list => list.map(x => x.id);

test("the list comes out in exactly the old order for every sort, profile and search, on the real data", () => {
  const all = loadAll();
  assert.ok(all.length > 1000, "the listing files should be in docs/data/listings");
  const searches = [null, "software engineer", "nursing", "boston", "marketing -unpaid"];
  for (const [name, p] of Object.entries(PROFILES)) {
    const S = scorer(p);
    for (const q of searches) {
      let base = all, rel = null, ranked = false;
      if (q) {
        const cq = IS.compileQuery(q, IS.placeWords(all));
        rel = new Map(); base = [];
        for (const x of all) { const m = IS.matchScore(x, cq); if (m) { rel.set(x, m); base.push(x); } }
        ranked = cq.terms.some(t => !t.neg && !t.place);
      }
      for (const sort of ["score", "new", "company", "comp"]) {
        const want = ids(legacySort(base.slice(), sort, S, ranked, rel));
        const got = ids(IS.sortRows(base.slice(), sort, S, ranked ? rel : null));
        assert.deepEqual(got, want, `profile ${name}, search ${JSON.stringify(q)}, sort ${sort}`);
      }
    }
  }
});

test("rows that arrive file by file, scored once each, sort the same as all rows at once", () => {
  // The page keeps each row's score as its file lands and only sorts again; the result has to match a
  // fresh score of everything.
  const all = loadAll();
  const p = PROFILES.cs, cachedS = scorer(p), seen = [];
  const files = [];
  for (let i = 0; i < all.length; i += 2500) files.push(all.slice(i, i + 2500));
  let got = [];
  for (const f of files) { seen.push(...f); got = ids(IS.sortRows(seen.slice(), "score", cachedS, null)); }
  const want = ids(legacySort(all.slice(), "score", scorer(p), false, null));
  assert.deepEqual(got, want);
});

test("an unknown sort leaves the order alone", () => {
  const list = rows(5);
  assert.deepEqual(ids(IS.sortRows(list.slice(), "nope", () => ({}), null)), ids(list));
});
