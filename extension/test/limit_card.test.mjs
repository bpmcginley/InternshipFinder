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
        return Object.fromEntries(
          []
            .concat(k)
            .filter((x) => x in data)
            .map((x) => [x, clone(data[x])]),
        );
      },
      async set(o) {
        for (const [k, v] of Object.entries(o)) data[k] = clone(v);
      },
      async remove(k) {
        for (const x of [].concat(k)) delete data[x];
      },
    },
    session: {
      async get() {
        return {};
      },
      async set() {},
    },
  },
  runtime: {
    getPlatformInfo(cb) {
      if (cb) cb({});
    },
  },
  permissions: {
    async contains() {
      return true;
    },
  },
  tabs: {
    async get(id) {
      return { id, status: "complete", url: "https://boards.greenhouse.io/acme/jobs/1" };
    },
    async create() {
      return { id: 7 };
    },
    async update(id) {
      return { id };
    },
    async group() {
      return 1;
    },
    onCreated: { addListener() {}, removeListener() {} },
  },
  tabGroups: {
    async get() {
      return {};
    },
    async update() {},
  },
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
    async fastFill() {
      return [];
    },
    snapshot: () => ({
      url: "https://boards.greenhouse.io/acme/jobs/1",
      title: "Apply",
      headings: ["Data Intern"],
      step: "",
      errors: [],
      captcha: false,
      elements: [{ ref: "e1", kind: "textarea", label: "Why Acme?", value: "" }],
      buttons: [{ ref: "b1", text: "Next" }],
      text: "",
      filledFields: 0,
      busy: false,
      frozen: false,
    }),
    async act(ref, a) {
      actions.push(`${a} ${ref}`);
      if (onAct) await onAct(a);
      return { ok: true };
    },
    highlight: () => ({ missing: 0, final: false }),
    mark: () => "same",
  },
};

const { workerError } = await import("../background/gemini.js");
const { jobActions } = await import("../sidepanel/card.js");
const { emptyStore } = await import("../lib/store.js");
const { addJobs, updateJob, getJob, publicQueue } = await import("../background/queue.js");
const { runJob } = await import("../background/agent.js");
const monthly = {
  error: "cap",
  task: "autofill",
  message: "Monthly autofill allowance is used up",
  resets: "2026-12-01",
};
const offer = { plan: "supporter", label: "Supporter", allowance: { autofill: 50 } };
const actionsFor = (job) => jobActions({ status: "needs_you", ...job }).map((a) => a[0]);

test("only the exact monthly autofill cap identifies an allowance limit, independent of offers", () => {
  for (const extra of [{}, { upgrade: false }, { upgrade: true, offer }]) {
    const e = workerError(429, { ...monthly, ...extra });
    assert.equal(e.allowanceLimited, true);
    assert.match(e.message, /current allowance/);
    assert.doesNotMatch(e.message, /free|used this month|resets|twice|gives you/);
  }
  for (const patch of [
    { error: "rate" },
    { task: "resume_tailor" },
    { message: "unknown" },
    { message: undefined },
    { message: "This run reached its call limit" },
    { message: "This account reached its monthly AI ceiling" },
  ]) {
    assert.equal(
      workerError(429, { ...monthly, upgrade: true, offer, ...patch }).allowanceLimited,
      false,
    );
  }
  assert.match(
    workerError(429, { ...monthly, message: "This run reached its call limit" }).message,
    /run reached its AI call limit/,
  );
  assert.match(
    workerError(429, { ...monthly, message: "This account reached its monthly AI ceiling" })
      .message,
    /AI spending limit/,
  );
});

test("top/no-offer and offered allowance cards preserve priority and legacy actions", () => {
  assert.deepEqual(actionsFor({ allowanceLimited: true }), ["invite", "resume", "focus", "remove"]);
  assert.deepEqual(actionsFor({ allowanceLimited: true, upgrade: offer }), [
    "upgrade",
    "invite",
    "resume",
    "focus",
    "remove",
  ]);
  assert.deepEqual(actionsFor({ upgrade: offer }), ["upgrade", "resume", "focus", "remove"]);
  for (const [patch, first] of [
    [{ needs_auth: true }, "signin_resume"],
    [{ needs_host: "https://example.com" }, "allow_host"],
    [{ question: "Synthetic?" }, "answer"],
    [{ tailored: { status: "pending" } }, "approve_tailored"],
  ]) {
    const list = actionsFor({ allowanceLimited: true, upgrade: offer, ...patch });
    assert.equal(list[0], first);
    assert.ok(!list.includes("invite"));
  }
});

let serial = 0;
async function job() {
  const store = emptyStore();
  store.settings.tailor_resume = "off";
  store.settings.onboarded = true;
  store.settings.resume_details_ready = true;
  store.files.resume = { name: "SYNTHETIC.txt", type: "text/plain", b64: "Zml4dHVyZQ==", size: 7 };
  data.store = store;
  data["internscout.session"] = { token: "iss_" + "a".repeat(43), expires: "2099-01-01T00:00:00Z" };
  const {
    added: [id],
  } = await addJobs([
    {
      id: ++serial,
      company: "Fixture Employer",
      title: "Data Intern",
      apply_url: `https://boards.greenhouse.io/acme/jobs/${serial}`,
    },
  ]);
  await updateJob(id, { status: "working" });
  return id;
}
function response(body, during) {
  globalThis.fetch = async (_url, options) => {
    if (during) await during(options.signal);
    return { status: 429, ok: false, headers: { get: () => null }, json: async () => body };
  };
}
test("the real guarded loop carries the signal through public queue and clears it for another cap", async () => {
  const id = await job();
  response(monthly);
  await runJob(id);
  let j = await getJob(id);
  assert.equal(j.status, "needs_you");
  assert.equal(j.allowanceLimited, true);
  assert.equal(publicQueue({ order: [id], jobs: { [id]: j } }).jobs[id].allowanceLimited, true);
  await updateJob(id, { status: "working" });
  response({ ...monthly, message: "This run reached its call limit" });
  await runJob(id);
  j = await getJob(id);
  assert.equal(j.allowanceLimited, false);
  assert.ok(!actionsFor(j).includes("invite"));
});
test("a late monthly cap cannot overwrite takeover or attach its flag", async () => {
  const id = await job();
  response(monthly, async () =>
    updateJob(id, (j) => ({
      status: "needs_you",
      reason: "Synthetic takeover",
      gen: (j.gen || 0) + 1,
    })),
  );
  await runJob(id);
  const j = await getJob(id);
  assert.equal(j.reason, "Synthetic takeover");
  assert.notEqual(j.allowanceLimited, true);
});
