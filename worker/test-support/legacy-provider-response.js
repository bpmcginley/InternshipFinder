import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { CONFIG } from "../src/config.js";
import { createSession } from "../src/session.js";
import { boundLegacySSE, LEGACY_SSE_LIMITS } from "../src/legacy-provider-response.js";
import { costCents } from "../src/gemini.js";
const user = "a".repeat(64);
const raw = JSON.stringify({
  candidates: [{ content: { parts: [{ text: "synthetic answer" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
});
async function setup(db, mode = "legacy", patch = {}) {
  await db.batch(
    [
      "runs",
      "usage",
      "bonus",
      "budget",
      "spend",
      "rate",
      "forget",
      "sessions",
      "plans",
      "event_counts",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  const now = new Date(),
    pending = [];
  const session = await createSession(db, { user, tier: "edu", provider: "google" }, now);
  const env = {
    DB: db,
    GEMINI_API_KEY: crypto.randomUUID(),
    FUNDED_RESPONSE_MAX_BYTES: "16384",
    FUNDED_RESPONSE_EVENT_BYTES: "8192",
    FUNDED_RESPONSE_DEADLINE_MS: "5000",
    ...(mode ? { FUNDED_RUNS_MODE: mode } : {}),
  };
  const config = {
    ...CONFIG,
    TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, allowance: 2 } },
    MAX_CALLS_PER_RUN: 2,
    USER_BUDGET_CENTS: { free: 1000 },
    MONTHLY_BUDGET_CENTS: 10000,
    DAILY_BUDGET_CENTS: 1000,
    ...patch,
  };
  let calls = 0,
    provider = async (_url, init) => new Response(init.body && raw);
  const api = async (runId = "fixture", stream = false, bodyPatch = {}, token = session.token) =>
    handle(
      new Request("https://internscout.test/ai" + (stream ? "?stream=1" : ""), {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          task: "autofill",
          run_id: runId,
          request: { contents: [{ role: "user", parts: [{ text: "synthetic input" }] }] },
          ...bodyPatch,
        }),
      }),
      env,
      { waitUntil: (p) => pending.push(p) },
      {
        now: () => now,
        config,
        fetch: async (url, init) => {
          assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\//);
          calls++;
          return provider(url, init);
        },
      },
    );
  const flush = async () => {
    await Promise.all(pending.splice(0));
  };
  const consume = async (response) => {
    const text = await response.text();
    await flush();
    return text;
  };
  return {
    env,
    config,
    now,
    api,
    flush,
    consume,
    calls: () => calls,
    provider: (fn) => {
      provider = fn;
    },
  };
}

const encoder = new TextEncoder();
const frame = `data: ${raw}\r\n\r\n`;
const spend = async (db) =>
  (await db.prepare("SELECT spend_cents FROM budget").first()).spend_cents;
const counted = async (db) =>
  (
    await db
      .prepare("SELECT COALESCE(SUM(n),0) n FROM event_counts WHERE event='first_autofill'")
      .first()
  ).n;
function response(chunks, { error = false, cancel = () => {}, next = async () => {} } = {}) {
  let index = 0;
  return new Response(
    new ReadableStream(
      {
        async pull(controller) {
          if (index > 0) await next();
          if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
          else if (error) controller.error(new Error("synthetic upstream"));
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9);
const price = (w) =>
  costCents(w.config.TASKS.autofill.model, JSON.parse(raw).usageMetadata, w.config, w.now);
export async function legacyExactBytesAndLimitBoundaries(db) {
  const cap = LEGACY_SSE_LIMITS.maxEventBytes;
  for (const size of [cap - 1, cap, cap + 1]) {
    const w = await setup(db);
    const comment = ":" + "x".repeat(size - 3) + "\n\n";
    let cancelled = 0;
    const body = comment + frame;
    w.provider(() => response([body], { cancel: () => cancelled++ }));
    const r = await w.api("fixture", true);
    const estimate = await spend(db);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "text/event-stream");
    assert.equal(r.headers.get("Cache-Control"), "no-cache");
    assert.equal(r.headers.get("X-InternScout-Model"), w.config.TASKS.autofill.model);
    assert.equal(r.headers.get("X-InternScout-Remaining"), "1");
    if (size > cap) {
      await assert.rejects(
        () => r.text(),
        (e) => e.code === "upstream",
      );
      await w.flush();
      assert.equal(await spend(db), estimate);
      assert.equal(cancelled, 1);
    } else {
      assert.equal(await r.text(), body);
      await w.flush();
      close(await spend(db), price(w));
    }
    assert.equal(await counted(db), 1);
    assert.equal(w.calls(), 1);
  }
}
export async function legacyExactBodyCeiling(db) {
  const cap = LEGACY_SSE_LIMITS.maxBytes;
  for (const size of [cap - 1, cap, cap + 1]) {
    const w = await setup(db),
      remaining = size - encoder.encode(frame).length;
    const body = ":x\n\n".repeat(Math.floor(remaining / 4)) + "\n".repeat(remaining % 4) + frame;
    assert.equal(encoder.encode(body).length, size);
    w.provider(() => response([body]));
    const r = await w.api("fixture", true),
      estimate = await spend(db);
    if (size > cap) {
      await assert.rejects(() => r.text());
      await w.flush();
      assert.equal(await spend(db), estimate);
    } else {
      assert.equal(await r.text(), body);
      await w.flush();
      close(await spend(db), price(w));
    }
    assert.equal(await counted(db), 1);
  }
}
export async function legacyLateCutoffDiscardsProvisionalUsage(db) {
  const w = await setup(db),
    bad = ":".repeat(LEGACY_SSE_LIMITS.maxEventBytes + 1);
  let cancelled = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  w.provider(() => response([frame, bad], { cancel: () => cancelled++, next: () => gate }));
  const r = await w.api("fixture", true),
    estimate = await spend(db),
    reader = r.body.getReader();
  assert.deepEqual((await reader.read()).value, encoder.encode(frame));
  release();
  await assert.rejects(
    () => reader.read(),
    (e) => e.code === "upstream",
  );
  await w.flush();
  assert.equal(await spend(db), estimate);
  assert.equal(await counted(db), 1);
  assert.equal(cancelled, 1);
  assert.equal(w.calls(), 1);
}
export async function legacyOrdinaryReadErrorRetainsSettlement(db) {
  for (const chunks of [[], [frame]]) {
    const w = await setup(db);
    w.provider(() => response(chunks, { error: true }));
    const r = await w.api("fixture", true),
      estimate = await spend(db);
    await assert.rejects(() => r.text());
    await w.flush();
    close(await spend(db), chunks.length ? price(w) : estimate);
    assert.equal(await counted(db), 1);
  }
}
export async function legacyClientCancelStillLetsMeterFinish(db) {
  const w = await setup(db);
  w.provider(() => response([": prelude\n\n", frame]));
  const r = await w.api("fixture", true);
  await r.body.cancel();
  await w.flush();
  close(await spend(db), price(w));
  assert.equal(await counted(db), 1);
  assert.equal(w.calls(), 1);
}
export async function legacyJsonPathUnchanged(db) {
  const w = await setup(db),
    data = raw.replace("synthetic answer", "x".repeat(LEGACY_SSE_LIMITS.maxEventBytes + 1));
  w.provider(() => new Response(data));
  const r = await w.api("fixture", false);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), data);
  await w.flush();
  close(await spend(db), price(w));
  assert.equal(await counted(db), 1);
}
export async function legacySplitFramingAndDirectCancellation() {
  const raw = "\ufeff\r\n: å🙂\r\n\r\n" + frame;
  const bytes = encoder.encode(raw);
  let offset = 0;
  const guarded = boundLegacySSE(
    new ReadableStream(
      {
        pull(c) {
          if (offset < bytes.length) c.enqueue(bytes.slice(offset, ++offset));
          else c.close();
        },
      },
      { highWaterMark: 0 },
    ),
  );
  assert.deepEqual(new Uint8Array(await new Response(guarded.body).arrayBuffer()), bytes);
  assert.equal(await guarded.completed, "complete");
  let cancelled = 0;
  const pending = boundLegacySSE(
    new ReadableStream(
      {
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  await pending.body.cancel();
  assert.equal(await pending.completed, "interrupted");
  await Promise.resolve();
  assert.equal(cancelled, 1);
}

export async function legacyCutoffStopsFurtherReads() {
  const chunk = encoder.encode(":" + "x".repeat(65533) + "\n\n");
  let reads = 0,
    cancelled = 0;
  const guarded = boundLegacySSE(
    new ReadableStream(
      {
        pull(c) {
          reads++;
          c.enqueue(chunk);
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const reader = guarded.body.getReader();
  let exposed = 0;
  await assert.rejects(async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      exposed += r.value.length;
    }
  });
  assert.equal(exposed, LEGACY_SSE_LIMITS.maxBytes);
  assert.equal(reads, 65);
  assert.equal(cancelled, 1);
  assert.equal(await guarded.completed, "limited");
}
export async function legacyCancelPendingReadDoesNotAwaitUpstream() {
  let rejectRead,
    started,
    cancelled = 0,
    released = 0;
  const pending = new Promise((_, reject) => {
    rejectRead = reject;
  });
  const reached = new Promise((resolve) => {
    started = resolve;
  });
  const guarded = boundLegacySSE({
    getReader: () => ({
      read() {
        started();
        return pending;
      },
      cancel() {
        cancelled++;
        return new Promise(() => {});
      },
      releaseLock() {
        released++;
      },
    }),
  });
  const reader = guarded.body.getReader();
  const read = reader.read();
  await reached;
  await reader.cancel();
  assert.equal(await guarded.completed, "interrupted");
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  rejectRead(new Error("synthetic late read rejection"));
  assert.equal((await read).done, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(released, 2);
}
