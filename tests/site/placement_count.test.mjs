// Paid listings shown and opened (S9, 2026-10-14): docs/js/count.js against a stand-in browser. A box
// with data-placement="<id>" counts "shown" once per page load when at least half of it is on screen and
// "open" once when its own posting link (rel="sponsored") is pressed. Only the id and the page's path are
// sent. The Worker side is worker/test/placement-counts.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const COUNT = read("docs/js/count.js");

const el = (id, extra = {}) => ({ getAttribute: k => k === "data-placement" ? id : null, ...extra });
function load({ host = "internscout.org", path = "/", search = "", webdriver = false, storage, queued, statics = [], io = true } = {}) {
  const sent = [], listeners = {}, observers = [];
  class IO {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.watched = new Set(); observers.push(this); }
    observe(e) { this.watched.add(e); }
    unobserve(e) { this.watched.delete(e); }
    fire(e, ratio) { if (this.watched.has(e)) this.cb([{ target: e, isIntersecting: ratio > 0, intersectionRatio: ratio }]); }
  }
  const ctx = {
    location: { hostname: host, pathname: path, search },
    navigator: { webdriver, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
    document: { referrer: "", prerendering: false, addEventListener: (t, fn) => { listeners[t] = fn; }, querySelectorAll: sel => sel === "[data-placement]" ? statics : [] },
    Blob: class { constructor(parts) { this.text = parts.join(""); } },
    URL, URLSearchParams, JSON, Array,
  };
  if (io) ctx.IntersectionObserver = IO;
  ctx.window = ctx;
  if (storage) ctx.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  if (queued) ctx.ISPlacementQ = queued;
  vm.createContext(ctx);
  vm.runInContext(COUNT, ctx);
  const bodies = () => sent.map(s => JSON.parse(s.blob.text)).filter(b => "s" in b);
  const fire = (e, ratio) => observers.forEach(o => o.fire(e, ratio));
  // A click on a link inside a box: closest("a[href]") is the link, closest("[data-placement]") the box.
  const click = (box, rel, cls = "open-link") => {
    const link = { href: "https://jobs.example/1", getAttribute: k => k === "rel" ? rel : null, closest: sel => sel === "[data-placement]" ? box : null };
    listeners.click({ target: { closest: sel => sel === "a[href]" ? link : sel === "a.go[href], a.open-link[href]" && cls ? link : sel === ".paid" ? box : null } });
  };
  return { ctx, sent, bodies, fire, click, observers };
}

test("shown: once per page load, only when at least half the box is on screen", () => {
  const box = el("p-2026-11-acme-1");
  const r = load({ path: "/internships/software/", statics: [box] });
  assert.deepEqual(JSON.parse(JSON.stringify(r.observers[0].opts)), { threshold: [0.5] });
  r.fire(box, 0.2);
  assert.deepEqual(r.bodies(), []);
  r.fire(box, 0.6);
  r.fire(box, 1);
  assert.deepEqual(r.bodies(), [{ s: "p-2026-11-acme-1", e: "shown", p: "/internships/software/" }], "the id, the event and the path, nothing else");
});

test("the dashboard's box, handed over before or after count.js runs, is watched the same way", () => {
  const early = el("p-early"), late = el("p-late");
  const r = load({ queued: [early] });
  r.ctx.ISPlacementQ.push(late);
  r.fire(early, 1); r.fire(late, 1);
  assert.deepEqual(r.bodies().map(b => b.s), ["p-early", "p-late"]);
  assert.deepEqual(r.bodies()[0], { s: "p-early", e: "shown", p: "/" });
});

test("open: its own sponsored posting link, once per page load; not the Why link, not a normal row", () => {
  const box = el("p-1");
  const r = load({ statics: [box] });
  r.click(box, "noopener");                      // "More about paid listings" or another link in the box
  r.click(null, "noopener");                     // an ordinary row's Open posting
  assert.deepEqual(r.bodies(), []);
  r.click(box, "sponsored noopener");
  r.click(box, "sponsored noopener");
  assert.deepEqual(r.bodies(), [{ s: "p-1", e: "open", p: "/" }]);
  // Not a posting_click (main, #115: clicks inside a paid box are left out, so payment never changes a
  // count); the ordinary row's Open posting above is one.
  assert.equal(r.sent.map(s => JSON.parse(s.blob.text)).filter(b => b.e === "posting_click").length, 1);
});

test("nothing is sent with ?nocount=1, on a local copy, in an automated browser, or for a malformed id", () => {
  for (const opts of [{ search: "?nocount=1", storage: new Map() }, { host: "localhost" }, { webdriver: true }]) {
    const box = el("p-1");
    const r = load({ ...opts, statics: [box], queued: [el("p-2")] });
    r.fire(box, 1);
    r.ctx.ISPlacementQ.push(el("p-3"));
    assert.equal(r.observers.length, 0, JSON.stringify(opts));
    assert.deepEqual(r.bodies(), [], JSON.stringify(opts));
  }
  const bad = el("p-1\"><script>"), r = load({ statics: [bad] });
  r.fire(bad, 1);
  assert.deepEqual(r.bodies(), []);
  // A browser without IntersectionObserver counts no "shown", and nothing breaks.
  const noIo = load({ io: false, statics: [el("p-1")] });
  noIo.ctx.ISPlacementQ.push(el("p-2"));
  assert.deepEqual(noIo.bodies(), []);
});

test("the dashboard box and the landing box both carry the placement id; count.js names nothing else", () => {
  assert.match(read("docs/js/placements.js"), /"data-placement": plId \|\| undefined/);
  assert.match(read("docs/js/placements.js"), /\(window\.ISPlacementQ = window\.ISPlacementQ \|\| \[\]\)\.push\(box\.current\)/);
  assert.match(read("backend/internscout/seo_pages.py"), /<li class="paid" data-placement="\{esc\(pl\.get\("id"\) or ""\)\}"/);
  const code = COUNT.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /beacon\(\{ s: id, e: e, p: location\.pathname \}\)/);
});
