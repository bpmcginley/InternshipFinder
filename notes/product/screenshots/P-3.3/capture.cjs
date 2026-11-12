// Local synthetic onboarding proof. The only AI reply comes from an in-page mock.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium } = require(path.join(process.env.CAPTURE_TOOLS, "node_modules/playwright-core"));
const root = path.resolve(__dirname, "../../../..");
const phase = process.argv[2];
const before = phase === "before";
const source = "extension/onboarding/onboarding.js";
const fixture = "Sample resume for isolated onboarding evidence.";

async function capture(browser, width, colorScheme) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme });
  const unexpected = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:8765") {
      unexpected.push(url.origin);
      return route.abort();
    }
    const relative = decodeURIComponent(url.pathname.slice(1));
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(path.join(root, "extension") + path.sep) || !fs.existsSync(filename)) {
      unexpected.push(relative);
      return route.fulfill({ status: 404, body: "" });
    }
    const body = before && relative === source
      ? execFileSync("git", ["show", `8c352e25:${source}`], { cwd: root })
      : fs.readFileSync(filename);
    const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2" };
    return route.fulfill({ body, contentType: mime[path.extname(filename)] || "application/octet-stream" });
  });
  await context.addInitScript(({ fixture }) => {
    const data = JSON.parse(sessionStorage.getItem("onboarding-fixture") || "{}");
    const listeners = [];
    const set = async (patch) => {
      const changes = {};
      for (const [key, value] of Object.entries(patch)) {
        changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
        data[key] = structuredClone(value);
      }
      sessionStorage.setItem("onboarding-fixture", JSON.stringify(data));
      listeners.forEach((fn) => fn(changes, "local"));
    };
    const get = async (keys) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])]),
    );
    const calls = [], unexpected = [];
    window.evidence = { data, set, calls, unexpected };
    window.chrome = {
      storage: {
        local: { get, set, remove: async () => {} },
        session: { get: async () => ({}) },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
      runtime: {
        async sendMessage({ type }) {
          if (type === "auth:status" || type === "auth:me") return { signedIn: !!data["internscout.session"] };
          if (type === "auth:offer_status") return { waiting: false };
          if (type === "held:get") return { jobs: [] };
          if (type === "auth:signin") {
            const finish = new Promise((resolve) => { window.evidence.releaseSignIn = resolve; });
            await set({ "internscout.session": { token: "iss_fixture", expires: "2099-01-01T00:00:00Z" } });
            await finish;
            return { signedIn: true };
          }
          unexpected.push(type);
          throw new Error("Unexpected synthetic message");
        },
      },
    };
    window.fetch = async (url, options) => {
      if (new URL(url).pathname !== "/ai") {
        unexpected.push("fetch");
        throw new Error("Unexpected synthetic fetch");
      }
      const payload = JSON.parse(options.body);
      if (payload.task !== "deep_dive" || !options.body.includes(fixture))
        throw new Error("Unexpected resume request");
      calls.push(payload.task);
      if (window.evidence.holdNextRead) {
        window.evidence.holdNextRead = false;
        await new Promise((resolve) => { window.evidence.releaseRead = resolve; });
      }
      const text = JSON.stringify({
        facts: { first_name: "Avery", last_name: "Example", email: "avery@example.invalid" },
        education: [{ school: "Sample University", major: "Computer Science" }],
        experience: [{ company: "Sample Lab", title: "Research assistant", bullets: ["Tested sample records."] }],
        projects: [],
        skills: { technical: ["Python"], tools: [], soft: [] },
        links: [],
      });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), {
        headers: { "content-type": "application/json" },
      });
    };
  }, { fixture });
  const page = await context.newPage();
  page.on("pageerror", (error) => unexpected.push(error.message));
  const url = "http://127.0.0.1:8765/extension/onboarding/onboarding.html";
  await page.goto(url);
  const shot = async (scenario) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo({ top: 0, behavior: "instant" });
      await new Promise(requestAnimationFrame);
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(__dirname, `${phase}-${width}-${colorScheme}-${scenario}.png`), fullPage: true });
  };
  await page.getByRole("heading", { name: before ? "Setup" : "Start with your resume", exact: true }).waitFor();
  if (before) await page.locator('#acct [data-signin="google"]').waitFor();
  if (!before) assert.equal(await page.locator("#files-signin").isVisible(), false);
  await shot("entry");
  if (before) await page.locator('[data-step="files"]').click();
  await page.locator('[data-slot="resume"]').setInputFiles({
    name: "Sample resume.txt", mimeType: "text/plain", buffer: Buffer.from(fixture),
  });
  const signIn = page.locator('#files-signin [data-signin="google"]');
  await signIn.waitFor();
  assert.deepEqual(await page.evaluate(() => evidence.calls), []);
  if (!before) assert.equal(await page.locator("#extract").isEnabled(), false);
  await signIn.press("Enter");
  await page.waitForFunction(() => typeof evidence.releaseSignIn === "function");
  if (!before) await signIn.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => evidence.calls), []);
  if (!before) assert.equal(await page.locator("#extract").isEnabled(), false);
  await page.evaluate(() => evidence.releaseSignIn());
  await page.getByRole("button", { name: "Turn on Auto-Apply now" }).waitFor();
  assert.deepEqual(await page.evaluate(() => evidence.calls), ["deep_dive"]);
  if (!before) await page.getByRole("heading", { name: "Review your resume details" }).waitFor();
  await shot("imported");
  if (!before) {
    await page.locator("#edit-contact").press("Enter");
    await page.locator('[data-fact="first_name"]').fill("Riley");
    await page.locator('[data-step="files"]').click();
    await page.locator("#resume-profile").getByText(/Riley Example/).waitFor();
    await page.locator("#edit-resume-profile").press("Enter");
    assert.equal(await page.locator('textarea[data-json="education"]').isVisible(), true);
    await page.goto(url + "?step=facts");
    await page.getByRole("heading", { name: "Quick facts", exact: true }).waitFor();
    assert.equal(await page.locator('[data-fact="first_name"]').inputValue(), "Riley");
    await page.evaluate(() => evidence.set({
      store: { ...evidence.data.store, settings: { ...evidence.data.store.settings, onboarded: true } },
    }));
    await page.goto(url);
    await page.getByRole("heading", { name: "Review", exact: true }).waitFor();
    if (width === 375 && colorScheme === "dark") {
      await page.locator('[data-step="files"]').click();
      await page.evaluate(() => { evidence.holdNextRead = true; });
      await page.locator("#extract").click();
      await page.waitForFunction(() => typeof evidence.releaseRead === "function");
      await page.evaluate(async () => {
        const store = structuredClone(evidence.data.store);
        store.profile.facts.first_name = "Restored";
        store.settings.resume_details_ready = true;
        store.settings.resume_import = null;
        await evidence.set({
          store,
          "internscout.restored": { at: "2026-11-11T02:00:00Z", updated: "2026-11-11T01:59:00Z", shown: false },
        });
      });
      await page.getByRole("heading", { name: "Review", exact: true }).waitFor();
      await page.evaluate(() => evidence.releaseRead());
      await page.waitForTimeout(100);
      const restored = await page.evaluate(() => evidence.data.store);
      assert.equal(restored.profile.facts.first_name, "Restored");
      assert.equal(restored.settings.resume_import, null);
      assert.equal(restored.settings.resume_details_ready, true);
      await page.evaluate(async () => {
        delete evidence.releaseSignIn;
        await evidence.set({ "internscout.session": undefined });
      });
      await page.locator('[data-step="setup"]').click();
      await page.locator('#acct [data-signin="google"]').press("Enter");
      await page.waitForFunction(() => typeof evidence.releaseSignIn === "function");
      await page.locator('[data-step="files"]').click();
      assert.equal(await page.locator("#extract").isEnabled(), false);
      await page.evaluate(() => evidence.releaseSignIn());
      await page.waitForFunction(() => !document.querySelector("#extract").disabled);
      assert.deepEqual(await page.evaluate(() => evidence.calls), ["deep_dive"]);
    }
  }
  assert.deepEqual(await page.evaluate(() => evidence.unexpected), []);
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ phase, width, colorScheme, captures: 2, mockReads: 1 }));
  await context.close();
}

(async () => {
  if (!["before", "after"].includes(phase)) throw new Error("Choose before or after");
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  try {
    for (const width of [1280, 375])
      for (const colorScheme of ["light", "dark"]) await capture(browser, width, colorScheme);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
