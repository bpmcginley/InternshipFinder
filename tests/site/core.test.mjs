// docs/js/core.js runs in the browser with no build step and no exports, so it is loaded here the way
// the page loads it: evaluated against a stand-in `window`, after which it hangs its API on window.IS.
// Kept outside docs/ so the test isn't published with the site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CORE = readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8");

// A fresh copy of core.js for each test, with `fetch` answered by the test.
function loadCore(fetchImpl) {
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = {
    CONFIG: { dataUrl: "./data/", rawDataFallback: "https://raw.example/data/" },
    fetch: fetchImpl, localStorage: store(), sessionStorage: store(),
    addEventListener() {}, postMessage() {}, setTimeout, clearTimeout,
    AbortController, TextDecoder,
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash: "" },
    document: { documentElement: { dataset: {} } },
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  return ctx.IS;
}

const ok = body => Promise.resolve({ ok: true, status: 200, json: async () => body });
const notFound = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
const MAJORS = { majors: [{ name: "Nursing", tags: ["nursing", "health"], related: [] }], fields: ["nursing", "health"] };

test("step 1 says the majors are loading, not that they failed, until the fetch settles", () => {
  const IS = loadCore(() => new Promise(() => {}));
  const loading = IS.majorsNote(null, false);
  assert.match(loading, /^Loading/);
  assert.doesNotMatch(loading, /didn't load/);
  assert.match(IS.majorsNote(null, true), /didn't load/);
  assert.equal(IS.majorsNote(MAJORS, true), null);
  assert.equal(IS.majorsNote(MAJORS, false), null);
});

const shardIndex = { files: { MA: { file: "listings/MA.json", desc: "listings/MA.desc.json" }, CT: { file: "listings/CT.json", desc: "listings/CT.desc.json" } } };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("concurrent description consumers both wait for posting context", async () => {
  let release;
  const IS = loadCore(url => url.endsWith("index.json") ? ok(shardIndex) : url.endsWith(".desc.json")
    ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ a: "Required Python" }) }); })
    : ok([{ id: "a" }]));
  const store = IS.createStore(); await store.init(); await store.ensure(["MA"]);
  const first = store.descs(["MA"]); await tick();
  let settled = false; const second = store.descs(["MA"]).then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  release(); await Promise.all([first, second]);
  assert.equal(store.all()[0].description, "Required Python");
});

test("a failed description download reports incompleteness and can recover without reloading", async () => {
  // was: one failure was enough; descriptions now get the listing files' quiet retry, so it takes two.
  let attempts = 0;
  const IS = loadCore(url => url.endsWith("index.json") ? ok(shardIndex) : url.endsWith(".desc.json")
    ? ++attempts <= 2 ? Promise.reject(new Error("offline")) : ok({ a: "Required SQL" }) : ok([{ id: "a" }]));
  const store = IS.createStore({ retryDelayMs: 0 }); await store.init(); await store.ensure(["MA"]);
  assert.deepEqual([...await store.descs(["MA"])], ["MA"]);
  assert.deepEqual([...await store.descs(["MA"])], []);
  assert.equal(attempts, 3); assert.equal(store.all()[0].description, "Required SQL");
});

test("a description file gets one quiet retry, like a listing file", async () => {
  let attempts = 0;
  const IS = loadCore(url => url.endsWith("index.json") ? ok(shardIndex) : url.endsWith(".desc.json")
    ? ++attempts === 1 ? Promise.reject(new Error("connection reset")) : ok({ a: "Required SQL" }) : ok([{ id: "a" }]));
  const store = IS.createStore({ retryDelayMs: 0 }); await store.init(); await store.ensure(["MA"]);
  assert.deepEqual([...await store.descs(["MA"])], []);
  assert.equal(attempts, 2); assert.equal(store.all()[0].description, "Required SQL");
});

// A response whose body arrives in pieces, every `everyMs`, and stops after `stallAfter` pieces.
function streamed(body, signal, { pieces = 12, everyMs = 15, stallAfter = Infinity } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const size = Math.ceil(bytes.length / pieces);
  let i = 0;
  const read = () => new Promise((resolve, reject) => {
    if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")));
    if (i >= stallAfter) return;
    setTimeout(() => {
      const at = i++ * size;
      resolve(at >= bytes.length ? { done: true, value: undefined } : { done: false, value: bytes.slice(at, at + size) });
    }, everyMs);
  });
  const json = async () => {
    const got = [];
    for (let r = await read(); !r.done; r = await read()) got.push(...r.value);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(got)));
  };
  return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({ read }) }, json });
}

test("a slow file that keeps arriving is not cancelled, however long it takes", async () => {
  // About 13 pieces 15 ms apart: four times the 50 ms limit in all, but never 50 ms without a byte.
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: "ca" + i, title: "Intern, Montréal et São Paulo" }));
  const IS = loadCore((url, options) => url.endsWith("index.json") ? ok(shardIndex)
    : url.endsWith("MA.json") ? streamed(rows, options.signal) : notFound());
  const store = IS.createStore({ timeoutMs: 50, retryDelayMs: 0 }); await store.init();
  const started = Date.now();
  assert.deepEqual([...await store.ensure(["MA"])], []);
  assert.ok(Date.now() - started > 100, "the download took longer than the limit");
  assert.equal(store.all().length, 40);
  assert.equal(store.all()[0].title, "Intern, Montréal et São Paulo", "multi-byte text split across pieces survives");
});

test("a file that stops arriving part-way is cancelled after the quiet limit, and the rest still load", async () => {
  const signals = [];
  const IS = loadCore((url, options) => {
    if (url.endsWith("index.json")) return ok(shardIndex);
    if (url.endsWith("MA.json")) return ok([{ id: "ma" }]);
    signals.push(options.signal);
    return streamed([{ id: "ct" }], options.signal, { pieces: 4, everyMs: 5, stallAfter: 1 });
  });
  const store = IS.createStore({ timeoutMs: 40, retryDelayMs: 0 }); await store.init();
  const started = Date.now();
  assert.deepEqual([...await store.ensure(["MA", "CT"])], ["CT"]);
  assert.ok(Date.now() - started < 1000, "a stalled body does not hang the page");
  assert.equal(signals.length, 2, "one quiet retry"); assert.ok(signals.every(s => s.aborted));
  assert.deepEqual([...store.all()].map(x => x.id), ["ma"]);
});

test("healthy states publish results while a stalled shard times out, then retry recovers", async () => {
  let recover = false; const signals = []; const published = [];
  const IS = loadCore((url, options) => {
    if (url.endsWith("index.json")) return ok(shardIndex);
    if (url.endsWith("MA.json")) return ok([{ id: "ma" }]);
    if (recover) return ok([{ id: "ct" }]);
    signals.push(options.signal); return new Promise(() => {});
  });
  const store = IS.createStore({ timeoutMs: 15, retryDelayMs: 0 }); await store.init();
  const request = store.ensure(["MA", "CT"], () => published.push(store.all().map(x => x.id)));
  await tick(); assert.deepEqual([...published[0]], ["ma"], "successful rows appear before all downloads finish");
  assert.deepEqual([...await request], ["CT"]); assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted), "timed-out requests are aborted");
  recover = true; assert.deepEqual([...await store.ensure(["CT"])], []);
  assert.deepEqual([...store.all()].map(x => x.id).sort(), ["ct", "ma"]);
});

test("a reload discards late listing and description responses from the previous data generation", async () => {
  let releaseListing, releaseDescription, old = true;
  const IS = loadCore(url => {
    if (url.endsWith("index.json")) return ok(shardIndex);
    if (url.endsWith("CT.json") && old) return new Promise(resolve => { releaseListing = () => resolve({ ok: true, json: async () => [{ id: "old-ct" }] }); });
    if (url.endsWith(".desc.json") && old) return new Promise(resolve => { releaseDescription = () => resolve({ ok: true, json: async () => ({ a: "Old description" }) }); });
    return ok([{ id: "a" }]);
  });
  const store = IS.createStore(); await store.init(); await store.ensure(["MA"]);
  const listing = store.ensure(["CT"]), description = store.descs(["MA"]); await tick();
  old = false; await store.init(); await store.ensure(["MA"]);
  releaseListing(); releaseDescription(); await Promise.all([listing, description]);
  assert.deepEqual([...store.all()].map(x => x.id), ["a"]); assert.equal(store.all()[0].description, undefined);
});

test("description download timeout is retryable and missing legacy sidecars remain compatible", async () => {
  let stalled = true;
  const IS = loadCore(url => url.endsWith("index.json") ? ok(shardIndex) : url.endsWith(".desc.json")
    ? stalled ? new Promise(() => {}) : ok({ a: "Recovered" }) : ok([{ id: "a" }]));
  const store = IS.createStore({ timeoutMs: 10, retryDelayMs: 0 }); await store.init(); await store.ensure(["MA"]);
  assert.deepEqual([...await store.descs(["MA"])], ["MA"]);
  stalled = false; assert.deepEqual([...await store.descs(["MA"])], []);
  const legacyIS = loadCore(url => url.endsWith("index.json") ? ok({ files: { MA: { file: "MA.json" } } }) : url.endsWith(".desc.json") ? notFound() : ok([{ id: "a", description: "Inline context" }]));
  const legacy = legacyIS.createStore(); await legacy.init(); await legacy.ensure(["MA"]);
  assert.deepEqual([...await legacy.descs(["MA"])], []); assert.equal(legacy.all()[0].description, "Inline context");
});

test("regional and Canadian remote roles use the same remote predicate as nationwide roles", () => {
  const IS = loadCore(notFound);
  assert.equal(IS.isRemote({ is_remote: true, regions: [{ kind: "new_england", state: "MA", loc: "Massachusetts, Virtual Address" }] }), true);
  assert.equal(IS.isRemote({ regions: [{ kind: "canada", state: "ON", loc: "Remote - Ontario" }] }), true);
  assert.equal(IS.isRemote({ regions: [{ kind: "remote", state: "Remote", loc: "USA" }] }), true);
  assert.equal(IS.isRemote({ regions: [{ kind: "us", state: "TX", loc: "Austin, TX" }] }), false);
});

test("placeholder salaries cannot masquerade as disclosed pay, while independent paid status survives", () => {
  const IS = loadCore(notFound);
  for (const salary of ["$0.00 /Yr", "$0.00 - $0.00 Per Hour", "$0.00 - $999.99 Hour"]) {
    assert.equal(IS.realSalary({ salary }), ""); assert.equal(IS.payOf({ salary }), null);
    assert.equal(IS.payOf({ salary, insights: { pay: "paid" } }), "paid");
  }
  assert.equal(IS.realSalary({ salary: "$20 - $30 /hour" }), "$20 - $30 /hour");
  assert.equal(IS.payOf({ salary: "$20 /hour" }), "paid");
});

test("application batches keep overflow explicit and statuses resolve only from confirmed job IDs", () => {
  const IS = loadCore(notFound);
  const listings = Array.from({ length: 150 }, (_, id) => ({ id, apply_url: `https://example.com/${id}` }));
  const { batch, remaining } = IS.applicationBatch([...listings, listings[0], { id: 151 }]);
  assert.equal(batch.length, 100); assert.equal(remaining.length, 50); assert.equal(remaining[0].id, 100);
  assert.deepEqual([...IS.queuedListingIds(["job-added", "missing"], { jobs: {
    "job-added": { listingId: 7 }, "job-skipped": { listingId: 8 }, "job-unrequested": { listingId: 100 }
  } })], ["7"]);
});

test("loadMajors stays pending while majors.json is still downloading", async () => {
  // The race: the page held null while this promise was pending and showed the failure text.
  let release;
  const IS = loadCore(() => new Promise(resolve => { release = resolve; }));
  const loading = IS.loadMajors();
  const outcome = await Promise.race([
    loading.then(() => "settled"),
    new Promise(r => setTimeout(() => r("pending"), 50)),
  ]);
  assert.equal(outcome, "pending");
  release(await ok(MAJORS)); await loading;
});

test("initial data-source stalls are bounded and the same store can retry successfully", async () => {
  let recover = false; const signals = [];
  const IS = loadCore((url, options) => { if (recover) return ok(shardIndex); signals.push(options.signal); return new Promise(() => {}); });
  const store = IS.createStore({ timeoutMs: 5 });
  await assert.rejects(store.init(), /timed out/);
  assert.ok(signals.length > 1); assert.ok(signals.every(signal => signal.aborted));
  recover = true; assert.equal((await store.init()).legacy, false);
});

test("loadMajors resolves null only after every source has failed", async () => {
  const asked = [];
  const IS = loadCore(url => { asked.push(url); return url.startsWith("https://raw.example/") ? Promise.reject(new Error("offline")) : notFound(); });
  assert.equal(await IS.loadMajors(), null);
  assert.equal(asked.length, 2, "tried the site copy and the raw fallback");
});

test("loadMajors falls back to the raw copy when the site's own copy fails", async () => {
  const IS = loadCore(url => url.startsWith("./data/") ? notFound() : ok(MAJORS));
  const m = await IS.loadMajors();
  assert.equal(m.majors[0].name, "Nursing");
  assert.equal(IS.majorsNote(m, true), null);
});

test("Canadian listings go in their province's file, or Canada's, and the save to the Worker leaves provinces out", () => {
  const IS = loadCore(notFound);
  const toronto = { regions: [{ loc: "Toronto, ON", kind: "canada", state: "ON", metro: "Toronto" }] };
  const anywhere = { regions: [{ loc: "Remote - Canada", kind: "canada", state: null }] };
  const both = { regions: [{ loc: "Toronto, ON", kind: "canada", state: "ON" }, { loc: "Boston, MA", kind: "new_england", state: "MA" }] };
  assert.deepEqual([...IS.shardKeys(toronto)], ["ON"]);
  assert.deepEqual([...IS.shardKeys(anywhere)], ["Canada"]);
  assert.equal(IS.keyLabel("ON"), "Ontario (ON)");
  assert.equal(IS.keyLabel("Canada"), "Canada (no province listed)");
  assert.ok(IS.inCanadaOnly(toronto) && IS.inCanadaOnly(anywhere) && !IS.inCanadaOnly(both));
  // The Worker's /demand refuses a whole save with one code it does not know.
  // was: ["MA", "REMOTE"]. The Worker counts provinces since 2026-10-01; "Canada" (no province) stays here.
  assert.deepEqual([...IS.demandStates({ states: ["MA", "ON", "Canada"], remote: true })], ["MA", "ON", "REMOTE"]);
});

test("the invite nudge is offered once, only to a signed-in student while invites are on", () => {
  const IS = loadCore(notFound);
  const offer = { bonus: { autofill: 3 }, max: 10 };
  const base = { signedIn: true, offer, panelOpen: false, seen: IS.inviteNudgeSeen() };
  assert.equal(base.seen, false, "a fresh browser has not seen it");
  assert.equal(IS.inviteNudgeDue(base), true);
  assert.equal(IS.inviteNudgeDue({ ...base, signedIn: false }), false, "signed out: no invite link to give");
  assert.equal(IS.inviteNudgeDue({ ...base, offer: null }), false, "the Worker offers no invites");
  assert.equal(IS.inviteNudgeDue({ ...base, offer: { bonus: {}, max: 10 } }), false, "an invite worth nothing");
  assert.equal(IS.inviteNudgeDue({ ...base, panelOpen: true }), false, "the invite panel is already open");
  // Shown once: the day it was shown is kept, and any value at all stops it for good.
  assert.equal(IS.INVITE_NUDGE_KEY, "internscout.invite_nudge");
  IS.markInviteNudge();
  assert.match(IS.ls.get(IS.INVITE_NUDGE_KEY), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(IS.inviteNudgeSeen(), true);
  assert.equal(IS.inviteNudgeDue({ ...base, seen: IS.inviteNudgeSeen() }), false);
  // Not now, or opening the panel (from the nudge or the Account menu), replaces the date.
  IS.markInviteNudge("dismissed");
  assert.equal(IS.ls.get(IS.INVITE_NUDGE_KEY), "dismissed");
  IS.markInviteNudge("opened");
  assert.equal(IS.ls.get(IS.INVITE_NUDGE_KEY), "opened");
  assert.equal(IS.inviteNudgeSeen(), true);
});

test("the plans announcement states only what /config serves, and not to paying students", () => {
  const IS = loadCore(() => new Promise(() => {}));
  const cfg = {
    payments: { enabled: true, plans: [
      { plan: "pro", label: "Pro", price: "$8/month", multiplier: 4 },
      { plan: "supporter", label: "Supporter", price: "$4/month", multiplier: 2 }] },
    allowance: { general: { autofill: 12 }, edu: { autofill: 25 }, supporter: { autofill: 50 }, pro: { autofill: 100 } },
  };
  const b = IS.plansBanner(cfg, null);
  assert.equal(b.from, "$4/month");
  assert.equal(b.free, 12);
  assert.equal(b.edu, 25);
  assert.deepEqual(b.plans.map(p => [p.label, p.runs, p.price]), [["Supporter", 50, "$4/month"], ["Pro", 100, "$8/month"]]);
  assert.equal(IS.plansBanner(cfg, { plan: "supporter" }), null);
  assert.ok(IS.plansBanner(cfg, { plan: "free" }));
  assert.equal(IS.plansBanner({ ...cfg, payments: { enabled: false, plans: [] } }, null), null);
  assert.equal(IS.plansBanner({ payments: cfg.payments }, null), null);
});

// The weekly email's "See last Monday's email" link (2026-10-06), worked out from the form's address.
// backend/tests/test_seo_pages.py checks seo_pages.digest_archive against the same cases.
test("digestArchive finds Buttondown's archive from the sign-up form's address, and nothing else", () => {
  const IS = loadCore(notFound);
  assert.equal(IS.digestArchive("https://buttondown.com/api/emails/embed-subscribe/internscout"), "https://buttondown.com/internscout/archive/");
  assert.equal(IS.digestArchive("https://buttondown.email/api/emails/embed-subscribe/intern_scout-2/"), "https://buttondown.com/intern_scout-2/archive/");
  for (const no of ["", undefined, "http://buttondown.com/api/emails/embed-subscribe/x", "https://example.com/api/emails/embed-subscribe/x",
    "https://buttondown.com/api/emails/embed-subscribe/x/../y", "https://buttondown.com/api/emails/embed-subscribe/a\"onmouseover=x"]) {
    assert.equal(IS.digestArchive(no), "", String(no));
  }
});

// Added 2026-10-07: the dashboard's review line (docs/js/app.js), for a student whose extension is set
// up and has filled applications. The extension's own answer wins, so "Don't ask again" there (false)
// quiets the dashboard too; an older extension that doesn't answer falls back to the queue.
test("the review line is due only with the extension set up and applications filled, and the extension can say no", () => {
  const IS = loadCore(notFound);
  const filled = { jobs: { a: { id: "a", status: "ready_to_submit" } } };
  const working = { jobs: { a: { id: "a", status: "working" } } };
  const on = { installed: true, onboarded: true };
  assert.equal(IS.reviewLineDue({ installed: false }, filled), false, "no extension");
  assert.equal(IS.reviewLineDue({ installed: true, onboarded: false }, filled), false, "Deep Dive not done");
  assert.equal(IS.reviewLineDue(on, filled), true, "an older extension: the queue says it has been used");
  assert.equal(IS.reviewLineDue(on, working), false);
  assert.equal(IS.reviewLineDue({ ...on, review_line: false }, filled), false, "reviewed, or Don't ask again, in the extension");
  assert.equal(IS.reviewLineDue({ ...on, review_line: true }, { jobs: {} }), true, "a cleared queue: the extension's count still says so");
  assert.equal(IS.REVIEW_LINE_KEY, "internscout.review_line");
  assert.match(IS.REVIEWS_URL, /^https:\/\/chromewebstore\.google\.com\/detail\/internscout-auto-apply\/hpnbbpmalfjijnmpoihhjgjolhabjpgi\/reviews$/);
});

// ---------- search reach and ranking (2026-10-14) ----------
const row = (id, o = {}) => ({ id, title: "", company_name: "Acme", field_tags: [], regions: [{ loc: "Boston, MA", state: "MA", kind: "new_england" }], status: "open", ...o });
const find = (IS, q, rows) => { const cq = IS.compileQuery(q, IS.placeWords(rows)); return rows.filter(x => IS.matchScore(x, cq)).map(x => x.id); };

test("no state picked means every state, and a profile without states still drops remote when asked", () => {
  const IS = loadCore(notFound);
  assert.equal(IS.viewScope(null, []).all, true);
  assert.equal(IS.viewScope({ states: [], remote: true }, []).all, true);
  assert.equal(IS.viewScope({ states: [], remote: false }, []).noRemote, true);
  assert.deepEqual([...IS.viewScope({ states: ["TX"], remote: false }, []).keys], ["TX"]);
  assert.deepEqual([...IS.viewScope(null, ["CA"]).keys], ["CA"]);
  assert.equal(IS.viewScope({ states: ["TX"] }, [IS.ALL_KEY]).all, true);
});

test("every state loads the Northeast and remote first, a searched place before those, and the rest only when asked", () => {
  const IS = loadCore(notFound);
  const index = ["MA", "NY", "remote", "AL", "TX", "CA"];
  const all = IS.viewScope(null, []);
  const quiet = IS.loadPlan(all, index, [], false);
  assert.deepEqual([...quiet.first], ["MA", "NY", "remote"]);
  assert.deepEqual([...quiet.rest], []);
  const searched = IS.loadPlan(all, index, IS.queryKeys("nursing alabama"), true);
  assert.equal(searched.first[0], "AL");
  assert.deepEqual([...searched.rest].sort(), ["CA", "TX"]);
  assert.ok(!IS.loadPlan({ ...all, noRemote: true }, index, [], true).first.includes("remote"));
  assert.deepEqual([...IS.loadPlan(IS.viewScope(null, ["TX"]), index, ["AL"], true).first], ["AL", "TX"]);
  assert.deepEqual([...IS.queryKeys("nurse -texas")], []);
});

test("short words match whole words only, so cs no longer finds physics or analytics", () => {
  const IS = loadCore(notFound);
  const rows = [row("phys", { title: "Physics Research Intern" }), row("ana", { title: "Analytics Intern" }),
    row("swe", { title: "Developer Intern", field_tags: ["swe"] }), row("cs", { title: "CS Intern" })];
  assert.deepEqual(find(IS, "cs", rows).sort(), ["cs", "swe"]);
});

test("one form of a word finds the others: nurse, nurses and nursing find the same roles", () => {
  const IS = loadCore(notFound);
  const rows = [row("a", { title: "Student Nurse Intern" }), row("b", { title: "Nursing Extern" }), row("c", { title: "Nurses Residency" }), row("d", { title: "Finance Intern" })];
  for (const q of ["nurse", "nursing", "nurses"]) assert.deepEqual(find(IS, q, rows).sort(), ["a", "b", "c"], q);
  assert.equal(IS.stem("sales"), "sales");
  assert.equal(IS.stem("engineering"), "engineer");
});

test("a word in the title ranks above the same word in the field, company or description", () => {
  const IS = loadCore(notFound);
  const rows = [row("desc", { title: "Operations Intern", description: "You will help the software team" }),
    row("co", { title: "Operations Intern", company_name: "Software Co" }),
    row("title", { title: "Software Engineering Intern" })];
  const cq = IS.compileQuery("software", IS.placeWords(rows));
  const order = rows.slice().sort((a, b) => IS.matchScore(b, cq) - IS.matchScore(a, cq)).map(x => x.id);
  assert.deepEqual(order, ["title", "co", "desc"]);
  // The word as typed beats a match through its stem only: Marketing before Capital Markets.
  const m = [row("mk", { title: "Capital Markets Intern" }), row("mt", { title: "Marketing Intern" })];
  const mq = IS.compileQuery("marketing", IS.placeWords(m));
  assert.ok(IS.matchScore(m[1], mq) > IS.matchScore(m[0], mq));
});

test("place names filter by location, and -word excludes", () => {
  const IS = loadCore(notFound);
  const tx = { regions: [{ loc: "Austin, TX", state: "TX", kind: "us" }] };
  const rows = [row("ma", { title: "Nursing Intern" }), row("tx", { title: "Nursing Intern", ...tx }), row("tx2", { title: "Unpaid Nursing Intern", ...tx })];
  assert.deepEqual(find(IS, "nursing texas", rows).sort(), ["tx", "tx2"]);
  assert.deepEqual(find(IS, "nursing texas -unpaid", rows), ["tx"]);
  assert.equal(IS.matchScore(rows[0], IS.compileQuery("", null)), 1);
});

test("a landing page's fields pick its major for the setup card, and a guess gives none", () => {
  const IS = loadCore(notFound);
  const majors = { majors: [{ name: "Mechanical Engineering", tags: ["mechanical", "aerospace"] }, { name: "Mechanical Engineering Technology", tags: ["mechanical"] }, { name: "Nursing", tags: ["nursing", "health"] }] };
  assert.equal(IS.majorForFields(["mechanical", "aerospace"], majors), "Mechanical Engineering");
  assert.equal(IS.majorForFields(["nursing"], majors), "Nursing");
  assert.equal(IS.majorForFields(["chemistry"], majors), null);
});

test("downloads beyond four wait their turn, and the quiet timer starts only when one begins", async () => {
  // Each file takes 30 ms against a 40 ms limit; eight at once would leave the last ones waiting for
  // a connection in the browser past the limit, so they queue here instead.
  const keys = ["MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ"];
  const index = { files: Object.fromEntries(keys.map(k => [k, { file: `listings/${k}.json` }])) };
  let running = 0, most = 0;
  const IS = loadCore(url => {
    if (url.endsWith("index.json")) return ok(index);
    running++; most = Math.max(most, running);
    const id = url.replace(/.*\/(\w+)\.json.*/, "$1");
    return new Promise(resolve => setTimeout(() => { running--; resolve({ ok: true, status: 200, json: async () => [{ id }] }); }, 30));
  });
  const store = IS.createStore({ timeoutMs: 40, retryDelayMs: 0 }); await store.init();
  assert.deepEqual([...await store.ensure(keys)], []);
  assert.equal(most, 4);
  assert.equal(store.all().length, keys.length);
});
