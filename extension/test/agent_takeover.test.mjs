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
const { runJob, resumeJob, takeBack, stopJob, accountCreationConfirmed, EARLY_READY_PUSHBACK, RESUME_REVIEW_HELP } = await import("../background/agent.js");

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

test("Take over during a page wait prevents later automatic prefill", async () => {
  const id = await newJob();
  let paused = false;
  const getTab = chrome.tabs.get, fastFill = window.ISDom.fastFill;
  chrome.tabs.get = async (tabId) => {
    if (!paused) { paused = true; await takeBack(id, TOOK_OVER); }
    return getTab(tabId);
  };
  window.ISDom.fastFill = async () => { actions.push("automatic prefill"); return ["Phone = test value"]; };
  replies = [FILL_CLICK_READY];
  try {
    await runJob(id);
    assert.deepEqual(actions, []);
    assert.equal((await getJob(id)).reason, TOOK_OVER.reason);
  } finally { chrome.tabs.get = getTab; window.ISDom.fastFill = fastFill; }
});

test("cancellation during the final ownership read prevents prefill even before storage status changes", async () => {
  const id = await newJob();
  const get = chrome.storage.local.get, execute = chrome.scripting.executeScript, fastFill = window.ISDom.fastFill;
  let armed = false, cancelled = false;
  chrome.scripting.executeScript = async (options) => {
    const result = await execute(options);
    if (options.files?.includes("agent/dom.js")) armed = true;
    return result;
  };
  chrome.storage.local.get = async (key) => {
    const stale = await get(key);
    if (armed && key === "queue" && !cancelled) { cancelled = true; stopJob(id); }
    return stale;
  };
  window.ISDom.fastFill = async () => { actions.push("automatic prefill"); return ["Phone = test value"]; };
  replies = [FILL_CLICK_READY];
  try {
    await runJob(id);
    assert.equal(cancelled, true);
    assert.deepEqual(actions, []);
    assert.equal(calls, 0);
  } finally {
    chrome.storage.local.get = get; chrome.scripting.executeScript = execute; window.ISDom.fastFill = fastFill;
  }
});

// PR #94 review: the resume-review gate was checked only when jobs were added (index.js enqueue). A job
// queued before the resume was replaced, or resumed after, has to stop here without filling anything.
test("a queued job whose resume is still being reviewed ends Needs you and fills nothing", async () => {
  const id = await newJob();
  const create = chrome.tabs.create, fastFill = window.ISDom.fastFill;
  let tabs = 0;
  chrome.tabs.create = async (o) => { tabs++; return create(o); };
  window.ISDom.fastFill = async () => { actions.push("automatic prefill"); return ["Race = Asian"]; };
  data.store.files.resume = { name: "new.pdf", type: "application/pdf", b64: "eA==", size: 1 };
  data.store.settings.resume_details_ready = false;
  replies = [FILL_CLICK_READY, FILL_CLICK_READY];
  try {
    await runJob(id);
    let j = await getJob(id);
    assert.equal(j.status, "needs_you");
    assert.equal(j.reason, RESUME_REVIEW_HELP);
    assert.match(j.reason, /Finish reviewing your resume in the Deep Dive/);
    assert.deepEqual(actions, [], "no prefill, no fill, no click");
    assert.equal(calls, 0, "no AI call");
    assert.equal(tabs, 0, "no tab opened");
    // Resume from the side panel before the review is saved: still stopped.
    await resumeJob(id);
    await updateJob(id, { status: "working" });
    await runJob(id);
    j = await getJob(id);
    assert.equal(j.status, "needs_you");
    assert.equal(j.reason, RESUME_REVIEW_HELP);
    assert.deepEqual(actions, []);
    // A pending review choice pauses it the same way.
    data.store.settings.resume_details_ready = true;
    data.store.settings.resume_import = { plan: [] };
    await resumeJob(id);
    await updateJob(id, { status: "working" });
    await runJob(id);
    assert.equal((await getJob(id)).reason, RESUME_REVIEW_HELP);
    assert.equal(calls, 0);
  } finally {
    chrome.tabs.create = create; window.ISDom.fastFill = fastFill;
    data.store.settings.resume_details_ready = true;
    data.store.settings.resume_import = null;
    data.store.files.resume = null;
  }
});

test("a resume replaced while a job is running stops it before the next page is filled", async () => {
  const id = await newJob();
  data.store.files.resume = { name: "new.pdf", type: "application/pdf", b64: "eA==", size: 1 };
  replies = [[use("t1", "fill", { ref: "0:e1", text: "Because." })], FILL_CLICK_READY];
  onAct = async () => { onAct = null; data.store.settings.resume_details_ready = false; };
  try {
    await runJob(id);
    const j = await getJob(id);
    assert.deepEqual(actions, ["fill e1"], "the step already under way finishes; nothing after it");
    assert.equal(calls, 1);
    assert.equal(j.status, "needs_you");
    assert.equal(j.reason, RESUME_REVIEW_HELP);
  } finally {
    data.store.settings.resume_details_ready = true;
    data.store.files.resume = null;
  }
});

test("typing a generated password keeps signup pending instead of claiming an existing account", async () => {
  const id = await newJob();
  data.store.accounts = [];
  data.store.settings.signup_email = "fixture@example.test";
  const snapshot = window.ISDom.snapshot;
  window.ISDom.snapshot = () => ({ ...snapshot(), elements: [{ ref: "e1", kind: "password", label: "Password", value: "" }] });
  replies = [[use("secret", "fill_secret", { ref: "0:e1" }), use("pause", "pause_for_user", { reason: "Fixture sign-up unfinished" })]];
  try {
    await runJob(id);
    assert.equal(data.store.accounts.length, 1);
    assert.equal(data.store.accounts[0].state, "pending");
    assert.ok(data.store.accounts[0].password.length >= 18);
  } finally { window.ISDom.snapshot = snapshot; }
});

test("signup confirmation requires explicit success without an error or verification gate", () => {
  const frame = { headings: ["Your account was successfully created"], elements: [], errors: [], text: "" };
  assert.equal(accountCreationConfirmed(frame), true);
  assert.equal(accountCreationConfirmed({ ...frame, errors: ["Invalid email"] }), false);
  assert.equal(accountCreationConfirmed({ ...frame, elements: [{ kind: "password" }] }), false);
  assert.equal(accountCreationConfirmed({ ...frame, headings: ["Verify your email"] }), false);
  assert.equal(accountCreationConfirmed({ ...frame, headings: ["Your account was not created"] }), false);
});

test("the early ready_to_submit pushback never names Apply", () => {
  assert.doesNotMatch(EARLY_READY_PUSHBACK, /apply/i);
  assert.doesNotMatch(EARLY_READY_PUSHBACK, /\b(submit|send|finish|done|confirm)\b/i);
});

// ---- PR #94 review, P2 and P3 (2026-10-14) ----
const agentMod = await import("../background/agent.js");

test("Take over tells every frame of the tab to stop, with the job's new gen (dom.js halt)", async () => {
  const id = await newJob();
  await updateJob(id, { tabId: 7 });
  const before = (await getJob(id)).gen || 0;
  const halted = [];
  window.ISDom.halt = (g) => { halted.push(g); return true; };
  try {
    await takeBack(id, TOOK_OVER);
    assert.deepEqual(halted, [before + 1]);
  } finally { delete window.ISDom.halt; }
});

test("every action, prefill and highlight carries the run's gen, so the page can refuse a stopped run", async () => {
  const id = await newJob();
  const gen = (await getJob(id)).gen || 0;
  const seen = [];
  const { act, fastFill, highlight, snapshot } = window.ISDom;
  // A blocked final button in view, so ready_to_submit is taken at once and highlight runs.
  window.ISDom.snapshot = () => ({ ...snapshot(), buttons: [{ ref: "b1", text: "Next" }, { ref: "b2", text: "Submit", blocked: true }] });
  window.ISDom.act = async (ref, a, p) => { seen.push(["act", p && p.gen]); return act(ref, a, p); };
  window.ISDom.fastFill = async (f, file, o) => { seen.push(["fastFill", o && o.gen]); return []; };
  window.ISDom.highlight = (o) => { seen.push(["highlight", o && o.gen]); return highlight(o); };
  replies = [FILL_CLICK_READY];
  try {
    await runJob(id);
    for (const name of ["act", "fastFill", "highlight"]) {
      const hits = seen.filter(([n]) => n === name);
      assert.ok(hits.length, name + " was called");
      assert.ok(hits.every(([, g]) => g === gen), name + " carried gen " + gen);
    }
  } finally { Object.assign(window.ISDom, { act, fastFill, highlight, snapshot }); }
});

test("an email-only sign-in step is not counted as filling the application; a real answer is", () => {
  const { signInStep } = agentMod;
  assert.equal(signInStep([{ elements: [{ kind: "text", type: "email", label: "Email address", value: "a@b.c" }] }]), true);
  assert.equal(signInStep([{ elements: [{ kind: "text", label: "E-mail", value: "a@b.c" }, { kind: "checkbox", label: "Remember me" }] }]), true);
  assert.equal(signInStep([{ elements: [{ kind: "password", label: "Password" }] }]), true);
  assert.equal(signInStep([{ elements: [{ kind: "text", type: "email", label: "Email" }, { kind: "text", label: "Phone" }] }]), false);
  assert.equal(signInStep([{ elements: [] }]), false);
});

test("a prefill that typed only the email on a sign-in step leaves run_filled off", async () => {
  const snapshot = window.ISDom.snapshot, fastFill = window.ISDom.fastFill;
  const run = async (elements, pre) => {
    const id = await newJob();
    window.ISDom.snapshot = () => ({ ...snapshot(), elements, buttons: [{ ref: "b1", text: "Next" }] });
    window.ISDom.fastFill = async () => pre;
    replies = [[use("p", "pause_for_user", { reason: "fixture" })]];
    await runJob(id);
    return !!(await getJob(id)).run_filled;
  };
  try {
    assert.equal(await run([{ ref: "e1", kind: "text", type: "email", label: "Email", value: "fixture@example.test" }], ["Email = fixture@example.test"]), false);
    assert.equal(await run([{ ref: "e1", kind: "text", label: "Phone", value: "555" }], ["Phone = 555"]), true);
  } finally { window.ISDom.snapshot = snapshot; window.ISDom.fastFill = fastFill; }
});

test("a password typed into an ATS iframe is saved and confirmed under the iframe's domain, not the top page's", async () => {
  const id = await newJob();
  data.store.accounts = [];
  data.store.settings.signup_email = "fixture@example.test";
  const execute = chrome.scripting.executeScript, snapshot = window.ISDom.snapshot;
  let frame = 0, signedUp = false;
  chrome.scripting.executeScript = async ({ func, args, files, target }) => {
    if (files) return [];
    const out = [];
    for (const fid of target.allFrames ? [0, 3] : target.frameIds || [0]) { frame = fid; out.push({ frameId: fid, result: await func(...(args || [])) }); }
    return out;
  };
  window.ISDom.snapshot = () => (frame === 0 ? snapshot() : {
    url: "https://acme.icims.example/jobs/1/login", title: "", step: "", errors: [], captcha: false, text: "", filledFields: 0, busy: false, frozen: false, buttons: [],
    headings: signedUp ? ["Your account was successfully created"] : ["Create an account"],
    elements: signedUp ? [] : [{ ref: "p1", kind: "password", label: "Password", value: "" }],
  });
  onAct = async (a) => { if (a === "fill") signedUp = true; };
  replies = [[use("s", "fill_secret", { ref: "3:p1" })], [use("p", "pause_for_user", { reason: "fixture" })]];
  try {
    await runJob(id);
    assert.equal(data.store.accounts.length, 1);
    assert.equal(data.store.accounts[0].domain, "acme.icims.example", "keyed to the frame the password box is in");
    assert.equal(data.store.accounts[0].state, "confirmed", "and confirmed there once the frame says so");
  } finally {
    chrome.scripting.executeScript = execute; window.ISDom.snapshot = snapshot;
    data.store.accounts = [];
  }
});

test("secretUrl prefers the ref's frame, then the tab, then the job's url", () => {
  const { secretUrl } = agentMod;
  assert.equal(secretUrl({ url: "https://a.icims.example/x" }, "https://top.example/", "https://job.example/"), "https://a.icims.example/x");
  assert.equal(secretUrl({}, "https://top.example/", "https://job.example/"), "https://top.example/");
  assert.equal(secretUrl(null, "", "https://job.example/"), "https://job.example/");
});

test("a Pause that lands before the first check stops the run before the paid resume tailoring", async () => {
  const id = await newJob();
  await updateJob(id, { description: "We are looking for a data intern to help analyze product usage. ".repeat(6) });
  const s = data.store;
  const saved = { tailor: s.settings.tailor_resume, exp: s.profile.experience };
  s.settings.tailor_resume = "auto";
  s.profile.experience = [{ company: "Fixture Co", title: "Analyst intern", bullets: ["Built a dashboard"] }];
  const contains = chrome.permissions.contains;
  chrome.permissions.contains = async () => { await takeBack(id, { status: "needs_you", reason: "Paused. Press Resume to continue.", activity: "" }); return true; };
  replies = [FILL_CLICK_READY];
  try {
    await runJob(id);
    assert.equal(calls, 0, "no tailoring call and no agent call");
    assert.deepEqual(actions, []);
    assert.equal((await getJob(id)).reason, "Paused. Press Resume to continue.");
  } finally {
    chrome.permissions.contains = contains;
    s.settings.tailor_resume = saved.tailor; s.profile.experience = saved.exp;
  }
});
