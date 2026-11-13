// Synthetic browser proof. Give FIXTURE_ROOT containing before/after packaged extension folders.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { chromium } = require(path.join(process.env.CAPTURE_TOOLS, "node_modules/playwright-core"));

(async () => {
  const root = process.env.FIXTURE_ROOT;
  const denied = [],
    measures = [],
    packageHashes = {};
  const proxy = http.createServer((request, response) => {
    denied.push(request.url);
    response.writeHead(403).end();
  });
  proxy.on("connect", (request, socket) => {
    socket.on("error", () => {});
    denied.push(request.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    for (const phase of ["before", "after"]) {
      const extension = path.join(root, phase, "unpacked");
      packageHashes[phase] = Object.fromEntries(
        ["manifest.json", "agent/guard.js", "agent/actions.js", "agent/dom.js"].map((file) => [
          file,
          createHash("sha256")
            .update(fs.readFileSync(path.join(extension, file)))
            .digest("hex"),
        ]),
      );
      const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json")));
      const id = createHash("sha256")
        .update(Buffer.from(manifest.key, "base64"))
        .digest("hex")
        .slice(0, 32)
        .replace(/[0-9a-f]/g, (char) => String.fromCharCode(97 + parseInt(char, 16)));
      const context = await chromium.launchPersistentContext(
        fs.mkdtempSync(path.join(root, phase, "profile-")),
        {
          executablePath:
            process.env.PRACTICE_BROWSER ||
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          headless: true,
          proxy: { server: "http://127.0.0.1:" + proxy.address().port },
          args: [
            "--disable-extensions-except=" + extension,
            "--load-extension=" + extension,
            "--disable-background-networking",
            "--disable-sync",
            "--disable-component-update",
            "--disable-quic",
            "--no-first-run",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
          ],
        },
      );
      try {
        const external = [];
        await context.route(/^(https?|wss?):/, (route) => {
          external.push(route.request().url());
          return route.abort();
        });
        for (const width of [1280, 375])
          for (const theme of ["light", "dark"]) {
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.setViewportSize({ width, height: width === 375 ? 900 : 850 });
            await page.emulateMedia({ colorScheme: theme });
            await page.addInitScript(() => {
              window.fixture = { events: [], submits: 0, violations: [] };
              for (const type of ["input", "change", "blur", "focusout"]) {
                document.addEventListener(
                  type,
                  (event) => {
                    if (event.target instanceof HTMLInputElement)
                      fixture.events.push([event.target.id, type]);
                  },
                  true,
                );
              }
              document.addEventListener("submit", () => fixture.submits++);
              document.addEventListener("securitypolicyviolation", (event) =>
                fixture.violations.push(event.violatedDirective),
              );
            });
            const url = `chrome-extension://${id}/practice/practice.html`;
            const missing = !fs.existsSync(path.join(extension, "practice/practice.html"));
            if (phase === "before") {
              assert.equal(missing, true);
              await page.goto(`chrome-extension://${id}/onboarding/onboarding.html`);
              await page.getByRole("heading", { name: "Set up Auto-Apply", exact: true }).waitFor();
              await page.screenshot({
                path: path.join(__dirname, `before-${width}-${theme}-setup.png`),
              });
              measures.push({ phase, width, theme, missing, baseline: "prior setup page" });
            } else {
              await page.goto(url);
              await page.evaluate(() => document.fonts.ready);
              assert.equal(
                await page
                  .locator("input")
                  .evaluateAll((fields) => fields.every((field) => !field.value && field.readOnly)),
                true,
              );
              await page.screenshot({
                path: path.join(__dirname, `after-${width}-${theme}-idle.png`),
              });
              await page.keyboard.press("Tab");
              assert.equal(
                await page.locator("#fill").evaluate((el) => el === document.activeElement),
                true,
              );
              await page.keyboard.press("Enter");
              await page
                .getByRole("status")
                .filter({ hasText: "Sample details filled." })
                .waitFor();
              assert.deepEqual(
                await page
                  .locator("input")
                  .evaluateAll((fields) => fields.map((field) => field.value)),
                ["Sample", "Student", "sample.student@example.invalid", "2025550100"],
              );
              assert.equal(
                await page.locator("#fill").evaluate((el) => el === document.activeElement),
                true,
              );
              for (let i = 0; i < 5; i++) await page.keyboard.press("Tab");
              assert.equal(
                await page.locator("#complete").evaluate((el) => el === document.activeElement),
                true,
              );
              await page.screenshot({
                path: path.join(__dirname, `after-${width}-${theme}-filled.png`),
              });
              await page.keyboard.press("Space");
              assert.equal(await page.getByRole("status").textContent(), "Practice complete.");
              assert.equal(page.url(), url);
              const proof = await page.evaluate(() => ({
                ...fixture,
                width: innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
                readonly: [...document.querySelectorAll("input")].every((field) => field.readOnly),
              }));
              assert.equal(proof.scrollWidth, width);
              assert.equal(proof.readonly, true);
              assert.equal(proof.submits, 0);
              assert.deepEqual(proof.violations, []);
              assert.deepEqual(errors, []);
              for (const name of ["first_name", "last_name", "email", "phone"]) {
                for (const type of ["input", "change"]) {
                  assert.equal(
                    proof.events.filter((event) => event[0] === name && event[1] === type).length,
                    1,
                  );
                }
              }
              await page.screenshot({
                path: path.join(__dirname, `after-${width}-${theme}-complete.png`),
              });
              measures.push({ phase, width, theme, ...proof, errors });
            }
            await page.close();
          }
        assert.deepEqual(external, []);
      } finally {
        await context.close();
      }
    }
    fs.writeFileSync(
      path.join(__dirname, "measurements.json"),
      JSON.stringify(
        {
          baselineCommit: "1712e648bc29202af7ba50f03876c246a292b31c",
          packageHashes,
          measures,
          blockedBrowserAttempts: denied,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("Eight width/theme comparisons passed; external requests blocked.");
  } finally {
    proxy.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
