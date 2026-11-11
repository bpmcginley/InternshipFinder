import test from "node:test";
import assert from "node:assert/strict";
import { readSSE, stitchChunks, callWorker, SSE_LIMITS } from "../background/gemini.js";
const encoder = new TextEncoder();
const chunk = (text, finishReason) => ({
  candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
});
const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
function response(text, { step = 7, onCancel = () => {} } = {}) {
  const bytes = typeof text === "string" ? encoder.encode(text) : text;
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (offset === bytes.length) return c.close();
        c.enqueue(bytes.slice(offset, offset + step));
        offset = Math.min(bytes.length, offset + step);
      },
      cancel: onCancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const opts = {
  url: "https://worker.example.test",
  token: "synthetic",
  task: "autofill",
  messages: [{ role: "user", content: "Synthetic" }],
  sleepImpl: async () => {},
};
test("malformed earlier data cannot be discarded in favor of a later STOP", async () => {
  const bad = "data: {broken\n\n" + event(chunk("incomplete", "STOP"));
  await assert.rejects(readSSE(response(bad)), SyntaxError);
  let calls = 0;
  const waits = [];
  const out = await callWorker({
    ...opts,
    sleepImpl: async (n) => waits.push(n),
    fetchImpl: async () =>
      ++calls === 1 ? response(bad) : response(event(chunk("complete", "STOP"))),
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1500]);
  assert.deepEqual(out.content, [{ type: "text", text: "complete" }]);
});
test("malformed data after STOP and unfinished final JSON/events reject the whole answer", async () => {
  const good = event(chunk("earlier", "STOP"));
  for (const tail of [
    "data: {bad}\n\n",
    'data: {"candidates":',
    "data: " + JSON.stringify(chunk("later", "STOP")),
    "data: " + JSON.stringify(chunk("later", "STOP")) + "\n",
  ])
    await assert.rejects(readSSE(response(good + tail)));
});
test("all malformed attempts preserve current four attempts and three waits, never partial content", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    callWorker({
      ...opts,
      fetchImpl: async () => {
        calls++;
        return response("data: nope\n\n" + event(chunk("unsafe", "STOP")));
      },
      sleepImpl: async (ms) => waits.push(ms),
    }),
    (e) => e.code === "upstream",
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1500, 3000, 6000]);
});
test("multiline event JSON, comments, metadata fields, BOM and split UTF-8 preserve content/signatures", async () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const text =
      "\ufeff: heartbeat" +
      newline +
      "event: message" +
      newline +
      "id: fixture" +
      newline +
      'data: {"candidates": [' +
      newline +
      'data: {"content":{"parts":[{"text":"café 😀","thoughtSignature":"SIG"}]},"finishReason":"STOP"}]}' +
      newline +
      newline +
      ": tail" +
      newline +
      "data: [DONE]" +
      newline +
      newline;
    const out = await callWorker({ ...opts, fetchImpl: async () => response(text, { step: 1 }) });
    assert.deepEqual(out.content, [{ type: "text", text: "café 😀", _sig: "SIG" }]);
    assert.equal(out.stop_reason, "end_turn");
  }
});
test("DONE is not a finish reason and later candidate content resets prior completion", async () => {
  const terminal = chunk("first", "STOP"),
    later = chunk("unfinished");
  assert.equal(stitchChunks([terminal, later]).complete, false);
  assert.equal(stitchChunks([terminal, { usageMetadata: { promptTokenCount: 4 } }]).complete, true);
  await assert.rejects(
    readSSE(response(event(terminal) + "data: [DONE]\n\n" + event(later))),
    /after SSE completion/,
  );
  let n = 0;
  const out = await callWorker({
    ...opts,
    fetchImpl: async () =>
      ++n === 1
        ? response(event(terminal) + event(later) + "data: [DONE]\n\n")
        : response(event(chunk("complete", "STOP"))),
  });
  assert.equal(n, 2);
  assert.equal(out.content[0].text, "complete");
});
test("prompt feedback cannot bless candidate content without a terminal marker", async () => {
  let n = 0;
  const out = await callWorker({
    ...opts,
    fetchImpl: async () =>
      ++n === 1
        ? response(event({ ...chunk("partial"), promptFeedback: { blockReason: "SAFETY" } }))
        : response(event(chunk("whole", "STOP"))),
  });
  assert.equal(n, 2);
  assert.equal(out.content[0].text, "whole");
  await assert.rejects(
    callWorker({
      ...opts,
      fetchImpl: async () => response(event({ promptFeedback: { blockReason: "SAFETY" } })),
    }),
    /blocked: SAFETY/,
  );
});
test("finish reasons and thought/tool signatures retain existing semantics", async () => {
  const data = {
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: "hidden" },
            {
              functionCall: { name: "check", args: { ref: "0:e1", checked: false } },
              thoughtSignature: "TOOL",
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };
  const out = await callWorker({ ...opts, fetchImpl: async () => response(event(data)) });
  assert.equal(out.stop_reason, "tool_use");
  assert.equal(out.content.length, 1);
  assert.deepEqual(out.content[0].input, { ref: "0:e1", checked: false });
  assert.equal(out.content[0]._sig, "TOOL");
  const max = await callWorker({
    ...opts,
    fetchImpl: async () => response(event(chunk("bounded", "MAX_TOKENS"))),
  });
  assert.equal(max.stop_reason, "max_tokens");
});
test("invalid UTF-8 and invalid JSON roots fail even if later JSON has STOP", async () => {
  const good = encoder.encode(event(chunk("not accepted", "STOP")));
  for (const bytes of [
    new Uint8Array([100, 97, 116, 97, 58, 32, 0xc3, 10, 10, ...good]),
    new Uint8Array([...encoder.encode(event(chunk("x", "STOP"))), 0xc3]),
  ])
    await assert.rejects(readSSE(response(bytes)), TypeError);
  for (const data of [null, [], 1, "text"])
    await assert.rejects(
      readSSE(response(event(data) + event(chunk("x", "STOP")))),
      /Invalid SSE data/,
    );
});
test("known malformed Gemini containers and error payloads cannot be stitched into an answer", () => {
  for (const bad of [
    { error: { code: 500 } },
    { candidates: {} },
    { candidates: [3] },
    { candidates: [null] },
    { candidates: [{ content: "bad", finishReason: "STOP" }] },
    { candidates: [{ content: { parts: "bad" }, finishReason: "STOP" }] },
    { candidates: [{ content: { parts: [null] }, finishReason: "STOP" }] },
    { candidates: [{ finishReason: {} }] },
  ])
    assert.throws(() => stitchChunks([bad, chunk("later", "STOP")]));
});
test("body and event bounds are byte-exact across transport boundaries and cancel rejected readers", async () => {
  const text = event({ text: "é" }),
    size = encoder.encode(text).length;
  assert.deepEqual(
    await readSSE(response(text, { step: 1 }), { maxBytes: size, maxEventBytes: size }),
    [{ text: "é" }],
  );
  let canceled = 0;
  await assert.rejects(
    readSSE(response(text + ": keep\n\n", { step: 1, onCancel: () => canceled++ }), {
      maxBytes: size,
      maxEventBytes: size,
    }),
    /body too large/,
  );
  assert.equal(canceled, 1);
  await assert.rejects(
    readSSE(response(text, { step: 1 }), { maxBytes: size, maxEventBytes: size - 1 }),
    /event too large/,
  );
  await assert.rejects(
    readSSE(response(":".repeat(size), { step: 1 }), { maxBytes: size, maxEventBytes: size - 1 }),
    /event too large/,
  );
  await assert.rejects(
    readSSE(response('data: {\ndata: "text":"' + "x".repeat(size), { step: 1 }), {
      maxBytes: 200,
      maxEventBytes: size,
    }),
    /event too large/,
  );
});
test("one transport chunk containing many bounded events is accepted and missing streaming body fails closed", async () => {
  const text = event({ a: 1 }).repeat(20);
  assert.equal(
    (await readSSE(response(text, { step: 10000 }), { maxBytes: 1000, maxEventBytes: 20 })).length,
    20,
  );
  let called = false;
  await assert.rejects(
    readSSE({
      text: async () => {
        called = true;
        return text;
      },
    }),
    /Missing SSE reader/,
  );
  assert.equal(called, false);
  assert.deepEqual(SSE_LIMITS, { maxBytes: 4 * 1024 * 1024, maxEventBytes: 1024 * 1024 });
  await assert.rejects(readSSE(response(text), { maxBytes: 0 }), /limits/);
});
test("abort cancels a stalled reader promptly and preserves the exact reason without retry", async () => {
  const ctl = new AbortController(),
    reason = new DOMException("Synthetic cancel", "AbortError");
  let canceled = 0,
    calls = 0,
    waits = 0;
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      canceled++;
    },
  });
  const pending = callWorker({
    ...opts,
    signal: ctl.signal,
    fetchImpl: async () => {
      calls++;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
    sleepImpl: async () => waits++,
  });
  await new Promise((r) => setTimeout(r, 0));
  ctl.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  assert.equal(calls, 1);
  assert.equal(waits, 0);
  assert.equal(canceled, 1);
});

test("ignored reader cancellation cannot hold the caller or consume a late response", async () => {
  const ctl = new AbortController(),
    reason = new DOMException("Stopped", "AbortError");
  let finish,
    reads = 0,
    cancellations = 0;
  const res = {
    body: {
      getReader: () => ({
        read: () => {
          reads++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        cancel: () => {
          cancellations++;
          return new Promise(() => {});
        },
        releaseLock() {},
      }),
    },
  };
  const pending = readSSE(res, { signal: ctl.signal });
  ctl.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  finish({ done: false, value: encoder.encode(event(chunk("late", "STOP"))) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 1);
  assert.ok(cancellations >= 1);
});
