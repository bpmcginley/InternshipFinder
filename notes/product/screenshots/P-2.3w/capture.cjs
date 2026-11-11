// Real publisher outputs, synthetic data, isolated Edge; every request intercepted locally.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const tools = path.join(process.env.TEMP, "internscout-product-capture-tools");
const { chromium } = require(path.join(tools, "node_modules/playwright-core"));
const root = path.resolve(process.argv[2]),
  report = [],
  prior = new Map();
let browser;
(async () => {
  browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  for (const phase of ["before", "after"])
    for (const width of [1280, 375])
      for (const colorScheme of ["light", "dark"]) {
        const ctx = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme,
          locale: "en-US",
          timezoneId: "America/New_York",
          reducedMotion: "reduce",
          serviceWorkers: "block",
        });
        const hits = [],
          requests = [],
          errors = [];
        await ctx.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => false });
          localStorage.setItem("internscout.setup.skipped.v1", "true");
          localStorage.setItem("internscout.landing.seen.v1", "true");
          localStorage.setItem(
            "internscout.visit.v1",
            JSON.stringify(Date.parse("2026-11-09T18:00:00Z")),
          );
        });
        await ctx.route("**/*", async (route) => {
          const u = new URL(route.request().url());
          requests.push(u.origin + u.pathname);
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
            if (u.pathname === "/hit") hits.push(JSON.parse(route.request().postData() || "{}"));
            return route.fulfill({
              json:
                u.pathname === "/config"
                  ? { google_client_id: "", microsoft_client_id: "", plans: [] }
                  : {},
            });
          } else if (u.origin !== "https://internscout.org") return route.abort();
          else {
            let name = decodeURIComponent(u.pathname).replace(/^\//, "");
            if (!name || name.endsWith("/")) name += "index.html";
            const site = path.join(root, phase, "site");
            file = path.resolve(site, name);
            assert(file.startsWith(site + path.sep));
          }
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
          const contentType =
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".mjs": "text/javascript",
              ".css": "text/css",
              ".json": "application/json",
              ".woff2": "font/woff2",
              ".png": "image/png",
              ".svg": "image/svg+xml",
            }[path.extname(file)] || "application/octet-stream";
          return route.fulfill({ body: fs.readFileSync(file), contentType });
        });
        for (const [name, suffix, selector] of [
          ["dashboard", "/", ".list a.open-link[data-employer-key]"],
          ["field", "/internships/software-engineering/", "a.go[data-employer-key]"],
          ["pay", "/internships/highest-paying/", "a.go[data-employer-key]"],
        ]) {
          const page = await ctx.newPage();
          page.on("pageerror", (e) => errors.push(e.message));
          await page.clock.install({ time: new Date("2026-11-10T18:00:00Z") });
          const requestStart = requests.length,
            hitStart = hits.length;
          const shardResponses =
            name === "dashboard"
              ? Object.keys(
                  JSON.parse(
                    fs.readFileSync(path.join(root, phase, "site/data/listings/index.json")),
                  ).files,
                )
                  .filter((key) => ["MA", "NY", "remote"].includes(key))
                  .map((key) =>
                    page.waitForResponse(
                      (response) =>
                        new URL(response.url()).pathname === `/data/listings/${key}.json`,
                    ),
                  )
              : [];
          await page.goto("https://internscout.org" + suffix);
          const link = page.locator(selector).first();
          await link.waitFor();
          await page.clock.runFor(2000);
          await Promise.all(shardResponses.map(async (response) => (await response).finished()));
          await page.waitForLoadState("networkidle");
          await page.clock.runFor(2000);
          if (name === "dashboard") await page.locator(".rowbtn.try").first().waitFor();
          await page.waitForTimeout(200);
          await page.evaluate(() => document.fonts.ready);
          await link.scrollIntoViewIfNeeded();
          assert.equal(
            await page.locator('script[data-employer-posting-counts="1"]').count(),
            phase === "after" ? 1 : 0,
          );
          assert.equal(
            await page
              .locator(".paid [data-employer-key], [data-placement] [data-employer-key]")
              .count(),
            0,
          );
          const proof = await page.evaluate(() => ({
            text: document.body.innerText,
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            links: [...document.querySelectorAll("a")].map((a) => ({
              href: a.getAttribute("href"),
              text: a.textContent,
              target: a.target,
              rel: a.rel,
              rect: [
                a.getBoundingClientRect().x,
                a.getBoundingClientRect().y,
                a.getBoundingClientRect().width,
                a.getBoundingClientRect().height,
              ],
            })),
          }));
          assert(proof.scrollWidth <= width + 1);
          const key = `${name}-${width}-${colorScheme}`,
            initialRequests = [...new Set(requests.slice(requestStart))].sort();
          if (phase === "before") prior.set(key, { proof, initialRequests });
          else assert.deepEqual({ proof, initialRequests }, prior.get(key));
          await page.screenshot({ path: path.join(__dirname, `${phase}-${key}.png`) });
          const company = await link.getAttribute("data-employer-key");
          for (let i = 0; i < 2; i++) {
            await link.focus();
            const opened = ctx.waitForEvent("page");
            await page.keyboard.press("Enter");
            const popup = await opened;
            await popup.waitForLoadState().catch(() => {});
            await popup.close();
          }
          const paid = page.locator(".paid a.go, [data-placement] a.go").first();
          if (await paid.count()) {
            const opened = ctx.waitForEvent("page");
            await paid.click();
            const popup = await opened;
            await popup.waitForLoadState().catch(() => {});
            await popup.close();
          }
          await page.waitForTimeout(100);
          const events = hits.slice(hitStart).filter((x) => x.e === "employer_posting_open");
          assert.deepEqual(
            events,
            phase === "after" ? [{ e: "employer_posting_open", c: company }] : [],
          );
          report.push({
            phase,
            name,
            width,
            colorScheme,
            noOverflow: true,
            identicalLayoutTextLinksAndInitialRequests: phase === "after",
            organicEvents: events.length,
            repeatedKeyboardDeduplicated: true,
            paidLinksTested: await paid.count(),
            externalRequestsAllowed: 0,
          });
          await page.close();
        }
        // The actual opt-out disables the flagged page too, without changing its annotations.
        const optout = await ctx.newPage(),
          start = hits.length;
        await optout.goto("https://internscout.org/internships/software-engineering/?nocount=1");
        const link = optout.locator("a.go[data-employer-key]").first();
        await link.focus();
        const opened = ctx.waitForEvent("page");
        await optout.keyboard.press("Enter");
        const popup = await opened;
        await popup.waitForLoadState().catch(() => {});
        await popup.close();
        assert.equal(hits.slice(start).filter((x) => x.e === "employer_posting_open").length, 0);
        assert.deepEqual(errors, []);
        await ctx.close();
      }
  await browser.close();
  for (const key of prior.keys())
    assert(
      fs
        .readFileSync(path.join(__dirname, `before-${key}.png`))
        .equals(fs.readFileSync(path.join(__dirname, `after-${key}.png`))),
      key,
    );
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(report, null, 2) + "\n");
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  process.exitCode = 1;
});
