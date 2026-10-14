import test from "node:test";
import assert from "node:assert/strict";
import { callClaude } from "../background/claude.js";
import { callGemini, callWorker } from "../background/gemini.js";
import { abortableSleep } from "../background/abort.js";

const opts = { messages: [{ role: "user", content: "Offline cancellation test" }] };
const clients = [
  ["Claude", (signal) => callClaude({ ...opts, signal, apiKey: "offline-test", model: "claude-sonnet-5" })],
  ["Gemini", (signal) => callGemini({ ...opts, signal, apiKey: "offline-test", model: "gemini-3.8-flash" })],
  ["Worker", (signal) => callWorker({ ...opts, signal, url: "https://offline.example", token: "offline-test", task: "autofill" })],
];
const abortError = () => new DOMException("Canceled by test", "AbortError");
const reply = (status, data = {}) => ({ status, ok: status >= 200 && status < 300,
  headers: { get: () => "" }, json: async () => data });

for (const [name, call] of clients) {
  test(`${name}: an already canceled call never reaches fetch`, async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Should not reach transport"); };
    await assert.rejects(call(controller.signal), { name: "AbortError" });
    assert.equal(calls, 0);
  });

  test(`${name}: fetch AbortError is propagated without retries`, { timeout: 1000 }, async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw abortError(); };
    await assert.rejects(call(), { name: "AbortError" });
    assert.equal(calls, 1);
  });

  for (const failure of ["network", "rate"]) {
    test(`${name}: cancellation interrupts ${failure} retry backoff without another fetch`, { timeout: 1000 }, async () => {
      const controller = new AbortController();
      let calls = 0, timer;
      globalThis.fetch = async () => {
        calls++;
        timer = setTimeout(() => controller.abort(), 10);
        if (failure === "network") throw new Error("Offline transient error");
        return reply(429, { error: "rate", retry_after: 30 });
      };
      try { await assert.rejects(call(controller.signal), { name: "AbortError" }); }
      finally { clearTimeout(timer); }
      assert.equal(calls, 1);
    });
  }

  test(`${name}: cancellation while reading a response cannot become a success`, async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ...reply(200), json: async () => { controller.abort(); throw abortError(); } };
    };
    await assert.rejects(call(controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
  });
}

test("canceling a retry delay removes its timer immediately and keeps the caller's reason", async () => {
  const controller = new AbortController(), reason = new Error("Human took over");
  const pending = abortableSleep(30000, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});
