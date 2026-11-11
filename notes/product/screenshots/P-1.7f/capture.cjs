const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const tools = process.env.CAPTURE_TOOLS;
const { chromium } = require(path.join(tools, "node_modules/playwright-core"));
const root = path.resolve(__dirname, "../../../..");
const delegateOnly = process.argv[2] === "delegate";
const phase = delegateOnly ? "after" : process.argv[2] || "after";
const parent = process.env.DASHBOARD_PARENT || "0dd68bbe475319cb8b33c8655c03366bc3bb933b";
const published = process.env.PUBLISHED_COUNTER || "700d1ddc96173c4214f5ff9965847b89b6d69f16";
const origin = "https://internscout.org";
const rows = require("../P-1.3/listings-fixture.json");
const urls = ["https://github.com/bpmcginley/internships-every-major", origin + "/widget/builder.html"];
const names = ["Internships for every major on GitHub", "Put live internships on your club or department site"];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const git = spec => execFileSync("git", ["show", spec], { cwd: root });
const fixtureIndex = { files: { MA: { file: "listings/MA.json", open: rows.length } } };

async function check(browser, width, colorScheme, simulateDelegate = false) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, hasTouch: width === 375 });
  const rejected = [], errors = [];
  try {
    await context.addInitScript(({ simulateDelegate }) => {
      localStorage.setItem("internscout.setup.skipped.v1", "true");
      localStorage.setItem("internscout.landing.seen.v1", "true");
      if (simulateDelegate) Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.fixtureBeacons = [];
      navigator.sendBeacon = (_url, data) => {
        window.fixtureBeacons.push(data.text().then(body => JSON.parse(body)));
        return true;
      };
    }, { simulateDelegate });
    await context.route("**/*", route => {
      const u = new URL(route.request().url()), p = u.pathname;
      if (u.hostname === "cdn.jsdelivr.net" && p.includes("react")) {
        const name = p.includes("react-dom@") ? "react-dom" : "react";
        const file = path.join(tools, "node_modules", name, "umd", name + ".production.min.js");
        return route.fulfill({ path: file, contentType: "text/javascript" });
      }
      if (u.origin !== origin) {
        if (u.hostname.endsWith(".workers.dev")) return route.fulfill({ json: { providers: [] }, headers: { "access-control-allow-origin": "*" } });
        rejected.push(u.origin); return route.abort();
      }
      if (p === "/data/listings/index.json") return route.fulfill({ json: fixtureIndex });
      if (p === "/data/listings/MA.json") return route.fulfill({ json: rows });
      if (p === "/data/stats.json") return route.fulfill({ json: { open: rows.length, new: 0 } });
      if (p === "/data/placements.json") return route.fulfill({ json: [] });
      if (p === "/js/app.js" && phase === "before") return route.fulfill({ body: git(parent + ":docs/js/app.js"), contentType: "text/javascript" });
      if (p === "/js/count.js" && simulateDelegate) return route.fulfill({ body: git(published + ":docs/js/count.js"), contentType: "text/javascript" });
      const file = path.join(root, "docs", p === "/" ? "index.html" : p.slice(1));
      return fs.existsSync(file) && fs.statSync(file).isFile()
        ? route.fulfill({ path: file, contentType: types[path.extname(file)] || "application/octet-stream" })
        : route.fulfill({ status: 404, body: "" });
    });
    const page = await context.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(origin + "/?state=MA");
    const footer = page.locator("footer .links");
    await footer.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const links = footer.locator("[data-distribution]");
    if (phase === "after") {
      assert.deepEqual(await links.evaluateAll(a => a.map(e => e.href)), urls);
      assert.deepEqual(await links.evaluateAll(a => a.map(e => e.textContent)), names);
      assert.deepEqual(await links.evaluateAll(a => a.map(e => e.dataset.distribution)), ["list", "widget"]);
      await footer.getByRole("link", { name: "Install extension" }).focus();
      await page.keyboard.press("Tab");
      assert.equal(await links.first().evaluate(e => e === document.activeElement), true);
      await page.keyboard.press("Tab");
      assert.equal(await links.last().evaluate(e => e === document.activeElement), true);
      await page.keyboard.press("Tab");
      assert.equal(await footer.getByRole("link", { name: "Also check Handshake" }).evaluate(e => e === document.activeElement), true);
      if (simulateDelegate) {
        await page.waitForFunction(() => typeof window.ISCount === "function");
        await page.evaluate(() => document.addEventListener("click", e => {
          if (e.target.closest("a[data-distribution]")) e.preventDefault();
        }));
        for (const link of await links.all()) { await link.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); }
        assert.deepEqual(await page.evaluate(async () => (await Promise.all(fixtureBeacons))
          .filter(b => b.e === "list_link_click" || b.e === "widget_link_click")), [
          { e: "list_link_click", p: "/" }, { e: "widget_link_click", p: "/" },
        ]);
      }
    } else assert.equal(await links.count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await footer.evaluate(e => e.scrollWidth > e.clientWidth), false);
    assert.deepEqual(errors, []);
    if (!simulateDelegate) {
      await page.evaluate(() => document.activeElement.blur());
      await page.locator("footer").scrollIntoViewIfNeeded();
      const png = await page.screenshot({ path: path.join(__dirname, `${phase}-${width}-${colorScheme}.png`) });
      assert.equal(png.readUInt32BE(16), width);
    }
    console.log(JSON.stringify({ phase, width, colorScheme, simulateDelegate, remoteRequestsBlocked: rejected.length, errors: errors.length }));
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  try {
    if (!delegateOnly) for (const width of [1280, 375]) for (const theme of ["light", "dark"]) await check(browser, width, theme);
    if (phase === "after") {
      console.log("Published delegate " + execFileSync("git", ["rev-parse", published], { cwd: root, encoding: "utf8" }).trim());
      await check(browser, 375, "light", true);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
