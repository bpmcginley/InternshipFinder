// The visit and step counter in docs/js/count.js, run against a stand-in browser: what it sends, when,
// and that a local copy or an automated browser sends nothing. The Worker side is worker/test/visits.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const COUNT = readFileSync(new URL("../../docs/js/count.js", import.meta.url), "utf8");

function load({ host = "internscout.org", path = "/", search = "", referrer = "", webdriver = false, queued, storage } = {}) {
  const sent = [], listeners = {};
  const ctx = {
    location: { hostname: host, pathname: path, search },
    navigator: { webdriver, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
    document: { referrer, prerendering: false, addEventListener: (t, fn) => { listeners[t] = fn; } },
    Blob: class { constructor(parts) { this.text = parts.join(""); } },
    URL, URLSearchParams, JSON,
  };
  ctx.window = ctx;
  if (storage) ctx.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  if (queued) ctx.ISCountQ = queued;
  vm.createContext(ctx);
  vm.runInContext(COUNT, ctx);
  const bodies = () => sent.map((s) => JSON.parse(s.blob.text));
  // was: const click = (href) => listeners.click({ target: { closest: () => ({ href }) } });
  // `cls` is the link's class: closest() finds it for "a[href]" always, and for a class selector only
  // when one of the selector's parts names that class.
  const click = (href, cls) => {
    const link = { href };
    const closest = (sel) => (sel === "a[href]" || (cls && sel.split(",").some((s) => s.trim() === `a.${cls}[href]`)) ? link : null);
    return listeners.click({ target: { closest } });
  };
  // A form sent (2026-10-06): `cls` is the form's class, and matches() is true only for "form.<cls>".
  // `fields` stand in for what the student typed, which count.js must never read.
  const submit = (cls, fields = {}) => listeners.submit({ target: { ...fields, matches: (sel) => sel === `form.${cls}` } });
  return { ctx, sent, bodies, click, submit };
}

test("one page load sends the path, the referring host and the campaign tag", () => {
  const { sent, bodies } = load({ path: "/internships/ohio/", search: "?utm_source=digest&utm_medium=email", referrer: "https://www.google.com/search?q=secret" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://internscout-api.bpmcginley.workers.dev/hit");
  assert.deepEqual(bodies()[0], { p: "/internships/ohio/", r: "www.google.com", u: "digest", m: "email" }, "only the host, never the search");
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
  let r = load({ storage, search: "?nocount=1" });
  r.ctx.ISCount("signin");
  assert.equal(r.sent.length, 0, "the load that sets it is not counted");
  assert.equal(storage.get("internscout.nocount"), "1");
  r = load({ storage, path: "/internships/ohio/" });
  r.ctx.ISCount("install_click");
  assert.equal(r.sent.length, 0, "a later page sends neither its load nor its steps");
  assert.throws(() => r.click("https://chromewebstore.google.com/detail/x"), TypeError, "no click listener is attached at all");
  r = load({ storage, search: "?nocount=0" });
  assert.equal(r.sent.length, 1);
  assert.equal(storage.has("internscout.nocount"), false);
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
