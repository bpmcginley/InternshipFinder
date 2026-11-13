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
    recoverFlag = true,
    recovery = "pending",
    recoveryCode = null,
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
  const state = { me: fixture, failed: false, held: false, recoverFlag, recovery, recoveryCode };
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
      localStorage.setItem(
        "internscout.profile.v1",
        JSON.stringify({
          majors: ["Computer Science"],
          fields: ["software"],
          states: ["RI"],
          class_year: "senior",
          updated: 1,
        }),
      );
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
      if (u.pathname === "/me" && req.method() === "DELETE")
        return route.fulfill({
          status: 409,
          json: { error: "topup_payment_pending", message: "synthetic" },
        });
      if (u.pathname === "/billing/topup/recover") {
        if (hold) await new Promise((resolve) => releases.push(resolve));
        const result = { status: state.recovery };
        if (state.recovery === "open")
          result.url = "https://checkout.stripe.com/c/pay/cs_test_synthetic";
        if (["settled", "expired", "inactive"].includes(state.recovery)) state.recoverFlag = false;
        return route.fulfill({
          status: state.recoveryCode || (state.recovery === "pending" ? 202 : 200),
          headers: { "cache-control": "no-store" },
          json: result,
        });
      }
      if (u.pathname === "/me") {
        const result = state.failed
          ? null
          : {
              plan: "free",
              tier: "edu",
              paused,
              can_upgrade: false,
              can_recover_topup: state.recoverFlag,
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
    } else if (u.origin === "https://checkout.stripe.com") {
      return route.fulfill({
        contentType: "text/html",
        body: "<title>Synthetic existing checkout</title><p>Local fixture only</p>",
      });
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
        ["/js/app/allowance.mjs", "/js/app/dashboard.mjs", "/js/core/account.mjs"].includes(
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
    let body = fs.readFileSync(file);
    if (u.pathname === "/js/app/dashboard.mjs")
      body = Buffer.from(
        body
          .toString()
          .replace(
            "const authRef = useRef(auth), authGeneration = useRef(0);",
            "const authRef = useRef(auth), authGeneration = useRef(0); browser.__fixtureAuth = (value) => { const next = {...authRef.current, ...value}; authRef.current = next; authGeneration.current++; setAuthState(next); };",
          ),
      );
    return route.fulfill({ body, contentType: type });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1" + pathname);
  await page.getByRole("button", { name: "Account", exact: true }).waitFor();
  await page.waitForTimeout(600);
  return { ctx, page, calls, errors, blocked, releases, state };
}

const countMe = (c) => c.calls.filter((x) => x.path === "/me" && x.method === "GET").length;
const recoverCalls = (c) => c.calls.filter((x) => x.path === "/billing/topup/recover");
async function check(c) {
  assert.deepEqual(c.errors, []);
  assert(c.blocked.every((u) => u === "https://static.cloudflareinsights.com/beacon.min.js"));
  assert.equal(
    c.calls.filter((x) => x.path === "/billing/topup/checkout" || x.path === "/billing/topup/offer")
      .length,
    0,
  );
  assert(await c.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
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
        await c.page.locator("#allowance-panel").scrollIntoViewIfNeeded();
        await c.page.evaluate(() => document.fonts.ready);
        assert.equal(
          await c.page
            .getByRole("button", { name: "Check or resume checkout", exact: true })
            .count(),
          phase === "after" ? 1 : 0,
        );
        assert.equal(recoverCalls(c).length, 0);
        await c.page.screenshot({
          path: path.join(__dirname, `${phase}-allowance-${width}-${theme}.png`),
        });
        await c.page.getByRole("button", { name: "Account", exact: true }).click();
        await c.page.locator("#acct-panel").waitFor();
        await c.page.screenshot({
          path: path.join(__dirname, `${phase}-account-${width}-${theme}.png`),
        });
        await c.page.keyboard.press("Escape");
        assert(
          await c.page
            .getByRole("button", { name: "Account", exact: true })
            .evaluate((e) => e === document.activeElement),
        );
        await check(c);
        report.push({
          phase,
          width,
          theme,
          views: ["allowance", "account"],
          passiveRecoveryRequests: recoverCalls(c).length,
          externalRequests: 0,
        });
        await c.ctx.close();
      }
  // Keyboard action with sales absent, pending/retry and exact terminal fresh read.
  const c = await context("after", 375, "light");
  const action = c.page.getByRole("button", { name: "Check or resume checkout", exact: true });
  await action.focus();
  await c.page.keyboard.press("Enter");
  await c.page
    .getByText("Your checkout is still being checked. Try again later.", { exact: true })
    .waitFor();
  assert.equal(recoverCalls(c).length, 1);
  const before = countMe(c);
  c.state.recovery = "settled";
  await action.click();
  await c.page.getByText("Checkout checked. Refreshing your allowance.", { exact: true }).waitFor();
  await c.page.waitForFunction(() => document.querySelector("#checkout-recovery-action") === null);
  assert.equal(countMe(c), before + 1);
  assert.equal(
    await c.page.locator("#checkout-recovery-status").evaluate((e) => e === document.activeElement),
    true,
  );
  assert.equal(await c.page.getByText(/payment (confirmed|successful)/i).count(), 0);
  for (const call of recoverCalls(c)) {
    assert.equal(call.method, "POST");
    assert.equal(call.body, null);
    assert.equal(call.hasBearer, true);
  }
  await check(c);
  report.push({
    scenario: "keyboard pending retry terminal, one fresh balance and focus preserved",
    recoveryRequests: 2,
    terminalMeReads: 1,
    externalRequests: 0,
  });
  await c.ctx.close();
  // Ordinary Account entry works with no arrival panel and sales off.
  const account = await context("after", 1280, "dark", { pathname: "/?nocount=1" });
  assert.equal(await account.page.locator("#allowance-panel").count(), 0);
  await account.page.getByRole("button", { name: "Account", exact: true }).click();
  await account.page.getByRole("button", { name: /^Check or resume checkout/ }).click();
  await account.page
    .getByText("Your checkout is still being checked. Try again later.", { exact: true })
    .waitFor();
  assert(
    await account.page
      .getByRole("button", { name: "Account", exact: true })
      .evaluate((e) => e === document.activeElement),
  );
  await check(account);
  report.push({ scenario: "ordinary Account recovery with sales off", externalRequests: 0 });
  await account.ctx.close();
  // A delayed response cannot navigate after auth A-B-A, even with reused token.
  const late = await context("after", 375, "light", { hold: true, recovery: "open" });
  await late.page.getByRole("button", { name: "Check or resume checkout", exact: true }).click();
  await late.page.waitForFunction(() =>
    document
      .querySelector("#checkout-recovery-status")
      ?.textContent.includes("Checking your checkout"),
  );
  await late.page.evaluate(() => {
    const a = { token: "iss_synthetic_topup", source: "page" };
    __fixtureAuth({ ...a, token: "iss_synthetic_other" });
    __fixtureAuth(a);
  });
  late.releases.forEach((r) => r());
  await late.page.waitForTimeout(100);
  assert.equal(new URL(late.page.url()).origin, "http://127.0.0.1");
  await check(late);
  report.push({
    scenario: "held recovery response after A-B-A does not navigate",
    externalRequests: 0,
  });
  await late.ctx.close();
  const hidden = await context("after", 375, "light", { recoverFlag: false });
  assert.equal(
    await hidden.page.getByRole("button", { name: /^Check or resume checkout/ }).count(),
    0,
  );
  await hidden.page.getByRole("button", { name: "Account", exact: true }).click();
  assert.equal(
    await hidden.page.getByRole("button", { name: /^Check or resume checkout/ }).count(),
    0,
  );
  assert.equal(recoverCalls(hidden).length, 0);
  await check(hidden);
  await hidden.ctx.close();
  report.push({
    scenario: "absent capability has no recovery action or request",
    externalRequests: 0,
  });
  const resumed = await context("after", 1280, "light", { recovery: "open" });
  await resumed.page.getByRole("button", { name: "Check or resume checkout", exact: true }).click();
  await resumed.page.waitForURL("https://checkout.stripe.com/c/pay/cs_test_synthetic");
  assert.equal(await resumed.page.title(), "Synthetic existing checkout");
  assert.equal(recoverCalls(resumed).length, 1);
  assert.equal(countMe(resumed), 1);
  await check(resumed);
  report.push({
    scenario: "verified open navigates only to intercepted synthetic existing Stripe checkout",
    externalRequests: 0,
  });
  await resumed.ctx.close();
  for (const phase of ["before", "after"])
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        const d = await context(phase, width, theme, { pathname: "/?nocount=1" });
        const saved = await d.page.evaluate(() => JSON.stringify({ ...localStorage }));
        await d.page.getByRole("button", { name: "My profile", exact: true }).click();
        d.page.on("dialog", (dialog) => dialog.accept());
        await d.page.getByRole("button", { name: "Delete my data", exact: true }).click();
        const text =
          phase === "after"
            ? "Finish or let your pending checkout expire before deleting your data. Contact support if a billing confirmation is pending. Nothing was deleted."
            : "Cancel your Supporter plan first (Manage plan), then delete. Nothing was deleted.";
        await d.page.getByText(text, { exact: true }).waitFor();
        await d.page.getByText(text, { exact: true }).scrollIntoViewIfNeeded();
        assert.equal(await d.page.evaluate(() => JSON.stringify({ ...localStorage })), saved);
        await d.page.screenshot({
          path: path.join(__dirname, `${phase}-deletion-${width}-${theme}.png`),
        });
        await check(d);
        report.push({
          phase,
          width,
          theme,
          scenario: "409 preserves browser values and session",
          externalRequests: 0,
        });
        await d.ctx.close();
      }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
