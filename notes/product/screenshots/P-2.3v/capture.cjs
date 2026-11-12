const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const tools = path.join(process.env.TEMP, "internscout-product-capture-tools");
const { chromium } = require(path.join(tools, "node_modules/playwright-core"));
const root = path.resolve(process.argv[2]),
  report = [],
  prior = new Map();
const data = path.join(root, "after/data");
const index = JSON.parse(fs.readFileSync(path.join(data, "listings/index.json")));
const all = [
  ...new Map(
    Object.values(index.files)
      .flatMap((m) => JSON.parse(fs.readFileSync(path.join(data, m.file))))
      .map((r) => [r.id, r]),
  ).values(),
];
const current = JSON.parse(fs.readFileSync(path.join(data, "first.json")))[0],
  closed = all.find((r) => r.status === "closed");
const snapshot = (r) => ({
  saved: true,
  company: r.company_name,
  title: r.title,
  url: r.apply_url,
  shards: Object.keys(index.files).filter((k) =>
    JSON.parse(fs.readFileSync(path.join(data, index.files[k].file))).some((x) => x.id === r.id),
  ),
});
const roles = {
  [current.id]: snapshot(current),
  [closed.id]: snapshot(closed),
  "saved-only": {
    saved: true,
    company: "Saved-only fixture",
    title: "Unavailable saved role",
    url: "https://jobs.example.test/saved-only",
    employer_key: "untrusted-local-key",
  },
};
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
        const errors = [],
          blocked = [],
          hits = [];
        await ctx.addInitScript(
          ({ roles }) => {
            localStorage.setItem("internscout.setup.skipped.v1", "true");
            localStorage.setItem("internscout.landing.seen.v1", "true");
            localStorage.setItem("internscout.mylist.v1", JSON.stringify({ version: 1, roles }));
            localStorage.setItem(
              "internscout.visit.v1",
              JSON.stringify(Date.parse("2026-11-09T18:00:00Z")),
            );
          },
          { roles },
        );
        await ctx.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          let file;
          if (url.hostname === "cdn.jsdelivr.net")
            file = path.join(
              tools,
              "node_modules",
              url.pathname.includes("react-dom@")
                ? "react-dom/umd/react-dom.production.min.js"
                : "react/umd/react.production.min.js",
            );
          else if (url.hostname === "internscout-api.bpmcginley.workers.dev") {
            if (url.pathname === "/hit") hits.push(route.request().postData());
            return route.fulfill({
              json:
                url.pathname === "/config"
                  ? { google_client_id: "", microsoft_client_id: "", plans: [] }
                  : {},
            });
          } else if (url.origin !== "http://127.0.0.1") {
            blocked.push(url.href);
            return route.abort();
          } else {
            file = path.resolve(
              root,
              phase,
              decodeURIComponent(url.pathname).replace(/^\//, "") || "index.html",
            );
            assert(file.startsWith(path.join(root, phase) + path.sep));
          }
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
          const type =
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
          await route.fulfill({ body: fs.readFileSync(file), contentType: type });
        });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await page.clock.install({ time: new Date("2026-11-10T18:00:00Z") });
        await page.goto("http://127.0.0.1/?nocount=1");
        await page.locator(".list a.open-link").first().waitFor();
        await page.waitForTimeout(800);
        await page.evaluate(() => document.fonts.ready);
        for (const view of ["browse", "my-list"]) {
          if (view === "my-list") {
            await page.getByRole("button", { name: /^My list \(/ }).click();
            await page.locator("#listing-saved-only").waitFor();
            await page.waitForTimeout(600);
          }
          const organic = page.locator('.list tr[id^="listing-"] a.open-link');
          const rows = await organic.evaluateAll((list) =>
            list.map((a) => ({
              id: a.closest("tr").id.slice(8),
              key: a.getAttribute("data-employer-key"),
              href: a.getAttribute("href"),
            })),
          );
          for (const row of rows) {
            const known = all.find((x) => x.id === row.id);
            assert.equal(row.key, phase === "after" && known ? known.employer_key : null, row.id);
          }
          assert.equal(
            await page
              .locator(
                ".paid [data-employer-key], a.aa[data-employer-key], button[data-employer-key], .aa-info [data-employer-key], script[data-employer-posting-counts]",
              )
              .count(),
            0,
          );
          if (view === "my-list") {
            assert.equal(await page.locator("#listing-saved-only [data-employer-key]").count(), 0);
            assert.match(await page.locator("#listing-" + closed.id).innerText(), /Closed/);
            assert.doesNotMatch(await page.locator("#listing-saved-only").innerText(), /Closed/);
          }
          await page.evaluate(() => {
            const row = document.querySelector('.list tr[id^="listing-"]');
            window.scrollTo(0, row.getBoundingClientRect().top + scrollY - 80);
          });
          const proof = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            text: document.querySelector(".sheet").innerText,
            links: [...document.querySelectorAll(".sheet a")].map((a) => ({
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
          const key = `${view}-${width}-${colorScheme}`;
          if (phase === "before") prior.set(key, proof);
          else assert.deepEqual(proof, prior.get(key));
          await page.screenshot({ path: path.join(__dirname, `${phase}-${key}.png`) });
          report.push({
            phase,
            view,
            width,
            colorScheme,
            rows: rows.length,
            annotated: rows.filter((r) => r.key !== null).length,
            unchangedLayoutAndLinks: phase === "after",
            externalPageRequestsAllowed: 0,
          });
        }
        const anchor = page.locator("#listing-" + current.id + " .open-link");
        await anchor.focus();
        const href = await anchor.getAttribute("href"),
          popupPromise = ctx.waitForEvent("page");
        await page.keyboard.press("Enter");
        const popup = await popupPromise;
        await popup.waitForLoadState().catch(() => {});
        assert(blocked.includes(href));
        await popup.close();
        const saved = page.locator("#listing-" + current.id + " .save-role");
        await saved.focus();
        await page.keyboard.press("Space");
        await page.waitForTimeout(100);
        assert.equal(await page.locator("#listing-" + current.id).count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.id), "listings");
        await page.getByRole("button", { name: "Browse roles", exact: true }).click();
        await page.getByRole("textbox", { name: "Search", exact: true }).fill(current.title);
        await page.locator(".paid .open-link").waitFor();
        assert.equal(await page.locator(".paid").count(), 1, "paid exclusion must be exercised");
        assert.equal(await page.locator(".paid [data-employer-key]").count(), 0);
        const tryButton = page.locator(".list .rowbtn.try").first();
        await tryButton.focus();
        await page.keyboard.press("Enter");
        await page.locator(".aa-info a").first().waitFor();
        assert.equal(
          await page.locator(".aa-info [data-employer-key],button[data-employer-key]").count(),
          0,
        );
        report[report.length - 1].keyboardOpenAndUnsave = true;
        report[report.length - 1].paidAndInstallExclusionsExercised = true;
        assert.deepEqual(hits, []);
        assert.deepEqual(errors, []);
        await ctx.close();
      }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(report, null, 2) + "\n");
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  process.exitCode = 1;
});
