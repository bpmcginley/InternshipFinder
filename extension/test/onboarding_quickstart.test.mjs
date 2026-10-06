// The Deep Dive's quick start: Auto-Apply can be turned on from the Files step once the AI, a resume and
// the sign-up email are there, and both finish buttons (Files, Review) do the same thing to the settings
// that background/index.js checks before it queues a job (onboarded && hasKey).
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} } };
const { quickStartReady, finishOnboarding, DIGEST_URL, digestLink } = await import("../onboarding/quickstart.js");
const { hasKey } = await import("../lib/store.js");

const student = (over = {}) => ({
  ai: { provider: "internscout", apiKey: "", geminiKey: "" },
  files: { resume: { name: "cv.pdf", type: "application/pdf", size: 1, b64: "AA==" } },
  settings: { signup_email: "sam@school.edu", onboarded: false, deep_dive_run: "run-1" },
  ...over,
});

test("finishOnboarding turns Auto-Apply on, dates it, retires the run and saves at once", async () => {
  const S = student();
  const saves = [];
  await finishOnboarding(S, async (now) => { saves.push({ now, onboarded: S.settings.onboarded, at: S.settings.deep_dive_at }); }, 1759600000000);
  assert.equal(S.settings.onboarded, true);
  assert.equal(S.settings.deep_dive_at, 1759600000000);
  assert.equal(S.settings.deep_dive_run, null);
  // One immediate save, after the settings were set (not a debounced one the page could lose on close).
  assert.deepEqual(saves, [{ now: true, onboarded: true, at: 1759600000000 }]);
  // Without a time it uses now.
  const T = student(), before = Date.now();
  await finishOnboarding(T, async () => {});
  assert.ok(T.settings.deep_dive_at >= before && T.settings.deep_dive_at <= Date.now());
  // The background's own gate (index.js: onboarded && hasKey) now lets a job through.
  assert.ok(S.settings.onboarded && hasKey(S));
});

test("the quick-start button needs exactly the AI, a resume and the sign-up email", () => {
  const cases = [
    [student(), true],
    [student({ files: { resume: null } }), false],
    [student({ settings: { signup_email: "" } }), false],
    [student({ ai: { provider: "anthropic", apiKey: "" } }), false],
    [student({ ai: { provider: "anthropic", apiKey: "sk-ant-x" } }), true],
    [student({ ai: { provider: "gemini", geminiKey: "AIza" } }), true],
    [student({ ai: { provider: "gemini", geminiKey: "", apiKey: "sk-ant-x" } }), false],
  ];
  for (const [S, want] of cases) {
    assert.equal(quickStartReady(S), want, JSON.stringify(S.ai) + JSON.stringify(S.settings) + !!S.files.resume);
    assert.equal(quickStartReady(S), !!(hasKey(S) && S.files.resume && S.settings.signup_email));
  }
});

// The weekly email's link at the end of setup (2026-10-06): optional, plain, and tagged as the
// extension's, to the one page every channel links.
test("the end of setup offers the weekly email as one plain link to /digest/", () => {
  assert.equal(DIGEST_URL, "https://internscout.org/digest/?utm_source=extension&utm_medium=extension");
  const html = digestLink();
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.ok(html.includes(`href="${DIGEST_URL}"`) && html.includes('target="_blank" rel="noopener"'));
  assert.ok(html.includes("Get new internships by email every Monday"));
  assert.ok(!/<form|<input|checked/.test(html), "a link, nothing to fill in or untick");
});
