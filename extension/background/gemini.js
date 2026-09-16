// Gemini generateContent client. Takes and returns the same message shapes as claude.js
// (text / document / tool_use / tool_result blocks), so the agent and Deep Dive stay provider-agnostic.
// The key never leaves the extension except to generativelanguage.googleapis.com. In InternScout mode the same
// body goes to the Worker (no key in the extension) and the reply is parsed the same way.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THINKING_RESERVE = 8192; // Gemini counts thinking tokens against maxOutputTokens

const textOfSystem = (system) => (Array.isArray(system) ? system.map((b) => b.text).join("\n\n") : String(system || ""));

function partsOf(content, idToName) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts = [];
  for (const b of content || []) {
    if (b.type === "text") {
      if (b.text) parts.push({ text: b.text, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
    } else if (b.type === "document" || b.type === "image") {
      const src = b.source || {};
      if (src.type === "base64") {
        if (b.title) parts.push({ text: `[${b.title}]` });
        parts.push({ inlineData: { mimeType: src.media_type, data: src.data } });
      } else if (src.type === "text") {
        parts.push({ text: `${b.title ? `[${b.title}]\n` : ""}${src.data}` });
      }
    } else if (b.type === "tool_use") {
      parts.push({ functionCall: { name: b.name, id: b.id, args: b.input || {} }, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
    } else if (b.type === "tool_result") {
      const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      parts.push({ functionResponse: { name: idToName[b.tool_use_id] || "tool", id: b.tool_use_id, response: b.is_error ? { error: out } : { result: out } } });
    }
  }
  return parts;
}

function toContents(messages) {
  const idToName = {};
  for (const m of messages) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "tool_use") idToName[b.id] = b.name;
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = partsOf(m.content, idToName);
    if (!parts.length) continue;
    // Function responses must come first in their turn; keep consecutive same-role turns merged.
    parts.sort((a, b) => (b.functionResponse ? 1 : 0) - (a.functionResponse ? 1 : 0));
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

function fromResponse(data) {
  const cand = (data.candidates || [])[0];
  if (!cand) {
    const why = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(`Gemini returned no answer${why ? ` (blocked: ${why})` : ""}.`);
  }
  const content = [];
  let n = 0;
  for (const p of (cand.content && cand.content.parts) || []) {
    if (p.thought) continue;
    if (p.functionCall) {
      content.push({ type: "tool_use", id: p.functionCall.id || `g${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}) });
    } else if (p.text != null || p.thoughtSignature) {
      content.push({ type: "text", text: p.text || "", ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}) });
    }
  }
  const fr = cand.finishReason;
  const stop_reason = fr === "MAX_TOKENS" ? "max_tokens" : content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  return { content, stop_reason, usage: data.usageMetadata };
}

// Gemini generateContent body (no model). Shared by direct-key calls and the InternScout Worker.
export function buildGeminiBody({ system, messages, tools, max_tokens = 4096, thinking }) {
  const body = {
    contents: toContents(messages),
    generationConfig: {
      maxOutputTokens: Math.min(max_tokens + THINKING_RESERVE, 64000),
      thinkingConfig: { thinkingLevel: thinking ? "high" : max_tokens <= 64 ? "low" : "medium" },
    },
  };
  const sys = textOfSystem(system);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (tools && tools.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
  }
  return body;
}

export async function callGemini({ apiKey, model, system, messages, tools, max_tokens = 4096, thinking, signal }) {
  if (!apiKey) throw new Error("No Gemini API key. Open Deep Dive → Setup.");
  const body = buildGeminiBody({ system, messages, tools, max_tokens, thinking });
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e.message;
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status}`;
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(data.error && data.error.message) || "request failed"}`);
    return fromResponse(data);
  }
  throw new Error(`Gemini API unavailable (${lastErr}). Try again shortly.`);
}

// ---------- InternScout Worker (worker/API.md → POST /ai) ----------
export const WORKER_TASKS = ["resume_tailor", "autofill", "deep_dive", "field_match", "short_answer"];
// Call-site kind → Worker task. agent = Auto-Apply steps, tailor = tailored resume, deep_dive = Deep Dive
// (resume reading, interview, stories, voice), test = the tiny "Reply OK" check.
const KIND_TASK = { agent: "autofill", tailor: "resume_tailor", deep_dive: "deep_dive", test: "short_answer", field_match: "field_match", short_answer: "short_answer" };
export const taskFor = (kind) => KIND_TASK[kind] || "short_answer";

export function buildWorkerRequest({ task, run_id, ...opts }) {
  if (!WORKER_TASKS.includes(task)) throw new Error(`Unknown InternScout task: ${task}`);
  return { task, ...(run_id ? { run_id } : {}), request: buildGeminiBody(opts) };
}

const SIGN_IN_HINT = "Sign in with Google or Microsoft in the InternScout popup or Deep Dive → Setup";
const OWN_KEY_HINT = "or add your own key under Deep Dive → Setup → Advanced";

// Turns a Worker error reply into an Error with .code and a message a student can act on.
export function workerError(status, data = {}) {
  const code = data.error || (status === 401 ? "auth" : status === 503 ? "paused" : status === 429 ? "rate" : status >= 500 ? "upstream" : "bad_request");
  let msg;
  if (code === "auth") msg = `${SIGN_IN_HINT} to use AI features, then try again.`;
  else if (code === "cap") {
    const label = { resume_tailor: "tailored-resume", autofill: "Auto-Apply", deep_dive: "Deep Dive", field_match: "field-matching", short_answer: "short-answer" }[data.task] || "AI";
    const resets = data.resets ? ` It resets ${new Date(data.resets).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}.` : "";
    msg = data.resets
      ? `You've used this month's free ${label} allowance.${resets} Accounts with a school .edu email get twice as much. To keep going now, ${OWN_KEY_HINT.replace(/^or /, "")}.`
      : `This run hit its AI call limit${data.message ? ` (${data.message})` : ""}. Finish it by hand, ${OWN_KEY_HINT}.`;
  } else if (code === "rate") msg = `Too many AI calls in a short time. Wait ${data.retry_after ? `${data.retry_after} seconds` : "a minute"}, then try again.`;
  // Not this student's own limit: everyone's calls together hit the server's per-minute ceiling. Say so,
  // or they read it as a punishment and cut back for no reason.
  else if (code === "busy") msg = `InternScout is busy right now — too many students using AI this minute. It should clear in ${data.retry_after ? `${data.retry_after} seconds` : "a minute"}.`;
  else if (code === "paused") msg = `InternScout AI is paused for everyone until the monthly budget resets. Search still works; to keep applying, ${OWN_KEY_HINT.replace(/^or /, "")}.`;
  else if (code === "upstream") msg = "The AI service had a problem. Try again shortly.";
  else msg = `InternScout rejected the request (${status}${data.message ? `: ${data.message}` : ""}).`;
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  if (data.retry_after) e.retry_after = +data.retry_after;
  return e;
}

// Codes that should pause a job for the student rather than fail it.
// "busy" is here as the backstop: callWorker already waits out a surge, so a job only gets this far
// when the server stayed busy across every retry. Pausing keeps the run resumable; failing loses it.
export const NEEDS_YOU_CODES = new Set(["auth", "cap", "rate", "paused", "busy"]);

// Sends the same Gemini body to WORKER_URL/ai and parses the reply with the Gemini parser.
// refreshToken(): called once after a 401; returns a new token or null.
export async function callWorker({ url, token, refreshToken, task, run_id, signal, fetchImpl = fetch, sleepImpl = sleep, ...opts }) {
  if (!token) throw workerError(401, { error: "auth" });
  const body = JSON.stringify(buildWorkerRequest({ task, run_id, ...opts }));
  let refreshed = false, lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${url}/ai`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = workerError(502, { error: "upstream" });
      await sleepImpl(1500 * 2 ** attempt);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return fromResponse(data);
    const err = workerError(res.status, data);
    if (err.code === "auth" && !refreshed && refreshToken) {
      refreshed = true;
      token = await refreshToken().catch(() => null);
      if (!token) throw err;
      attempt--;
      continue;
    }
    // "busy" waits up to a full minute, unlike "rate": the global bucket always empties at the minute
    // boundary, so the wait is bounded and the student did nothing wrong to have to sit out.
    if ((err.code === "rate" && (err.retry_after || 0) <= 30) || (err.code === "busy" && (err.retry_after || 0) <= 60)
        || err.code === "upstream") {
      lastErr = err;
      await sleepImpl(err.retry_after ? err.retry_after * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    throw err;
  }
  throw lastErr || workerError(502, { error: "upstream" });
}
