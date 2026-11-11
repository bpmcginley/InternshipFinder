// Local synthetic pages, isolated Edge contexts, all outgoing requests intercepted.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const root = path.resolve(process.argv[2]);
let browser;
(async () => {
  browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const report = [],
    prior = new Map();
  for (const phase of ["before", "after"])
    for (const width of [1280, 375])
      for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme,
          reducedMotion: "reduce",
        });
        const blocked = [],
          errors = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== "http://local.test") {
            blocked.push(url.href);
            return route.abort();
          }
          let name = decodeURIComponent(url.pathname).replace(/^\//, "");
          if (!name || name.endsWith("/")) name += "index.html";
          const site = path.join(root, phase, "site"),
            file = path.resolve(site, name);
          assert(file.startsWith(site + path.sep));
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
          const type =
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".woff2": "font/woff2",
            }[path.extname(file)] || "application/octet-stream";
          await route.fulfill({ body: fs.readFileSync(file), contentType: type });
        });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        for (const [name, suffix] of [
          ["field", "software-engineering"],
          ["pay", "highest-paying"],
        ]) {
          await page.goto(`http://local.test/internships/${suffix}/`);
          await page.evaluate(() => document.fonts.ready);
          const direct = page.locator("a.go:not(.paid a.go)");
          assert((await direct.count()) > 0);
          assert.equal(
            await page.locator("[data-employer-key]").count(),
            phase === "after" ? await direct.count() : 0,
          );
          assert.equal(
            await page.locator("a.aa[data-employer-key], .paid [data-employer-key]").count(),
            0,
          );
          assert.equal(await page.locator("script[data-employer-posting-counts]").count(), 0);
          await direct.first().scrollIntoViewIfNeeded();
          const proof = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            text: document.querySelector("main").innerText,
            links: [...document.querySelectorAll("main a")].map((a) => ({
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
          const key = `${name}-${width}-${colorScheme}`;
          if (phase === "before") prior.set(key, proof);
          else assert.deepEqual(proof, prior.get(key));
          await page.screenshot({ path: path.join(__dirname, `${phase}-${key}.png`) });
          await direct.first().focus();
          const href = await direct.first().getAttribute("href");
          const popupPromise = context.waitForEvent("page");
          await page.keyboard.press("Enter");
          const popup = await popupPromise;
          await popup.waitForLoadState().catch(() => {});
          assert(blocked.includes(href));
          await popup.close();
          report.push({
            phase,
            name,
            width,
            colorScheme,
            directLinks: await direct.count(),
            identicalLayoutAndLinks: phase === "after",
            keyboardPostingRequestIntercepted: true,
            externalRequestsAllowed: 0,
          });
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(report, null, 2) + "\n");
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
