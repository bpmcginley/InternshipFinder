import test from "node:test";
import assert from "node:assert/strict";
import { aiBody, setup } from "./helpers.js";
import { FLASH, FLASH_LITE } from "../src/config.js";
import { GLOBAL_USER } from "../src/limits.js";

const me = async (w, token) => (await w.api("GET", "/me", { token })).json();
const geminiCalls = (w) => w.fetch.calls.filter((c) => c.url.includes("generativelanguage"));

test("allowance counts distinct (task, run_id) and blocks at the cap", async () => {
  const w = await setup();
  const token = await w.token();
  let res = await w.api("POST", "/ai", { token, body: aiBody("deep_dive", "run-a") });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-InternScout-Model"), FLASH);
  assert.equal(res.headers.get("X-InternScout-Remaining"), "1");
  res = await w.api("POST", "/ai", { token, body: aiBody("deep_dive", "run-a") });
  assert.equal(res.headers.get("X-InternScout-Remaining"), "1");
  assert.equal((await me(w, token)).allowance.deep_dive.used, 1);

  res = await w.api("POST", "/ai", { token, body: aiBody("deep_dive", "run-b") });
  assert.equal(res.headers.get("X-InternScout-Remaining"), "0");
  assert.equal((await me(w, token)).allowance.deep_dive.used, 2);

  res = await w.api("POST", "/ai", { token, body: aiBody("deep_dive", "run-c") });
  assert.equal(res.status, 429);
  const err = await res.json();
  assert.equal(err.error, "cap");
  assert.equal(err.task, "deep_dive");
  assert.equal(err.resets, "2026-10-01");

  // an already-counted run may keep going; other tasks have their own allowance
  assert.equal((await w.api("POST", "/ai", { token, body: aiBody("deep_dive", "run-a") })).status, 200);
  assert.equal((await w.api("POST", "/ai", { token, body: aiBody("autofill", "run-c") })).status, 200);
});

test("missing run_id: every call is its own unit", async () => {
  const w = await setup();
  const token = await w.token();
  for (let i = 0; i < 2; i++) {
    const res = await w.api("POST", "/ai", { token, body: aiBody("field_match") });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-InternScout-Model"), FLASH_LITE);
  }
  assert.equal((await me(w, token)).allowance.field_match.used, 2);
});

test("MAX_CALLS_PER_RUN caps one run", async () => {
  const w = await setup({ config: { MAX_CALLS_PER_RUN: 3 } });
  const token = await w.token();
  for (let i = 0; i < 3; i++) {
    assert.equal((await w.api("POST", "/ai", { token, body: aiBody("autofill", "long-run") })).status, 200);
  }
  const res = await w.api("POST", "/ai", { token, body: aiBody("autofill", "long-run") });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "cap");
  assert.equal((await me(w, token)).allowance.autofill.used, 1);
});

test("rate limit: 10 per minute, then per day", async () => {
  const w = await setup();
  const token = await w.token();
  for (let i = 0; i < 10; i++) {
    assert.equal((await w.api("POST", "/ai", { token, body: aiBody("field_match", "r" + i) })).status, 200);
  }
  let res = await w.api("POST", "/ai", { token, body: aiBody("field_match", "r10") });
  assert.equal(res.status, 429);
  const err = await res.json();
  assert.equal(err.error, "rate");
  assert.equal(err.retry_after, 30);
  assert.equal(geminiCalls(w).length, 10);

  w.setNow(new Date("2026-09-14T10:06:01Z"));
  assert.equal((await w.api("POST", "/ai", { token, body: aiBody("field_match", "r10") })).status, 200);

  const d = await setup({ config: { RATE: { perMinute: 100, perDay: 3 } } });
  const t2 = await d.token();
  for (let i = 0; i < 3; i++) await d.api("POST", "/ai", { token: t2, body: aiBody("field_match") });
  res = await d.api("POST", "/ai", { token: t2, body: aiBody("field_match") });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).retry_after, 13 * 3600 + 54 * 60 + 30);
});

test("a global stampede turns away a student who is inside their own limit", async () => {
  const w = await setup({ config: { RATE: { perMinute: 100, perDay: 300, globalPerMinute: 3 } } });
  const busy = await w.token({ sub: "busy-student" });
  const other = await w.token({ sub: "other-student" });
  for (let i = 0; i < 3; i++) {
    assert.equal((await w.api("POST", "/ai", { token: busy, body: aiBody("field_match", "r" + i) })).status, 200);
  }
  // the second student has used none of their own 100/min, so this can only be the global ceiling
  const res = await w.api("POST", "/ai", { token: other, body: aiBody("field_match", "r0") });
  assert.equal(res.status, 503);
  const err = await res.json();
  assert.equal(err.error, "busy");          // not "rate": it is not this student's doing
  assert.equal(err.retry_after, 30);
  assert.equal(geminiCalls(w).length, 3);   // the refusal never reached Gemini

  // being turned away must not have cost them any allowance
  assert.equal((await me(w, other)).allowance.field_match.used, 0);
  w.setNow(new Date("2026-09-14T10:06:01Z"));
  assert.equal((await w.api("POST", "/ai", { token: other, body: aiBody("field_match", "r0") })).status, 200);
});

test("GLOBAL_RPM overrides config, and no configured ceiling means no global limit", async () => {
  const w = await setup({ env: { GLOBAL_RPM: "1" }, config: { RATE: { perMinute: 100, perDay: 300, globalPerMinute: 500 } } });
  const token = await w.token();
  assert.equal((await w.api("POST", "/ai", { token, body: aiBody("field_match", "a") })).status, 200);
  assert.equal((await w.api("POST", "/ai", { token, body: aiBody("field_match", "b") })).status, 503);

  // RATE without globalPerMinute must not become a NaN compare that silently never fires
  const n = await setup({ config: { RATE: { perMinute: 100, perDay: 300 } } });
  const t2 = await n.token();
  for (let i = 0; i < 5; i++) {
    assert.equal((await n.api("POST", "/ai", { token: t2, body: aiBody("field_match", "r" + i) })).status, 200);
  }
});

test("budget reached -> 503 paused, and Gemini is not called", async () => {
  const w = await setup();
  await w.db.prepare("INSERT INTO budget (month, spend_cents) VALUES ('2026-09', 2500)").run();
  const token = await w.token();
  const res = await w.api("POST", "/ai", { token, body: aiBody() });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "paused");
  assert.equal(geminiCalls(w).length, 0);
  assert.equal((await (await w.api("GET", "/config")).json()).paused, true);
  assert.equal((await me(w, token)).paused, true);

  const zero = await setup({ env: { MONTHLY_BUDGET_CENTS: "0" } });
  assert.equal((await zero.api("POST", "/ai", { token: await zero.token(), body: aiBody() })).status, 503);
});

test("each call's usage is priced and added to the month's budget", async () => {
  const w = await setup();
  const token = await w.token();
  await w.api("POST", "/ai", { token, body: aiBody("resume_tailor", "x") });
  // 1000 input * $0.75 + 300 output (incl. thinking) * $3.75, per 1M tokens, in cents
  const expected = ((1000 * 0.75 + 300 * 3.75) / 1e6) * 100;
  const { spend_cents } = await w.db.prepare("SELECT spend_cents FROM budget WHERE month = '2026-09'").first();
  assert.ok(Math.abs(spend_cents - expected) < 1e-9, `${spend_cents} vs ${expected}`);
});

test("?stream=1 passes SSE through and still records spend", async () => {
  const w = await setup();
  const token = await w.token();
  const res = await w.api("POST", "/ai?stream=1", { token, body: aiBody("short_answer", "s1") });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  const text = await res.text();
  assert.match(text, /Hello /);
  assert.match(text, /world/);
  assert.ok(geminiCalls(w)[0].url.endsWith(":streamGenerateContent?alt=sse"));
  const { spend_cents } = await w.db.prepare("SELECT spend_cents FROM budget").first();
  assert.ok(Math.abs(spend_cents - ((1000 * 0.3 + 300 * 2.5) / 1e6) * 100) < 1e-9);
});

test("Gemini failure -> 502 upstream and no unit is charged", async () => {
  const w = await setup({ gemini: () => Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 }) });
  const token = await w.token();
  const res = await w.api("POST", "/ai", { token, body: aiBody("resume_tailor", "x") });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "upstream");
  assert.equal((await me(w, token)).allowance.resume_tailor.used, 0);
  assert.equal(w.db.dump().runs.length, 0);
});

test("bad bodies -> 400", async () => {
  const w = await setup();
  const token = await w.token();
  const status = async (body) => {
    const res = await w.api("POST", "/ai", { token, body });
    return [res.status, (await res.json()).error];
  };
  assert.deepEqual(await status({ task: "write_my_essay", request: { contents: [{}] } }), [400, "bad_task"]);
  assert.deepEqual(await status({ task: "autofill", request: {} }), [400, "bad_request"]);
  assert.deepEqual(await status({ ...aiBody(), run_id: "has spaces!" }), [400, "bad_request"]);
  assert.equal(geminiCalls(w).length, 0);
});

test("the key goes in a header, the model is the server's, the body is cleaned", async () => {
  const w = await setup();
  const body = aiBody("autofill", "k");
  body.request.model = "gemini-3.1-pro-preview";
  body.request.safetySettings = [];
  body.request.generationConfig = { maxOutputTokens: 100000, thinkingConfig: { thinkingLevel: "high" } };
  await w.api("POST", "/ai", { token: await w.token(), body });
  const [call] = geminiCalls(w);
  assert.ok(call.url.includes(`/models/${FLASH}:generateContent`));
  assert.ok(!call.url.includes("dummy-test-key"));
  assert.equal(call.init.headers["x-goog-api-key"], "dummy-test-key");
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.model, undefined);
  assert.equal(sent.safetySettings, undefined);
  assert.equal(sent.generationConfig.maxOutputTokens, 4096);
  assert.deepEqual(sent.generationConfig.thinkingConfig, { thinkingLevel: "low" });
});

test("prompt text, email, name and token never reach the DB or the logs", async () => {
  const w = await setup();
  const secret = "SECRET-PROMPT-7f3a my resume says I led the robotics club";
  const token = await w.token();
  const logged = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    saved[k] = console[k];
    console[k] = (...a) => logged.push(a.map(String).join(" "));
  }
  try {
    await w.api("POST", "/ai", { token, body: aiBody("resume_tailor", "p1", secret) });
    await w.api("POST", "/ai?stream=1", { token, body: aiBody("short_answer", "p2", secret) });
    await w.api("POST", "/ai", { token, body: aiBody("field_match", undefined, secret) });
    await w.api("POST", "/demand", { token, body: { states: ["MA"] } });
  } finally {
    Object.assign(console, saved);
  }
  const everything = JSON.stringify(w.db.dump()) + logged.join("\n");
  for (const bad of ["SECRET-PROMPT", "robotics", "Hello", "student@umass.edu", "Test Student", "109876543210", token, token.split(".")[2]]) {
    assert.ok(!everything.includes(bad), `found ${bad.slice(0, 20)}`);
  }
  const dump = w.db.dump();
  assert.equal(dump.usage.length, 3);
  assert.deepEqual(Object.keys(dump.usage[0]).sort(), ["month", "task", "units", "user_hash"]);
  assert.match(dump.usage[0].user_hash, /^[0-9a-f]{64}$/);
});

test("DELETE /me removes this user's rows only", async () => {
  const w = await setup();
  const a = await w.token();
  const b = await w.token({ sub: "other-student" });
  for (const token of [a, b]) {
    await w.api("POST", "/ai", { token, body: aiBody("autofill", "run") });
    await w.api("POST", "/demand", { token, body: { states: ["MA", "NY"] } });
  }
  const before = w.db.dump();
  assert.equal(before.usage.length, 2);
  assert.equal(before.demand.length, 2);

  const res = await w.api("DELETE", "/me", { token: a });
  assert.deepEqual(await res.json(), { ok: true });
  const after = w.db.dump();
  // The deployment-wide rate counter is keyed "*" and holds a call count, not a person. Like budget
  // it is nobody's personal data, so it is not a user's to delete -- exclude it before checking that
  // every per-user row for the deleted student is gone.
  const mine = (rows) => rows.filter((r) => r.user_hash !== GLOBAL_USER);
  for (const t of ["usage", "runs", "rate", "demand"]) {
    const rows = mine(after[t]);
    const users = new Set(rows.map((r) => r.user_hash));
    assert.equal(users.size, 1, t);
    assert.equal(rows.length, mine(before[t]).length / 2, t);
  }
  assert.equal(after.budget.length, 1, "spend is not per-user and stays");
  assert.ok(after.rate.some((r) => r.user_hash === GLOBAL_USER), "the global rate counter is not a user's to delete");
  assert.equal((await me(w, a)).allowance.autofill.used, 0);
  assert.equal((await me(w, b)).allowance.autofill.used, 1);
});
