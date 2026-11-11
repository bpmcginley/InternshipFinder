// Gemini generateContent client. Takes and returns the same message shapes as claude.js
// (text / document / tool_use / tool_result blocks), so the agent and Deep Dive stay provider-agnostic.
// The key never leaves the extension except to generativelanguage.googleapis.com. In InternScout mode the same
// body goes to the Worker (no key in the extension) and the reply is parsed the same way.
import { abortableSleep as sleep, throwIfAborted } from "./abort.js";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const THINKING_RESERVE = 8192; // Gemini counts thinking tokens against maxOutputTokens

const textOfSystem = (system) =>
  Array.isArray(system) ? system.map((b) => b.text).join("\n\n") : String(system || "");

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
      parts.push({
        functionCall: { name: b.name, id: b.id, args: b.input || {} },
        ...(b._sig ? { thoughtSignature: b._sig } : {}),
      });
    } else if (b.type === "tool_result") {
      const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      parts.push({
        functionResponse: {
          name: idToName[b.tool_use_id] || "tool",
          id: b.tool_use_id,
          response: b.is_error ? { error: out } : { result: out },
        },
      });
    }
  }
  return parts;
}

function toContents(messages) {
  const idToName = {};
  for (const m of messages)
    for (const b of Array.isArray(m.content) ? m.content : [])
      if (b.type === "tool_use") idToName[b.id] = b.name;
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
      content.push({
        type: "tool_use",
        id: p.functionCall.id || `g${Date.now().toString(36)}_${n++}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
        ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}),
      });
    } else if (p.text != null || p.thoughtSignature) {
      content.push({
        type: "text",
        text: p.text || "",
        ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}),
      });
    }
  }
  const fr = cand.finishReason;
  const stop_reason =
    fr === "MAX_TOKENS"
      ? "max_tokens"
      : content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : "end_turn";
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
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }
  return body;
}

export async function callGemini({
  apiKey,
  model,
  system,
  messages,
  tools,
  max_tokens = 4096,
  thinking,
  signal,
}) {
  if (!apiKey) throw new Error("No Gemini API key. Open Auto-Apply setup → Setup.");
  const body = buildGeminiBody({ system, messages, tools, max_tokens, thinking });
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    throwIfAborted(signal);
    let res;
    try {
      res = await fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (signal?.aborted || e.name === "AbortError") throw e;
      lastErr = e.message;
      await sleep(1500 * 2 ** attempt, signal);
      continue;
    }
    throwIfAborted(signal);
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status}`;
      await sleep(2000 * 2 ** attempt, signal);
      continue;
    }
    const data = await res.json().catch((e) => {
      if (signal?.aborted || e.name === "AbortError") throw e;
      return {};
    });
    throwIfAborted(signal);
    if (!res.ok)
      throw new Error(
        `Gemini API ${res.status}: ${(data.error && data.error.message) || "request failed"}`,
      );
    return fromResponse(data);
  }
  throw new Error(`Gemini API unavailable (${lastErr}). Try again shortly.`);
}

// ---------- InternScout Worker (worker/API.md → POST /ai) ----------
export const WORKER_TASKS = [
  "resume_tailor",
  "autofill",
  "deep_dive",
  "field_match",
  "short_answer",
];
// Call-site kind → Worker task. agent = Auto-Apply steps, tailor = tailored resume, deep_dive = Deep Dive
// (resume reading, interview, stories, voice), test = the tiny "Reply OK" check.
const KIND_TASK = {
  agent: "autofill",
  tailor: "resume_tailor",
  deep_dive: "deep_dive",
  test: "short_answer",
  field_match: "field_match",
  short_answer: "short_answer",
};
export const taskFor = (kind) => KIND_TASK[kind] || "short_answer";

export function buildWorkerRequest({ task, run_id, ...opts }) {
  if (!WORKER_TASKS.includes(task)) throw new Error(`Unknown InternScout task: ${task}`);
  return { task, ...(run_id ? { run_id } : {}), request: buildGeminiBody(opts) };
}

const SIGN_IN_HINT =
  "Sign in with Google or Microsoft in the InternScout popup or Auto-Apply setup → Setup";
const OWN_KEY_HINT = "or add your own key under Auto-Apply setup → Setup → Advanced";

// Turns a Worker error reply into an Error with .code and a message a student can act on.
export function workerError(status, data = {}) {
  const code =
    data.error ||
    (status === 401
      ? "auth"
      : status === 503
        ? "paused"
        : status === 429
          ? "rate"
          : status >= 500
            ? "upstream"
            : "bad_request");
  let msg,
    offer = null;
  // The cap code/reset/offer are shared by monthly, per-run and spend limits. Only this
  // exact Worker response identifies the allowance (including a disabled zero limit).
  const allowanceLimited =
    code === "cap" &&
    data.task === "autofill" &&
    data.message === "Monthly autofill allowance is used up";
  if (code === "auth") msg = `${SIGN_IN_HINT} to use AI features, then try again.`;
  else if (code === "cap") {
    const label =
      {
        resume_tailor: "tailored-resume",
        autofill: "Auto-Apply",
        deep_dive: "Deep Dive",
        field_match: "field-matching",
        short_answer: "short-answer",
      }[data.task] || "AI";
    const resets = data.resets
      ? ` It resets ${new Date(data.resets).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}.`
      : "";
    // The Worker sets `upgrade` only when the Supporter plan is switched on, so we never advertise
    // a plan that doesn't exist.
    // was: const more = data.upgrade ? " To raise it, open the InternScout dashboard and press Upgrade, or " : " To keep going now, ";
    // Since 2026-09-30 the Worker also names the next plan and what it gives this student (limits.js
    // upgradeOffer), so say that instead of a bare "Upgrade"; the job card adds a button for it.
    const units =
      data.upgrade && data.resets && data.offer && data.offer.allowance
        ? data.offer.allowance[data.task]
        : null;
    if (units)
      offer = {
        plan: data.offer.plan,
        label: data.offer.label || data.offer.plan,
        price: data.offer.price || "",
        units,
      };
    const more = offer
      ? ` ${offer.label}${offer.price ? ` (${offer.price})` : ""} gives you ${offer.units} a month: upgrade on the InternScout dashboard. Or, to keep going now, `
      : data.upgrade
        ? " To raise it, open the InternScout dashboard and press Upgrade, or "
        : " To keep going now, ";
    // The Worker says which tier hit the cap; a student who already has the .edu allowance is not told to get one.
    const edu = data.tier === "edu" ? "" : " Accounts with a school .edu email get twice as much.";
    msg = data.resets
      ? `You've used this month's free ${label} allowance.${resets}${edu}${more}${OWN_KEY_HINT.replace(/^or /, "")}.`
      : `This run hit its AI call limit${data.message ? ` (${data.message})` : ""}. Finish it by hand, ${OWN_KEY_HINT}.`;
    if (allowanceLimited)
      msg =
        "Auto-Apply cannot start another run with this account's current allowance. Open the dashboard to check your allowance and available options, or finish this application by hand.";
    else if (data.message === "This run reached its call limit")
      msg = `This run reached its AI call limit. Finish it by hand, ${OWN_KEY_HINT}.`;
    else if (data.message === "This account reached its monthly AI ceiling")
      msg = `This account reached its monthly AI spending limit. Finish this application by hand, ${OWN_KEY_HINT}.`;
  } else if (code === "rate")
    msg = `Too many AI calls in a short time. Wait ${data.retry_after ? `${data.retry_after} seconds` : "a minute"}, then try again.`;
  // Not this student's own limit: everyone's calls together hit the server's per-minute ceiling. Say so,
  // or they read it as a punishment and cut back for no reason.
  else if (code === "busy")
    msg = `InternScout is busy right now: too many students are using AI this minute. It should clear in ${data.retry_after ? `${data.retry_after} seconds` : "a minute"}.`;
  else if (code === "paused")
    msg = `InternScout AI is paused for everyone until the monthly budget resets. Search still works; to keep applying, ${OWN_KEY_HINT.replace(/^or /, "")}.`;
  else if (code === "upstream") msg = "The AI service had a problem. Try again shortly.";
  else
    msg = `InternScout rejected the request (${status}${data.message ? `: ${data.message}` : ""}).`;
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  e.allowanceLimited = allowanceLimited;
  if (offer) e.offer = offer;
  if (data.retry_after) e.retry_after = +data.retry_after;
  return e;
}

// Codes that should pause a job for the student rather than fail it.
// "busy" is here as the backstop: callWorker already waits out a surge, so a job only gets this far
// when the server stayed busy across every retry. Pausing keeps the run resumable; failing loses it.
export const NEEDS_YOU_CODES = new Set(["auth", "cap", "rate", "paused", "busy"]);

// Puts a streamed Gemini reply back together as one generateContent reply, so fromResponse reads it
// like any other. Each chunk carries a few parts; text that was split across chunks is joined again.
// A part with a thoughtSignature closes the text before it, because the signature belongs to that part.
export function stitchChunks(chunks) {
  const parts = [];
  let finishReason,
    usageMetadata,
    promptFeedback,
    seen = false;
  for (const c of chunks) {
    if (!c || typeof c !== "object" || Array.isArray(c))
      throw new Error("Invalid Gemini stream chunk");
    if (c.error) throw new Error("Gemini stream error");
    if (c.candidates !== undefined && !Array.isArray(c.candidates))
      throw new Error("Invalid Gemini candidates");
    if (c.usageMetadata) usageMetadata = c.usageMetadata;
    if (c.promptFeedback) promptFeedback = c.promptFeedback;
    const cand = (c.candidates || [])[0];
    if (!c.candidates?.length) continue;
    if (
      !cand ||
      typeof cand !== "object" ||
      Array.isArray(cand) ||
      (cand.finishReason !== undefined && typeof cand.finishReason !== "string")
    )
      throw new Error("Invalid Gemini candidate");
    if (
      cand.content !== undefined &&
      (!cand.content || typeof cand.content !== "object" || Array.isArray(cand.content))
    )
      throw new Error("Invalid Gemini content");
    const candidateParts = cand.content?.parts;
    if (candidateParts !== undefined && !Array.isArray(candidateParts))
      throw new Error("Invalid Gemini parts");
    seen = true;
    // Later candidate content cannot inherit an earlier terminal marker. Usage-only trailers can.
    finishReason = cand.finishReason;
    for (const p of candidateParts || []) {
      if (
        !p ||
        typeof p !== "object" ||
        Array.isArray(p) ||
        (p.text != null && typeof p.text !== "string")
      )
        throw new Error("Invalid Gemini part");
      if (p.thought) continue;
      const last = parts[parts.length - 1];
      const plain = (x) => x && x.text != null && !x.functionCall;
      if (plain(p) && plain(last) && !last.thoughtSignature) {
        last.text += p.text;
        if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
      } else parts.push({ ...p });
    }
  }
  return {
    candidates: seen
      ? [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }]
      : [],
    ...(usageMetadata ? { usageMetadata } : {}),
    ...(promptFeedback ? { promptFeedback } : {}),
    complete: !!finishReason,
  };
}

// Technical client ceilings, not claims about operator-configured Worker limits.
export const SSE_LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxEventBytes: 1024 * 1024 });

// Decode complete SSE events, never individual data lines or a truncated last event.
export async function readSSE(
  res,
  { signal, maxBytes = SSE_LIMITS.maxBytes, maxEventBytes = SSE_LIMITS.maxEventBytes } = {},
) {
  throwIfAborted(signal);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > SSE_LIMITS.maxBytes ||
    !Number.isSafeInteger(maxEventBytes) ||
    maxEventBytes < 1 ||
    maxEventBytes > Math.min(maxBytes, SSE_LIMITS.maxEventBytes)
  )
    throw new Error("Invalid SSE limits");
  if (!res.body?.getReader) throw new Error("Missing SSE reader");
  const reader = res.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true }),
    encoder = new TextEncoder();
  const chunks = [];
  let buffer = "",
    lines = [],
    eventBytes = 0,
    total = 0,
    ended = false;
  const dispatch = () => {
    const data = lines.join("\n");
    lines = [];
    eventBytes = 0;
    if (!data.trim()) return;
    if (data.trim() === "[DONE]") {
      ended = true;
      return;
    }
    if (ended) throw new Error("Data after SSE completion");
    const value = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid SSE data");
    chunks.push(value);
  };
  const scan = (piece, final = false) => {
    buffer += piece;
    let end;
    while ((end = buffer.search(/[\r\n]/)) !== -1) {
      if (buffer[end] === "\r" && end + 1 === buffer.length && !final) break;
      const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + width);
      eventBytes += encoder.encode(line).byteLength + width;
      if (eventBytes > maxEventBytes) throw new Error("SSE event too large");
      if (!line) {
        dispatch();
        continue;
      }
      if (line === "data" || line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
    }
    if (eventBytes + encoder.encode(buffer).byteLength > maxEventBytes)
      throw new Error("SSE event too large");
    if (final) {
      if (buffer === "data" || buffer.startsWith("data:"))
        lines.push(buffer.slice(5).replace(/^ /, ""));
      // Preserve a harmless final DONE trailer; it never supplies Gemini's finish reason.
      if (lines.length && lines.join("\n").trim() !== "[DONE]")
        throw new Error("Incomplete SSE event");
    }
  };
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const cancelReader = (reason) => {
    try {
      void Promise.resolve(reader.cancel(reason)).catch(() => {});
    } catch {}
  };
  const abort = () => {
    const reason = signal.reason || new DOMException("The request was canceled.", "AbortError");
    rejectAbort(reason);
    cancelReader(reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(signal);
    const read = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error("Invalid SSE bytes");
        total += value.byteLength;
        if (total > maxBytes) throw new Error("SSE body too large");
        scan(decoder.decode(value, { stream: true }));
      }
      scan(decoder.decode(), true);
      throwIfAborted(signal);
      return chunks;
    };
    // One abort race for the operation, not one retained reaction per incoming chunk.
    return await Promise.race([read(), aborted]);
  } finally {
    signal?.removeEventListener("abort", abort);
    cancelReader();
    try {
      reader.releaseLock();
    } catch {}
  }
}

const isSSE = (res) =>
  /event-stream/i.test((res.headers && res.headers.get && res.headers.get("content-type")) || "");

// Sends the same Gemini body to WORKER_URL/ai and parses the reply with the Gemini parser.
// refreshToken(rejected): called once after a 401 with the token the Worker refused; returns a new token or null.
//
// The call asks for a streamed reply (?stream=1). Chrome ends an extension service worker whose
// fetch has had no response for 30 seconds, and a tailored resume or a Deep Dive step can take longer
// than that to finish. A stream answers as soon as Gemini starts, and the pieces are joined here.
// Errors (401, 429, 503...) still come back as plain JSON, exactly as before.
export async function callWorker({
  url,
  token,
  refreshToken,
  task,
  run_id,
  signal,
  fetchImpl = fetch,
  sleepImpl = sleep,
  ...opts
}) {
  if (!token) throw workerError(401, { error: "auth" });
  const body = JSON.stringify(buildWorkerRequest({ task, run_id, ...opts }));
  const maxAttempts = 4;
  let refreshed = false,
    lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const hasNextAttempt = attempt + 1 < maxAttempts;
    throwIfAborted(signal);
    let res;
    try {
      res = await fetchImpl(`${url}/ai?stream=1`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
      });
    } catch (e) {
      if (signal?.aborted || e.name === "AbortError") throw e;
      lastErr = workerError(502, { error: "upstream" });
      if (hasNextAttempt) await sleepImpl(1500 * 2 ** attempt, signal);
      continue;
    }
    throwIfAborted(signal);
    if (res.ok && isSSE(res)) {
      let whole;
      try {
        whole = stitchChunks(await readSSE(res, { signal }));
      } catch (e) {
        if (signal?.aborted || e.name === "AbortError") throw e;
        whole = null;
      }
      throwIfAborted(signal);
      // A stream that stopped before Gemini said it was finished is a dropped connection, not an
      // answer: half a tool call or half a resume must not be acted on. Try again like any 502.
      if (!whole || (!whole.complete && (whole.candidates.length || !whole.promptFeedback))) {
        lastErr = workerError(502, { error: "upstream" });
        if (hasNextAttempt) await sleepImpl(1500 * 2 ** attempt, signal);
        continue;
      }
      return fromResponse(whole);
    }
    const data = await res.json().catch((e) => {
      if (signal?.aborted || e.name === "AbortError") throw e;
      return {};
    });
    throwIfAborted(signal);
    if (res.ok) return fromResponse(data);
    const err = workerError(res.status, data);
    if (err.code === "auth" && !refreshed && refreshToken) {
      refreshed = true;
      token = await refreshToken(token).catch(() => null); // gets the rejected token, so a dead session can be dropped
      if (!token) throw err;
      attempt--;
      continue;
    }
    // "busy" waits up to a full minute, unlike "rate": the global bucket always empties at the minute
    // boundary, so the wait is bounded and the student did nothing wrong to have to sit out.
    if (
      (err.code === "rate" && (err.retry_after || 0) <= 30) ||
      (err.code === "busy" && (err.retry_after || 0) <= 60) ||
      err.code === "upstream"
    ) {
      lastErr = err;
      if (hasNextAttempt)
        await sleepImpl(err.retry_after ? err.retry_after * 1000 : 2000 * 2 ** attempt, signal);
      continue;
    }
    throw err;
  }
  throw lastErr || workerError(502, { error: "upstream" });
}
