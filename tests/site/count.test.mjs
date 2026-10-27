// The visit and step counter in docs/js/count.js, run against a stand-in browser: what it sends, when,
// and that a local copy or an automated browser sends nothing. The Worker side is worker/test/visits.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const COUNT = readFileSync(new URL("../../docs/js/count.js", import.meta.url), "utf8");

function load({ host = "internscout.org", path = "/", search = "", referrer = "", webdriver = false, queued, storage, session, placements } = {}) {
  const sent = [], listeners = {};
  let intersection, mutation;
  const observing = new Set();
  const ctx = {
    location: { hostname: host, pathname: path, search },
    navigator: { webdriver, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
    document: { referrer, prerendering: false, addEventListener: (t, fn) => { listeners[t] = fn; } },
    Blob: class { constructor(parts) { this.text = parts.join(""); } },
    URL, URLSearchParams, JSON,
  };
  ctx.window = ctx;
  if (placements) {
    ctx.document.body = {};
    ctx.document.querySelectorAll = () => placements;
    ctx.IntersectionObserver = class {
      constructor(callback) { intersection = callback; }
      observe(el) { observing.add(el); }
      unobserve(el) { observing.delete(el); }
    };
    ctx.MutationObserver = class {
      constructor(callback) { mutation = callback; }
      observe() {}
    };
  }
  if (storage) ctx.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  if (session) ctx.sessionStorage = { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) };
  if (queued) ctx.ISCountQ = queued;
  vm.createContext(ctx);
  vm.runInContext(COUNT, ctx);
  const bodies = () => sent.map((s) => JSON.parse(s.blob.text));
  // was: const click = (href) => listeners.click({ target: { closest: () => ({ href }) } });
  // `cls` is the link's class: closest() finds it for "a[href]" always, and for a class selector only
  // when one of the selector's parts names that class. `box` is the class of an element around the link
  // (".paid" for a paid listing's box), found by closest(".<box>").
  const click = (href, cls, box, placement) => {
    const link = { href, getAttribute: (name) => name === "data-digest-placement" ? placement : null };
    const closest = (sel) => (box && sel === `.${box}`) ? {} :
      (sel === "a[href]" || (cls && sel.split(",").some((s) => s.trim() === `a.${cls}[href]`)) ? link : null);
    return listeners.click({ target: { closest } });
  };
  // A form sent (2026-10-06): `cls` is the form's class, and matches() is true only for "form.<cls>".
  // `fields` stand in for what the student typed, which count.js must never read.
  const submit = (cls, fields = {}) => listeners.submit({ target: { ...fields, matches: (sel) => sel === `form.${cls}` } });
  return { ctx, sent, bodies, click, submit, observing,
    expose: (target, ratio) => intersection([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    mount: (addedNodes = [], removedNodes = []) => mutation([{ addedNodes, removedNodes }]) };
}

test("one page load sends the path, the referring host and the campaign tag", () => {
  const { sent, bodies } = load({ path: "/internships/ohio/", search: "?utm_source=digest&utm_medium=email", referrer: "https://www.google.com/search?q=secret" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://internscout-api.bpmcginley.workers.dev/hit");
  assert.deepEqual(bodies()[0], { p: "/internships/ohio/", r: "www.google.com", u: "digest", m: "email" }, "only the host, never the search");
});

test("campaign and content tags follow conversion intents only within the same tab", () => {
  const session = new Map();
  const first = load({ session, path: "/internships/software-engineering/",
    search: "?utm_source=x&utm_medium=social&utm_campaign=weekly-2026w44&utm_content=search_card" });
  assert.deepEqual(first.bodies()[0], { p: "/internships/software-engineering/", r: "", u: "x", m: "social",
    c: "weekly-2026w44", t: "search_card" });
  const later = load({ session, path: "/install.html", referrer: "https://internscout.org/internships/software-engineering/" });
  later.click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi");
  assert.deepEqual(later.bodies().filter((b) => b.e), [{ e: "install_click", p: "/install.html", u: "x", m: "social",
    c: "weekly-2026w44", t: "search_card" }]);
  const otherTab = load({ path: "/install.html" });
  otherTab.click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi");
  assert.deepEqual(otherTab.bodies().filter((b) => b.e), [{ e: "install_click", p: "/install.html" }]);
});

test("non-attributed product steps never transmit campaign context", () => {
  const r = load({ session: new Map(), search: "?utm_source=x&utm_medium=social&utm_campaign=weekly-2026w44&utm_content=search_card" });
  for (const event of ["signin_start", "signin", "profile", "autoapply", "posting_click", "review_click"]) r.ctx.ISCount(event);
  assert.deepEqual(r.bodies().filter((b) => b.e), [
    { e: "signin_start", p: "/" }, { e: "signin", p: "/" }, { e: "profile", p: "/" },
    { e: "autoapply", p: "/" }, { e: "posting_click", p: "/" }, { e: "review_click", p: "/" },
  ]);
});

test("campaign context refuses URLs, email-like values and overlong tags", () => {
  const r = load({ session: new Map(), search: "?utm_source=x&utm_medium=social&utm_campaign=https%3A%2F%2Fevil.example%2Fa&utm_content=student%40school.edu" });
  r.ctx.ISCount("install_click");
  assert.deepEqual(r.bodies().filter((b) => b.e), [{ e: "install_click", p: "/", u: "x", m: "social" }]);
});

test("a new external referral replaces an older tab campaign, while an auth round trip keeps it", () => {
  const session = new Map();
  load({ session, search: "?utm_source=x&utm_medium=social&utm_campaign=weekly-2026w44" });
  const auth = load({ session, path: "/", referrer: "https://accounts.google.com/" });
  auth.ctx.ISCount("install_click");
  assert.equal(auth.bodies().find((b) => b.e).c, "weekly-2026w44");
  const newer = load({ session, path: "/", referrer: "https://example.edu/resources" });
  newer.ctx.ISCount("install_click");
  assert.deepEqual(newer.bodies().find((b) => b.e), { e: "install_click", p: "/", r: "example.edu" });
});

test("local copies and automated browsers send nothing, and steps there are dropped", () => {
  for (const opts of [{ host: "localhost" }, { webdriver: true }]) {
    const { ctx, sent } = load(opts);
    ctx.ISCount("signin");
    ctx.ISCountQ.push("profile");
    assert.equal(sent.length, 0);
  }
});

test("?nocount=1 stops counting this browser on every later load, and ?nocount=0 starts it again", () => {
  const storage = new Map();
  const session = new Map();
  let r = load({ storage, session, search: "?nocount=1&utm_source=x&utm_medium=social&utm_campaign=private-test" });
  r.ctx.ISCount("signin");
  assert.equal(r.sent.length, 0, "the load that sets it is not counted");
  assert.equal(session.size, 0, "an opted-out load does not retain campaign context");
  assert.equal(storage.get("internscout.nocount"), "1");
  r = load({ storage, session, path: "/internships/ohio/" });
  r.ctx.ISCount("install_click");
  assert.equal(r.sent.length, 0, "a later page sends neither its load nor its steps");
  assert.throws(() => r.click("https://chromewebstore.google.com/detail/x"), TypeError, "no click listener is attached at all");
  r = load({ storage, session, search: "?nocount=0" });
  assert.equal(r.sent.length, 1);
  assert.equal(storage.has("internscout.nocount"), false);
  r.click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi");
  assert.deepEqual(r.bodies().find((b) => b.e), { e: "install_click", p: "/" }, "opted-out tags are never replayed");
});

test("steps count once per page load, queued ones included, and store links count as install clicks", () => {
  const { ctx, bodies, click } = load({ queued: ["signin_start"] });
  ctx.ISCount("signin");
  ctx.ISCount("signin");                 // a double click is one
  ctx.ISCountQ.push("autoapply");        // core.js IS.count after count.js ran
  click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi?utm_source=landing");
  click("https://internscout.org/install.html");
  const steps = bodies().filter((b) => b.e).map((b) => b.e);
  assert.deepEqual(steps, ["signin_start", "signin", "autoapply", "install_click"]);
  assert.ok(bodies().every((b) => b.p === "/"));
});

test("opening a posting from a landing page or the dashboard is a posting_click, once per page load", () => {
  const landing = load({ path: "/internships/ohio/" });
  landing.click("https://boards.greenhouse.io/acme/jobs/1", "go");
  landing.click("https://boards.greenhouse.io/acme/jobs/2", "go");
  landing.click("https://internscout.org/install.html");          // any other link is not a posting
  assert.deepEqual(landing.bodies().filter((b) => b.e), [{ e: "posting_click", p: "/internships/ohio/" }]);
  const dash = load();
  dash.click("https://jobs.lever.co/acme/1", "open-link");
  dash.click("https://chromewebstore.google.com/detail/x", "nav");
  assert.deepEqual(dash.bodies().filter((b) => b.e).map((b) => b.e), ["posting_click", "install_click"]);
});

test("opening a posting from a paid listing's box is never a posting_click (payment never changes a count)", () => {
  const r = load({ path: "/internships/ohio/" });
  r.click("https://boards.greenhouse.io/acme/jobs/9", "go", "paid");
  assert.deepEqual(r.bodies().filter((b) => b.e), []);
  r.click("https://boards.greenhouse.io/acme/jobs/1", "go");
  assert.deepEqual(r.bodies().filter((b) => b.e), [{ e: "posting_click", p: "/internships/ohio/" }]);
});

test("sending a weekly email sign-up form is a digest_signup, once per page load, and nothing typed goes", () => {
  for (const path of ["/", "/internships/machine-learning-ai/", "/internships/new/", "/digest/"]) {
    const r = load({ path });
    r.submit("digest", { email: { value: "someone@school.edu" }, tag: { value: "ml" } });
    r.submit("digest");                        // a second send from the same page load is one
    r.submit("search");                        // any other form is not a sign-up
    const steps = r.bodies().filter((b) => b.e);
    assert.deepEqual(steps, [{ e: "digest_signup", p: path }]);
    assert.ok(!r.sent.some((s) => /someone|school\.edu|"ml"/.test(s.blob.text)), "never the address or the field");
  }
});

test("a local copy counts no sign-ups and attaches no submit listener", () => {
  const r = load({ host: "localhost" });
  assert.throws(() => r.submit("digest"), TypeError);
  assert.equal(r.sent.length, 0);
});

const placementElement = (placement) => ({ nodeType: 1, getAttribute: (name) => name === "data-digest-placement" ? placement : null });

test("digest exposure waits for visibility and observes React mounts without counting DOM presence", () => {
  const footer = placementElement("footer"), inline = placementElement("results-inline"), unknown = placementElement("someone@school.edu");
  const r = load({ placements: [footer, unknown] });
  assert.deepEqual(r.bodies().filter((b) => b.e), [], "a below-the-fold form is not a view");
  assert.equal(r.observing.has(unknown), false, "arbitrary placement values are never observed");
  r.expose(footer, 0.1);
  assert.deepEqual(r.bodies().filter((b) => b.e), []);
  r.mount([inline]);
  assert.equal(r.observing.has(inline), true, "later React form is observed");
  r.expose(inline, 0.25);
  r.expose(inline, 1);
  r.expose(footer, 0.5);
  assert.deepEqual(r.bodies().filter((b) => b.e), [
    { e: "digest_view_results_inline", p: "/" }, { e: "digest_view_footer", p: "/" }
  ]);
  assert.equal(r.observing.has(inline), false, "a measured form stops observing");
  const contextual = placementElement("contextual");
  r.mount([contextual]); r.mount([], [contextual]);
  assert.equal(r.observing.has(contextual), false, "removed elements release the observer");
  r.mount([contextual]);
  assert.equal(r.observing.has(contextual), true, "reinserted unseen elements can still be measured");
});

test("finite digest click and submit attribution never reports confirmation or typed fields", () => {
  const r = load();
  r.click("https://internscout.org/digest/", "nav", null, "nav");
  r.click("https://internscout.org/digest/", null, null, "contextual");
  r.click("https://internscout.org/digest/", null, null, "invented");
  const form = placementElement("results-inline");
  Object.defineProperty(form, "email", { get: () => { throw new Error("must not read email"); } });
  r.submit("digest", form); r.submit("digest", form);
  r.submit("digest", placementElement("footer"));
  assert.deepEqual(r.bodies().filter((b) => b.e).map((b) => b.e), [
    "digest_click_nav", "digest_click_contextual", "digest_signup", "digest_submit_results_inline", "digest_submit_footer"
  ]);
  assert.ok(r.bodies().every((b) => !/confirmed|subscriber/.test(b.e || "")));
});

// Added 2026-10-07: a link to the listing's reviews page (the dashboard's review line, the install
// page) is a review_click, not an install_click; any other store link is still an install_click.
test("a click on the store's reviews page is a review_click, and only that one", () => {
  const r = load({ path: "/install.html" });
  r.click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi/reviews");
  r.click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi/reviews?utm_source=install-page");
  assert.deepEqual(r.bodies().filter((b) => b.e), [{ e: "review_click", p: "/install.html" }]);
  const d = load();
  d.click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi?utm_source=reviews");
  d.click("https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi/reviews");
  assert.deepEqual(d.bodies().filter((b) => b.e).map((b) => b.e), ["install_click", "review_click"]);
});
