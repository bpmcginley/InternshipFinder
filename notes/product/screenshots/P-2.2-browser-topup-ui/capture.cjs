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
    hint = true,
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
      if (u.pathname === "/me")
        return route.fulfill({
          json: {
            plan: "free",
            tier: "edu",
            paused,
            can_upgrade: false,
            allowance: { autofill: { used, limit: 10, bonus: 0 } },
          },
        });
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
        ["/js/app/allowance.mjs", "/js/app/dashboard.mjs"].includes(u.pathname)
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
  await page.goto("http://127.0.0.1/?out_of_runs=1&nocount=1");
  await page.locator("#allowance-panel").waitFor();
  await page
    .getByText(signedIn ? "10 runs used this month" : "Sign in to see", { exact: false })
    .count();
  await page.waitForTimeout(500);
  return { ctx, page, calls, errors, blocked, releases };
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
        if (phase === "after")
          await c.page.getByRole("button", { name: "Buy 25 extra runs", exact: true }).waitFor();
        else assert.equal(c.calls.filter((x) => x.path.includes("/topup/")).length, 0);
        await c.page.locator("#allowance-panel").scrollIntoViewIfNeeded();
        await c.page.evaluate(() => document.fonts.ready);
        assert.equal(
          await c.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await c.page.screenshot({ path: path.join(__dirname, `${phase}-${width}-${theme}.png`) });
        if (phase === "after") {
          const buy = c.page.getByRole("button", { name: "Buy 25 extra runs", exact: true });
          assert((await buy.boundingBox()).height >= 44);
          assert.equal(
            await c.page
              .locator('section[aria-label="Extra Auto-Apply runs"] [role="status"]')
              .getAttribute("aria-live"),
            "polite",
          );
          await buy.focus();
          await c.page.keyboard.press("Enter");
          await c.page
            .getByText(
              "Extra runs are not available right now. Your current allowance is unchanged.",
              { exact: true },
            )
            .waitFor();
          assert.equal(c.calls.filter((x) => x.path.endsWith("/checkout")).length, 1);
          assert.equal(await c.page.evaluate(() => document.activeElement.id), "topup-action");
          assert.equal(c.calls.find((x) => x.path.endsWith("/checkout")).body, null);
          assert.equal(c.page.url(), "http://127.0.0.1/?nocount=1");
          assert.equal(await c.page.getByText(/payment pending|payment confirmed/i).count(), 0);
          await c.page.getByRole("button", { name: "Retry extra runs" }).click();
          await buy.waitFor();
          assert.equal(c.calls.filter((x) => x.path.endsWith("/offer")).length, 2);
        }
        assert.deepEqual(c.errors, []);
        assert(c.blocked.every((u) => u === "https://static.cloudflareinsights.com/beacon.min.js"));
        report.push({
          phase,
          width,
          theme,
          calls: c.calls,
          errors: c.errors,
          blockedExternalAttempts: c.blocked,
          externalRequests: 0,
        });
        await c.ctx.close();
      }
  for (const [name, opts] of Object.entries({
    absent: { hint: false },
    remaining: { used: 2 },
    paused: { paused: true },
    anonymous: { signedIn: false },
    offerError: { offerError: true },
  })) {
    const c = await context("after", 375, "light", opts);
    if (name === "offerError")
      await c.page
        .getByText("Extra runs are not available right now. Your current allowance is unchanged.", {
          exact: true,
        })
        .waitFor();
    else assert.equal(c.calls.filter((x) => x.path.includes("/topup/")).length, 0);
    assert.equal(await c.page.getByRole("button", { name: "Buy 25 extra runs" }).count(), 0);
    assert.deepEqual(c.errors, []);
    report.push({ scenario: name, calls: c.calls, errors: c.errors });
    await c.ctx.close();
  }
  const late = await context("after", 375, "light", { checkout: "open", hold: true });
  await late.page.getByRole("button", { name: "Buy 25 extra runs" }).click();
  await late.page.waitForTimeout(100);
  await late.page.getByRole("button", { name: "Not now", exact: true }).click();
  late.releases.forEach((r) => r());
  await late.page.waitForTimeout(200);
  assert(late.blocked.every((u) => u === "https://static.cloudflareinsights.com/beacon.min.js"));
  assert.equal(late.page.url(), "http://127.0.0.1/?nocount=1");
  report.push({ scenario: "late checkout after close", calls: late.calls, blocked: late.blocked });
  await late.ctx.close();
  const signedOut = await context("after", 375, "dark", { checkout: "open", hold: true });
  await signedOut.page.getByRole("button", { name: "Buy 25 extra runs" }).click();
  await signedOut.page.waitForTimeout(100);
  await signedOut.page.getByRole("button", { name: "Account", exact: true }).click();
  await signedOut.page.getByRole("button", { name: "Sign out", exact: true }).click();
  signedOut.releases.forEach((r) => r());
  await signedOut.page.waitForTimeout(200);
  assert(
    signedOut.blocked.every((u) => u === "https://static.cloudflareinsights.com/beacon.min.js"),
  );
  assert.equal(await signedOut.page.getByRole("button", { name: "Buy 25 extra runs" }).count(), 0);
  report.push({
    scenario: "late checkout after sign out",
    calls: signedOut.calls,
    blocked: signedOut.blocked,
  });
  await signedOut.ctx.close();
  const invalid = await context("after", 1280, "light", { checkout: "invalid" });
  await invalid.page.getByRole("button", { name: "Buy 25 extra runs" }).click();
  await invalid.page
    .getByText("Extra runs are not available right now. Your current allowance is unchanged.", {
      exact: true,
    })
    .waitFor();
  assert(invalid.blocked.every((u) => u === "https://static.cloudflareinsights.com/beacon.min.js"));
  report.push({ scenario: "invalid checkout URL", calls: invalid.calls, blocked: invalid.blocked });
  await invalid.ctx.close();
  const valid = await context("after", 1280, "light", { checkout: "open" });
  let intercepted = 0;
  await valid.ctx.route("https://checkout.stripe.com/**", (r) => {
    intercepted++;
    return r.fulfill({
      contentType: "text/html",
      body: "<p>Synthetic navigation intercepted locally. No payment.</p>",
    });
  });
  await valid.page.getByRole("button", { name: "Buy 25 extra runs" }).click();
  await valid.page.waitForURL("https://checkout.stripe.com/c/pay/cs_test_synthetic");
  assert.equal(intercepted, 1);
  report.push({ scenario: "verified checkout local navigation", intercepted, calls: valid.calls });
  await valid.ctx.close();
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ screenshots: 8, scenarios: report.length, externalRequests: 0 }));
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
  });
