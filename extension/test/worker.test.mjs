// InternScout Worker routing: request building, error mapping, token expiry, store migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerRequest, callWorker, workerError, taskFor, NEEDS_YOU_CODES } from "../background/gemini.js";
import { decodeJwt, isExpired, parseRedirect, buildAuthUrl, pickProvider, allowanceLines } from "../lib/auth.js";
import { emptyStore, upgradeStore, migrate, hasKey, modelFor, EMPTY_FACTS, STORE_VERSION } from "../lib/store.js";

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64url({ alg: "RS256" })}.${b64url(payload)}.sig`;
const reply = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3 } });
const res = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const opts = { system: [{ type: "text", text: "RULES" }], messages: [{ role: "user", content: "hi" }], max_tokens: 1000,
  tools: [{ name: "click", description: "Click", input_schema: { type: "object" } }] };

test("call sites map to Worker tasks", () => {
  assert.equal(taskFor("agent"), "autofill");
  assert.equal(taskFor("tailor"), "resume_tailor");
  assert.equal(taskFor("deep_dive"), "deep_dive");
  assert.equal(taskFor("test"), "short_answer");
  assert.equal(taskFor(undefined), "short_answer");
});

test("worker request carries task, run_id and the Gemini body without a model", () => {
  const r = buildWorkerRequest({ task: "autofill", run_id: "run-1", ...opts });
  assert.deepEqual(Object.keys(r), ["task", "run_id", "request"]);
  assert.equal(r.task, "autofill");
  assert.equal(r.run_id, "run-1");
  assert.deepEqual(r.request.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.deepEqual(r.request.systemInstruction, { parts: [{ text: "RULES" }] });
  assert.equal(r.request.tools[0].functionDeclarations[0].name, "click");
  assert.ok(r.request.generationConfig.maxOutputTokens > 1000);
  assert.ok(!("model" in r.request));
  assert.ok(!("run_id" in buildWorkerRequest({ task: "short_answer", ...opts })));
  assert.throws(() => buildWorkerRequest({ task: "essay", ...opts }), /Unknown InternScout task/);
});

test("callWorker posts with the bearer token and parses the Gemini reply", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return res(200, reply("OK")); };
  const out = await callWorker({ url: "https://w.example", token: "T1", task: "deep_dive", run_id: "dd", fetchImpl, ...opts });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://w.example/ai");
  assert.equal(calls[0].init.headers.authorization, "Bearer T1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.task, "deep_dive");
  assert.equal(body.run_id, "dd");
  assert.deepEqual(out.content, [{ type: "text", text: "OK" }]);
  assert.equal(out.stop_reason, "end_turn");
});

test("401 refreshes the token once, then gives up with a sign-in message", async () => {
  const tokens = [];
  let n = 0;
  const fetchImpl = async (url, init) => { tokens.push(init.headers.authorization); return n++ === 0 ? res(401, { error: "auth" }) : res(200, reply("x")); };
  await callWorker({ url: "u", token: "old", refreshToken: async () => "new", task: "autofill", fetchImpl, ...opts });
  assert.deepEqual(tokens, ["Bearer old", "Bearer new"]);

  const always401 = async () => res(401, { error: "auth", message: "expired" });
  await assert.rejects(callWorker({ url: "u", token: "old", refreshToken: async () => null, task: "autofill", fetchImpl: always401, ...opts }),
    (e) => e.code === "auth" && /Sign in with Google or Microsoft/.test(e.message));
  await assert.rejects(callWorker({ url: "u", token: null, task: "autofill", fetchImpl: always401, ...opts }), (e) => e.code === "auth");
});

test("rate limits wait retry_after and retry; caps and pauses do not retry", async () => {
  const slept = [];
  let n = 0;
  const fetchImpl = async () => (n++ === 0 ? res(429, { error: "rate", retry_after: 2 }) : res(200, reply("ok")));
  await callWorker({ url: "u", token: "t", task: "autofill", fetchImpl, sleepImpl: async (ms) => slept.push(ms), ...opts });
  assert.deepEqual(slept, [2000]);

  for (const [status, data, code] of [[429, { error: "cap", task: "autofill", resets: "2026-10-01" }, "cap"], [503, { error: "paused" }, "paused"]]) {
    let calls = 0;
    await assert.rejects(callWorker({ url: "u", token: "t", task: "autofill", fetchImpl: async () => { calls++; return res(status, data); }, sleepImpl: async () => {}, ...opts }),
      (e) => e.code === code);
    assert.equal(calls, 1, code);
  }
});

test("a busy server is waited out, and pauses the job only after every retry", async () => {
  const slept = [];
  let n = 0;
  const busy = res(503, { error: "busy", retry_after: 45 });
  // 45s is past the 30s the per-student "rate" code will wait, but the global bucket empties at the
  // minute boundary regardless, so this one is still worth sitting out rather than failing.
  const fetchImpl = async () => (n++ === 0 ? busy : res(200, reply("ok")));
  await callWorker({ url: "u", token: "t", task: "autofill", fetchImpl, sleepImpl: async (ms) => slept.push(ms), ...opts });
  assert.deepEqual(slept, [45000]);

  let calls = 0;
  await assert.rejects(callWorker({ url: "u", token: "t", task: "autofill", sleepImpl: async () => {},
    fetchImpl: async () => { calls++; return busy; }, ...opts }), (e) => e.code === "busy");
  assert.equal(calls, 4, "a surge that never clears is retried, not given up on at once");
});

test("error mapping gives clear student-facing messages", () => {
  const cap = workerError(429, { error: "cap", task: "resume_tailor", resets: "2026-10-01T00:00:00Z" });
  assert.equal(cap.code, "cap");
  assert.match(cap.message, /tailored-resume allowance/);
  assert.match(cap.message, /Oct 1/);
  assert.match(cap.message, /own key/);
  assert.match(workerError(429, { error: "cap", message: "run limit" }).message, /call limit/);
  assert.match(workerError(429, { error: "rate", retry_after: 40 }).message, /40 seconds/);
  assert.match(cap.message, /\.edu email get twice/);
  assert.match(workerError(503, { error: "paused" }).message, /paused for everyone/);
  // A busy server must not read as the student's own limit, and must not be mistaken for the budget pause
  const b = workerError(503, { error: "busy", retry_after: 45 });
  assert.equal(b.code, "busy");
  assert.match(b.message, /too many students/);
  assert.match(b.message, /45 seconds/);
  assert.equal(workerError(401, {}).code, "auth");
  assert.equal(workerError(502, {}).code, "upstream");
  assert.equal(workerError(400, { error: "bad_task", message: "nope" }).code, "bad_task");
  for (const c of ["auth", "cap", "rate", "paused", "busy"]) assert.ok(NEEDS_YOU_CODES.has(c));
  assert.ok(!NEEDS_YOU_CODES.has("not_campus"));
  assert.ok(!NEEDS_YOU_CODES.has("upstream"));
});

test("token expiry check with leeway", () => {
  const now = Date.UTC(2026, 8, 15, 12);
  const at = (s) => jwt({ exp: Math.floor(now / 1000) + s, email: "sam@umass.edu" });
  assert.equal(decodeJwt(at(0)).email, "sam@umass.edu");
  assert.equal(isExpired(at(3600), now), false);
  assert.equal(isExpired(at(30), now), true);   // inside the 60 s leeway
  assert.equal(isExpired(at(-10), now), true);
  assert.equal(isExpired(jwt({ email: "no-exp" }), now), true);
  assert.equal(isExpired("garbage", now), true);
  assert.equal(isExpired(null, now), true);
});

test("sign-in URL and redirect parsing check the nonce", () => {
  const cfg = { providers: [
    { id: "google", client_id: "gid", authorize_url: "https://accounts.google.com/o/oauth2/v2/auth" },
    { id: "microsoft", client_id: "mid", authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", scopes: ["openid", "email", "profile"] },
  ] };
  assert.equal(pickProvider(cfg, "apple"), null);
  assert.equal(pickProvider({}, "google"), null);
  const ms = new URL(buildAuthUrl(pickProvider(cfg, "microsoft"), { redirectUri: "https://abc.chromiumapp.org/", nonce: "n1" }));
  assert.equal(ms.searchParams.get("client_id"), "mid");
  assert.equal(ms.searchParams.get("response_type"), "id_token");
  assert.equal(ms.searchParams.get("response_mode"), "fragment");
  assert.equal(ms.searchParams.get("nonce"), "n1");
  assert.equal(ms.searchParams.get("scope"), "openid email profile");
  assert.equal(ms.searchParams.get("redirect_uri"), "https://abc.chromiumapp.org/");
  assert.equal(ms.searchParams.get("prompt"), "select_account");
  const g = new URL(buildAuthUrl(pickProvider(cfg, "google"), { redirectUri: "r", nonce: "n", silent: true }));
  assert.equal(g.searchParams.get("client_id"), "gid");
  assert.equal(g.searchParams.get("prompt"), "none");
  // anyone may sign in: no school-domain restriction in the URL
  for (const u of [ms, g]) for (const k of ["hd", "domain_hint"]) assert.equal(u.searchParams.get(k), null);

  const tok = jwt({ nonce: "n1", exp: 9e9 });
  assert.equal(parseRedirect(`https://abc.chromiumapp.org/#id_token=${tok}&state=n1`, "n1"), tok);
  assert.throws(() => parseRedirect(`https://abc.chromiumapp.org/#id_token=${tok}`, "other"), /did not match/);
  assert.throws(() => parseRedirect("https://abc.chromiumapp.org/#error=access_denied&error_description=Nope", "n1"), /Nope/);
});

test("allowance lines from GET /me", () => {
  const lines = allowanceLines({ allowance: { resume_tailor: { used: 1, limit: 8 }, autofill: { used: 16, limit: 15 } } });
  assert.deepEqual(lines, ["Tailored resumes: 7 of 8 left", "Auto-Apply runs: 0 of 15 left"]);
});

test("new installs default to InternScout", () => {
  const s = emptyStore();
  assert.equal(s.version, STORE_VERSION);
  assert.equal(s.ai.provider, "internscout");
  assert.ok(hasKey(s));
  assert.match(modelFor(s, "agent"), /^gemini/);
  for (const k of ["majors", "class_year", "grad_term"]) assert.equal(EMPTY_FACTS[k], "");
});

test("store migration keeps a student's own key and provider", () => {
  const v2 = (ai) => ({ version: 2, ai, settings: { onboarded: true }, profile: { facts: { first_name: "Sam" } } });
  const none = upgradeStore(v2({ provider: "anthropic", apiKey: "", geminiKey: "", model: "claude-sonnet-5" }));
  assert.equal(none.ai.provider, "internscout");
  assert.equal(none.version, STORE_VERSION);
  assert.equal(none.profile.facts.first_name, "Sam");
  assert.equal(none.profile.facts.majors, "");

  const claude = upgradeStore(v2({ provider: "anthropic", apiKey: "sk-ant-placeholder", geminiKey: "", model: "claude-sonnet-5" }));
  assert.equal(claude.ai.provider, "anthropic");
  assert.equal(claude.ai.apiKey, "sk-ant-placeholder");
  assert.equal(claude.ai.model, "claude-sonnet-5");

  const gem = upgradeStore(v2({ provider: "gemini", apiKey: "", geminiKey: "AIza-placeholder" }));
  assert.equal(gem.ai.provider, "gemini");
  assert.equal(gem.ai.geminiKey, "AIza-placeholder");

  // Already v3: a student who picked their own provider (key not typed yet) is not switched back.
  const v3 = upgradeStore({ version: 3, ai: { provider: "anthropic", apiKey: "" } });
  assert.equal(v3.ai.provider, "anthropic");

  // v0.1 flat keys with a key go to Anthropic; without one, to InternScout.
  assert.equal(migrate({ ai: { apiKey: "sk-ant-placeholder" } }).ai.provider, "anthropic");
  assert.equal(migrate({ internscout: { first_name: "Sam" } }).ai.provider, "internscout");
});
