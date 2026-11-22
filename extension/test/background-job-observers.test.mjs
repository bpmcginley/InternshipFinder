import test from "node:test";
import assert from "node:assert/strict";

const events = {};
const event = (name) => ({ addListener(callback) { events[name] = callback; } });
const data = {};
const storage = {
  async get(key) { return { [key]: structuredClone(data[key]) }; },
  async set(patch) {
    for (const [key, value] of Object.entries(patch)) data[key] = structuredClone(value);
  },
};
let frontTab = 7;
let readPage;
globalThis.self = globalThis;
globalThis.chrome = {
  runtime: {
    onMessage: event("message"), onConnect: event("connect"),
    onStartup: event("startup"), onInstalled: event("install"),
  },
  storage: { local: storage, session: storage, onChanged: event("storage") },
  tabs: {
    onActivated: event("activate"), onRemoved: event("removed"),
    async query() { return [{ id: frontTab }]; },
    async sendMessage() {},
  },
  notifications: { onClicked: event("notification"), create() {} },
  webNavigation: { onCompleted: event("navigation") },
  scripting: { async executeScript({ func }) { return func ? readPage() : []; } },
};

const { getJob, updateJob } = await import("../background/queue.js");
const { BACKGROUND_TAB_HELP } = await import("../background/agent.js");
await import("../background/index.js");

function reset(patch = {}) {
  data.queue = {
    jobs: { job: { id: "job", tabId: 7, status: "ready_to_submit", gen: 3, ...patch } },
    order: [],
  };
  frontTab = 7;
  readPage = async () => [{ result: true }];
}

function timers(t, delay) {
  const callbacks = [];
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== delay) return realTimeout(callback, ms, ...args);
    callbacks.push(callback);
    return 0;
  });
  return callbacks;
}

test("a confirmation from an old page check cannot overwrite manual takeover", async () => {
  reset();
  const started = Promise.withResolvers();
  const answer = Promise.withResolvers();
  readPage = () => {
    started.resolve();
    return answer.promise;
  };
  const navigation = events.navigation({ frameId: 0, tabId: 7 });
  await started.promise;
  await updateJob("job", { status: "needs_you", reason: "You took over.", gen: 4 });
  const takeover = await getJob("job");
  answer.resolve([{ result: true }]);
  await navigation;
  assert.deepEqual(await getJob("job"), takeover);
});

test("a confirmation still marks the current ready job as submitted", async () => {
  reset();
  await events.navigation({ frameId: 0, tabId: 7 });
  const job = await getJob("job");
  assert.equal(job.status, "submitted");
  assert.ok(job.submitted_at > 0);
});

test("a previous submission poll does not inspect a new ready generation", async (t) => {
  reset();
  let reads = 0;
  readPage = async () => {
    reads++;
    return [{ result: true }];
  };
  const callbacks = [];
  t.mock.method(globalThis, "setTimeout", (callback) => {
    callbacks.push(callback);
    return 0;
  });
  await new Promise((resolve) =>
    events.message({ type: "maybe_submitted" }, { tab: { id: 7 } }, resolve));
  assert.equal(callbacks.length, 4);
  await updateJob("job", { gen: 5 });
  for (const callback of callbacks.slice()) await callback();
  assert.equal(reads, 0);
  assert.equal((await getJob("job")).status, "ready_to_submit");
});

test("a delayed resume cannot undo takeover or start after the student switches tabs", async (t) => {
  const callbacks = timers(t, 800);
  for (const patch of [{ status: "needs_you", reason: "You took over.", gen: 4 }, null]) {
    reset({ status: "needs_you", reason: BACKGROUND_TAB_HELP });
    await events.activate({ tabId: 7 });
    assert.equal(callbacks.length, 1);
    if (patch) await updateJob("job", patch);
    else frontTab = 8;
    const paused = await getJob("job");
    await callbacks.pop()();
    assert.deepEqual(await getJob("job"), paused);
  }
});

test("a sleeping job still resumes on its active tab when nothing changed", async (t) => {
  reset({ status: "needs_you", reason: BACKGROUND_TAB_HELP });
  const callbacks = timers(t, 800);
  await events.activate({ tabId: 7 });
  assert.equal(callbacks.length, 1);
  await callbacks.pop()();
  const job = await getJob("job");
  assert.equal(job.status, "queued");
  assert.equal(job.gen, 4);
});
