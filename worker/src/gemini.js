// Gemini paid-tier calls: clean the client's body, call the task's model, price the usage.
// Request and reply text pass through memory only; nothing here stores or logs them.
import { HttpError } from "./http.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const LEVELS = ["minimal", "low", "medium", "high"];
const GEN_KEYS = ["temperature", "topP", "topK", "stopSequences", "responseMimeType", "responseSchema",
  "responseJsonSchema", "presencePenalty", "frequencyPenalty", "seed"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// What a part may carry. Everything the extension sends is here. What is not: fileData, whose fileUri
// makes Gemini fetch a file or a video by reference, so a 200-byte request could cost a million input
// tokens and no body-size limit would notice; and executableCode and friends, which we never use.
function cleanPart(part) {
  if (!isObj(part)) return null;
  const out = {};
  if (typeof part.text === "string") out.text = part.text;
  if (isObj(part.inlineData) && typeof part.inlineData.data === "string") {
    out.inlineData = { mimeType: String(part.inlineData.mimeType || ""), data: part.inlineData.data };
  }
  if (isObj(part.functionCall)) {
    const { name, id, args } = part.functionCall;
    out.functionCall = { name, ...(id != null ? { id } : {}), args: isObj(args) ? args : {} };
  }
  if (isObj(part.functionResponse)) {
    // `response` only: a function response can also carry parts of its own, fileData among them.
    const { name, id, response } = part.functionResponse;
    out.functionResponse = { name, ...(id != null ? { id } : {}), response: isObj(response) ? response : {} };
  }
  if (!Object.keys(out).length) return null;
  if (typeof part.thoughtSignature === "string") out.thoughtSignature = part.thoughtSignature;
  if (part.thought === true) out.thought = true;
  return out;
}

function cleanContent(c) {
  if (!isObj(c) || !Array.isArray(c.parts)) return null;
  const parts = c.parts.map(cleanPart).filter(Boolean);
  if (!parts.length) return null;
  return { ...(typeof c.role === "string" ? { role: c.role } : {}), parts };
}

// Keeps only contents, systemInstruction, tools, toolConfig and generationConfig; clamps tokens and thinking.
export function sanitizeRequest(body, task, config) {
  const cfg = config.TASKS[task];
  const contents = isObj(body) && Array.isArray(body.contents) ? body.contents.map(cleanContent).filter(Boolean) : [];
  if (contents.length === 0) {
    throw new HttpError(400, "bad_request", "request.contents must be a non-empty array");
  }
  const out = { contents };
  const sys = cleanContent(body.systemInstruction);
  if (sys) out.systemInstruction = sys;

  // Function tools only: Google Search grounding and similar tools are billed per use
  if (Array.isArray(body.tools)) {
    const tools = body.tools
      .filter((t) => isObj(t) && Array.isArray(t.functionDeclarations))
      .map((t) => ({ functionDeclarations: t.functionDeclarations }));
    if (tools.length) out.tools = tools;
  }
  if (out.tools && isObj(body.toolConfig)) out.toolConfig = body.toolConfig;

  const src = isObj(body.generationConfig) ? body.generationConfig : {};
  const gen = {};
  for (const k of GEN_KEYS) if (k in src) gen[k] = src[k];
  const asked = Math.floor(Number(src.maxOutputTokens));
  gen.maxOutputTokens = asked > 0 ? Math.min(asked, cfg.maxOutputTokens) : cfg.maxOutputTokens;
  gen.thinkingConfig = clampThinking(src.thinkingConfig, cfg, config.THINKING_LEVELS[cfg.model]);
  out.generationConfig = gen;
  return out;
}

// Always sends a thinking setting so a model's default can't exceed the task ceiling.
function clampThinking(tc, cfg, levels) {
  tc = isObj(tc) ? tc : {};
  const out = {};
  if (tc.includeThoughts === true) out.includeThoughts = true;
  if (levels) {
    const ceil = LEVELS.indexOf(cfg.thinkingLevel);
    let want = LEVELS.indexOf(String(tc.thinkingLevel || "").toLowerCase());
    if (want < 0 || want > ceil) want = ceil;
    // step up to the lowest level this model accepts
    out.thinkingLevel = LEVELS.slice(want).find((l) => levels.includes(l)) || levels[0];
  } else {
    const asked = Math.floor(Number(tc.thinkingBudget));
    out.thinkingBudget = asked >= 0 ? Math.min(asked, cfg.thinkingBudget) : cfg.thinkingBudget;
  }
  return out;
}

export function geminiUrl(model, stream) {
  return BASE + encodeURIComponent(model) + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent");
}

export async function callGemini(model, body, stream, env, fetcher) {
  if (!env.GEMINI_API_KEY) throw new HttpError(500, "server", "Server is missing GEMINI_API_KEY");
  let res;
  try {
    res = await fetcher(geminiUrl(model, stream), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, "upstream", "Gemini could not be reached");
  }
  if (!res.ok) {
    let status = "";
    try {
      status = (await res.json())?.error?.status || "";
    } catch {}
    throw new HttpError(502, "upstream", `Gemini failed (${res.status}${status ? " " + status : ""})`);
  }
  return res;
}

export function priceFor(model, config, date) {
  const rows = config.PRICES[model];
  if (!rows) return config.FALLBACK_PRICE;
  const day = date.toISOString().slice(0, 10);
  return rows.find((r) => !r.until || day < r.until) || rows[rows.length - 1];
}

// Cents for one call from its usageMetadata
export function costCents(model, usage, config, date) {
  if (!isObj(usage)) return 0;
  const p = priceFor(model, config, date);
  const n = (k) => Math.max(0, Number(usage[k]) || 0);
  const cached = Math.min(n("cachedContentTokenCount"), n("promptTokenCount"));
  const input = n("promptTokenCount") - cached + n("toolUsePromptTokenCount");
  const output = n("candidatesTokenCount") + n("thoughtsTokenCount");
  return ((input * p.input + cached * p.cached + output * p.output) / 1e6) * 100;
}

// No usageMetadata (a cut-off stream): assume ~4 bytes per input token and a full-length reply
export function estimateCents(model, bodyBytes, maxOutputTokens, config, date) {
  return costCents(model, { promptTokenCount: Math.ceil(bodyBytes / 4), candidatesTokenCount: maxOutputTokens }, config, date);
}

// Reads an SSE stream to the end and returns the last usageMetadata (each chunk carries the running total).
export async function readUsageFromSSE(stream) {
  let usage = null;
  let buf = "";
  const scan = (line) => {
    if (!line.startsWith("data:")) return;
    try {
      const u = JSON.parse(line.slice(5)).usageMetadata;
      if (u) usage = u;
    } catch {}
  };
  try {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(scan);
    }
    scan(buf);
  } catch {}
  return usage;
}
