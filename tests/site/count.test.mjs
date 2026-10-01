// The visit and step counter in docs/js/count.js, run against a stand-in browser: what it sends, when,
// and that a local copy or an automated browser sends nothing. The Worker side is worker/test/visits.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const COUNT = readFileSync(new URL("../../docs/js/count.js", import.meta.url), "utf8");

function load({ host = "internscout.org", path = "/", search = "", referrer = "", webdriver = false, queued } = {}) {
  const sent = [], listeners = {};
  const ctx = {
    location: { hostname: host, pathname: path, search },
    navigator: { webdriver, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
    document: { referrer, prerendering: false, addEventListener: (t, fn) => { listeners[t] = fn; } },
    Blob: class { constructor(parts) { this.text = parts.join(""); } },
    URL, URLSearchParams, JSON,
  };
  ctx.window = ctx;
  if (queued) ctx.ISCountQ = queued;
  vm.createContext(ctx);
  vm.runInContext(COUNT, ctx);
  const bodies = () => sent.map((s) => JSON.parse(s.blob.text));
  const click = (href) => listeners.click({ target: { closest: () => ({ href }) } });
  return { ctx, sent, bodies, click };
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
