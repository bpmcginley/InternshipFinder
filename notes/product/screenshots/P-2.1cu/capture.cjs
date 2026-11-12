const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const site = path.resolve(__dirname, "../../../..", "docs"),
  fixture = process.argv[2],
  origin = "https://internscout.org",
  routePath = "/internships/at/fixture-labs/";
const reports = [];
async function run(browser, phase, width, theme, broken = "") {
  const ctx = await browser.newContext({
    viewport: { width, height: 1000 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  if (broken === "setup")
    await ctx.addInitScript(() => {
      window.MutationObserver = class {
        constructor() {
          throw new Error("Synthetic unavailable observer");
        }
      };
    });
  const page = await ctx.newPage(),
    requests = [],
    errors = [];
  let held,
    next = 202,
    calls = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ctx.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    requests.push(u.pathname);
    if (u.origin === "https://internscout-api.bpmcginley.workers.dev") {
      assert.equal(u.pathname, "/follows/signup");
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      assert.equal(req.method(), "POST");
      assert.equal(u.search, "");
      calls.push({ body: req.postDataJSON(), headers: req.headers() });
      if (next === "held") {
        held = () => route.fulfill({ status: 202, headers });
        return;
      }
      return route.fulfill({ status: next, headers, body: next === 200 ? "{}" : "" });
    }
    assert.equal(u.origin, origin, "no third-party request");
    if (u.pathname === "/fixture-away/")
      return route.fulfill({
        body: "<!doctype html><title>Offline fixture away</title>",
        contentType: "text/html",
      });
    if (u.pathname === routePath) {
      assert.equal(req.method(), "GET");
      assert.equal(u.search, "");
      return route.fulfill({ path: path.join(fixture, phase + ".html"), contentType: "text/html" });
    }
    if (broken === "missing" && u.pathname === "/js/follow-company.mjs")
      return route.fulfill({ status: 404 });
    let file = path.resolve(site, "." + u.pathname);
    assert(file.startsWith(site + path.sep));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    let body = fs.readFileSync(file);
    if (broken === "old" && u.pathname === "/js/app/follow-form.mjs")
      body = Buffer.from(
        body
          .toString()
          .replace("export const FOLLOW_COPY", "const FOLLOW_COPY")
          .replace("export function normalizeFollowEmail", "function normalizeFollowEmail"),
      );
    return route.fulfill({
      body,
      contentType: {
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".woff2": "font/woff2",
        ".png": "image/png",
      }[path.extname(file)],
    });
  });
  await page.goto(origin + routePath);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(calls.length, 0);
  const toggle = page.getByRole("button", {
    name: "Email me when Fixture Labs posts an internship",
    exact: true,
  });
  if (phase === "before" || broken) {
    await page.waitForTimeout(50);
    assert.equal(await page.locator("input").count(), 0);
    assert.equal(await toggle.count(), 0);
    if (phase === "before") assert(!requests.includes("/js/follow-company.mjs"));
  } else {
    await toggle.waitFor();
    await toggle.focus();
    await page.keyboard.press("Enter");
    const form = page.getByRole("form", {
        name: "Email me when Fixture Labs posts an internship",
        exact: true,
      }),
      email = form.getByLabel("Email", { exact: true }),
      submit = form.getByRole("button", { name: "Email me new internships", exact: true });
    assert(await email.evaluate((e) => e === document.activeElement));
    for (const el of [toggle, email, submit]) assert((await el.boundingBox()).height >= 44);
    await toggle.evaluate((e) => e.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(__dirname, `after-${width}-${theme}.png`) });
    await email.fill("bad");
    await submit.click();
    await form.getByText("Enter a valid email address.", { exact: true }).waitFor();
    assert.equal(calls.length, 0);
    await email.fill("SYNTHETIC@example.test");
    await page.keyboard.press("Enter");
    await form
      .getByText("If this address can receive email, a confirmation link is on its way.", {
        exact: true,
      })
      .waitFor();
    assert.deepEqual(calls[0].body, {
      email: "synthetic@example.test",
      link: false,
      scope: { kind: "company", company: "fixture" },
    });
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls[0].headers.referer, undefined);
    await email.focus();
    await page.keyboard.press("Escape");
    assert.equal(await form.isVisible(), false);
    assert(await toggle.evaluate((e) => e === document.activeElement));
    await toggle.click();
    assert.equal(await email.inputValue(), "");
    next = 200;
    await email.fill("synthetic@example.test");
    await submit.click();
    await form
      .getByText("Email follows are unavailable. Please try again later.", { exact: true })
      .waitFor();
    await page.evaluate(() => {
      window.__persistedReturns = 0;
      window.addEventListener("pageshow", (e) => {
        if (e.persisted) window.__persistedReturns++;
      });
    });
    await page.goto(origin + "/fixture-away/");
    await page.goBack({ waitUntil: "commit" });
    await toggle.waitFor();
    assert.equal(await page.evaluate(() => window.__persistedReturns), 1, "actual BFCache return");
    assert.equal(await form.isVisible(), false);
    await toggle.click();
    assert.equal(await email.inputValue(), "");
    await email.fill("synthetic@example.test");
    next = "held";
    await submit.click();
    while (!held) await page.waitForTimeout(10);
    await email.evaluate((e) =>
      e.form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(await form.getAttribute("aria-busy"), "true");
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    assert.equal(await form.isVisible(), false);
    await toggle.click();
    assert.equal(await email.inputValue(), "");
    await held().catch(() => {});
    await page.waitForTimeout(30);
    assert.equal(
      await form
        .getByText("If this address can receive email, a confirmation link is on its way.", {
          exact: true,
        })
        .count(),
      0,
    );
    held = null;
    await email.fill("synthetic@example.test");
    await submit.click();
    while (!held) await page.waitForTimeout(10);
    await page.evaluate(() =>
      document
        .querySelector("[data-follow-company-key]")
        .setAttribute("data-follow-company-key", "different"),
    );
    await held().catch(() => {});
    await page.waitForTimeout(30);
    assert.equal(await page.locator("input").count(), 0);
    assert.equal(
      await page
        .getByText("If this address can receive email, a confirmation link is on its way.", {
          exact: true,
        })
        .count(),
      0,
    );
  }
  if (phase === "before") {
    await page
      .locator(".jobs")
      .first()
      .evaluate((e) => e.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(__dirname, `before-${width}-${theme}.png`) });
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (!broken) assert.deepEqual(errors, []);
  reports.push({
    phase,
    width,
    theme,
    broken,
    mockPosts: calls.length,
    expectedModuleErrors: errors.length,
    actualPersistedReturn: phase === "after" && !broken,
  });
  await ctx.close();
}
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"],
  });
  try {
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        await run(browser, "before", width, theme);
        await run(browser, "after", width, theme);
      }
    for (const broken of ["missing", "old", "setup"])
      await run(browser, "after", 375, "light", broken);
    fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(reports, null, 2) + "\n");
    console.log(JSON.stringify({ scenarios: reports.length, screenshots: 8, externalRequests: 0 }));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
