// Synthetic finish-flow proof. All browser HTTP requests are intercepted and fulfilled locally.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require(path.join(process.env.CAPTURE_TOOLS, "node_modules/playwright-core"));
const root = path.resolve(__dirname, "../../../..");
const origin = "http://127.0.0.1:8765";
const onboarding = "extension/onboarding/onboarding.js";
const baseline = execFileSync("git", ["show", `ac9e9b27:${onboarding}`], { cwd: root });
const practice = `${origin}/extension/practice/practice.html`;

async function run(browser, phase, width, theme, flow) {
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    colorScheme: theme,
  });
  const unexpected = [];
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const filename = path.resolve(root, decodeURIComponent(url.pathname.slice(1)));
      if (
        url.origin !== origin ||
        !filename.startsWith(path.join(root, "extension") + path.sep) ||
        !fs.existsSync(filename)
      ) {
        unexpected.push(url.href);
        return route.abort();
      }
      const mime = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".woff2": "font/woff2",
      };
      return route.fulfill({
        body:
          phase === "before" && filename === path.resolve(root, onboarding)
            ? baseline
            : fs.readFileSync(filename),
        contentType: mime[path.extname(filename)] || "application/octet-stream",
      });
    });
    await context.addInitScript(() => {
      const key = "finish-fixture";
      const data = JSON.parse(sessionStorage.getItem(key) || "{}");
      const unexpected = [];
      const set = async (patch) => {
        Object.assign(data, structuredClone(patch));
        sessionStorage.setItem(key, JSON.stringify(data));
      };
      window.evidence = { data, set, unexpected };
      window.chrome = {
        storage: {
          local: {
            get: async (keys) =>
              Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(data[k])]),
              ),
            set,
            remove: async () => {},
          },
          session: { get: async () => ({}) },
          onChanged: { addListener() {} },
        },
        runtime: {
          async sendMessage({ type }) {
            if (type === "auth:status") return { signedIn: true };
            if (type === "auth:offer_status") return { waiting: false };
            if (type === "held:get") return { jobs: [] };
            unexpected.push(type);
            throw new Error("Unexpected synthetic message");
          },
        },
      };
      window.fetch = async () => {
        unexpected.push("fetch");
        throw new Error("Unexpected synthetic fetch");
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => unexpected.push(error.message));
    const url = `${origin}/extension/onboarding/onboarding.html?step=${flow === "review" ? "review" : "files"}`;
    await page.goto(url);
    await page.evaluate(async () => {
      const { emptyStore } = await import("/extension/lib/store.js");
      const store = emptyStore();
      store.files.resume = {
        name: "Sample resume.txt",
        size: 16,
        type: "text/plain",
        text: "Synthetic resume",
        b64: "U3ludGhldGljIHJlc3VtZQ==",
      };
      store.settings.signup_email = "student@example.invalid";
      store.settings.resume_details_ready = true;
      await evidence.set({ store });
    });
    await page.reload();
    const link = page.getByRole("link", { name: "Practice Auto-Apply", exact: true });
    assert.equal(await link.count(), 0);
    const finish = page.getByRole("button", {
      name: flow === "review" ? "Finish, turn on Auto-Apply" : "Turn on Auto-Apply now",
    });
    if (flow === "restore")
      await page.evaluate(() => {
        evidence.data["internscout.restored"] = { at: "2026-11-10T12:00:00Z", shown: true };
      });
    await finish.press("Enter");
    await page.getByText("Saved. Auto-Apply is on.", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => evidence.data.store.settings.onboarded),
      flow !== "restore",
    );
    assert.equal(context.pages().length, 1);
    if (phase === "after" && flow !== "restore") {
      await link.waitFor();
      assert.equal(await link.count(), 1);
      assert.equal(await link.getAttribute("href"), "../practice/practice.html");
      assert.equal(await link.evaluate((el) => el === document.activeElement), true);
    } else assert.equal(await link.count(), 0);
    if (flow !== "restore") {
      await page.evaluate(async () => {
        await document.fonts.ready;
        window.scrollTo({ top: 0, behavior: "instant" });
        await new Promise(requestAnimationFrame);
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({
        path: path.join(__dirname, `${phase}-${width}-${theme}-${flow}.png`),
        fullPage: true,
      });
    }
    if (phase === "after" && flow !== "restore") {
      const [opened] = await Promise.all([context.waitForEvent("page"), link.press("Enter")]);
      await opened.getByRole("heading", { name: "Practice Auto-Apply" }).waitFor();
      assert.equal(opened.url(), practice);
      assert.equal(context.pages().length, 2);
      await opened.getByRole("button", { name: "Fill sample details" }).press("Enter");
      await opened.getByRole("status").filter({ hasText: "Sample details filled." }).waitFor();
      await opened.getByRole("button", { name: "Complete practice" }).press("Space");
      assert.equal(await opened.getByRole("status").textContent(), "Practice complete.");
      assert.equal(page.url(), url);
      assert.deepEqual(await opened.evaluate(() => evidence.unexpected), []);
    }
    assert.deepEqual(await page.evaluate(() => evidence.unexpected), []);
    assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ phase, width, theme, flow, requests: 0 }));
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PRACTICE_BROWSER ||
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  try {
    for (const phase of ["before", "after"])
      for (const width of [1280, 375])
        for (const theme of ["light", "dark"])
          for (const flow of ["resume", "review"]) await run(browser, phase, width, theme, flow);
    await run(browser, "after", 375, "light", "restore");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
