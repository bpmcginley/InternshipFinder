// Synthetic fixture only. Every browser request is fulfilled locally or blocked.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const tools = process.env.ADVISOR_CAPTURE_TOOLS ||
  path.join(process.env.TEMP, "internscout-product-capture-tools");
const { chromium } = require(path.join(tools, "node_modules/playwright-core"));
const fixture = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] || __dirname);
const origin = "http://local.test";
const action = "https://buttondown.com/api/emails/embed-subscribe/advisor-fixture";
const email = "fixture@example.test";
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

async function snapshot(page, name) {
  await page.goto(origin + "/" + name.split("-")[0] + ".html");
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false);
  assert.equal(await page.locator("h1").count(), 1);
  await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
}

async function checkForm(context, page, posted) {
  const form = page.getByRole("form");
  const advisor = form.getByRole("checkbox", { name: "Subscribe as an advisor" });
  const field = form.getByRole("checkbox", { name: /^Save Finance/ });
  assert.equal(await form.getAttribute("action"), action);
  assert.equal(await form.getAttribute("target"), "_blank");
  assert.equal(await form.getAttribute("data-digest-placement"), null);
  assert.equal(await advisor.getAttribute("aria-describedby"), "digest-advisor-help");
  assert.equal(await advisor.isChecked(), false);
  assert.equal(await field.isChecked(), false);
  const storage = () => page.evaluate(() => [
    Object.entries(localStorage),
    Object.entries(sessionStorage),
  ]);
  const initialStorage = await storage();
  const values = () => form.evaluate(el => new FormData(el).getAll("tag"));
  assert.deepEqual(await values(), []);
  await form.getByRole("textbox", { name: "Email" }).fill(email);

  for (const box of [field, advisor]) {
    await box.focus();
    assert.equal(await box.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Space");
    assert.equal(await box.isChecked(), true);
  }
  assert.deepEqual(await values(), ["finance", "advisor"]);

  async function submit(tags) {
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      form.getByRole("button", { name: "Email me new internships" }).click(),
    ]);
    await popup.getByText("Synthetic confirmation only").waitFor();
    assert.deepEqual(posted.at(-1), [["email", email], ...tags.map(value => ["tag", value]), ["embed", "1"]].sort());
    await popup.close();
  }

  await submit(["finance", "advisor"]);
  await advisor.focus();
  await page.keyboard.press("Space");
  assert.equal(await advisor.isChecked(), false);
  assert.deepEqual(await values(), ["finance"]);
  await submit(["finance"]);
  assert.deepEqual(await storage(), initialStorage);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.ADVISOR_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const report = [];
  try {
    for (const width of [1280, 375]) {
      for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 1100 }, colorScheme, reducedMotion: "reduce",
        });
        const posted = [];
        await context.route("**/*", route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.href === action && request.method() === "POST") {
            posted.push([...new URLSearchParams(request.postData())].sort());
            return route.fulfill({ contentType: "text/html", body: "<p>Synthetic confirmation only</p>" });
          }
          if (url.origin !== origin || request.method() !== "GET") return route.abort();
          const asset = path.resolve(fixture, "." + url.pathname);
          assert(asset.startsWith(fixture + path.sep));
          if (!fs.existsSync(asset)) return route.fulfill({ status: 404, body: "Not found" });
          return route.fulfill({ body: fs.readFileSync(asset), contentType: contentTypes[path.extname(asset)] });
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await snapshot(page, `before-${width}-${colorScheme}`);
        assert.equal(await page.getByRole("form").count(), 0);
        await snapshot(page, `after-${width}-${colorScheme}`);
        await checkForm(context, page, posted);
        assert.equal(posted.length, 2);
        assert.deepEqual(errors, []);
        report.push({ width, colorScheme, localSyntheticSubmissions: posted.length, externalRequestsAllowed: 0 });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
