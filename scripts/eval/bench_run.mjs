// The spending phases of the offline form benchmark (see form_bench.mjs for the overview): the answer
// key, the model runs, the free-text judge, and the report. Every paid call goes through charge(),
// which keeps bench-spend.json and refuses a call once the cap is reached.
import { load, save, opt, sleep, factsFor, accountLine } from "./bench_io.mjs";
import * as L from "./bench_lib.mjs";

const { TOOLS, formatSnapshot, preFilledLine, trimHistory } = await import("../../extension/background/agent.js");
const { buildGeminiBody } = await import("../../extension/background/gemini.js");
const { CONFIG } = await import("../../worker/src/config.js");
const { sanitizeRequest, costCents } = await import("../../worker/src/gemini.js");
const { askClaude } = await import("./autofill_models.mjs");
const { profileForModel } = await import("../../extension/lib/store.js");
const { benchStore, RESUME_FILE } = await import("./bench_profile.mjs");

const TODAY = "2026-10-09";
const AFTER_RISE = new Date("2027-01-02T00:00:00Z");
const PROD = CONFIG.TASKS.autofill.model;   // gemini-3.8-flash

export const CONFIGS = {
  "flash-low": { provider: "gemini", model: PROD, thinking: null, label: "Gemini 3.8 Flash, thinking low (production)" },
  "flash-medium": { provider: "gemini", model: PROD, thinking: "medium", label: "Gemini 3.8 Flash, thinking medium" },
  "haiku-low": { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", label: "Claude Haiku 5.5, effort low" },
  "haiku-medium": { provider: "anthropic", model: "claude-haiku-5-5", effort: "medium", label: "Claude Haiku 5.5, effort medium" },
  "haiku-high": { provider: "anthropic", model: "claude-haiku-5-5", effort: "high", label: "Claude Haiku 5.5, effort high" },
};

// ---------- spend ----------
let CAP = 1450;   // cents; --cap=dollars overrides
const spend = () => load("spend", { gemini: 0, anthropic: 0, calls: { gemini: 0, anthropic: 0 } });
function charge(provider, cents) {
  const s = spend();
  s[provider] += cents; s.calls[provider]++;
  save("spend", s);
}
function guard() {
  const s = spend();
  if (s.gemini + s.anthropic >= CAP) throw Object.assign(new Error(`spend cap reached: $${((s.gemini + s.anthropic) / 100).toFixed(2)} of $${(CAP / 100).toFixed(2)}`), { cap: true });
}
const keys = () => ({ gemini: process.env.GEMINI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY });

// ---------- model calls ----------
// One Auto-Apply step on Gemini, built as production builds it: the extension's buildGeminiBody, then
// the Worker's sanitizeRequest for the autofill task. The reply is read the way gemini.js fromResponse
// reads it (thought parts dropped, ids and thought signatures kept for the next turn).
async function geminiStep(cfg, system, messages) {
  guard();
  let body = sanitizeRequest(buildGeminiBody({ system, messages, tools: TOOLS, max_tokens: 8000 }), "autofill", CONFIG);
  if (cfg.thinking) body = { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: cfg.thinking } } };
  let res, data, t0;
  for (let attempt = 0; ; attempt++) {
    t0 = Date.now();
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": keys().gemini }, body: JSON.stringify(body) });
    data = await res.json().catch(() => ({}));
    if (!(res.status === 429 || res.status >= 500) || attempt >= 4) break;
    await sleep(2000 * 2 ** attempt);
  }
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`${cfg.model}: HTTP ${res.status} ${(data.error && data.error.message) || ""}`);
  const usage = data.usageMetadata || {};
  const cents = costCents(cfg.model, usage, CONFIG, new Date());
  charge("gemini", cents);
  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error(`no candidate (${data.promptFeedback && data.promptFeedback.blockReason})`);
  const content = [];
  let n = 0;
  for (const p of (cand.content && cand.content.parts) || []) {
    if (p.thought) continue;
    if (p.functionCall) content.push({ type: "tool_use", id: p.functionCall.id || `g${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}) });
    else if (p.text != null || p.thoughtSignature) content.push({ type: "text", text: p.text || "", ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}) });
  }
  const tokens = { prompt: (usage.promptTokenCount || 0) + (usage.toolUsePromptTokenCount || 0), cached: usage.cachedContentTokenCount || 0,
    output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), thoughts: usage.thoughtsTokenCount || 0 };
  return { content, ms, cents, later: costCents(cfg.model, usage, CONFIG, AFTER_RISE), usage, tokens, stop: cand.finishReason };
}

async function claudeStep(cfg, system, messages) {
  guard();
  let r;
  try { r = await askClaude(cfg.model, { system, messages }, keys().anthropic, cfg.effort); }
  catch (e) { if (e.usage) charge("anthropic", L.claudeCents(cfg.model, e.usage)); throw e; }
  charge("anthropic", r.cents);
  const u = r.usage || {};
  // The assistant turn as the history keeps it: tool calls (with ids) and text; thinking blocks are
  // dropped by claudeMessages on the next request anyway, as the extension's history would not carry them.
  const content = r.raw.filter((b) => b.type === "tool_use" || (b.type === "text" && b.text)).map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input || {} } : { type: "text", text: b.text }));
  const tokens = { prompt: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0,
    written: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 };
  return { content, ms: r.ms, cents: r.cents, later: r.cents, usage: u, tokens, stop: r.stop };
}
const modelStep = (cfg, system, messages) => (cfg.provider === "gemini" ? geminiStep(cfg, system, messages) : claudeStep(cfg, system, messages));

// Claude Opus 5.5 for the answer key and the judge: adaptive thinking at effort high, JSON by schema.
async function opusJson(system, user, schema, maxTokens = 32000) {
  guard();
  const body = { model: L.OPUS.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }],
    thinking: { type: "adaptive" }, output_config: { effort: "high", format: { type: "json_schema", schema } } };
  let res, data;
  for (let attempt = 0; ; attempt++) {
    // Streamed, so a long think cannot hit an HTTP timeout; the events are put back together here.
    res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": keys().anthropic, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ ...body, stream: true }) });
    if (!(res.status === 429 || res.status === 529 || res.status >= 500) || attempt >= 4) break;
    await sleep((+res.headers.get("retry-after") || 3 * 2 ** attempt) * 1000);
  }
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(`opus: HTTP ${res.status} ${(d.error && d.error.message) || ""}`); }
  const text = await res.text();
  let out = "", usage = {}, stop = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
    if (ev.type === "message_start") usage = { ...ev.message.usage };
    else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") out += ev.delta.text;
    else if (ev.type === "message_delta") { usage = { ...usage, ...ev.usage }; stop = ev.delta && ev.delta.stop_reason; }
  }
  charge("anthropic", L.opusCents(usage));
  if (stop === "refusal") throw new Error("opus refused");
  if (stop === "max_tokens") throw new Error("opus ran out of tokens");
  return JSON.parse(out);
}

// ---------- key ----------
const KEY_SCHEMA = { type: "object", additionalProperties: false, required: ["fields"], properties: { fields: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["ref", "cls", "expect", "match", "sensitive", "why"], properties: {
    ref: { type: "string" }, cls: { type: "string", enum: ["objective", "free", "skip"] }, expect: { type: "array", items: { type: "string" } },
    match: { type: "string", enum: ["exact", "contains", "phone", "url", "date", "year", "number", "blank", "any"] },
    sensitive: { type: "boolean" }, why: { type: "string" } } } } } };

const KEY_SYSTEM = `You write the answer key for a benchmark of AI agents that fill internship application forms for a student. The student is fictional; the forms are real. You get the student's full profile (the only facts the agent has), the job, and every field on the form in page order. Key only the fields marked NEEDS KEY; the others are shown for context.

For each NEEDS KEY field return:
- cls "objective" when the right answer follows from the profile, either directly or by an uncontroversial derivation (class standing from the graduation date and today's date, "Yes" to "will you be enrolled during the internship", "No" to "were you referred" when the profile names no referrer). Put every acceptable answer in expect. For a choice field (select, radio_group, listbox, combobox) each expect entry must be copied EXACTLY from that field's options. For a checkbox expect is ["true"] or ["false"]. For text, give the canonical value and choose match: exact, contains (value must contain it), phone, url, date (same month/year, day if given), year, number.
- cls "objective" with match "blank" and expect [""] when the field is OPTIONAL and nothing in the profile answers it: an agent that fills it has invented something.
- cls "free" for open-ended prose (why this company, describe a project, cover letter text, additional information, explain an answer). Not scored against expect; leave expect [].
- cls "skip" when the answer cannot be decided fairly: the profile does not cover a REQUIRED question (the agent should ask the human), it needs information only the human has (today's signature date, references' contact details), or reasonable readers would disagree. Say why.
A conditional follow-up ("If yes, please explain", "If you answered no above...") whose condition does not apply to this student: if the field is optional, objective/blank; if required, objective with the sensible filler (e.g. "N/A") only when the form makes that the obvious answer, otherwise skip.
sensitive: true for work authorization, visa/sponsorship, citizenship, export control, EEO and demographic questions (gender, race, ethnicity, veteran, disability, sexual orientation), criminal history, age, salary, relocation, start or graduation dates, GPA, security clearance, and any legal attestation.
Today's date is ${TODAY}. Be strict and literal: the key decides which agent is better.`;

async function phaseKey(argv) {
  CAP = Math.round(Number(opt(argv, "cap", "14.5")) * 100);
  const steps = load("steps"), key = load("key", {});
  const store = benchStore(), profile = store.profile, pm = profileForModel(store);
  for (const st of steps) {
    if (key[st.key] && !argv.includes("--redo")) continue;
    const k = {}, need = [];
    for (const f of st.fields) {
      const base = { label: L.questionText(f), kind: f.kind, required: !!f.required, options: f.options };
      const r = L.ruleKey(f, profile);
      if (r) k[f.ref] = { ...base, ...r };
      else { k[f.ref] = base; need.push(f.ref); }
    }
    if (need.length) {
      const lines = st.fields.map((f) => `[${f.ref}] ${need.includes(f.ref) ? "NEEDS KEY" : "context"} | ${f.kind}${f.required ? " required" : " optional"} | "${L.questionText(f)}"` +
        `${f.options && f.options.length ? ` | options: ${f.options.map((o) => JSON.stringify(o)).join(", ")}` : ""}${f.maxlength ? ` | maxlength ${f.maxlength}` : ""}`);
      const user = `STUDENT PROFILE (JSON)\n${JSON.stringify(pm)}\n\nJOB\nCompany: ${st.job.company}\nTitle: ${st.job.title}\nLocation: ${st.job.location}\nDescription (start):\n${st.job.description.slice(0, 3000)}\n\nFORM FIELDS (page order)\n${lines.join("\n")}\n\nReturn one entry per NEEDS KEY field (${need.length} of them).`;
      const out = await opusJson(KEY_SYSTEM, user, KEY_SCHEMA);
      for (const e of out.fields || []) if (k[e.ref] && need.includes(e.ref)) Object.assign(k[e.ref], { cls: e.cls, expect: e.expect, match: e.match, sensitive: e.sensitive || L.SENSITIVE_RE.test(k[e.ref].label), why: e.why, source: "opus" });
      const missing = need.filter((r) => !k[r].cls);
      for (const r of missing) Object.assign(k[r], { cls: "skip", why: "not keyed", source: "none" });
      console.log(`${st.key}: ${st.fields.length - need.length} by rule, ${need.length - missing.length} by Opus${missing.length ? `, ${missing.length} unkeyed` : ""}`);
    }
    key[st.key] = k;
    save("key", key);
  }
  const s = spend();
  console.log(`spend so far: Gemini $${(s.gemini / 100).toFixed(3)}, Anthropic $${(s.anthropic / 100).toFixed(3)}`);
}

// ---------- applying a step's tool calls in the page (agent.js execTool, minus the Chrome APIs) ----------
const toolResult = (id, content, isError) => ({ type: "tool_result", tool_use_id: id, content: typeof content === "string" ? content : JSON.stringify(content), ...(isError ? { is_error: true } : {}) });
const NEEDS_REF = ["fill", "select", "check", "upload", "click", "fill_secret"];
const REQUIRED_ARGS = Object.fromEntries(TOOLS.map((t) => [t.name, t.input_schema.required || []]));

async function applyCalls(page, uses, snap, fails) {
  const { act } = await import("./bench_page.mjs");
  const results = [], calls = [];
  let stop = null;
  for (const u of uses) {
    const input = { ...(u.input || {}) };
    const rec = { name: u.name, ref: input.ref, ok: true };
    // Claude Haiku 5.5 often copies the snapshot's brackets into the ref ("[0:6]"); production's execTool
    // answers that with "Unknown ref". The bench strips them (the one-line change a switch would need)
    // and records each call that needed it, so both the as-is and the fixed behaviour can be reported.
    if (typeof input.ref === "string" && /^\s*\[[^\]]+\]\s*$/.test(input.ref)) { input.ref = input.ref.trim().slice(1, -1); rec.bracketed = true; }
    calls.push(rec);
    if (stop) { results.push(toolResult(u.id, "Not run: the job paused.")); Object.assign(rec, { ok: false, control: true, error: "not run (after a stop)" }); continue; }
    if ((REQUIRED_ARGS[u.name] || []).some((a) => input[a] === undefined)) rec.malformed = true;
    const t = NEEDS_REF.includes(u.name) ? snap.index[input.ref] : null;
    if (NEEDS_REF.includes(u.name) && !t) { results.push(toolResult(u.id, `Unknown ref ${input.ref}. Use refs from the latest snapshot.`, true)); Object.assign(rec, { ok: false, error: "unknown ref" }); continue; }
    if (NEEDS_REF.includes(u.name) && (fails[input.ref] || 0) >= 3) { results.push(toolResult(u.id, "This field already failed 3 times. Skip it, or pause_for_user if it is required.", true)); Object.assign(rec, { ok: false, error: "failed 3 times" }); continue; }
    const local = String(input.ref || "").split(":")[1];
    let r;
    switch (u.name) {
      case "fill": r = await act(page, local, "fill", { text: String(input.text ?? "") }); break;
      case "select": r = await act(page, local, "select", { option: String(input.option ?? "") }); break;
      case "check": r = await act(page, local, "check", { checked: !!input.checked }); break;
      case "upload":
        if (input.file !== "resume") { results.push(toolResult(u.id, `No ${input.file} file saved. Skip unless required; if required, ask_user.`, true)); Object.assign(rec, { ok: false, error: "no such file" }); continue; }
        r = await act(page, local, "upload", { file: { name: RESUME_FILE.name, type: RESUME_FILE.type, b64: RESUME_FILE.b64 } });
        break;
      case "fill_secret": r = await act(page, local, "fill", { text: "x", secret: true }); delete r.value; break;
      case "click": {
        const before = await page.evaluate(() => window.ISDom.mark());
        r = await act(page, local, "click", {});
        if (r.blocked) { results.push(toolResult(u.id, `${r.error}. Do not click it. If everything else is complete, call ready_to_submit; otherwise keep filling fields.`, true)); Object.assign(rec, { ok: false, error: "blocked click (final submit)" }); continue; }
        await sleep(300);
        if (r.ok && before === (await page.evaluate(() => window.ISDom.mark()))) r = { ...r, note: "The page looks the same as before the click; the button may not have been wired up yet. Wait a few seconds and click it once more before trying something else." };
        rec.button = t.label;
        break;
      }
      case "wait": results.push(toolResult(u.id, "Waited.")); rec.control = true; continue;
      case "ask_user": stop = { kind: "ask", question: input.question }; rec.control = true; rec.text = input.question; continue;
      case "pause_for_user": stop = { kind: "pause", reason: input.reason }; rec.control = true; rec.text = input.reason; continue;
      case "ready_to_submit":
        if (!snap.hasFinal && !fails.__earlyReady) { fails.__earlyReady = 1; results.push(toolResult(u.id, "No final Submit button is visible yet, so the application is probably not finished. Click Apply / Next / Save and Continue to reach the last page. Call ready_to_submit again only if you are sure nothing is left.", true)); Object.assign(rec, { ok: false, control: true }); continue; }
        stop = { kind: "ready", summary: input.summary, double_check: input.double_check }; rec.control = true;
        results.push(toolResult(u.id, "Marked ready. The human will review and submit."));
        continue;
      default: results.push(toolResult(u.id, `Unknown tool ${u.name}`, true)); Object.assign(rec, { ok: false, error: "unknown tool" }); continue;
    }
    if (!r.ok) { fails[input.ref] = (fails[input.ref] || 0) + 1; rec.ok = false; rec.error = String(r.error || (r.options ? "option not found" : "failed")).slice(0, 120); }
    results.push(toolResult(u.id, r, !r.ok));
  }
  return { results, calls, stop };
}

const valuesOf = (frames) => Object.fromEntries(frames[0].elements.map((e) => [`0:${e.ref}`, e.value]));
const stepRecord = (r, applied) => ({ content: r.content, usage: r.usage, tokens: r.tokens, ms: r.ms, cents: r.cents, later: r.later, stop: r.stop,
  calls: applied.calls, stopKind: applied.stop ? applied.stop.kind : null, stopText: applied.stop ? (applied.stop.question || applied.stop.reason || applied.stop.summary || "") : "" });

// One form under one config: step 1 on the fresh form, the calls applied in Chrome, and for the
// step-2 subset (when step 1 did not end the run) a second step on the page as step 1 left it.
async function runOne(browser, st, cfg, twoSteps) {
  const { loadForm, snapshotFrames } = await import("./bench_page.mjs");
  const store = benchStore();
  const { page } = await loadForm(browser, st.job.apply_url, load("formsHtml")[st.key], factsFor(store, st.job), RESUME_FILE);
  try {
    let frames = await snapshotFrames(page);
    const fails = {};
    let snap = formatSnapshot(frames, fails);
    const expected = st.messages[st.messages.length - 1].content.find((b) => b.text.startsWith("SNAPSHOT")).text;
    const drift = !expected.endsWith(snap.text);
    const msgs = JSON.parse(JSON.stringify(st.messages));
    const r1 = await modelStep(cfg, st.system, msgs);
    const uses1 = r1.content.filter((b) => b.type === "tool_use");
    const a1 = await applyCalls(page, uses1, snap, fails);
    frames = await snapshotFrames(page);
    const out = { drift, step1: stepRecord(r1, a1), after1: valuesOf(frames) };
    if (!twoSteps || a1.stop) return out;
    // agent.js loop: pending results (or the "Continue using the tools" note when there were no
    // calls), fastFill again, a fresh snapshot, history trimmed.
    msgs.push({ role: "assistant", content: r1.content });
    const pre = (await page.evaluate((f, file) => window.ISDom.fastFill(f, file), factsFor(store, st.job), RESUME_FILE)) || [];
    frames = await snapshotFrames(page);
    snap = formatSnapshot(frames, fails);
    const content = [...a1.results];
    if (!uses1.length) content.push({ type: "text", text: r1.stop === "max_tokens" || r1.stop === "MAX_TOKENS" ? "Your reply was cut off. Use fewer, shorter tool calls per turn." : "Continue using the tools. If only the final submit remains, call ready_to_submit." });
    if (pre.length) content.push({ type: "text", text: preFilledLine(pre, snap.shown) });
    content.push({ type: "text", text: `SNAPSHOT\n${accountLine(store, st.job.apply_url)}\n${snap.text}` });
    msgs.push({ role: "user", content });
    trimHistory(msgs);
    const r2 = await modelStep(cfg, st.system, msgs);
    const a2 = await applyCalls(page, r2.content.filter((b) => b.type === "tool_use"), snap, fails);
    frames = await snapshotFrames(page);
    return { ...out, step2: stepRecord(r2, a2), after2: valuesOf(frames) };
  } finally { await page.close().catch(() => {}); }
}

// --configs=flash-low,haiku-low  --runs=2  --two=10 (forms in the step-2 subset)  --only=formKey  --cap=14.5
async function phaseRun(argv) {
  CAP = Math.round(Number(opt(argv, "cap", "14.5")) * 100);
  const configs = opt(argv, "configs", "flash-low,flash-medium,haiku-low,haiku-medium").split(",");
  const nRuns = Number(opt(argv, "runs", "2")), nTwo = Number(opt(argv, "two", "10")), only = opt(argv, "only", "");
  const conc = Number(opt(argv, "concurrency", "4"));
  for (const c of configs) {
    if (!CONFIGS[c]) throw new Error(`unknown config ${c}`);
    if (!keys()[CONFIGS[c].provider]) throw new Error(`${CONFIGS[c].provider} key missing for ${c}`);
  }
  const steps = load("steps").filter((s) => !only || s.key === only);
  const two = new Set(load("steps").filter((_, i) => i % 3 === 0).slice(0, nTwo).map((s) => s.key));
  const forms = load("forms");
  save("formsHtml", Object.fromEntries(forms.map((f) => [f.key, f.html])));
  const runs = load("runs", {});
  const tasks = [];
  for (const st of steps) for (let run = 1; run <= nRuns; run++) for (const c of configs) {
    if (runs[c] && runs[c][run] && runs[c][run][st.key] && !runs[c][run][st.key].error) continue;
    tasks.push({ st, c, run });
  }
  console.log(`${tasks.length} tasks (${configs.join(", ")}; ${nRuns} runs; step 2 on ${two.size} forms)`);
  const { openBrowser } = await import("./bench_page.mjs");
  const { browser, close } = await openBrowser();
  let done = 0, capHit = false;
  const worker = async () => {
    while (tasks.length && !capHit) {
      const { st, c, run } = tasks.shift();
      let rec;
      try { rec = await runOne(browser, st, CONFIGS[c], two.has(st.key)); }
      catch (e) { if (e.cap) { capHit = true; console.error(e.message); break; } rec = { error: String(e.message).slice(0, 300), refusal: !!e.refusal }; }
      ((runs[c] = runs[c] || {})[run] = runs[c][run] || {})[st.key] = rec;
      save("runs", runs);
      done++;
      const s = spend();
      process.stdout.write(`\r${done} done; spent $${((s.gemini + s.anthropic) / 100).toFixed(2)} (Gemini $${(s.gemini / 100).toFixed(2)}, Anthropic $${(s.anthropic / 100).toFixed(2)})   `);
      if (rec.error) console.error(`\n${c} run ${run} ${st.key}: ${rec.error}`);
    }
  };
  try { await Promise.all(Array.from({ length: conc }, worker)); } finally { await close(); }
  process.stdout.write("\n");
}

// ---------- judge ----------
const JUDGE_SCHEMA = { type: "object", additionalProperties: false, required: ["questions"], properties: { questions: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["ref", "ratings"], properties: { ref: { type: "string" }, ratings: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["answer", "relevance", "truthfulness", "fit", "overall", "invented"], properties: {
      answer: { type: "string" }, relevance: { type: "integer" }, truthfulness: { type: "integer" }, fit: { type: "integer" }, overall: { type: "integer" },
      invented: { type: "array", items: { type: "string" } } } } } } } } } };

const JUDGE_SYSTEM = `You grade answers that AI agents wrote into free-text questions of a real internship application, on behalf of a fictional student. Each question has several anonymous answers labelled with letters, in random order; they come from different systems and you must not guess which. Grade each answer on its own merits against the student's profile (the only facts the agents had) and the job.
Scores are integers 1-5:
- relevance: answers the question asked, for this company and role.
- truthfulness: every claim about the student is supported by the profile (5 = fully grounded; 1 = key claims made up). Reasonable framing and opinions are fine; new employers, numbers, dates, skills, awards, courses or experiences are not.
- fit: length, tone and format suit the field (respects any character limit; plain, specific, first person; not padded, no clichés).
- overall: would a careful student be happy to send it as written?
invented: list each specific claim not supported by the profile (empty list if none).
Return every question and every answer label you were given.`;

function seeded(seed) { let x = 0; for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }

async function phaseJudge(argv) {
  CAP = Math.round(Number(opt(argv, "cap", "14.5")) * 100);
  const steps = load("steps"), key = L.applyKeyFixes(load("key")), runs = load("runs"), judged = load("judge", {});
  const configs = Object.keys(runs);
  const pm = profileForModel(benchStore());
  const dry = { forms: 0, answers: 0, inChars: 0 };
  for (const st of steps) {
    if (judged[st.key] && !argv.includes("--redo")) continue;
    const free = Object.entries(key[st.key] || {}).filter(([, k]) => k.cls === "free").map(([ref, k]) => ({ ref, ...k }));
    if (!free.length) continue;
    const rnd = seeded(st.key);
    const qs = [];
    for (const q of free) {
      const answers = [];
      for (const c of configs) for (const run of Object.keys(runs[c])) {
        const r = runs[c][run][st.key];
        // The whole answer from the call that wrote it (the snapshot cuts a long value at 400 characters).
        const v = r && !r.error ? L.writtenText(r.step1.content, q.ref) ?? r.after1[q.ref] : "";
        if (typeof v === "string" && v.trim()) answers.push({ c, run, text: v });
      }
      for (let i = answers.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [answers[i], answers[j]] = [answers[j], answers[i]]; }
      answers.forEach((a, i) => { a.label = String.fromCharCode(65 + i); });
      if (answers.length) qs.push({ ...q, answers });
    }
    if (!qs.length) continue;
    const field = st.fields.reduce((m, f) => ((m[f.ref] = f), m), {});
    const user = `STUDENT PROFILE (JSON)\n${JSON.stringify(pm)}\n\nJOB\nCompany: ${st.job.company}\nTitle: ${st.job.title}\nLocation: ${st.job.location}\nDescription (start):\n${st.job.description.slice(0, 3000)}\n\n` +
      qs.map((q) => `QUESTION ${q.ref}: "${q.label}"${q.required ? " (required)" : ""}${field[q.ref] && field[q.ref].maxlength ? ` (max ${field[q.ref].maxlength} characters)` : ""}\n` +
        q.answers.map((a) => `Answer ${a.label}:\n${a.text}`).join("\n\n")).join("\n\n=====\n\n");
    if (argv.includes("--dry")) {
      // Rough size only (about 4 characters a token); nothing is sent.
      const n = qs.reduce((a, q) => a + q.answers.length, 0);
      dry.forms++; dry.answers += n; dry.inChars += JUDGE_SYSTEM.length + user.length;
      console.log(`${st.key}: ${qs.length} questions, ${n} answers, ~${Math.round((JUDGE_SYSTEM.length + user.length) / 4)} input tokens`);
      continue;
    }
    const out = await opusJson(JUDGE_SYSTEM, user, JUDGE_SCHEMA);
    const rows = [];
    for (const q of out.questions || []) {
      const mine = qs.find((x) => x.ref === q.ref);
      if (!mine) continue;
      for (const g of q.ratings || []) {
        const a = mine.answers.find((x) => x.label === g.answer);
        if (a) rows.push({ ref: q.ref, label: mine.label, config: a.c, run: a.run, chars: a.text.length, relevance: g.relevance, truthfulness: g.truthfulness, fit: g.fit, overall: g.overall, invented: g.invented, text: a.text });
      }
    }
    judged[st.key] = rows;
    save("judge", judged);
    const s = spend();
    console.log(`${st.key}: ${qs.length} questions, ${rows.length} answers graded; spent $${((s.gemini + s.anthropic) / 100).toFixed(2)}`);
  }
  if (argv.includes("--dry")) {
    // Output: the ratings JSON (about 120 tokens an answer) plus adaptive thinking at effort high,
    // assumed here at up to 6,000 tokens a form.
    const inTok = dry.inChars / 4, outTok = dry.answers * 120 + dry.forms * 6000;
    console.log(`${dry.forms} forms, ${dry.answers} answers: ~${Math.round(inTok)} input / ~${Math.round(outTok)} output tokens, about $${((inTok * L.OPUS.input + outTok * L.OPUS.output) / 1e6).toFixed(2)} on Claude Opus 5.5`);
  }
}

export const PHASES = { key: phaseKey, run: phaseRun, judge: phaseJudge, report: (argv) => import("./bench_report.mjs").then((m) => m.report(argv)) };
export { CONFIGS as configs, spend };
