// Local synthetic Markdown preview only. No GitHub or third-party requests.
// node capture.cjs <isolated-playwright-tools> <preview-directory> <edge-executable>
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const [tools, preview, edge] = process.argv.slice(2);
const { chromium } = createRequire(path.join(path.resolve(tools), "package.json"))("playwright-core");

(async () => {
  const before = JSON.parse(fs.readFileSync(path.join(preview, "before-output.json"), "utf8"));
  const after = JSON.parse(fs.readFileSync(path.join(preview, "after-output.json"), "utf8"));
  const changed = Object.keys(after).filter((file) => after[file] !== before[file]);
  if (JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(Object.keys(after).sort()) ||
      JSON.stringify(changed) !== '["README.md"]' ||
      before["README.md"].split("## Contents")[1] !== after["README.md"].split("## Contents")[1]) {
    throw new Error("Only the README opening may change; field files and contents must be identical.");
  }
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  const results = [];
  for (const phase of ["before", "after"]) {
    for (const width of [1280, 375]) {
      for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 }, colorScheme, deviceScaleFactor: 1,
          locale: "en-US", timezoneId: "America/New_York", serviceWorkers: "block",
        });
        const blocked = [];
        await context.route("**/*", (route) => {
          if (route.request().url() === "http://127.0.0.1/readme.html") {
            return route.fulfill({ contentType: "text/html; charset=utf-8",
              body: fs.readFileSync(path.join(preview, `${phase}.html`)) });
          }
          blocked.push(route.request().url());
          return route.abort();
        });
        const page = await context.newPage();
        await page.goto("http://127.0.0.1/readme.html");
        const layout = await page.evaluate(() => ({
          viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
          firstHeading: document.querySelector("h1").innerText,
          contentsTop: [...document.querySelectorAll("h2")].find((h) => h.textContent === "Contents").getBoundingClientRect().top,
          starTop: [...document.querySelectorAll("p")].find((p) => p.textContent === "Star this repository to follow updates.")?.getBoundingClientRect().top ?? null,
        }));
        if (layout.documentWidth > width || blocked.length) throw new Error(JSON.stringify({ layout, blocked }));
        const file = `${phase}-${width}-${colorScheme}.png`;
        await page.screenshot({ path: path.join(__dirname, file) });
        results.push({ file, ...layout, externalRequests: blocked.length });
        await context.close();
      }
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, "measurements.json"), JSON.stringify({
    fixture: "Synthetic golden listing data, frozen at 2026-11-10T12:00:00Z; not live counts",
    renderer: "Mistune 3.1.4 with local CSS; not GitHub UI",
    fieldFilesIdentical: Object.keys(after).length - 1, contentsTailIdentical: true,
    beforeBytes: Buffer.byteLength(before["README.md"]), afterBytes: Buffer.byteLength(after["README.md"]),
    results,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ changed, fieldFilesIdentical: Object.keys(after).length - 1, captures: results.length }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
