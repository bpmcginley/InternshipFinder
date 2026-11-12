const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(path.join(process.env.CAPTURE_TOOLS, "node_modules/playwright-core"));

const root = path.resolve(__dirname, "../../../..");
const source = "extension/onboarding/onboarding.js";
const [phase] = process.argv.slice(2);
const before = phase === "before";
const key = "deepdive_chat";
const origin = "http://127.0.0.1:8765";
const worker = "https://internscout-api.bpmcginley.workers.dev/ai?stream=1";
const runId = "00000000-0000-4000-8000-000000000001";
const answer = "I built a synthetic sorting demo for class.";
const draft = "I also compared two sample inputs.";
const prior = [
  { role: "user", content: "(Begin the interview.)" },
  { role: "assistant", content: "Which synthetic project taught you the most?" },
];

async function capture(browser, width, colorScheme) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
  const requests = [], errors = [];
  const baseline = before ? execFileSync("git", ["show", "628a960f:" + source], { cwd: root }) : null;
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.href === worker && request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    if (url.href === worker && request.method() === "POST") {
      const body = request.postDataBuffer(), parsed = JSON.parse(body);
      assert.equal(request.headers().authorization, "Bearer iss_synthetic_session");
      assert.equal(parsed.task, "deep_dive");
      assert.equal(parsed.run_id, runId);
      requests.push({ body, async finish(text, status = 200) {
        const json = status === 200
          ? { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }
          : { error: "bad_request", message: text };
        await route.fulfill({ status, headers: cors, json });
      } });
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(1));
    const filename = path.resolve(root, relative);
    if (url.origin !== origin || !filename.startsWith(path.join(root, "extension") + path.sep) || !fs.existsSync(filename)) {
      errors.push(request.url());
      return route.abort();
    }
    const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2" };
    return route.fulfill({
      body: before && relative === source ? baseline : fs.readFileSync(filename),
      contentType: mime[path.extname(filename)] || "application/octet-stream",
    });
  });
  await context.addInitScript(({ key, prior, runId }) => {
    const data = {
      [key]: prior,
      store: { version: 3, settings: { deep_dive_run: runId } },
      "internscout.session": { token: "iss_synthetic_session", expires: "2099-01-01T00:00:00Z" },
    };
    const listeners = [];
    const evidence = window.evidence = { data, writes: [], storyWrites: [], restoreReads: 0 };
    const local = {
      async get(keys) {
        if (keys === "internscout.restored") evidence.restoreReads++;
        return Object.fromEntries([keys].flat().map((k) => [k, structuredClone(data[k])]));
      },
      async set(patch) {
        patch = structuredClone(patch);
        if (evidence.holdProfile && patch.store?.profile?.stories?.length) {
          evidence.holdProfile = false;
          await new Promise((resolve) => { evidence.releaseProfile = resolve; });
        }
        if (evidence.holdWrite && patch[key]?.at(-1)?.content === evidence.holdWrite) {
          await new Promise((resolve) => { evidence.releaseWrite = resolve; });
        }
        const changes = Object.fromEntries(Object.entries(patch).map(([k, value]) => [k, {
          oldValue: data[k], newValue: value,
        }]));
        if (key in patch) evidence.writes.push(patch[key]);
        if (patch.store?.profile?.stories?.length) evidence.storyWrites.push(patch.store.profile.stories[0].theme);
        Object.assign(data, patch);
        listeners.forEach((fn) => fn(changes, "local"));
      },
    };
    evidence.set = local.set;
    window.chrome = {
      storage: { local, session: { get: async () => ({}) }, onChanged: { addListener: (fn) => listeners.push(fn) } },
      runtime: { async sendMessage({ type }) {
        if (type === "auth:status") return { signedIn: true };
        if (type === "auth:offer_status") return { waiting: false };
        if (type === "held:get") return { jobs: [] };
        throw new Error("Unexpected synthetic message " + type);
      } },
    };
  }, { key, prior, runId });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const send = page.locator("#send"), say = page.locator("#say"), chat = page.locator("#chat");
  const tab = (id) => page.locator('[data-step="' + id + '"]');
  const turn = async (text) => { await say.fill(text); await say.press("Control+Enter"); };
  const nav = async () => {
    await tab("voice").click();
    await page.getByRole("heading", { name: "Your voice" }).waitFor();
    await tab("interview").click();
    await say.waitFor();
  };
  const count = async (expected) => {
    for (let i = 0; requests.length < expected && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.length, expected);
  };
  const stored = (text) => page.waitForFunction(({ key, text }) => evidence.data[key]?.at(-1)?.content === text, { key, text });
  const visible = (text) => chat.getByText(text, { exact: true }).waitFor();
  const shot = async (suffix = "") => {
    if (process.env.VERIFY_ONLY) return;
    await page.evaluate(async () => { await document.fonts.ready; scrollTo(0, 0); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(__dirname, phase + "-" + width + "-" + colorScheme + suffix + ".png"), fullPage: true, animations: "disabled" });
  };
  await page.goto(origin + "/extension/onboarding/onboarding.html?step=interview");
  await turn(answer);
  await count(1);
  await say.fill(draft);
  if (!before) await say.press("Control+Enter");
  await nav();
  await count(before ? 2 : 1);
  assert.equal(await say.inputValue(), before ? "" : draft);
  assert.equal(await send.isDisabled(), true);
  await shot();
  if (before) {
    assert.ok(requests[0].body.equals(requests[1].body));
    await requests[1].finish("The reopened view received this reply.");
    await visible("The reopened view received this reply.");
    await requests[0].finish("The original reply arrived late.");
    await stored("The original reply arrived late.");
    await visible("The reopened view received this reply.");
  } else {
    await say.press("Meta+Enter");
    await requests[0].finish("The original reply updated this view.");
    await visible("The original reply updated this view.");
    await stored("The original reply updated this view.");
    assert.equal(await say.inputValue(), draft);
    await count(1);
  }
  const firstTurn = requests.map(({ body }) => body.length);
  const digest = createHash("sha256").update(requests[0].body).digest("hex");
  const extended = !before && width === 1280 && colorScheme === "light";
  const restart = page.locator("#restart"), finish = page.locator("#finish");
  const result = (theme) => JSON.stringify({
    stories: [{ theme, situation: "Built a sample sorting demo." }], goals: {}, facts: {},
  });
  const finishRequest = requests.length;
  await page.evaluate(() => { evidence.holdProfile = true; });
  await finish.click();
  await count(finishRequest + 1);
  assert.equal(await restart.isEnabled(), true);
  await requests[finishRequest].finish(result("Synthetic project"));
  await page.waitForFunction(() => !!evidence.releaseProfile);
  assert.equal(await restart.isEnabled(), before);
  await shot("-finish-saving");
  if (extended) {
    await nav();
    assert.equal(await restart.isDisabled(), true);
    let dialogs = 0;
    const unexpectedReset = async (dialog) => { dialogs++; await dialog.accept(); };
    page.on("dialog", unexpectedReset);
    await restart.dispatchEvent("click");
    page.off("dialog", unexpectedReset);
    assert.equal(dialogs, 0);
    await count(finishRequest + 1);
    assert.equal(await page.evaluate(() => evidence.data.store.profile.stories.length), 0);
  }
  await page.evaluate(() => evidence.releaseProfile());
  await page.waitForFunction(() => evidence.data.store.profile.stories[0]?.theme === "Synthetic project");

  if (extended) {
    await page.waitForFunction(() => !document.querySelector("#restart").disabled);
    await say.press("Control+Enter");
    await count(3);
    await requests[2].finish("Synthetic request failure.", 400);
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await say.fill("This draft belongs to the next answer.");
    await nav();
    await count(3);
    assert.equal(await send.textContent(), "Retry");
    await send.click();
    await count(4);
    assert.ok(requests[2].body.equals(requests[3].body));
    await requests[3].finish("The retry succeeded.");
    await visible("The retry succeeded.");
    await stored("The retry succeeded.");
    assert.equal(await say.inputValue(), "This draft belongs to the next answer.");
    await say.press("Control+Enter");
    await count(5);

    // Simulate an old reply already inside the storage write when Start over is pressed.
    await page.evaluate(() => { evidence.holdWrite = "Old reply before reset."; });
    await requests[4].finish("Old reply before reset.");
    await page.waitForFunction(() => !!evidence.releaseWrite);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#restart").click();
    await page.evaluate(() => evidence.releaseWrite());
    await count(6);
    await requests[5].finish("Welcome to the new conversation.");
    await visible("Welcome to the new conversation.");
    await stored("Welcome to the new conversation.");
    assert.equal(await chat.getByText("Old reply before reset.").count(), 0);
    assert.equal(await page.evaluate((key) => evidence.data[key].length, key), 2);

    // The exact restore marker can arrive while the prior reply write is in flight.
    const lastAnswer = "Answer before the synthetic restore.";
    await turn(lastAnswer);
    await count(7);
    await page.evaluate(() => {
      evidence.holdWrite = "Old reply after restore.";
      delete evidence.releaseWrite;
    });
    await requests[6].finish("Old reply after restore.");
    await page.waitForFunction(() => !!evidence.releaseWrite);
    await say.fill("Draft from before the synthetic restore.");
    await page.evaluate(() => evidence.set({
      store: { ...evidence.data.store, settings: { ...evidence.data.store.settings, onboarded: true } },
      "internscout.restored": { at: "2026-11-11T02:00:00Z", updated: "2026-11-11T01:59:00Z", shown: false },
    }));
    await page.getByRole("heading", { name: "Review", exact: true }).waitFor();
    await tab("interview").click();
    assert.equal(await say.count(), 0);
    await page.evaluate(() => evidence.releaseWrite());
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await stored(lastAnswer);
    await visible(lastAnswer);
    assert.equal(await chat.getByText("Old reply after restore.").count(), 0);
    assert.equal(await say.inputValue(), "");
    await count(7);
    await send.click();
    await count(8);
    assert.ok(requests[6].body.equals(requests[7].body));
    await requests[7].finish("This reply belongs to the restored generation.");
    await visible("This reply belongs to the restored generation.");
    await stored("This reply belongs to the restored generation.");
    assert.equal(await say.evaluate((element) => element === document.activeElement), true);

    // Start over can still retire a Finish request before it reaches the profile commit.
    await finish.click();
    await count(9);
    assert.equal(await restart.isEnabled(), true);
    page.once("dialog", (dialog) => dialog.accept());
    await restart.click();
    await count(10);
    await requests[9].finish("Welcome after retiring the old Finish request.");
    await visible("Welcome after retiring the old Finish request.");
    const beforeRetiredResponse = await page.evaluate(() => evidence.restoreReads);
    await requests[8].finish(result("Retired stories"));
    await page.waitForFunction((reads) => evidence.restoreReads > reads, beforeRetiredResponse);
    assert.equal(await page.evaluate(() => evidence.storyWrites.includes("Retired stories")), false);
    assert.equal(await page.evaluate(() => evidence.data.store.profile.stories[0]?.theme), "Synthetic project");
    await stored("Welcome after retiring the old Finish request.");
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ phase, width, colorScheme, firstTurn, digest, requests: requests.length }));
  await context.close();
}

(async () => {
  assert.ok(["before", "after"].includes(phase));
  const browser = await chromium.launch({
    executablePath: process.env.INTERVIEW_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  try {
    for (const width of [1280, 375])
      for (const colorScheme of ["light", "dark"]) await capture(browser, width, colorScheme);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
