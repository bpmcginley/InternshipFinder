// U5 and U7 (2026-10-14 UX audit): a batch asks the tailored-resume question once instead of stopping every
// job, and a new job tab doesn't take the screen while the student is busy with another job.
// Also U4: Setup is ticked only once signed in, and the Files step asks for sign-in itself.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data = {};
globalThis.chrome = { runtime: {}, storage: { local: {
  async get(k) { return typeof k === "string" ? { [k]: data[k] } : Object.fromEntries([].concat(k).map((x) => [x, data[x]])); },
  async set(o) { for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
  async remove(k) { for (const x of [].concat(k)) delete data[x]; },
}, session: {} } };

const queue = await import("../background/queue.js");
const { jobActions, jobCard } = await import("../sidepanel/card.js");
const { setupDone, signInNeeded, readAfterSignIn } = await import("../onboarding/quickstart.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const index = read("background/index.js"), agent = read("background/agent.js");

const listing = (n) => ({ id: n, company: `Co ${n}`, title: "Intern", apply_url: `https://boards.greenhouse.io/co/jobs/${n}` });

// ---------- U5 ----------
test("U5: one Auto-Apply press is one batch", async () => {
  const a = await queue.addJobs([listing(1), listing(2)]);
  const b = await queue.addJobs([listing(3)]);
  const q = await queue.getQueue();
  const [j1, j2] = a.added.map((id) => q.jobs[id]), j3 = q.jobs[b.added[0]];
  assert.ok(j1.batch && j1.batch === j2.batch);
  assert.notEqual(j3.batch, j1.batch);
});

test("U5: while one job waits on its tailored resume, the rest of its batch waits too, and the choice covers them", async () => {
  for (const k of Object.keys(data)) delete data[k];
  const { added: [a, b, c, d] } = await queue.addJobs([listing(11), listing(12), listing(13), listing(14)]);
  const { added: [other] } = await queue.addJobs([listing(15)]);
  await queue.updateJob(a, { status: "needs_you", tailored: { status: "pending", diff: [{}] } });
  await queue.updateJob(d, { status: "working", tailored: { status: "approved" } });
  let q = await queue.getQueue();
  assert.equal(queue.tailorWaiting(q, q.jobs[b]), true);
  assert.equal(queue.tailorWaiting(q, q.jobs[c]), true);
  assert.equal(queue.tailorWaiting(q, q.jobs[other]), false, "another batch goes on");
  assert.equal(queue.batchLeft(q, q.jobs[a]), 2, "b and c; d is already filling with its resume chosen");
  const pub = queue.publicQueue(q).jobs;
  assert.equal(pub[b].tailor_wait, true);
  assert.equal(pub[a].batch_left, 2);
  // "Use tailored for all": every job of the batch remembers it, and the waiting one is named for resuming.
  assert.deepEqual(await queue.setBatchTailor(q.jobs[a].batch, "approved"), [a]);
  q = await queue.getQueue();
  assert.deepEqual([a, b, c, d].map((id) => q.jobs[id].batch_tailor), ["approved", "approved", "approved", "approved"]);
  assert.equal(q.jobs[other].batch_tailor, undefined);
  assert.equal(queue.tailorWaiting(q, q.jobs[b]), false, "answered for all: the others start");
  assert.deepEqual(await queue.setBatchTailor(q.jobs[a].batch, "maybe"), [], "only the two answers");
});

test("U5: what a tailored resume does: the setting, unless a for-all answer was given", () => {
  assert.equal(queue.tailorChoice("review", undefined), "review");
  assert.equal(queue.tailorChoice("auto", undefined), "auto");
  assert.equal(queue.tailorChoice("review", "approved"), "auto");
  assert.equal(queue.tailorChoice("review", "skipped"), "original");
  assert.equal(queue.tailorChoice("auto", "skipped"), "original");
  // The agent uses it, read fresh, and a batch that chose the original isn't tailored at all.
  assert.match(agent, /const choice = tailorChoice\(store\.settings\.tailor_resume, \(\(await getJob\(id\)\) \|\| job\)\.batch_tailor\);/);
  assert.match(agent, /job\.batch_tailor !== "skipped" && canTailor\(store, job\)/);
  // The scheduler leaves waiting jobs queued, and the for-all answers resume the waiting ones.
  assert.match(index, /if \(j && j\.status === "queued" && !tailorWaiting\(q, j\)\)/);
  assert.match(index, /case "approve_tailored_all":\s*case "skip_tailored_all":/);
});

test("U5: the card offers the for-all answers only when others share the batch, and says why they wait", () => {
  const pending = { id: "j1", status: "needs_you", company: "Acme", title: "Intern", tailored: { status: "pending", file: { name: "r.pdf" } } };
  assert.deepEqual(jobActions({ ...pending, batch_left: 0 }).map((b) => b[0]), ["approve_tailored", "preview_tailored", "skip_tailored", "focus", "remove"]);
  const many = jobActions({ ...pending, batch_left: 3 });
  assert.deepEqual(many.map((b) => b[0]), ["approve_tailored", "preview_tailored", "skip_tailored", "approve_tailored_all", "skip_tailored_all", "focus", "remove"]);
  assert.equal(many[3][1], "Use tailored for all 4");
  assert.equal(many[4][1], "Use my original for all 4");
  assert.match(jobCard({ ...pending, batch_left: 1 }), /1 more application you queued with this one waits for this choice\./);
  assert.match(jobCard({ ...pending, batch_left: 3 }), /3 more applications you queued with this one wait for this choice\./);
  assert.match(jobCard({ id: "j2", status: "queued", tailor_wait: true }), /Waiting for your choice about the tailored resume/);
  assert.match(jobCard({ id: "j3", status: "queued" }), /Waiting for a free tab/);
});

// ---------- U7 ----------
test("U7: the student is busy on a tab that holds a job waiting on them, and only then", async () => {
  const q = { jobs: {
    a: { id: "a", tabId: 5, status: "ready_to_submit" }, b: { id: "b", tabId: 6, status: "needs_you" },
    c: { id: "c", tabId: 7, status: "working" }, d: { id: "d", tabId: 8, status: "submitted" } } };
  assert.equal(queue.studentBusyOn(q, 5).id, "a");
  assert.equal(queue.studentBusyOn(q, 6).id, "b");
  assert.equal(queue.studentBusyOn(q, 7), null);
  assert.equal(queue.studentBusyOn(q, 8), null);
  assert.equal(queue.studentBusyOn(q, 99), null);
  assert.equal(queue.studentBusyOn(q, undefined), null);
});

test("U7: the scheduler holds new jobs then, and tries again when the student moves on; nothing clicks or submits", () => {
  const sched = index.slice(index.indexOf("async function schedule()"), index.indexOf("// ---------- helpers"));
  assert.match(sched, /chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/);
  assert.match(sched, /if \(front && studentBusyOn\(q, front\.id\)\) break;/);
  assert.match(index, /chrome\.tabs\.onActivated\.addListener\(async \(\{ tabId \}\) => \{\s*schedule\(\);/);
  assert.match(index, /if \(prev === "needs_you" \|\| prev === "ready_to_submit"\) schedule\(\);/);
  assert.doesNotMatch(sched, /click|submit\(/i);
});

// ---------- U4 ----------
const S = (over = {}) => ({ ai: { provider: "internscout" }, files: { resume: { name: "r.pdf" } }, settings: { signup_email: "sam@umass.edu", resume_details_ready: false }, ...over });

test("U4: Setup is ticked only once signed in on InternScout's AI (not while unknown); an own key needs no sign-in", () => {
  assert.equal(setupDone(S(), true), true);
  assert.equal(setupDone(S(), false), false);
  assert.equal(setupDone(S(), null), false);
  assert.equal(setupDone(S({ settings: { signup_email: "" } }), true), false);
  assert.equal(setupDone(S({ ai: { provider: "anthropic", apiKey: "k" } }), null), true);
  assert.equal(setupDone(S({ ai: { provider: "anthropic", apiKey: "" } }), true), false);
});

test("U4: sign-in is asked for only on InternScout's AI once known signed out, and a chosen resume is read straight after", () => {
  assert.equal(signInNeeded(S(), false), true);
  assert.equal(signInNeeded(S(), null), false);
  assert.equal(signInNeeded(S(), true), false);
  assert.equal(signInNeeded(S({ ai: { provider: "gemini", geminiKey: "k" } }), false), false);
  assert.equal(readAfterSignIn(S()), true);
  assert.equal(readAfterSignIn(S(), { extracting: true }), false);
  assert.equal(readAfterSignIn(S(), { pending: true }), false);
  assert.equal(readAfterSignIn(S({ settings: { resume_details_ready: true } })), false, "already read");
  assert.equal(readAfterSignIn(S({ files: { resume: null } })), false);
});

test("U4: the pages use them: Setup's step tick, its Next label and warning, the Files sign-in and its read", () => {
  const onb = read("onboarding/onboarding.js");
  assert.match(onb, /setup: setupDone\(S, signedIn\),/);
  assert.match(onb, /navButtons\(null, "files", "Next: add your resume"\)/);
  assert.match(onb, /You aren't signed in yet\. Reading your resume and Auto-Apply both need it, so sign in above first\./);
  assert.match(onb, /<div id="files-signin" hidden><\/div>/);
  assert.match(onb, /if \(inp\.dataset\.slot === "resume" && hasKey\(S\) && !signInNeeded\(S, signedIn\)\) extract/);
  assert.match(onb, /if \(readAfterSignIn\(S, \{ extracting, pending: !!pendingResumeImport \}\)\) extract/);
  assert.match(onb, /refreshSignIn\(\);\s*$/);
});

test("Take over brings the tab forward within TAKEOVER_FOCUS_MS, not after a slow page's halt (2026-10-14 review)", () => {
  const m = index.match(/case "takeover": \{([\s\S]*?)\n    \}/);
  assert.ok(m, "takeover case found");
  const body = m[1].replace(/^\s*\/\/.*$/gm, "");
  assert.match(body, /const halting = takeBack\(/);
  assert.match(body, /await Promise\.race\(\[halting, new Promise\(\(r\) => setTimeout\(r, TAKEOVER_FOCUS_MS\)\)\]\);\s*await focusJob\(j\);\s*await halting;/);
  assert.doesNotMatch(body, /await takeBack\(/, "focus no longer waits for the whole halt");
  assert.match(index, /const TAKEOVER_FOCUS_MS = 1500;/);
});
