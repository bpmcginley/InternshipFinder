// Synthetic actual publisher artifacts only; every request is local or intercepted.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const artifacts = path.resolve(process.argv[2]),
  output = __dirname;
const origin = "http://artifact.test";
const disclosure =
  "If you choose Subscribe as an advisor, your email address and an advisor tag go directly to Buttondown. Buttondown stores the tag to identify subscribers who advise students.";
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const reports = [];
  try {
    for (const width of [1280, 375])
      for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 1100 },
          colorScheme,
          reducedMotion: "reduce",
        });
        let selected = "before";
        const posts = [],
          errors = [];
        await context.route("**/*", (route) => {
          const request = route.request(),
            url = new URL(request.url());
          if (
            url.href === "https://buttondown.com/api/emails/embed-subscribe/advisor-fixture" &&
            request.method() === "POST"
          ) {
            posts.push([...new URLSearchParams(request.postData())].sort());
            return route.fulfill({
              contentType: "text/html",
              body: "<p>Synthetic confirmation only</p>",
            });
          }
          if (url.origin !== origin || request.method() !== "GET") return route.abort();
          let pathname = decodeURIComponent(url.pathname);
          if (pathname === "/privacy") pathname = "/privacy.html";
          if (pathname.endsWith("/")) pathname += "index.html";
          const root = path.join(artifacts, selected),
            file = path.resolve(root, "." + pathname);
          assert(file.startsWith(root + path.sep));
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "Local missing" });
          return route.fulfill({
            body: fs.readFileSync(file),
            contentType:
              {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript",
                ".woff2": "font/woff2",
                ".png": "image/png",
              }[path.extname(file)] || "application/octet-stream",
          });
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        for (const phase of ["before", "after"]) {
          selected = phase;
          await page.goto(origin + "/internships/for/computer-science-majors/weekly/");
          await page.evaluate(() => document.fonts.ready);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          const advisor = page.getByRole("checkbox", { name: "Subscribe as an advisor" });
          assert.equal(await advisor.count(), phase === "after" ? 1 : 0);
          await page.screenshot({
            path: path.join(output, `${phase}-form-${width}-${colorScheme}.png`),
            fullPage: true,
          });
          if (phase === "after") {
            const form = page.getByRole("form"),
              storage = await page.evaluate(() => [
                Object.entries(localStorage),
                Object.entries(sessionStorage),
              ]);
            assert.equal(await advisor.isChecked(), false);
            assert.equal(await form.getByRole("checkbox").count(), 1);
            await form.getByRole("textbox", { name: "Email" }).fill("fixture@example.test");
            for (const checked of [true, false]) {
              await advisor.focus();
              await page.keyboard.press("Space");
              assert.equal(await advisor.isChecked(), checked);
              assert.deepEqual(
                await form.evaluate((el) => new FormData(el).getAll("tag")),
                checked ? ["advisor"] : [],
              );
              const [popup] = await Promise.all([
                context.waitForEvent("page"),
                form.getByRole("button", { name: "Email me new internships" }).click(),
              ]);
              await popup.getByText("Synthetic confirmation only").waitFor();
              assert.deepEqual(
                posts.at(-1),
                [
                  ["email", "fixture@example.test"],
                  ["embed", "1"],
                  ...(checked ? [["tag", "advisor"]] : []),
                ].sort(),
              );
              await popup.close();
            }
            assert.deepEqual(
              await page.evaluate(() => [
                Object.entries(localStorage),
                Object.entries(sessionStorage),
              ]),
              storage,
            );
            await page.getByRole("link", { name: "Details", exact: true }).click();
            assert.equal(new URL(page.url()).hash, "#digest");
          } else await page.goto(origin + "/privacy.html#digest");
          assert.equal(
            await page.getByText(disclosure, { exact: true }).count(),
            phase === "after" ? 1 : 0,
          );
          await page.evaluate(() => {
            const item = [...document.querySelectorAll("li")].find((e) =>
              e.textContent.startsWith("Buttondown holds your address"),
            );
            window.scrollTo(0, item.getBoundingClientRect().top + scrollY - 30);
          });
          await page.evaluate(() => document.fonts.ready);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          await page.screenshot({
            path: path.join(output, `${phase}-privacy-${width}-${colorScheme}.png`),
          });
        }
        selected = "rollback";
        await page.goto(origin + "/internships/for/computer-science-majors/weekly/");
        assert.equal(
          await page.getByRole("checkbox", { name: "Subscribe as an advisor" }).count(),
          0,
        );
        await page.goto(origin + "/privacy.html#digest");
        assert.equal(await page.getByText(disclosure, { exact: true }).count(), 0);
        assert.deepEqual(errors, []);
        reports.push({
          width,
          colorScheme,
          localSyntheticPosts: posts.length,
          rollbackChecked: true,
          externalRequestsAllowed: 0,
          overflow: false,
        });
        await context.close();
      }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(reports, null, 2) + "\n");
  console.log(
    JSON.stringify({
      contexts: reports.length,
      screenshots: 16,
      localPosts: reports.reduce((n, r) => n + r.localSyntheticPosts, 0),
      passed: true,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
