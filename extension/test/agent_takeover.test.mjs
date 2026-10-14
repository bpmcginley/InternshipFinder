// Pause and Take over have to stop the agent, including an AI reply that was already on its way when
// the student pressed the button (product review 2026-10-13, Codex #1). The loop runs here for real
// against stubbed Chrome APIs, a stubbed page (window.ISDom) and a stubbed AI (fetch), offline.
import test from "node:test";
import assert from "node:assert/strict";

const data = {};
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        if (k == null) return clone(data);
        return Object.fromEntries([].concat(k).filter((x) => x in data).map((x) => [x, clone(data[x])]));
      },
      async set(o) { for (const [k, v] of Object.entries(o)) data[k] = clone(v); },
      async remove(k) { for (const x of [].concat(k)) delete data[x]; },
    },
    session: { async get() { return {}; }, async set() {} },
  },
  runtime: { getPlatformInfo(cb) { if (cb) cb({}); } },
  permissions: { async contains() { return true; } },
  tabs: {
    async get(id) { return { id, status: "complete", url: "https://boards.greenhouse.io/acme/jobs/1" }; },
    async create() { return { id: 7 }; },
    async update(id) { return { id }; },
    async group() { return 1; },
    onCreated: { addListener() {}, removeListener() {} },
  },
  tabGroups: { async get() { return {}; }, async update() {} },
  scripting: {
    async executeScript({ func, args, files }) {
      if (files) return [];
      return [{ frameId: 0, result: await func(...(args || [])) }];
    },
  },
};

// The page: one empty question and a button. Every action the agent takes on it is recorded.
const actions = [];
let onAct = null;
globalThis.window = {
  ISDom: {
    async fastFill() { return []; },
    snapshot: () => ({ url: "https://boards.greenhouse.io/acme/jobs/1", title: "Apply", headings: ["Data Intern"], step: "", errors: [], captcha: false,
      elements: [{ ref: "e1", kind: "textarea", label: "Why Acme?", value: "" }], buttons: [{ ref: "b1", text: "Next" }], text: "", filledFields: 0, busy: false, frozen: false }),
    async act(ref, a) { actions.push(`${a} ${ref}`); if (onAct) await onAct(a); return { ok: true }; },
    highlight: () => ({ missing: 0, final: false }),
    mark: () => "same",
  },
};

// The AI: each call takes the next scripted reply. `during` runs while the call is in flight.
let replies = [], during = null, calls = 0;
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
globalThis.fetch = async (url, opts) => {
  calls++;
  const reply = replies.shift();
  if (during) { const d = during; during = null; await d(opts.signal); }
  if (opts.signal && opts.signal.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ content: reply, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } }) };
};

const { emptyStore } = await import("../lib/store.js");
const { addJobs, updateJob, getJob, loadMsgs } = await import("../background/queue.js");
const { runJob, resumeJob, takeBack, EARLY_READY_PUSHBACK } = await import("../background/agent.js");

const store = emptyStore();
store.ai = { provider: "anthropic", apiKey: "test-key", geminiKey: "", model: "claude-sonnet-5" };
store.settings.tailor_resume = "off";
store.settings.onboarded = true;
data.store = store;

let n = 0;
async function newJob() {
  const { added: [id] } = await addJobs([{ id: ++n, company: "Acme", title: "Data Intern", apply_url: `https://boards.greenhouse.io/acme/jobs/${n}` }]);
  await updateJob(id, { status: "working" });   // as index.js schedule() does
  actions.length = 0; calls = 0; onAct = null;
  return id;
}
const FILL_CLICK_READY = [use("t1", "fill", { ref: "0:e1", text: "Because." }), use("t2", "click", { ref: "0:b1" }), use("t3", "ready_to_submit", { summary: "Done" })];
const TOOK_OVER = { status: "needs_you", reason: "You took over. Press Resume to hand it back.", activity: "" };

test("a reply that arrives after Take over does nothing and leaves the student's status alone", async () => {
  const id = await newJob();
  replies = [FILL_CLICK_READY];
  // The student presses Take over while the model is thinking. This reply ignores the abort, as a
  // response already on the wire would.
  during = async () => { await updateJob(id, (j) => ({ ...TOOK_OVER, gen: (j.gen || 0) + 1 })); };
  await runJob(id);
  const j = await getJob(id);
  assert.deepEqual(actions, [], "no field filled and no button clicked after Take over");
  assert.equal(j.status, "needs_you");
  assert.equal(j.reason, TOOK_OVER.reason);
  assert.equal(j.steps || 0, 0);
  assert.deepEqual(await loadMsgs(id), [], "the dropped turn is not in the history");
});

test("Take over cuts the AI call off, and the job is not marked failed", async () => {
  const id = await newJob();
  replies = [FILL_CLICK_READY];
  during = (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", resolve);
    takeBack(id, TOOK_OVER);
  });
  const t0 = Date.now();
  await runJob(id);
  const j = await getJob(id);
  assert.deepEqual(actions, []);
  assert.equal(j.status, "needs_you");
  assert.equal(j.reason, TOOK_OVER.reason);
  assert.ok(Date.now() - t0 < 6000, "no retries after the abort");
});

test("Take over in the middle of a reply stops the rest of it", async () => {
  const id = await newJob();
  replies = [FILL_CLICK_READY];
  // The student takes over while the first field is being typed.
  onAct = async () => { onAct = null; await takeBack(id, TOOK_OVER); };
  await runJob(id);
  const j = await getJob(id);
  assert.deepEqual(actions, ["fill e1"], "the click and ready_to_submit after it are not run");
  assert.equal(j.status, "needs_you");
  assert.equal(j.reason, TOOK_OVER.reason, "ready_to_submit did not overwrite it");
  const results = j.pending.results.map((r) => r.content);
  assert.match(results[1], /^Not run/);
  assert.match(results[2], /^Not run/);
  const msgs = await loadMsgs(id);
  assert.equal(msgs[msgs.length - 1].role, "assistant", "history and pending results still pair up for Resume");
});

test("a late pause_for_user cannot turn Submitted back into Needs you", async () => {
  const id = await newJob();
  replies = [[use("p1", "pause_for_user", { reason: "Something went wrong" })]];
  during = () => takeBack(id, { status: "submitted", activity: "", submitted_at: Date.now() });
  await runJob(id);
  const j = await getJob(id);
  assert.equal(j.status, "submitted");
});

test("Pause then Resume while a reply is in flight starts one fresh run instead of a stuck one", async () => {
  const id = await newJob();
  replies = [FILL_CLICK_READY, [use("p2", "pause_for_user", { reason: "Pick a start date yourself." })]];
  let second = null;
  during = async () => {
    await updateJob(id, (j) => ({ status: "needs_you", reason: "Paused. Press Resume to continue.", gen: (j.gen || 0) + 1 }));
    await resumeJob(id);
    await updateJob(id, { status: "working" });   // schedule() picks it up again...
    second = runJob(id);                            // ...while the first run is still waiting on the AI
  };
  await runJob(id);
  await second;
  const j = await getJob(id);
  assert.equal(calls, 2, "the fresh run asked the AI again");
  assert.deepEqual(actions, [], "the first run's reply was dropped");
  assert.equal(j.status, "needs_you");
  assert.equal(j.reason, "Pick a start date yourself.");
});

test("the early ready_to_submit pushback never names Apply", () => {
  assert.doesNotMatch(EARLY_READY_PUSHBACK, /apply/i);
  assert.doesNotMatch(EARLY_READY_PUSHBACK, /\b(submit|send|finish|done|confirm)\b/i);
});
