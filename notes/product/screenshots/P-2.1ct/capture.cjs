const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const tools = path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules");
const [before, after] = process.argv.slice(2),
  origin = "https://internscout.org",
  api = "https://internscout-api.bpmcginley.workers.dev";
const mime = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const report = [];
async function scenario(
  browser,
  site,
  phase,
  width,
  theme,
  enabled,
  signed = false,
  variant = "valid",
) {
  const ctx = await browser.newContext({
    viewport: { width, height: 1000 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const token = "iss_" + crypto.randomBytes(32).toString("base64url");
  await ctx.addInitScript(
    ({ signed, token }) => {
      localStorage.setItem("internscout.setup.skipped.v1", "true");
      localStorage.setItem("internscout.landing.seen.v1", "true");
      if (signed)
        localStorage.setItem(
          "internscout.session",
          JSON.stringify({
            token,
            account: "synthetic",
            email: "synthetic@example.test",
            expires: "2099-01-01T00:00:00Z",
          }),
        );
    },
    { signed, token },
  );
  let held,
    next = 202,
    calls = [],
    external = 0,
    errors = [];
  await ctx.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "cdn.jsdelivr.net" && /react(?:-dom)?@/.test(u.pathname)) {
      const n = u.pathname.includes("react-dom@") ? "react-dom" : "react";
      return route.fulfill({
        path: path.join(tools, n, "umd", n + ".production.min.js"),
        contentType: "text/javascript",
      });
    }
    if (u.origin === api) {
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (u.pathname === "/follows/signup") {
        calls.push({
          body: route.request().postDataJSON(),
          headers: route.request().headers(),
          url: route.request().url(),
        });
        if (next === "held") {
          held = () => route.fulfill({ status: 202, headers });
          return;
        }
        return route.fulfill({ status: next, headers, body: next === 200 ? "{}" : "" });
      }
      return route.fulfill({ status: 404, headers });
    }
    if (u.hostname === "static.cloudflareinsights.com")
      return route.fulfill({ body: "", contentType: "text/javascript" });
    if (u.origin !== origin) {
      external++;
      return route.abort();
    }
    if (u.pathname === "/data/placements.json") return route.fulfill({ json: { placements: [] } });
    let name = decodeURIComponent(u.pathname).slice(1);
    if (!name || name.endsWith("/")) name += "index.html";
    if (variant === "root-fallback" && name === "data/listings/index.json")
      return route.fulfill({ status: 404 });
    if (variant === "root-fallback" && name === "data/index.json")
      name = "data/listings/index.json";
    const file = path.resolve(site, name);
    assert(file.startsWith(path.resolve(site) + path.sep));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    let body = fs.readFileSync(file);
    if (name === "index.html" && enabled)
      body = Buffer.from(
        body.toString().replace("<html ", '<html data-follow-signup-enabled="1" '),
      );
    if (/\/listings\.mjs$/.test(name))
      body = Buffer.from(
        body
          .toString()
          .replace(
            "return {\n      init, ensure,",
            "return browser.__companyStore = {\n      init, ensure,",
          ),
      );
    if (/^data\/listings\/[A-Z]{2}\.json$/.test(name) || name === "data/first.json") {
      const rows = JSON.parse(body);
      for (const row of rows) {
        row.company_name = "Fixture Labs";
        row.follow_company_key = "fixture labs";
        if (variant === "missing") delete row.follow_company_key;
        if (variant === "malformed") row.follow_company_key = " bad";
        if (variant === "closed") row.status = "closed";
      }
      body = Buffer.from(JSON.stringify(rows));
    }
    return route.fulfill({ body, contentType: mime[path.extname(file)] });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/?state=MA" + (variant === "closed" ? "&status=closed" : ""));
  const details = page.getByRole("button", { name: /^Details: Fixture Labs,/ }).first();
  await details.waitFor();
  await details.focus();
  await page.keyboard.press("Enter");
  const panel = page.locator("tr.why").first();
  await panel.waitFor();
  await page.evaluate(() => document.fonts.ready);
  const toggle = panel.getByRole("button", {
    name: "Email me when Fixture Labs posts an internship",
    exact: true,
  });
  assert.equal(calls.length, 0);
  const usable = enabled && phase !== "before" && variant === "valid";
  let screenshot;
  if (!usable) {
    assert.equal(await toggle.count(), 0);
    await panel.evaluate((e) => e.scrollIntoView({ block: "start" }));
    if (variant === "valid")
      screenshot = await page.screenshot({
        path: phase === "before" ? path.join(__dirname, `before-${width}-${theme}.png`) : undefined,
      });
  } else {
    await toggle.waitFor();
    await toggle.focus();
    await page.keyboard.press("Enter");
    const form = panel.getByRole("form", {
        name: "Email me when Fixture Labs posts an internship",
        exact: true,
      }),
      email = form.getByLabel("Email", { exact: true }),
      submit = form.getByRole("button", { name: "Email me new internships", exact: true });
    await email.waitFor();
    assert(await email.evaluate((e) => e === document.activeElement));
    assert.equal(await form.getByRole("checkbox").count(), signed ? 1 : 0);
    for (const c of [toggle, email, submit]) assert((await c.boundingBox()).height >= 44);
    await panel.evaluate((e) => e.scrollIntoView({ block: "start" }));
    screenshot = await page.screenshot({
      path: path.join(
        __dirname,
        `after-${signed ? "linked-option" : "anonymous"}-${width}-${theme}.png`,
      ),
    });
    await email.fill("synthetic@example.test");
    if (signed) {
      const cb = form.getByRole("checkbox");
      assert(!(await cb.isChecked()));
      await cb.check();
    }
    await submit.click();
    await form.getByRole("status").filter({ hasText: "If this address" }).waitFor();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      email: "synthetic@example.test",
      link: signed,
      scope: { kind: "company", company: "fixture labs" },
    });
    assert.equal(calls[0].headers.authorization, signed ? "Bearer " + token : undefined);
    assert.equal(calls[0].headers.referer, undefined);
    await page.keyboard.press("Escape");
    assert.equal(await panel.count(), 1);
    assert.equal(await form.count(), 0);
    await toggle.click();
    next = 200;
    await email.fill("synthetic@example.test");
    await submit.click();
    await form
      .getByText("Email follows are unavailable. Please try again later.", { exact: true })
      .waitFor();
    next = "held";
    await submit.click();
    await page.waitForFunction(
      () => document.querySelector("tr.why form")?.getAttribute("aria-busy") === "true",
    );
    while (!held) await page.waitForTimeout(10);
    await email.focus();
    await page.keyboard.press("Escape");
    assert.equal(await panel.count(), 1);
    assert.equal(await form.getAttribute("aria-busy"), "true");
    await page
      .getByRole("button", { name: /^Details: Fixture Labs,/ })
      .first()
      .click();
    await held().catch(() => {});
    await page.waitForTimeout(30);
    assert.equal(await page.locator("tr.why").count(), 0);
    assert.equal(
      await page
        .getByText("If this address can receive email, a confirmation link is on its way.", {
          exact: true,
        })
        .count(),
      0,
    );
    await details.click();
    await toggle.click();
    assert.equal(await email.inputValue(), "");
    if (signed) {
      held = null;
      await email.fill("synthetic@example.test");
      await form.getByRole("checkbox").check();
      await submit.click();
      while (!held) await page.waitForTimeout(10);
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await held().catch(() => {});
      await page.waitForTimeout(30);
      assert.equal(await email.count(), 0);
      await toggle.click();
      assert.equal(await form.getByRole("checkbox").count(), 0);
      assert.equal(await email.inputValue(), "");
    }
    if (width === 1280 && theme === "light" && !signed) {
      // Test-only access to the actual native Core store; no production hook is added.
      assert(await page.evaluate(() => !!window.__companyStore));
      held = null;
      await email.fill("synthetic@example.test");
      await submit.click();
      while (!held) await page.waitForTimeout(10);
      await page.evaluate(() => {
        for (const r of window.__companyStore.all()) r.follow_company_key = "changed";
      });
      await held().catch(() => {});
      await form
        .getByText("Email follows are unavailable. Please try again later.", { exact: true })
        .waitFor();
      const n = calls.length;
      await submit.click();
      await page.waitForTimeout(30);
      assert.equal(calls.length, n);
      await page.evaluate(() => {
        for (const r of window.__companyStore.all()) r.follow_company_key = "fixture labs";
      });
      held = null;
      await submit.click();
      while (!held) await page.waitForTimeout(10);
      assert.equal(calls.length, n + 1);
      const cleared = await page.evaluate(() => {
        window.__reset = window.__companyStore.init();
        return { rows: window.__companyStore.all().length, index: window.__companyStore.index() };
      });
      assert.deepEqual(cleared, { rows: 0, index: null });
      await held().catch(() => {});
      await form
        .getByText("Email follows are unavailable. Please try again later.", { exact: true })
        .waitFor();
      await page.evaluate(() => window.__reset);
      await page.waitForTimeout(50);
      assert.equal(calls.length, n + 1);
      await page.evaluate(() =>
        document
          .querySelector("tr.why form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await page.waitForTimeout(30);
      assert.equal(calls.length, n + 1);
    }
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  assert.equal(external, 0);
  report.push({
    phase,
    width,
    theme,
    enabled,
    signed,
    variant,
    mockPosts: calls.length,
    external,
    pageErrors: errors.length,
  });
  await ctx.close();
  return screenshot;
}
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-features=BackForwardCache",
    ],
  });
  try {
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        const a = await scenario(browser, before, "before", width, theme, false);
        const b = await scenario(browser, after, "default", width, theme, false);
        assert(a.equals(b), "default screenshot parity");
        await scenario(browser, after, "after", width, theme, true);
        await scenario(browser, after, "after", width, theme, true, true);
      }
    for (const v of ["missing", "malformed", "closed", "root-fallback"])
      await scenario(browser, after, "after", 375, "light", true, false, v);
    fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify({
        scenarios: report.length,
        defaultPixelParity: 4,
        screenshots: 12,
        externalRequests: 0,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
