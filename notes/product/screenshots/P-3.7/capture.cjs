const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(path.join(process.env.CAPTURE_TOOLS, "node_modules/playwright-core"));

const root = path.resolve(__dirname, "../../../..");
const [phase] = process.argv.slice(2);
const before = phase === "before";
const origin = "http://127.0.0.1:8765";
const sources = ["extension/lib/store.js", "extension/lib/sync.js", "extension/onboarding/onboarding.js"];
const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2" };

async function capture(browser, width, colorScheme) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
  const errors = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const relative = decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, relative);
    if (url.origin !== origin || !file.startsWith(path.join(root, "extension") + path.sep) || !fs.existsSync(file)) {
      errors.push(url.href);
      return route.abort();
    }
    const body = before && sources.includes(relative)
      ? execFileSync("git", ["show", "f3cf022a:" + relative], { cwd: root })
      : fs.readFileSync(file);
    return route.fulfill({ body, contentType: mime[path.extname(file)] || "application/octet-stream" });
  });
  await context.addInitScript(() => {
    const marker = "internscout.restored";
    const listeners = [];
    const data = {
      store: { version: 3, profile: { voice: { sample: "Old local Voice sample" } } },
      "internscout.session": { token: "iss_synthetic_session", expires: "2099-01-01T00:00:00Z" },
    };
    const evidence = window.evidence = { data };
    const local = {
      async get(keys) {
        if (!evidence.scheduled && [keys].flat().includes(marker)) {
          evidence.scheduled = true;
          const locks = await navigator.locks.query();
          evidence.markerReadLocked = locks.held.some(({ name }) => name === "internscout-store");
          const publish = navigator.locks.request("internscout-store", async () => {
            const store = structuredClone(data.store);
            store.profile.voice.sample = "New account Voice sample";
            await local.set({
              store,
              [marker]: { updated: "2026-11-12T13:06:00Z", at: "2026-11-12T13:07:00Z", shown: false },
            });
          });
          if (!evidence.markerReadLocked) await publish;
        }
        return Object.fromEntries([keys].flat().map((key) => [key, structuredClone(data[key])]));
      },
      async set(patch) {
        const changes = Object.fromEntries(Object.entries(structuredClone(patch)).map(([key, value]) => {
          const oldValue = data[key];
          data[key] = value;
          return [key, { oldValue, newValue: value }];
        }));
        if (evidence.restoreEvents && marker in patch) evidence.restoreEvents.push(changes);
        else listeners.forEach((listen) => listen(changes, "local"));
      },
    };
    const fetchOther = window.fetch.bind(window);
    window.fetch = (url, init) => {
      if (String(url) !== "https://internscout-api.bpmcginley.workers.dev/ai?stream=1") return fetchOther(url, init);
      if (JSON.parse(init.body).task !== "deep_dive") throw new Error("Unexpected synthetic task");
      evidence.posts = (evidence.posts || 0) + 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          evidence.aborted = true;
          reject(init.signal.reason);
        }, { once: true });
      });
    };
    const publish = async (at, sample) => {
      const store = structuredClone(data.store);
      store.profile.voice.sample = sample;
      await local.set({ store, [marker]: { updated: at, at, shown: false } });
    };
    evidence.restoreDuringInterview = () => {
      navigator.locks.request("internscout-store", async () => {
        const gate = new Promise((resolve) => { evidence.releaseRestore = resolve; });
        await publish("2026-11-12T14:07:00Z", "Second account Voice sample");
        await gate;
      });
    };
    evidence.supersedeRestore = async () => {
      evidence.restoreEvents = [];
      await navigator.locks.request("internscout-store", () =>
        publish("2026-11-12T15:07:00Z", "First queued Voice sample"));
      void navigator.locks.request("internscout-store", async () => {
        const events = evidence.restoreEvents;
        delete evidence.restoreEvents;
        events.forEach((changes) => listeners.forEach((listen) => listen(changes, "local")));
        await new Promise((resolve) => { evidence.releaseNewest = resolve; });
        await publish("2026-11-12T15:08:00Z", "Newest queued Voice sample");
      });
    };
    window.chrome = {
      storage: { local, session: { get: async () => ({}) }, onChanged: { addListener: (listen) => listeners.push(listen) } },
      runtime: { async sendMessage({ type }) {
        if (type === "auth:status") return { signedIn: true };
        if (type === "auth:offer_status") return { waiting: false };
        throw new Error("Unexpected synthetic message " + type);
      } },
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/extension/onboarding/onboarding.html?step=voice");
  await page.getByText(/^Restored your Deep Dive from your account/).waitFor();
  const sample = page.locator('[data-voice="sample"]');
  assert.equal(await sample.inputValue(), before ? "Old local Voice sample" : "New account Voice sample");
  assert.equal(await page.evaluate(() => evidence.markerReadLocked), !before);
  assert.equal(await page.evaluate(() => evidence.data.store.profile.voice.sample), "New account Voice sample");
  if (!process.env.VERIFY_ONLY) {
    await page.evaluate(async () => { await document.fonts.ready; scrollTo(0, 0); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({
      path: path.join(__dirname, phase + "-" + width + "-" + colorScheme + ".png"),
      fullPage: true,
      animations: "disabled",
    });
  }
  await sample.fill("Synthetic edit after the restore notice.");
  await page.waitForFunction(() => evidence.data.store.profile.voice.sample === "Synthetic edit after the restore notice.");
  if (!before && width === 1280 && colorScheme === "light") {
    await page.locator('[data-step="interview"]').click();
    await page.waitForFunction(() => evidence.posts === 1);
    await page.evaluate(() => evidence.restoreDuringInterview());
    await page.waitForFunction(() => evidence.aborted);
    assert.equal(await page.evaluate(async () => {
      const locks = await navigator.locks.query();
      return locks.held.some(({ name }) => name === "internscout-store") && !!evidence.releaseRestore;
    }), true);
    await page.evaluate(() => evidence.releaseRestore());
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => evidence.posts), 1);

    await page.locator('[data-step="voice"]').click();
    await sample.waitFor();
    await page.evaluate(() => evidence.supersedeRestore());
    await page.waitForFunction(async () => evidence.releaseNewest &&
      (await navigator.locks.query()).pending.some(({ name }) => name === "internscout-store"));
    await page.evaluate(() => evidence.releaseNewest());
    await page.waitForFunction(() =>
      document.querySelector('[data-voice="sample"]')?.value === "Newest queued Voice sample");
    const newestNotice = page.getByText(/^Restored your Deep Dive from your account/);
    await newestNotice.waitFor();
    assert.equal(await newestNotice.count(), 1);
    assert.equal(await page.evaluate(() => evidence.data["internscout.restored"].shown), true);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ phase, width, colorScheme, markerReadLocked: !before }));
  await context.close();
}

(async () => {
  assert.ok(["before", "after"].includes(phase));
  const browser = await chromium.launch({
    executablePath: process.env.RESTORE_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  try {
    for (const width of [1280, 375])
      for (const colorScheme of ["light", "dark"]) await capture(browser, width, colorScheme);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
