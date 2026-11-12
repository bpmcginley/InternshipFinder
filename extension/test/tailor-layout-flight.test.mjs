import assert from "node:assert/strict";
import { test } from "node:test";
import { tailorResume } from "../background/tailor.js";
import { SESSION_KEY } from "../lib/auth.js";
import { renderResume, toB64 } from "../lib/pdf.js";
import { emptyStore } from "../lib/store.js";

const session = (suffix) => ({ token: "iss_synthetic_" + suffix, expires: "2099-01-01T00:00:00Z" });
const profile = emptyStore().profile;
Object.assign(profile.facts, { first_name: "Jamie", last_name: "Fixture" });
profile.education = [{ school: "Example University", major: "Computer Science", degree: "BS" }];
profile.experience = [
  {
    company: "Example Lab",
    title: "Research Assistant",
    bullets: ["Ran 40 sample tests weekly", "Kept the test notebook", "Prepared fixture inputs"],
  },
];
const layout = {
  columns: 1,
  graphics: false,
  style: {
    font: "serif",
    body_size: 10,
    name_size: 22,
    heading_size: 11,
    pages: 1,
    margin_in: 0.75,
  },
  header: { name: "Jamie Fixture", contact: ["jamie@example.invalid"] },
  sections: [
    { title: "Education", entries: [{ rows: [{ left: "**Example University**" }] }] },
    {
      title: "Experience",
      entries: [{ rows: [{ left: "**Example Lab**" }], bullets: profile.experience[0].bullets }],
    },
  ],
};
const edit = {
  entries: [
    {
      s: 1,
      e: 0,
      bullets: [
        { from: 0, text: "Ran 40 sample tests each week" },
        { from: 1, text: "Kept the test notebook" },
        { from: 2, text: "Prepared fixture inputs" },
      ],
    },
  ],
  lines: [],
  changes: ["Reworded the existing test count."],
};
const JOBS = ["Research", "Testing"].map((title, i) => ({
  company: "Example Employer",
  title: title + " Intern",
  description: "Synthetic listing for regression.",
  run_id: "00000000-0000-4000-8000-00000000000" + (i + 1),
}));
function storeOf(contact = "jamie@example.invalid") {
  const store = emptyStore();
  store.profile = structuredClone(profile);
  store.settings.tailor_resume = "review";
  const bytes = renderResume({
    name: "Jamie Fixture",
    contact: [contact],
    education: profile.education,
    experience: profile.experience,
    projects: [],
    skills: {},
  });
  store.files.resume = {
    name: "fixture.pdf",
    type: "application/pdf",
    size: bytes.length,
    b64: toB64(bytes),
  };
  return store;
}
function harness(t, layoutReply) {
  const requests = [];
  const local = { [SESSION_KEY]: session("a") };
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries([keys].flat().map((key) => [key, structuredClone(local[key])])),
        set: async (patch) => Object.assign(local, structuredClone(patch)),
      },
      session: { get: async () => ({}) },
    },
  };
  t.after(() => {
    globalThis.chrome = originalChrome;
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.method, "POST");
    const worker = String(url) === "https://internscout-api.bpmcginley.workers.dev/ai?stream=1";
    if (worker) assert.equal(body.task, "resume_tailor");
    else assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const system = worker ? body.request.systemInstruction.parts[0].text : body.system;
    const kind = system.startsWith("You transcribe") ? "layout" : "edit";
    const request = {
      kind,
      worker,
      body,
      signal: init.signal,
      authorization: init.headers.authorization,
    };
    requests.push(request);
    const result = kind === "layout" ? await layoutReply(request) : edit;
    if (result instanceof Response) return result;
    const text = JSON.stringify(result);
    return Response.json(
      worker
        ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }
        : { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 30 } },
    );
  });
  return { requests, local };
}
function heldReply() {
  const reached = Promise.withResolvers(),
    reply = Promise.withResolvers();
  return {
    reached: reached.promise,
    finish: (value = layout) => reply.resolve(value),
    async hold(request) {
      const cancel = () => reply.reject(request.signal.reason);
      request.signal?.addEventListener("abort", cancel, { once: true });
      reached.resolve(request);
      try {
        return await reply.promise;
      } finally {
        request.signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
function observeWaiter(t) {
  const controller = new AbortController();
  const joined = Promise.withResolvers();
  const listen = controller.signal.addEventListener.bind(controller.signal);
  t.mock.method(controller.signal, "addEventListener", (name, ...rest) => {
    if (name === "abort") joined.resolve();
    return listen(name, ...rest);
  });
  return { controller, joined: joined.promise };
}
const assertValid = (result) => {
  assert.equal(result.format, "pdf_layout");
  assert.equal(result.diff.length, 1);
  assert.ok(result.file.b64);
};

test(
  "two Worker jobs share one PDF reading and keep their own edits",
  { timeout: 5000 },
  async (t) => {
    const gate = heldReply();
    const { requests } = harness(t, gate.hold);
    const store = storeOf();
    const first = tailorResume(store, JOBS[0]);
    const original = await gate.reached;
    const waiter = observeWaiter(t);
    const second = tailorResume(store, JOBS[1], { signal: waiter.controller.signal });
    await waiter.joined;
    assert.equal(requests.length, 1);
    assert.equal(original.body.run_id, JOBS[0].run_id);
    assert.equal(
      original.body.request.contents[0].parts.find((part) => part.inlineData).inlineData.data,
      store.files.resume.b64,
    );
    gate.finish();
    (await Promise.all([first, second])).forEach(assertValid);
    assert.deepEqual(
      requests.map(({ kind }) => kind),
      ["layout", "edit", "edit"],
    );
    const edits = requests.filter(({ kind }) => kind === "edit");
    assert.deepEqual(
      new Set(edits.map(({ body }) => body.run_id)),
      new Set(JOBS.map(({ run_id }) => run_id)),
    );
    assert.notDeepEqual(edits[0].body.request, edits[1].body.request);
  },
);

test(
  "active readers reuse a layout even if its optional cache write fails",
  { timeout: 5000 },
  async (t) => {
    const gate = heldReply();
    const { requests, local } = harness(t, gate.hold);
    const set = chrome.storage.local.set;
    t.mock.method(chrome.storage.local, "set", async (patch) => {
      if (patch.resume_layout) throw new Error("Synthetic layout storage failure");
      return set(patch);
    });
    const store = storeOf();
    const first = tailorResume(store, JOBS[0]);
    await gate.reached;
    const waiter = observeWaiter(t);
    const second = tailorResume(store, JOBS[1], { signal: waiter.controller.signal });
    await waiter.joined;
    gate.finish();
    (await Promise.all([first, second])).forEach(assertValid);
    assert.deepEqual(
      requests.map(({ kind }) => kind),
      ["layout", "edit", "edit"],
    );
    assert.equal(local.resume_layout, undefined);
  },
);

test(
  "the shared reading still checks the waiting job's own profile",
  { timeout: 5000 },
  async (t) => {
    const gate = heldReply();
    const { requests } = harness(t, gate.hold);
    const original = tailorResume(storeOf(), JOBS[0]);
    await gate.reached;
    const differentProfile = storeOf();
    differentProfile.profile.facts.last_name = "SomeoneElse";
    differentProfile.settings.tailor_resume = "auto";
    const waiter = observeWaiter(t);
    const other = tailorResume(differentProfile, JOBS[1], { signal: waiter.controller.signal });
    const refusal = assert.rejects(other, /does not match the name/);
    await waiter.joined;
    gate.finish();
    assertValid(await original);
    await refusal;
    assert.deepEqual(
      requests.map(({ kind }) => kind),
      ["layout", "edit"],
    );
  },
);

for (const canceled of [0, 1]) {
  test(
    "canceling " + (canceled === 0 ? "the first" : "a waiting") + " reader leaves the other active",
    { timeout: 5000 },
    async (t) => {
      const gate = heldReply();
      const { requests } = harness(t, gate.hold);
      const readers = [observeWaiter(t), observeWaiter(t)];
      const store = storeOf();
      const first = tailorResume(store, JOBS[0], { signal: readers[0].controller.signal });
      const upstream = await gate.reached;
      const second = tailorResume(store, JOBS[1], { signal: readers[1].controller.signal });
      await readers[1].joined;
      const jobs = [first, second];
      const abort = assert.rejects(jobs[canceled], { name: "AbortError" });
      readers[canceled].controller.abort();
      await abort;
      assert.equal(upstream.signal.aborted, false);
      assert.equal(requests.length, 1);
      gate.finish();
      assertValid(await jobs[1 - canceled]);
      assert.deepEqual(
        requests.map(({ kind }) => kind),
        ["layout", "edit"],
      );
      assert.equal(requests[1].body.run_id, JOBS[1 - canceled].run_id);
    },
  );
}

test(
  "the last cancellation aborts the read and a later job can start fresh",
  { timeout: 5000 },
  async (t) => {
    const gate = heldReply();
    let reads = 0;
    const { requests } = harness(t, (request) => (++reads === 1 ? gate.hold(request) : layout));
    const controller = new AbortController();
    const store = storeOf();
    const job = tailorResume(store, JOBS[0], { signal: controller.signal });
    const upstream = await gate.reached;
    const abort = assert.rejects(job, { name: "AbortError" });
    controller.abort();
    await abort;
    assert.equal(upstream.signal.aborted, true);
    assertValid(await tailorResume(store, JOBS[1]));
    assert.deepEqual(
      requests.map(({ kind }) => kind),
      ["layout", "layout", "edit"],
    );
  },
);

test("a failed reader's run error does not fail the waiting job", { timeout: 5000 }, async (t) => {
  const gate = heldReply();
  let reads = 0;
  const { requests } = harness(t, (request) => (++reads === 1 ? gate.hold(request) : layout));
  const store = storeOf();
  const first = tailorResume(store, JOBS[0]);
  const failure = assert.rejects(first, { code: "cap" });
  await gate.reached;
  const waiter = observeWaiter(t);
  const second = tailorResume(store, JOBS[1], { signal: waiter.controller.signal });
  await waiter.joined;
  gate.finish(Response.json({ error: "cap", task: "resume_tailor" }, { status: 429 }));
  await failure;
  assertValid(await second);
  assert.deepEqual(
    requests.map(({ kind, body }) => [kind, body.run_id]),
    [
      ["layout", JOBS[0].run_id],
      ["layout", JOBS[1].run_id],
      ["edit", JOBS[1].run_id],
    ],
  );
});

for (const separate of ["resume", "account", "own key"]) {
  test(
    "an overlapping " + separate + " does not join the Worker reading",
    { timeout: 5000 },
    async (t) => {
      const firstGate = heldReply(),
        secondGate = heldReply();
      let reads = 0;
      const { local, requests } = harness(t, (request) =>
        ++reads === 1 ? firstGate.hold(request) : secondGate.hold(request),
      );
      const first = tailorResume(storeOf(), JOBS[0]);
      const original = await firstGate.reached;
      const otherStore = storeOf(separate === "resume" ? "changed@example.invalid" : undefined);
      if (separate === "account") local[SESSION_KEY] = session("b");
      if (separate === "own key")
        otherStore.ai = { provider: "anthropic", apiKey: "synthetic-fixture-key" };
      const second = tailorResume(otherStore, JOBS[1]);
      const independent = await secondGate.reached;
      assert.equal(requests.length, 2);
      assert.equal(independent.worker, separate !== "own key");
      if (separate === "resume")
        assert.notDeepEqual(original.body.request, independent.body.request);
      if (separate === "account")
        assert.notEqual(original.authorization, independent.authorization);
      const firstOutcome =
        separate === "account" ? assert.rejects(first, { code: "auth" }) : first.then(assertValid);
      firstGate.finish();
      secondGate.finish();
      await firstOutcome;
      assertValid(await second);
      assert.equal(
        requests.filter(({ kind }) => kind === "edit").length,
        separate === "account" ? 1 : 2,
      );
      if (separate === "account")
        assert.equal(
          requests.find(({ kind }) => kind === "edit").authorization,
          independent.authorization,
        );
    },
  );
}

test(
  "a bound edit checks the live session without waiting on legacy auth",
  { timeout: 5000 },
  async (t) => {
    const gate = heldReply();
    const { requests, local } = harness(t, gate.hold);
    const reading = Promise.withResolvers(),
      release = Promise.withResolvers();
    const getLocal = chrome.storage.local.get;
    let holdSession = false,
      legacyReads = 0;
    t.mock.method(chrome.storage.local, "get", async (keys) => {
      if (holdSession && keys === SESSION_KEY) {
        holdSession = false;
        reading.resolve();
        await release.promise;
      }
      return getLocal(keys);
    });
    t.mock.method(chrome.storage.session, "get", async () => {
      legacyReads++;
      return {};
    });
    const tailoring = tailorResume(storeOf(), JOBS[0]);
    const rejected = assert.rejects(tailoring, { code: "auth" });
    await gate.reached;
    holdSession = true;
    gate.finish();
    await reading.promise;
    local[SESSION_KEY] = session("b");
    release.resolve();
    await rejected;
    assert.equal(legacyReads, 0);
    assert.deepEqual(
      requests.map(({ kind }) => kind),
      ["layout"],
    );
  },
);

for (const replaced of [false, true]) {
  test(
    "a bound rate retry " +
      (replaced ? "stops after session replacement" : "continues with the same live session"),
    { timeout: 5000 },
    async (t) => {
      const gate = heldReply();
      let reads = 0;
      const { requests, local } = harness(t, (request) =>
        ++reads === 1 ? gate.hold(request) : layout,
      );
      const tailoring = tailorResume(storeOf(), JOBS[0]);
      const outcome = replaced
        ? assert.rejects(tailoring, { code: "auth" })
        : tailoring.then(assertValid);
      const initial = await gate.reached;
      if (replaced) local[SESSION_KEY] = session("b");
      gate.finish(Response.json({ error: "rate", retry_after: 0.001 }, { status: 429 }));
      await outcome;
      assert.deepEqual(
        requests.map(({ kind }) => kind),
        replaced ? ["layout"] : ["layout", "layout", "edit"],
      );
      assert.ok(requests.every(({ authorization }) => authorization === initial.authorization));
    },
  );
}

test(
  "legacy auth keeps its original unbound layout behavior when the job is paused",
  { timeout: 5000 },
  async (t) => {
    const gate = heldReply();
    const { requests, local } = harness(t, gate.hold);
    delete local[SESSION_KEY];
    const payload = Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url");
    const legacy = "fixture." + payload + ".fixture";
    t.mock.method(chrome.storage.session, "get", async (key) => ({ [key]: { token: legacy } }));
    const controller = new AbortController();
    const tailoring = tailorResume(storeOf(), JOBS[0], { signal: controller.signal });
    const original = await gate.reached;
    assert.equal(original.signal, undefined);
    controller.abort();
    gate.finish();
    assertValid(await tailoring);
    assert.deepEqual(
      requests.map(({ kind, authorization }) => [kind, authorization]),
      [
        ["layout", "Bearer " + legacy],
        ["edit", "Bearer " + legacy],
      ],
    );
  },
);
