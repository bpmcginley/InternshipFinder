import assert from "node:assert/strict";
import { fundedProviderResponse as boundary } from "../src/funded-provider.js";
import { reserveFirstFundedRun } from "../src/funded-run-admission.js";
const userHash = "a".repeat(64),
  limits = { maxBytes: 8192, maxEventBytes: 4096, deadlineMs: 5000 };
const encoder = new TextEncoder();
const answer = (text = "fixture", extra = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
  ...extra,
});
const frame = (data) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const stored = (db) => db.prepare("SELECT state FROM funded_run_calls").first();
async function setup(db) {
  await db.batch(
    ["runs", "usage", "budget", "spend", "event_counts"].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  const input = {
    userHash,
    task: "autofill",
    runId: "fixture",
    allowance: 2,
    maxCalls: 3,
    estimate: 6,
    accountCeiling: 100,
    monthBudget: 100,
    dayBudget: 100,
    freeTier: true,
  };
  const result = await reserveFirstFundedRun(db, input);
  assert.equal(result.status, "reserved");
  return {
    db,
    identity: { ...input, ...result },
    limits,
    price: () => 2,
    model: "fixture-model",
    headers: {
      "Content-Type": "application/json",
      "X-InternScout-Model": "fixture-model",
      "X-InternScout-Remaining": "1",
    },
  };
}
const used = async (db) => (await db.prepare("SELECT units FROM usage").first()).units;
const budget = async (db) =>
  (await db.prepare("SELECT spend_cents FROM budget").first()).spend_cents;
export async function fundedJsonCommitsBeforeExactExposure(db) {
  const options = await setup(db),
    raw = " \n" + JSON.stringify(answer("fixture å")) + "\n";
  let calls = 0;
  const result = await boundary({
    ...options,
    send: async () => {
      calls++;
      return new Response(raw);
    },
  });
  assert.equal(calls, 1);
  assert.equal((await db.prepare("SELECT accepted FROM funded_runs").first()).accepted, 1);
  assert.equal(await result.response.text(), raw);
  assert.deepEqual(
    Object.fromEntries(result.response.headers),
    Object.fromEntries(new Headers(options.headers)),
  );
  await result.completion;
  assert.equal(await budget(db), 2);
  assert.equal(await stored(db), null);
  assert.equal(await used(db), 1);
  assert.equal(
    (await db.prepare("SELECT n FROM event_counts WHERE event='first_autofill'").first()).n,
    1,
  );
}
export async function fundedProviderDefiniteFailureVersusUncertainty(db) {
  for (const [send, restored] of [
    [async () => new Response("rejected", { status: 429 }), true],
    [
      async () => {
        throw Error("synthetic transport lost");
      },
      false,
    ],
    [async () => new Response("not JSON"), false],
    [async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })), true],
    [async () => new Response("{}"), false],
    [async () => new Response(new Uint8Array([255])), false],
  ]) {
    const options = await setup(db);
    await assert.rejects(
      () => boundary({ ...options, send }),
      (e) => e.code === "upstream" && !e.message.includes("synthetic"),
    );
    assert.equal(await used(db), restored ? 0 : 1);
    assert.equal(await budget(db), restored ? 0 : 6);
    assert.equal((await stored(db))?.state, restored ? undefined : "reserved");
  }
}
export async function fundedAcceptanceFailureNeverExposesOrRefunds(db) {
  const options = await setup(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_accept_abort BEFORE UPDATE OF accepted ON funded_runs BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  await assert.rejects(
    () => boundary({ ...options, send: async () => new Response(JSON.stringify(answer())) }),
    (e) => e.code === "busy",
  );
  assert.equal(await budget(db), 6);
  assert.equal((await stored(db)).state, "reserved");
  await db.prepare("DROP TRIGGER fixture_accept_abort").run();
  const unknown = {
    prepare: db.prepare.bind(db),
    batch: async (list) => {
      await db.batch(list);
      throw Error("lost acknowledgment");
    },
  };
  await assert.rejects(
    () =>
      boundary({
        ...options,
        db: unknown,
        send: async () => new Response(JSON.stringify(answer())),
      }),
    (e) => e.code === "busy",
  );
  assert.equal(await budget(db), 6);
  assert.equal((await stored(db)).state, "accepted");
}
export async function fundedSseWaitsForCompleteUsableEvent(db) {
  const options = await setup(db);
  let controller,
    finished = false;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const content = frame(answer("fixture å")),
    bytes = encoder.encode(": keepalive\r\n\r\n" + content);
  const responsePromise = boundary({
    ...options,
    stream: true,
    headers: {
      ...options.headers,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
    send: async () => new Response(stream),
  }).then((v) => {
    finished = true;
    return v;
  });
  controller.enqueue(bytes.slice(0, bytes.length - 1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, false);
  assert.equal((await stored(db)).state, "reserved");
  controller.enqueue(bytes.slice(bytes.length - 1));
  const result = await responsePromise;
  assert.equal((await stored(db)).state, "accepted");
  controller.close();
  assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), bytes);
  await result.completion;
  assert.equal(await budget(db), 2);
  assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(result.response.headers.get("Cache-Control"), "no-cache");
}
export async function fundedSseToolAndInterruptedUsage(db) {
  const options = await setup(db);
  const content =
    frame({
      candidates: [{ content: { parts: [{ thought: true, text: "private reasoning" }] } }],
    }) +
    frame({
      candidates: [
        { content: { parts: [{ functionCall: { name: "fixtureTool", args: { value: 1 } } }] } },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
    });
  let controller;
  const source = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode(content));
    },
  });
  const result = await boundary({
    ...options,
    stream: true,
    send: async () => new Response(source),
  });
  assert.equal((await stored(db)).state, "accepted");
  const reader = result.response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), content);
  controller.error(Error("synthetic interrupted"));
  await assert.rejects(() => reader.read());
  await result.completion;
  assert.equal(await budget(db), 6);
  assert.equal((await stored(db)).state, "accepted");
}
export async function fundedSseEmptyAndIncompleteNeverPretendAccepted(db) {
  for (const [raw, restored] of [
    [frame({ promptFeedback: { blockReason: "SAFETY" } }), true],
    ['data: {"candidates":[]}', false],
    [": keepalive\n\n", false],
    [
      frame({
        candidates: [
          { content: { parts: [{ thought: true, text: "reasoning" }] }, finishReason: "STOP" },
        ],
      }),
      true,
    ],
  ]) {
    const options = await setup(db);
    await assert.rejects(
      () => boundary({ ...options, stream: true, send: async () => new Response(raw) }),
      (e) => e.code === "upstream",
    );
    assert.equal(await budget(db), restored ? 0 : 6);
    assert.equal(await used(db), restored ? 0 : 1);
  }
}
export async function fundedBodyBoundsAndDeadlineAreConservative(db) {
  for (const stream of [false, true]) {
    const options = await setup(db);
    const raw = stream ? frame(answer("x".repeat(9000))) : JSON.stringify(answer("x".repeat(9000)));
    await assert.rejects(() =>
      boundary({ ...options, stream, send: async () => new Response(raw) }),
    );
    assert.equal(await budget(db), 6);
  }
  const eventBound = await setup(db);
  await assert.rejects(
    () =>
      boundary({
        ...eventBound,
        stream: true,
        send: async () => new Response(frame(answer("x".repeat(5000)))),
      }),
    (e) => e.code === "upstream",
  );
  assert.equal(await budget(db), 6);
  const options = await setup(db);
  let timer,
    cancelled = false;
  const source = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const pending = boundary({
    ...options,
    stream: true,
    send: async () => new Response(source),
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  await Promise.resolve();
  timer();
  await assert.rejects(
    () => pending,
    (e) => e.code === "upstream",
  );
  assert.equal(cancelled, true);
  assert.equal(await budget(db), 6);
}
export async function fundedExpiryDuringAcceptanceRetainsCommitWithoutExposure(db) {
  const options = await setup(db);
  let timer;
  const delayed = {
    prepare: db.prepare.bind(db),
    batch: async (list) => {
      const result = await db.batch(list);
      timer();
      return result;
    },
  };
  await assert.rejects(
    () =>
      boundary({
        ...options,
        db: delayed,
        send: async () => new Response(JSON.stringify(answer())),
        setTimer: (fn) => {
          timer = fn;
          return 1;
        },
        clearTimer: () => {},
      }),
    (e) => e.code === "upstream",
  );
  assert.equal((await stored(db)).state, "accepted");
  assert.equal(await budget(db), 6);
}
export async function fundedMeterFailureAndClientCancelKeepEstimate(db) {
  const options = await setup(db);
  const result = await boundary({
    ...options,
    price: () => {
      throw Error("fixture pricing unavailable");
    },
    send: async () => new Response(JSON.stringify(answer())),
  });
  await result.response.text();
  await result.completion;
  assert.equal(await budget(db), 6);
  assert.equal((await stored(db)).state, "accepted");
  const missing = await setup(db);
  const noUsage = await boundary({
    ...missing,
    send: async () => new Response(JSON.stringify(answer("fixture", { usageMetadata: undefined }))),
  });
  await noUsage.response.text();
  await noUsage.completion;
  assert.equal(await budget(db), 6);
  assert.equal((await stored(db)).state, "accepted");
  const next = await setup(db);
  const output = await boundary({
    ...next,
    stream: true,
    send: async () => new Response(frame(answer())),
  });
  await output.response.body.cancel();
  await output.completion;
  assert.equal(await budget(db), 6);
  assert.equal((await stored(db)).state, "accepted");
}
export async function fundedSseUsageTrailerRequiresTerminalOutput(db) {
  for (const extraContent of [false, true]) {
    const options = await setup(db);
    const raw =
      frame(answer("fixture å", { usageMetadata: undefined })) +
      (extraContent
        ? frame({ candidates: [{ content: { parts: [{ text: "still generating" }] } }] })
        : "") +
      frame({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
    const bytes = encoder.encode(raw);
    const source = new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        c.close();
      },
    });
    const result = await boundary({
      ...options,
      stream: true,
      send: async () => new Response(source),
    });
    assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), bytes);
    await result.completion;
    assert.equal(await budget(db), extraContent ? 6 : 2);
    assert.equal((await stored(db))?.state, extraContent ? "accepted" : undefined);
  }
}
