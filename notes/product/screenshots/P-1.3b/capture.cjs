const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const tools = path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules");
const { chromium } = require(path.join(tools, "playwright-core"));
const [before, after] = process.argv.slice(2);
const origin = "https://internscout.org";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".css": "text/css",
};
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  let checks = 0;
  try {
    for (const [phase, site] of [
      ["before", before],
      ["after", after],
    ])
      for (const width of [1280, 375])
        for (const theme of ["light", "dark"]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: theme,
            reducedMotion: "reduce",
          });
          await context.addInitScript(() => {
            localStorage.setItem("internscout.setup.skipped.v1", "true");
            localStorage.setItem("internscout.landing.seen.v1", "true");
          });
          let external = 0;
          const errors = [];
          await context.route("**/*", async (route) => {
            const u = new URL(route.request().url());
            if (u.hostname === "cdn.jsdelivr.net" && /react(?:-dom)?@/.test(u.pathname)) {
              const n = u.pathname.includes("react-dom@") ? "react-dom" : "react";
              return route.fulfill({
                path: path.join(tools, n, "umd", n + ".production.min.js"),
                contentType: "text/javascript",
              });
            }
            if (u.hostname === "static.cloudflareinsights.com")
              return route.fulfill({ body: "", contentType: "text/javascript" });
            if (u.hostname === "internscout-api.bpmcginley.workers.dev")
              return route.fulfill({
                status: 404,
                body: "",
                headers: { "Access-Control-Allow-Origin": origin },
              });
            if (u.origin !== origin) {
              external++;
              return route.abort();
            }
            if (u.pathname === "/data/placements.json")
              return route.fulfill({ json: { placements: [] } });
            let name = decodeURIComponent(u.pathname).slice(1);
            if (!name || name.endsWith("/")) name += "index.html";
            const file = path.resolve(site, name);
            assert(file.startsWith(path.resolve(site) + path.sep));
            if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
            return route.fulfill({ path: file, contentType: types[path.extname(file)] });
          });
          const page = await context.newPage();
          page.on("pageerror", (e) => errors.push(e.message));
          for (const key of ["constructor", "__proto__"]) {
            await page.goto(origin + "/?field=" + key + "&state=MA");
            const empty = page.locator(".sheet.empty p");
            await empty.waitFor();
            await page.waitForFunction(() =>
              document
                .querySelector(".sheet.empty p")
                ?.textContent.startsWith("No open listings match"),
            );
            const text = await empty.innerText();
            const expected =
              phase === "before"
                ? key === "constructor"
                  ? "function Object() { [native code] }"
                  : "[object Object]"
                : key;
            assert(text.includes("field " + expected), text);
            await page.evaluate(() => document.fonts.ready);
            await empty.evaluate((e) => e.scrollIntoView({ block: "center" }));
            await page.screenshot({
              path: path.join(__dirname, `${phase}-${key}-${width}-${theme}.png`),
            });
            if (phase === "after")
              assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
              );
            checks++;
          }
          for (const [key, label] of [
            ["swe", "Software"],
            ["future_field", "Future field"],
          ]) {
            await page.goto(origin + "/?field=" + key + "&state=MA&q=synthetic_unmatched_query");
            await page.waitForFunction(() =>
              document
                .querySelector(".sheet.empty p")
                ?.textContent.startsWith("No open listings match"),
            );
            assert((await page.locator(".sheet.empty p").innerText()).includes("field " + label));
            checks++;
          }
          assert.deepEqual(errors, []);
          assert.equal(external, 0);
          console.log(JSON.stringify({ phase, width, theme, external }));
          await context.close();
        }
    console.log(`${checks} native checks;16 paired screenshots;all traffic intercepted`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
