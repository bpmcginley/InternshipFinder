import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { CLOCK_CRON, startCatchup } from "../src/clock.js";

test("the clock starts Keep schedule on GitHub with the token, and only the status is kept", async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
  assert.deepEqual(await startCatchup({ GITHUB_DISPATCH_TOKEN: "ghp_test" }, fake), { started: true });
  assert.equal(calls[0].url, "https://api.github.com/repos/bpmcginley/InternshipFinder/actions/workflows/catchup.yml/dispatches");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer ghp_test");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main" });

  const refused = await startCatchup({ GITHUB_DISPATCH_TOKEN: "ghp_test" }, async () => new Response("{}", { status: 403 }));
  assert.deepEqual(refused, { started: false, why: "HTTP 403" });
});

test("without the secret the clock does nothing", async () => {
  let called = false;
  const r = await startCatchup({}, async () => { called = true; return new Response(null, { status: 204 }); });
  assert.equal(called, false);
  assert.equal(r.started, false);
});

test("the half-hourly trigger runs the clock and not the daily cleanup", async () => {
  const pending = [];
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(null, { status: 204 }); };
  try {
    // No DB in env: the daily cleanup would throw if it ran.
    worker.scheduled({ cron: CLOCK_CRON }, { GITHUB_DISPATCH_TOKEN: "t" }, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(urls.length, 1);
  assert.match(urls[0], /catchup\.yml\/dispatches$/);
});
