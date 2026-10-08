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

test("loadMajors stays pending while majors.json is still downloading", async () => {
  // The race: the page held null while this promise was pending and showed the failure text.
  const IS = loadCore(() => new Promise(() => {}));
  const outcome = await Promise.race([
    IS.loadMajors().then(() => "settled"),
    new Promise(r => setTimeout(() => r("pending"), 50)),
  ]);
  assert.equal(outcome, "pending");
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
