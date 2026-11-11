// Offline Edge capture. Requests are fulfilled from this checkout or blocked.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const root = path.resolve(__dirname, "../../../..");
const base = "6827576b64790afc2a4a659a316a5a983beb29bb";
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const report = [];
  for (const phase of process.argv[2] ? [process.argv[2]] : ["before", "after"]) {
    for (const pageName of ["terms", "privacy"])
      for (const width of [1280, 375])
        for (const colorScheme of ["light", "dark"]) {
          const context = await browser.newContext({
            viewport: { width, height: 1100 },
            colorScheme,
            serviceWorkers: "block",
          });
          const blocked = [],
            errors = [];
          await context.route("**/*", async (route) => {
            const u = new URL(route.request().url());
            if (u.origin !== "https://internscout.test") {
              blocked.push(u.origin);
              return route.abort();
            }
            const relative =
              u.pathname === "/" + pageName ? pageName + ".html" : u.pathname.slice(1);
            if (relative.includes("..")) return route.abort();
            const file = path.join(root, "docs", relative);
            if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
            const body =
              phase === "before" && relative === pageName + ".html"
                ? cp.execFileSync("git", ["show", base + ":docs/" + relative], { cwd: root })
                : fs.readFileSync(file);
            const ext = path.extname(file);
            return route.fulfill({
              body,
              contentType:
                {
                  ".html": "text/html",
                  ".js": "text/javascript",
                  ".woff2": "font/woff2",
                  ".png": "image/png",
                }[ext] || "application/octet-stream",
            });
          });
          const page = await context.newPage();
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto("https://internscout.test/" + pageName);
          await page.evaluate(() => document.fonts.ready);
          const selector = phase === "after" ? "#topups" : pageName === "privacy" ? "#paid" : "h2";
          const clip = await page.evaluate(
            ({ selector, pageName, phase }) => {
              const start =
                phase === "before" && pageName === "terms"
                  ? [...document.querySelectorAll("h2")].find(
                      (x) => x.textContent === "Paid plans (optional)",
                    )
                  : document.querySelector(selector);
              let end = start.nextElementSibling;
              while (end && end.tagName !== "H2") end = end.nextElementSibling;
              const y = start.getBoundingClientRect().top + scrollY - 12;
              return {
                x: 0,
                y,
                width: innerWidth,
                height:
                  (end ? end.getBoundingClientRect().top + scrollY : document.body.scrollHeight) -
                  y,
              };
            },
            { selector, pageName, phase },
          );
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          );
          if (overflow || errors.length)
            throw Error(JSON.stringify({ pageName, width, phase, overflow, errors }));
          await page.screenshot({
            path: path.join(__dirname, `${phase}-${pageName}-${width}-${colorScheme}.png`),
            fullPage: true,
            clip,
          });
          report.push({
            phase,
            page: pageName,
            width,
            colorScheme,
            overflow,
            errors,
            blockedExternalRequests: blocked.length,
            clip,
          });
          await context.close();
        }
  }
  await browser.close();
  fs.writeFileSync(
    path.join(__dirname, `${process.argv[2] || "all"}-results.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
