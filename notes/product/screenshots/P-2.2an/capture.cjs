const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const root = path.resolve(__dirname, "../../../.."),
  baseline = process.argv[2],
  A = "iss_synthetic_A",
  B = "iss_synthetic_B";
const tools = path.join(process.env.TEMP, "internscout-product-capture-tools");
const rows = JSON.parse(
  fs.readFileSync(path.join(root, "notes/product/screenshots/P-1.3/listings-fixture.json")),
);
const report = [];
let browser;
(async () => {
  browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  for (const phase of ["before", "after"])
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        const ctx = await browser.newContext({
          viewport: { width, height: 1100 },
          colorScheme: theme,
          reducedMotion: "reduce",
          locale: "en-US",
          timezoneId: "America/New_York",
          serviceWorkers: "block",
        });
        const calls = [],
          blocked = [],
          errors = [];
        let releaseOld,
          first = true;
        await ctx.addInitScript(
          ({ A }) => {
            localStorage.setItem("internscout.setup.skipped.v1", "true");
            localStorage.setItem("internscout.landing.seen.v1", "true");
            if (!sessionStorage.getItem("synthetic.initialized")) {
              localStorage.setItem(
                "internscout.session",
                JSON.stringify({
                  token: A,
                  account: "synthetic",
                  email: "fixture@example.edu",
                  expires: "2030-11-10T18:00:00Z",
                }),
              );
              sessionStorage.setItem("synthetic.initialized", "1");
            }
            addEventListener("message", (event) => {
              const d = event.data;
              if (d?.__internscout === "req")
                postMessage({ __internscout: "res", id: d.id, result: {} }, location.origin);
            });
          },
          { A },
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
              bearer: !!req.headers().authorization,
            });
            if (u.pathname === "/config")
              return route.fulfill({
                json: {
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
              if (first && req.headers().authorization === "Bearer " + A) {
                first = false;
                await new Promise((resolve) => (releaseOld = resolve));
                return route.fulfill({ status: 401, json: { error: "auth" } });
              }
              return route.fulfill({
                headers: { "cache-control": "no-store" },
                json: {
                  plan: "free",
                  tier: "edu",
                  can_upgrade: false,
                  allowance: { autofill: { used: 2, limit: 10, bonus: 0, purchased: 5 } },
                },
              });
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
            if (["/data/first.json", "/data/listings/RI.json"].includes(u.pathname))
              return route.fulfill({ json: rows });
            if (u.pathname.endsWith(".desc.json")) return route.fulfill({ json: {} });
            if (phase === "before" && u.pathname === "/js/core/account.mjs")
              file = path.join(baseline, "docs/js/core/account.mjs");
            else if (phase === "before" && u.pathname === "/js/app/allowance.mjs")
              file = path.join(baseline, "docs/js/app/allowance.mjs");
            else
              file = path.join(
                root,
                "docs",
                u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname),
              );
          }
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
          let bytes = fs.readFileSync(file);
          if (u.pathname === "/js/app/dashboard.mjs") {
            // Test-only observation seam in the intercepted local response. The actual
            // setter, generation updates, effects, Core and loader execute unchanged.
            const marker = "    const { info, queue, profile: extProfile } = useExtension();";
            let source = bytes.toString("utf8");
            assert.equal(source.split(marker).length, 2);
            source = source.replace(marker, "    browser.__fixtureSetAuth = setAuth;\n" + marker);
            bytes = Buffer.from(source);
          }
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
          return route.fulfill({ body: bytes, contentType: type });
        });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("http://127.0.0.1/?out_of_runs=1&nocount=1");
        await page.waitForFunction(() => typeof window.__fixtureSetAuth === "function");
        while (!releaseOld) await page.waitForTimeout(10);
        async function select(token) {
          await page.evaluate((token) => {
            const record = {
              token,
              account: "synthetic",
              email: "fixture@example.edu",
              expires: "2030-11-10T18:00:00Z",
            };
            localStorage.setItem("internscout.session", JSON.stringify(record));
            window.__fixtureSetAuth((a) => ({
              ...a,
              token,
              who: window.IS.authInfo(record),
              source: "page",
            }));
          }, token);
        }
        await select(B);
        await page.waitForFunction(() =>
          document.querySelector("#allowance-status")?.textContent.includes("2 Auto-Apply"),
        );
        const beforeReturn = calls.filter((x) => x.path === "/me").length;
        await select(A);
        while (calls.filter((x) => x.path === "/me").length === beforeReturn)
          await page.waitForTimeout(10);
        await page.waitForTimeout(100);
        releaseOld();
        await page.waitForTimeout(100);
        const retained = await page.evaluate(() => !!localStorage.getItem("internscout.session"));
        assert.equal(retained, phase === "after");
        // A fresh dashboard from the resulting storage displays the actual persisted
        // outcome. The initial synthetic record is not injected again on navigation.
        await page.goto("http://127.0.0.1/?out_of_runs=1&nocount=1");
        await page.locator("#allowance-panel").waitFor();
        if (phase === "after")
          await page.getByText("2 Auto-Apply runs used this month", { exact: false }).waitFor();
        else
          await page
            .getByText("Sign in to see your allowance, invite link and available plans.", {
              exact: false,
            })
            .waitFor();
        await page.locator("#allowance-panel").scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() =>
          scrollTo({
            top: Math.max(
              0,
              document.querySelector("#allowance-panel").getBoundingClientRect().top + scrollY - 16,
            ),
            behavior: "instant",
          }),
        );
        assert((await page.locator("#allowance-panel").boundingBox()).y >= 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        assert(blocked.every((u) => u === "https://static.cloudflareinsights.com/beacon.min.js"));
        assert(calls.filter((x) => x.path === "/me").every((x) => x.bearer));
        await page.screenshot({ path: path.join(__dirname, `${phase}-${width}-${theme}.png`) });
        report.push({
          phase,
          width,
          theme,
          persistedSessionRetained: retained,
          authenticatedMeReads: calls.filter((x) => x.path === "/me").length,
          errors,
          externalRequests: 0,
        });
        await ctx.close();
      }
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  await browser.close();
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  process.exitCode = 1;
});
