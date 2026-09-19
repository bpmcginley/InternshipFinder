// InternScout Worker routing: request building, error mapping, token expiry, store migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerRequest, callWorker, workerError, taskFor, NEEDS_YOU_CODES, stitchChunks, readSSE } from "../background/gemini.js";
import { decodeJwt, isExpired, parseRedirect, buildAuthUrl, pickProvider, allowanceLines, tierNote, MAIN_TASKS } from "../lib/auth.js";
import { emptyStore, upgradeStore, migrate, hasKey, modelFor, EMPTY_FACTS, STORE_VERSION } from "../lib/store.js";
import { postingGone, deadPage, pageGone, noChange, toPage, pageBulk, FROZEN_PAGE } from "../background/agent.js";

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
  assert.equal(calls[0].url, "https://w.example/ai?stream=1");
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
  // an .edu student is not told to get an .edu email; a general one is
  assert.doesNotMatch(workerError(429, { error: "cap", task: "autofill", resets: "2026-10-01", tier: "edu" }).message, /\.edu email/);
  assert.match(workerError(429, { error: "cap", task: "autofill", resets: "2026-10-01", tier: "general" }).message, /\.edu email/);
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

test("account panel: main tasks only, and a tier note", () => {
  const me = { tier: "edu", paused: false, allowance: { field_match: { used: 0, limit: 200 }, deep_dive: { used: 0, limit: 2 } } };
  assert.deepEqual(allowanceLines(me, MAIN_TASKS), ["Deep Dives: 2 of 2 left"]);
  // The Deep Dive has no monthly cap now (the Worker sends limit: null), so it reads "unlimited"
  const uncapped = { ...me, allowance: { deep_dive: { used: 3, limit: null } } };
  assert.deepEqual(allowanceLines(uncapped, MAIN_TASKS), ["Deep Dives: unlimited"]);
  assert.match(tierNote(me), /School \(\.edu\)/);
  assert.match(tierNote({ ...me, tier: "general", paused: true }), /Standard.*paused/);
  assert.match(tierNote(null), /Couldn't reach/);
  assert.match(tierNote({ error: "auth" }), /auth/);
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

// A closed posting redirects to the company's list of other openings; filling one of those hands
// the student an application for a job they never picked.
test("a posting that redirected to a board of other jobs is caught; a real step is not", () => {
  const snap = (url) => ({ top: { url } });
  const page = (o) => [{ title: "", headings: [], buttons: [], text: "", ...o }];
  const vetsez = { title: "Full Stack Developer Intern", apply_url: "https://vetsez.breezy.hr/p/a4010fdb3a7001-full-stack-developer-intern-remote-opportunity" };

  assert.equal(postingGone(vetsez, snap("https://vetsez.breezy.hr/"), page({
    title: "Openings at VetsEZ",
    headings: ["Build the AI-Native Future of Federal Health"],
    buttons: [{ text: "Apply" }, { text: "View Openings" }],
    text: "Proposal Solutions Architect - DHA | Program Manager | Senior Cybersecurity Engineer",
  })), true);

  // Same redirect, but the posting is on the page after all: the student is where they meant to be.
  assert.equal(postingGone(vetsez, snap("https://vetsez.breezy.hr/"), page({
    headings: ["Full Stack Developer Intern (Remote Opportunity)"],
  })), false);

  // A normal multi-step application keeps the posting id in the URL.
  assert.equal(postingGone(
    { title: "Data Analyst Intern", apply_url: "https://job-boards.greenhouse.io/olsson/jobs/5397033008" },
    snap("https://job-boards.greenhouse.io/olsson/jobs/5397033008#app"), page({})), false);

  // A title with nothing distinctive in it ("Summer Internship Program") can't be judged this way.
  assert.equal(postingGone(
    { title: "Summer 2027 Internship Program", apply_url: "https://acme.com/careers/openings/12345-summer" },
    snap("https://acme.com/careers"), page({ text: "Nothing here." })), false);

  // A short or missing path segment is no evidence either way.
  assert.equal(postingGone({ title: "Robotics Intern", apply_url: "https://acme.com/jobs/7" },
    snap("https://acme.com/"), page({})), false);

  // BambooHR numbers its postings, and every one of its links says "careers" as well. Picking the
  // longest segment picked the word the board root also has, so the redirect read as no redirect.
  assert.equal(postingGone(
    { title: "Software Engineer Intern", apply_url: "https://fullbay.bamboohr.com/careers/131/" },
    snap("https://fullbay.bamboohr.com/careers"), page({
      headings: ["Current Openings"],
      text: "Customer Support Rep | Paid Media Manager | Sr. Product Manager - Payments | Revenue Operations Analyst",
    })), true);

  // Taleo sends everyone to a login page before the form, and keeps the posting id in the query
  // string where the key never looks. What is left of the path has to be the part both URLs share,
  // and the name of the template that drew the page is not it.
  assert.equal(postingGone(
    { title: "2027 Data Product & Analytics Intern", apply_url: "https://textron.taleo.net/careersection/textron/jobdetail.ftl?job=343181" },
    snap("https://textron.taleo.net/careersection/iam/accessmanagement/login.jsf"), page({
      title: "Applicant Login", headings: ["Applicant Login"], buttons: [{ text: "SIGN IN" }],
    })), false);
});

// Not every pulled posting redirects. Some just 404 and say so.
test("a page that says the posting is not there is believed, unless it is still a form", () => {
  const f = (o) => ({ frameId: 0, title: "", headings: [], elements: [], ...o });

  // AcreTrader's Data Intern on Rippling: a 404 title, a footer, and the site's own search box.
  assert.equal(pageGone([f({ title: "404 | Page Not Found", elements: [{ kind: "text", label: "Search" }] })]), true);
  assert.equal(pageGone([f({ headings: ["This job is no longer available"] })]), true);
  assert.equal(pageGone([f({ title: "Careers", headings: ["The position has been filled"] })]), true);

  // A real application that happens to say it: the form is still asking for the student.
  assert.equal(pageGone([f({ title: "404 | Page Not Found",
    elements: [{ kind: "text", label: "Email address" }, { kind: "file", label: "Resume" }] })]), false);

  // An ordinary posting says nothing of the kind.
  assert.equal(pageGone([f({ title: "Data Intern at AcreTrader", elements: [] })]), false);
  assert.equal(pageGone([]), false);
});

// A link that renders nothing costs a model turn and a slice of the student's allowance before
// anyone finds out. ADP's cookie-walled page is the real one this came from.
test("a page with nothing to fill and no way forward is not sent to the model", () => {
  const f = (o) => ({ elements: [], buttons: [], busy: false, captcha: false, ...o });

  // ADP: a OneTrust banner and nothing else.
  assert.equal(deadPage([f({ buttons: [{ text: "Close" }, { text: "Cookie Privacy Statement" }] })]), true);

  // A normal job page before the form: no fields yet, but a way in.
  assert.equal(deadPage([f({ buttons: [{ text: "Apply now" }] })]), false);
  assert.equal(deadPage([f({ buttons: [{ text: "Sign in to continue" }] })]), false);

  // Still drawing, or asking for a robot check: not dead, just slow.
  assert.equal(deadPage([f({ busy: true })]), false);
  assert.equal(deadPage([f({ captcha: true })]), false);

  // A form: obviously alive, whatever the buttons say.
  assert.equal(deadPage([f({ elements: [{ ref: "e1" }], buttons: [{ text: "Close" }] })]), false);

  // An iframe carrying the application counts for the whole page.
  assert.equal(deadPage([f({ buttons: [{ text: "Close" }] }), f({ buttons: [{ text: "Start application" }] })]), false);

  // No frames at all means the page was not readable; that is a different story.
  assert.equal(deadPage([]), false);

  // Workable's job page for its first few seconds: the site's own furniture, drawn before the job is.
  // This is indistinguishable from the ADP case above and it is meant to be - the point is that being
  // sure needs a second look a few seconds later, which is why runJob waits on this whole condition
  // and not merely on a frame with nothing in it at all.
  assert.equal(deadPage([f({ buttons: [{ text: "Cookie settings" }, { text: "Help" }, { text: "View all jobs" }] })]), true);
});

// The wait above only ends early when the page has stopped growing, so the measure of "how much page
// is there" has to move when the page does and hold still when it does not.
test("a page still arriving can be told from a page that is all there", () => {
  const f = (o) => ({ elements: [], buttons: [], text: "", ...o });

  // Workable, three looks apart: furniture, then the job, then the form.
  const a = [f({ buttons: [{ text: "Cookie settings" }], text: "x".repeat(204) })];
  const b = [f({ buttons: [{ text: "Cookie settings" }], text: "x".repeat(5765) })];
  const c = [f({ elements: [{ ref: "e1" }, { ref: "e2" }], buttons: [{ text: "Submit application" }] })];
  assert.notEqual(pageBulk(a), pageBulk(b));
  assert.notEqual(pageBulk(b), pageBulk(c));

  // ADP's cookie wall, twice: the same page both times, so the wait can stop.
  const dead = [f({ buttons: [{ text: "Close" }], text: "We use cookies" })];
  assert.equal(pageBulk(dead), pageBulk([f({ buttons: [{ text: "Close" }], text: "We use cookies" })]));

  // Missing fields are counted as nothing rather than throwing.
  assert.equal(pageBulk([{}]), 0);
  assert.equal(pageBulk([]), 0);
});

// A click the page never answered. Qorvo draws "Apply now" as a dropdown whose menu is bound by a
// script that lands after the page is otherwise ready: clicked a moment early it reports success,
// opens nothing, and leaves the run to work out for itself that this is the same page again.
test("a click that changed nothing is only reported when both marks are real", () => {
  const page = "0=https://careers.qorvo.com/job/x~3~28~Analog Design Intern";
  assert.equal(noChange(page, page), true);
  assert.equal(noChange(page, "0=https://careers.qorvo.com/job/x~3~32~Analog Design Intern"), false);
  // Mid-navigation nothing answers, and an unreachable page is not a page that stayed the same.
  assert.equal(noChange(page, ""), false);
  assert.equal(noChange("", ""), false);
});

// ADP Workforce Now's recruitment page can wedge its renderer: scripts sent into it never come back,
// and Chrome reports neither a result nor an error. Without a deadline the run simply waits, and a
// run that is waiting looks no different to the student from one that is working.
test("a page that never answers is given up on rather than waited for", async () => {
  assert.equal(await toPage(Promise.resolve("here"), 50), "here");
  await assert.rejects(toPage(new Promise(() => {}), 20), (e) => e.message === FROZEN_PAGE);
  // The page's own errors still reach the caller unchanged.
  await assert.rejects(toPage(Promise.reject(new Error("no such tab")), 50), /no such tab/);
});

// ---- streamed replies (?stream=1)
const sse = (chunks, { cut = 0 } = {}) => {
  let text = chunks.map((c) => `data: ${JSON.stringify(c)}` + "\r\n\r\n").join("");
  if (cut) text = text.slice(0, -cut);
  const bytes = new TextEncoder().encode(text);
  // Small, odd-sized pieces, so a line (and a multi-byte character) is split across reads.
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } });
  return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body, json: async () => { throw new Error("not json"); } };
};
const chunk = (parts, extra = {}) => ({ candidates: [{ content: { role: "model", parts }, ...extra }], usageMetadata: { promptTokenCount: 5 } });

test("a streamed reply is joined back into one answer", async () => {
  const fetchImpl = async () => sse([
    chunk([{ text: "thinking...", thought: true }]),
    chunk([{ text: "Hello, caf" }]),
    chunk([{ text: "é wor" }]),
    chunk([{ text: "ld", thoughtSignature: "SIG" }], { finishReason: "STOP" }),
  ]);
  const out = await callWorker({ url: "u", token: "t", task: "resume_tailor", fetchImpl, ...opts });
  assert.deepEqual(out.content, [{ type: "text", text: "Hello, café world", _sig: "SIG" }]);
  assert.equal(out.stop_reason, "end_turn");
  assert.equal(out.usage.promptTokenCount, 5);
});

test("a streamed tool call keeps its arguments and signature", async () => {
  const fetchImpl = async () => sse([
    chunk([{ text: "Filling the form." }]),
    chunk([{ functionCall: { name: "fill", args: { selector: "#email", value: "a@b.edu" } }, thoughtSignature: "S2" }], { finishReason: "STOP" }),
  ]);
  const out = await callWorker({ url: "u", token: "t", task: "autofill", fetchImpl, ...opts });
  assert.equal(out.stop_reason, "tool_use");
  assert.equal(out.content[0].text, "Filling the form.");
  assert.deepEqual(out.content[1].input, { selector: "#email", value: "a@b.edu" });
  assert.equal(out.content[1]._sig, "S2");
});

test("a stream cut off before the finish is retried, never acted on", async () => {
  let n = 0;
  const slept = [];
  const fetchImpl = async () => (n++ === 0
    ? sse([chunk([{ text: "half a res" }]), chunk([{ text: "ume" }], { finishReason: "STOP" })], { cut: 40 })
    : sse([chunk([{ text: "whole" }], { finishReason: "STOP" })]));
  const out = await callWorker({ url: "u", token: "t", task: "resume_tailor", fetchImpl, sleepImpl: async (ms) => slept.push(ms), ...opts });
  assert.equal(n, 2);
  assert.equal(slept.length, 1);
  assert.deepEqual(out.content, [{ type: "text", text: "whole" }]);
});

test("MAX_TOKENS and a blocked prompt come through a stream unchanged", async () => {
  const long = await callWorker({ url: "u", token: "t", task: "deep_dive", fetchImpl: async () => sse([chunk([{ text: "a" }], { finishReason: "MAX_TOKENS" })]), ...opts });
  assert.equal(long.stop_reason, "max_tokens");
  await assert.rejects(callWorker({ url: "u", token: "t", task: "deep_dive", fetchImpl: async () => sse([{ promptFeedback: { blockReason: "SAFETY" } }]), ...opts }), /blocked: SAFETY/);
});

test("stitchChunks and readSSE on their own", async () => {
  assert.deepEqual(stitchChunks([]), { candidates: [], complete: false });
  const got = await readSSE({ text: async () => "event: x" + "\n" + "data: {\"a\":1}" + "\n\n" + "data: [DONE]" + "\n" });
  assert.deepEqual(got, [{ a: 1 }]);
});
