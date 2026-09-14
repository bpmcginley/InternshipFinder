// Gemini generateContent client. Takes and returns the same message shapes as claude.js
// (text / document / tool_use / tool_result blocks), so the agent and Deep Dive stay provider-agnostic.
// The key never leaves the extension except to generativelanguage.googleapis.com.
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

export async function callGemini({ apiKey, model, system, messages, tools, max_tokens = 4096, thinking, signal }) {
  if (!apiKey) throw new Error("No Gemini API key. Open Deep Dive → Setup.");
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
