import assert from "node:assert/strict";
import test from "node:test";
import { callClaude } from "../background/claude.js";
import { callGemini } from "../background/gemini.js";

const options = {
  apiKey: "offline-test",
  messages: [{ role: "user", content: "Synthetic retry check" }],
};
const clients = [
  {
    name: "Gemini",
    call: callGemini,
    model: "gemini-offline",
    authHeader: "x-goog-api-key",
    httpDelays: [2000, 4000, 8000, 16000],
  },
  {
    name: "Claude",
    call: callClaude,
    model: "claude-offline",
    authHeader: "x-api-key",
    httpDelays: [1500, 3000, 6000, 12000],
  },
];
const statuses = [429, 500, 502, 503, 529];
const originalSetTimeout = globalThis.setTimeout;

function capture(t, respond) {
  const delays = [];
  let attempt = 0;
  const fetch = t.mock.method(globalThis, "fetch", async () => respond(++attempt));
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    delays.push(ms);
    return originalSetTimeout(callback, 0);
  });
  return { fetch, delays };
}

for (const { name, call, model, authHeader, httpDelays } of clients) {
  test(`${name} stops waiting after the fifth network failure`, async (t) => {
    const { fetch, delays } = capture(t, () => {
      throw new Error("Synthetic disconnect");
    });
    await assert.rejects(call({ ...options, model }), {
      message: `${name} API unavailable (Synthetic disconnect). Try again shortly.`,
    });
    assert.equal(fetch.mock.callCount(), 5);
    assert.deepEqual(delays, [1500, 3000, 6000, 12000]);
  });

  test(`${name} stops waiting after the fifth retryable HTTP failure`, async (t) => {
    const { fetch, delays } = capture(
      t,
      (attempt) =>
        new Response(null, {
          status: statuses[attempt - 1],
        }),
    );
    await assert.rejects(call({ ...options, model }), {
      message: `${name} API unavailable (529). Try again shortly.`,
    });
    assert.equal(fetch.mock.callCount(), 5);
    assert.deepEqual(delays, httpDelays);
  });

  test(`${name} still surfaces auth errors without retrying`, async (t) => {
    const { fetch, delays } = capture(
      t,
      () =>
        new Response(JSON.stringify({ error: { message: "Synthetic invalid key" } }), {
          status: 401,
        }),
    );
    await assert.rejects(call({ ...options, model }), {
      message: `${name} API 401: Synthetic invalid key`,
    });
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[1].headers[authHeader], options.apiKey);
    assert.deepEqual(delays, []);
  });
}

test("Claude honors Retry-After before a retry and stops waiting after the last response", async (t) => {
  const retryAfter = ["7", null, "2", "3", "45"];
  const { fetch, delays } = capture(
    t,
    (attempt) =>
      new Response(null, {
        status: statuses[attempt - 1],
        headers: retryAfter[attempt - 1] ? { "retry-after": retryAfter[attempt - 1] } : {},
      }),
  );
  await assert.rejects(callClaude({ ...options, model: "claude-offline" }), {
    message: "Claude API unavailable (529). Try again shortly.",
  });
  assert.equal(fetch.mock.callCount(), 5);
  assert.deepEqual(delays, [7000, 3000, 2000, 3000]);
});
