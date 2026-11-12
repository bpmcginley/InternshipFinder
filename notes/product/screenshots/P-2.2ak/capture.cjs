const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const tools = path.join(process.env.TEMP, "internscout-product-capture-tools");
const { chromium } = require(path.join(tools, "node_modules/playwright-core"));
const root = path.resolve(__dirname, "../../../.."),
  baseline = process.argv[2];
const rows = JSON.parse(
  fs.readFileSync(path.join(root, "notes/product/screenshots/P-1.3/listings-fixture.json")),
);
const report = [];
let browser;
async function context(
  phase,
  width,
  colorScheme,
  {
    hint = false,
    pathname = "/?out_of_runs=1&nocount=1",
    fixture = { used: 12, limit: 40, bonus: 3, purchased: 25 },
    used = 10,
    paused = false,
    signedIn = true,
    offerError = false,
    checkout = "pending",
    hold = false,
  } = {},
) {
  const ctx = await browser.newContext({
    viewport: { width, height: 1100 },
    colorScheme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "America/New_York",
    serviceWorkers: "block",
  });
  const state = { me: fixture, failed: false, held: false };
  const calls = [],
    errors = [],
    blocked = [],
    releases = [];
  await ctx.addInitScript(
    ({ signedIn }) => {
      addEventListener("message", (event) => {
        const d = event.data;
        if (d?.__internscout === "req")
          postMessage({ __internscout: "res", id: d.id, result: {} }, location.origin);
      });
      localStorage.setItem("internscout.setup.skipped.v1", "true");
      localStorage.setItem("internscout.landing.seen.v1", "true");
      if (signedIn)
        localStorage.setItem(
          "internscout.session",
          JSON.stringify({
            token: "iss_synthetic_topup",
            email: "fixture@example.edu",
            account: "fixture",
            expires: "2030-11-10T18:00:00Z",
          }),
        );
    },
    { signedIn },
  );
  await ctx.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    let file;
    if (u.hostname === "cdn.jsdelivr.net")
      file = path.join(
        tools,
        "node_modules",
        u.pathname.includes("react-dom@")
          ? "react-dom/umd/react-dom.production.min.js"
          : "react/umd/react.production.min.js",
      );
    else if (u.hostname === "internscout-api.bpmcginley.workers.dev") {
      calls.push({
        path: u.pathname,
        method: req.method(),
        body: req.postData(),
        hasBearer: !!req.headers().authorization,
      });
      if (u.pathname === "/config")
        return route.fulfill({
          json: {
            ...(hint ? { topups: true } : {}),
            providers: [
              {
                id: "google",
                client_id: "synthetic",
                authorize_url: "https://signin.example.test/",
              },
            ],
            payments: { enabled: false, plans: [] },
            allowance: { edu: { autofill: 10 } },
          },
        });
      if (u.pathname === "/me") {
        const result = state.failed
          ? null
          : {
              plan: "free",
              tier: "edu",
              paused,
              can_upgrade: false,
              allowance: { autofill: { ...state.me } },
            };
        if (state.held) await new Promise((resolve) => releases.push(resolve));
        return route.fulfill({
          status: result ? 200 : 503,
          headers: { "cache-control": "no-store" },
          json: result || {},
        });
      }
      if (u.pathname === "/billing/topup/offer")
        return route.fulfill(
          offerError
            ? { status: 503, body: "" }
            : {
                headers: { "cache-control": "no-store" },
                json: { enabled: true, offer: { amount: 300, currency: "usd", units: 25 } },
              },
        );
      if (u.pathname === "/billing/topup/checkout") {
        if (hold) await new Promise((r) => releases.push(r));
        return route.fulfill(
          checkout === "pending"
            ? { status: 202, headers: { "cache-control": "no-store" }, json: { status: "pending" } }
            : {
                headers: { "cache-control": "no-store" },
                json: {
                  status: "open",
                  url:
                    checkout === "invalid"
                      ? "https://invalid.example.test/"
                      : "https://checkout.stripe.com/c/pay/cs_test_synthetic",
                },
              },
        );
      }
      return route.fulfill({ json: {} });
    } else if (u.origin !== "http://127.0.0.1") {
      blocked.push(u.href);
      return route.abort();
    } else {
      if (u.pathname === "/data/listings/index.json")
        return route.fulfill({
          json: {
            generated_at: "2026-11-10T18:00:00Z",
            files: { RI: { file: "listings/RI.json", open: rows.length } },
            first: { file: "first.json", rows: rows.length, keys: ["RI"], sort: "new" },
          },
        });
      if (u.pathname === "/data/first.json" || u.pathname === "/data/listings/RI.json")
        return route.fulfill({ json: rows });
      if (u.pathname.endsWith(".desc.json")) return route.fulfill({ json: {} });
      if (
        phase === "before" &&
        ["/js/app/allowance.mjs", "/js/app/dashboard.mjs", "/js/app/controls.mjs"].includes(
          u.pathname,
        )
      )
        file = path.join(baseline, path.basename(u.pathname));
      else
        file = path.join(
          root,
          "docs",
          u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname),
        );
    }
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const type =
      {
        ".html": "text/html",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[path.extname(file)] || "application/octet-stream";
    return route.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1" + pathname);
  await page.getByRole("button", { name: "Account", exact: true }).waitFor();
  await page.waitForTimeout(600);
  return { ctx, page, calls, errors, blocked, releases, state };
}

const countMe = (c) => c.calls.filter((x) => x.path === "/me").length;
async function returning(c, persisted = false) {
  await c.page.evaluate((persisted) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    if (persisted) dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    if (persisted) dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
  }, persisted);
}
(async () => {
  browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  for (const phase of ["before", "after"])
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        const c = await context(phase, width, theme);
        await c.page.getByText("28 runs left in your allowance.", { exact: false }).waitFor();
        await c.page.locator("#allowance-panel").scrollIntoViewIfNeeded();
        await c.page.evaluate(() => document.fonts.ready);
        assert(await c.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (phase === "after")
          await c.page
            .getByText("Purchased Auto-Apply runs remaining: 25.", { exact: false })
            .waitFor();
        await c.page.screenshot({
          path: path.join(__dirname, `${phase}-allowance-${width}-${theme}.png`),
        });
        await c.page.getByRole("button", { name: "Account", exact: true }).click();
        await c.page.locator("#acct-panel").waitFor();
        if (phase === "after") {
          await c.page
            .locator("#acct-panel")
            .getByText("Purchased Auto-Apply runs", { exact: true })
            .waitFor();
          assert.equal(
            await c.page
              .locator("#acct-panel .acct-sec")
              .filter({ hasText: "This month" })
              .getByText("Purchased Auto-Apply runs", { exact: true })
              .count(),
            0,
          );
        }
        await c.page.screenshot({
          path: path.join(__dirname, `${phase}-account-${width}-${theme}.png`),
        });
        await c.page.keyboard.press("Escape");
        assert.equal(
          await c.page
            .getByRole("button", { name: "Account", exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        );
        assert.deepEqual(c.errors, []);
        assert(c.blocked.every((u) => u === "https://static.cloudflareinsights.com/beacon.min.js"));
        assert.equal(c.calls.filter((x) => x.path.includes("/topup/")).length, 0);
        report.push({
          phase,
          width,
          theme,
          meReads: countMe(c),
          errors: c.errors,
          externalRequests: 0,
        });
        await c.ctx.close();
      }
  const c = await context("after", 375, "light", { pathname: "/?nocount=1" });
  assert.equal(await c.page.locator("#allowance-panel").count(), 0);
  await c.page.getByRole("button", { name: "Account", exact: true }).click();
  await c.page.getByText("25 remaining. Purchased runs do not expire.", { exact: true }).waitFor();
  const initial = countMe(c);
  c.state.me = { used: 12, limit: 22, bonus: 3, purchased: 7 };
  await returning(c, true);
  await c.page.getByText("7 remaining. Purchased runs do not expire.", { exact: true }).waitFor();
  assert.equal(countMe(c), initial + 1);
  c.state.me = { used: 12, limit: 15, bonus: 3 };
  await returning(c);
  await c.page.waitForFunction(
    () => !document.querySelector("#acct-panel")?.textContent.includes("Purchased Auto-Apply runs"),
  );
  assert.equal(countMe(c), initial + 2);
  c.state.me = { used: 12, limit: 40, bonus: 3, purchased: 25 };
  await returning(c);
  await c.page.getByText("25 remaining. Purchased runs do not expire.", { exact: true }).waitFor();
  c.state.failed = true;
  await returning(c);
  await c.page.waitForFunction(
    () => !document.querySelector("#acct-panel")?.textContent.includes("Purchased Auto-Apply runs"),
  );
  c.state.failed = false;
  c.state.me = { used: 12, limit: 20, bonus: 3, purchased: 5 };
  await returning(c);
  await c.page.getByText("5 remaining. Purchased runs do not expire.", { exact: true }).waitFor();
  assert.equal(c.calls.filter((x) => x.path.includes("/topup/")).length, 0);
  assert.equal(await c.page.getByText(/payment confirmed|payment successful/i).count(), 0);
  assert.deepEqual(c.errors, []);
  report.push({
    scenario:
      "ordinary root return, paired BFCache events, hold/removal, stale failure and recovery",
    meReads: countMe(c),
    externalRequests: 0,
    errors: c.errors,
  });
  await c.ctx.close();
  await browser.close();
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  process.exitCode = 1;
});
