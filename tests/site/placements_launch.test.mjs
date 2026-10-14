// The launch text for paid listings (S8, 2026-10-14; B2 plan section 9 PR 8, B1-data-privacy.md section 7):
// the privacy page's #paid-listings section, the terms' employer section and the one-time dashboard notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const PRIVACY = read("docs/privacy.html"), TERMS = read("docs/terms.html"), APP = read("docs/js/app.js");
const visible = html => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const section = (html, id) => { const v = visible(html); const at = v.indexOf(`<h2 id="${id}">`); assert.ok(at >= 0, `#${id}`); const end = v.indexOf("<h2", at + 4); return v.slice(at, end < 0 ? undefined : end); };
const words = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("privacy: the paid listings section is #paid-listings (#paid is paid plans), and the links land on it", () => {
  const v = visible(PRIVACY);
  assert.equal((v.match(/ id="paid-listings"/g) || []).length, 1);
  assert.equal((v.match(/<h2[^>]*>Paid listings<\/h2>/g) || []).length, 1, "one paid listings section");
  assert.match(v, /<h2 id="paid-listings">Paid listings<\/h2>/);
  assert.match(v, /<h2 id="paid">If you join a paid plan<\/h2>/);
  // Every in-page link about paid listings goes to #paid-listings; #paid is only ever the paid plans section.
  for (const m of v.matchAll(/<a href="#paid">([^<]*)<\/a>/g)) assert.equal(m[1], "If you join a paid plan");
  for (const m of v.matchAll(/<a href="#paid-listings">([^<]*)<\/a>/g)) assert.match(m[1], /^(Details below|paid listings?|Paid listings)$/);
  // Every in-page link has a target.
  for (const m of v.matchAll(/href="#([a-z-]+)"/g)) assert.match(v, new RegExp(` id="${m[1]}"`), "#" + m[1]);
  // The boxes link here.
  assert.match(read("backend/internscout/seo_pages.py"), /href="\/privacy\.html#paid-listings">Why am I seeing this\?/);
  assert.match(read("docs/js/placements.js"), /href: "privacy\.html#paid-listings"/);
  assert.match(APP, /href: "privacy\.html#paid-listings", onClick: onHide/);
  assert.match(TERMS, /href="privacy\.html#paid-listings"/);
  for (const [name, src] of [["app.js", APP], ["terms.html", TERMS], ["placements.js", read("docs/js/placements.js")]])
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, "").replace(/<!--[\s\S]*?-->/g, ""), /privacy\.html#paid["#]/, name);
});

test("privacy: the promises that stop being true on launch day are gone, and the new ones are there", () => {
  const v = words(visible(PRIVACY));
  assert.doesNotMatch(v, /we don't show ads/i);
  assert.doesNotMatch(v, /nothing on it is sold or paid for/);
  assert.doesNotMatch(v, /featured listings or promoted roles/);
  const paid = words(section(PRIVACY, "paid-listings"));
  for (const want of [
    // The reviewed text from main (#115), with the dashboard added.
    /Some internship pages, and the dashboard after you search or pick a field, can show one box headed "Paid listing", with "Ad" before the company name/,
    /paying never changes match scores, the order of the list, filters, counts or what Auto-Apply does/,
    /the same role is also in the page's normal list/,
    /At most one per page/,
    /We count how many times the box is shown and opened, never who saw or opened it/,
    // Added for S8 and S9.
    /only after you search for something or pick a field/,
    /the price never decides/,
    // The hide-only profile sentence (decision 5).
    /Your saved profile can only hide one\..*It is never used to pick one, and it never leaves your browser\./,
    /The extension never shows paid listings/,
    /"Hide paid listings".*"Show paid listings".*never sent to us/,
    // S9: what is counted, and the minimum-count rule.
    /shown \(at least half of its box on your screen, once per page load\) and opened/,
    /sends only the paid listing's id and the address of the page/,
    /rounded down to the nearest 10\. Any number under 10 is shown as "fewer than 10"/,
    /split by kind of page only when every number in the split is 10 or more/,
    /We don't see applications/,
    /No ad network, tracking pixel or cookie/,
    /Paying can't add a listing or change one/,
  ]) assert.match(paid, want);
  // The short version, the counting line, local settings, the Web Store and children sections say it too.
  assert.match(v, /Some searches and pages show one paid listing/);
  assert.match(v, /We count paid listings the same way: how many times a day each one was shown and opened, by kind of page, and nothing else\./);
  assert.match(v, /If you hide paid listings, or hide the notice that they started, your browser keeps that one setting/);
  assert.match(v, /The extension never shows paid listings, and nothing in it is used to choose the ones the website shows\./);
  assert.match(v, /Paid listings are never aimed at anyone, of any age/);
  assert.match(v, /The only paid content on InternScout is the labelled paid listing/);
});

test("terms: an employer section, and the screening line says what a paid listing is checked for", () => {
  const emp = words(section(TERMS, "employers"));
  for (const want of [/headed "Paid listing", with "Ad" before your company name/, /at most one paid listing on a page/,
    /doesn't change where any of your listings, or anyone else's, rank, how they are scored, which filters they pass/,
    /isn't aimed at students by profile, school, major, age or any other trait/, /Paying never adds a listing/,
    /We don't promise views, clicks or applicants/, /rounded down to the nearest 10/, /unused days back as credit or a refund/,
    /stay free whether or not you buy a paid listing/]) assert.match(emp, want);
  const v = words(visible(TERMS));
  assert.match(v, /We don't screen employers, except that a paid listing has to be a real, open role/);
  assert.match(v, /A paid listing is an ad, not a recommendation/);
});

test("the launch text has no em dash, and never calls a paid listing Sponsored, Promoted or Featured", () => {
  for (const s of [section(PRIVACY, "paid-listings"), section(TERMS, "employers")]) {
    assert.doesNotMatch(s, /—/);
    assert.doesNotMatch(s, /\b(Sponsored|Promoted|Featured)\b/);
  }
  assert.doesNotMatch(APP.match(/function PlaceNotice[\s\S]*?\n  \}/)[0], /—|Sponsored|Promoted|Featured/);
});

// ---------- the dashboard notice ----------
function harness() {
  const react = {
    Fragment: "fragment", memo: fn => fn,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(x => x != null && x !== false) }),
    useState: i => [typeof i === "function" ? i() : i, () => {}], useRef: i => ({ current: i }), useId: () => "id",
    useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
  };
  const ctx = { React: react, URLSearchParams, setTimeout, clearTimeout, console, CONFIG: {}, localStorage: { getItem() { return null; } }, sessionStorage: { getItem() { return null; } },
    addEventListener() {}, postMessage() {}, location: { search: "", origin: "https://internscout.org" }, document: { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(read("docs/js/core.js"), ctx);
  vm.runInContext(APP.replace('ReactDOM.createRoot(document.getElementById("root")).render(h(App));', "window.components = { PlaceNotice };"), ctx);
  return ctx.components;
}
const text = n => typeof n === "string" ? n : n && n.children ? n.children.map(text).join("") : "";
const nodes = (t, pred) => !t || typeof t !== "object" ? [] : [...(pred(t) ? [t] : []), ...t.children.flatMap(c => nodes(c, pred))];

test("the notice: says what changed, links to the privacy section, and hides for good", () => {
  const { PlaceNotice } = harness();
  let hidden = 0;
  const tree = PlaceNotice({ onHide: () => hidden++ });
  assert.equal(tree.props.className, "notice place-notice");
  assert.match(text(tree), /New: paid listings\. When you search or pick a field, you may now see one listing an employer paid for, in its own box labelled Ad\. Paying never changes your results, their order or any Match score, and it is never chosen from your profile\./);
  const link = nodes(tree, n => n.type === "a")[0];
  assert.equal(link.props.href, "privacy.html#paid-listings");
  link.props.onClick();
  nodes(tree, n => n.type === "button")[0].props.onClick();
  assert.equal(hidden, 2, "following the link hides it too");
  // Kept in this browser under its own key, and only once there are placements.
  assert.match(APP, /const PLACE_NOTICE_KEY = "internscout\.placements\.notice\.v1";/);
  assert.match(APP, /const hidePlaceNotice = \(\) => \{ IS\.ls\.set\(PLACE_NOTICE_KEY, true\); setPlaceNoticeHidden\(true\); \};/);
  assert.match(APP, /const placeNoticeEl = placements\.length > 0 && !placeNoticeHidden && h\(PlaceNotice/);
});

test("the notice obeys one notice above the list (D16): third in line, otherwise under the list", () => {
  // The slot logic: the first notice that is on goes above the list, the others under it.
  assert.match(APP, /const \[topNotice, \.\.\.laterNotices\] = \[setupAskEl, oneStepEl, placeNoticeEl\]\.filter\(Boolean\);/);
  assert.match(APP, /const promoEls = h\(F, null,\s*\/\/ was: setupAsk && oneStepEl,\s*\.\.\.laterNotices,/);
  // topNotice is rendered once above the list, and nothing else above it is a standing notice of this kind.
  assert.equal((APP.match(/^\s*topNotice,$/gm) || []).length, 1);
  const order = ["setupAskEl", "oneStepEl", "placeNoticeEl"];
  const slots = (on) => { const [top, ...rest] = order.filter(k => on[k]); return { top, rest }; };
  assert.deepEqual(slots({ placeNoticeEl: 1 }), { top: "placeNoticeEl", rest: [] });
  assert.deepEqual(slots({ setupAskEl: 1, placeNoticeEl: 1 }), { top: "setupAskEl", rest: ["placeNoticeEl"] });
  assert.deepEqual(slots({ oneStepEl: 1, placeNoticeEl: 1 }), { top: "oneStepEl", rest: ["placeNoticeEl"] });
});

test("the page head reads placements.json, so the dashboard knows on its first draw; load() reuses that request", async () => {
  const html = read("docs/index.html");
  assert.match(html, /if \(window\.CONFIG\.placements !== false\) window\.__placementsP = fetch\(d \+ "placements\.json", \{ cache: "no-cache" \}\)/);
  assert.ok(html.indexOf("window.__placementsP") < html.indexOf("react.production"));
  assert.match(APP, /useState\(\(\) => \(PL && PL\.loaded\(\)\) \|\| \[\]\)/);
  const run = extra => {
    const ctx = { CONFIG: { dataUrl: "./data/" }, fetch: () => { throw new Error("a second request"); }, ...extra };
    ctx.window = ctx; vm.createContext(ctx); vm.runInContext(read("docs/js/placements.js"), ctx); return ctx.ISPlace;
  };
  const body = { placements: [{ id: "p-1", listing_id: "a1", apply_url: "https://x.example/1", employer: "Acme", start: "2026-10-01", end: "2026-11-01" }, { id: "bad id" }] };
  let P = run({ __placements: body, __placementsP: Promise.resolve(body) });
  assert.deepEqual(JSON.parse(JSON.stringify(P.loaded())), [body.placements[0]]);
  assert.deepEqual(JSON.parse(JSON.stringify(await P.load())), [body.placements[0]]);
  P = run({});                       // not arrived yet: nothing known, and no error
  assert.equal(P.loaded(), null);
  P = run({ __placements: null, __placementsP: Promise.resolve(null) });   // missing file
  assert.deepEqual(JSON.parse(JSON.stringify(P.loaded())), []);
  assert.deepEqual(JSON.parse(JSON.stringify(await P.load())), []);
  P = run({ CONFIG: { placements: false }, __placements: body });
  assert.equal(P.loaded(), null);
});
