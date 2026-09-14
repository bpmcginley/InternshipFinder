// Minimal Anthropic Messages API client (raw fetch; MV3 cannot load the SDK from a CDN and the
// extension has no bundler). The key never leaves the extension except to api.anthropic.com.
import { callGemini } from "./gemini.js";

const URL = "https://api.anthropic.com/v1/messages";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Routes by model id: gemini-* goes to Google with the Gemini key, everything else to Anthropic.
export function callAI({ ai, model, ...opts }) {
  return String(model).startsWith("gemini")
    ? callGemini({ apiKey: ai.geminiKey, model, ...opts })
    : callClaude({ apiKey: ai.apiKey, model, ...opts });
}

export async function callClaude({ apiKey, model, system, messages, tools, max_tokens = 4096, thinking, signal }) {
  if (!apiKey) throw new Error("No Anthropic API key. Open Deep Dive → Setup.");
  const body = { model, max_tokens, messages };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  if (thinking && !/haiku/.test(model)) body.thinking = thinking;
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(URL, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e.message;
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      lastErr = `${res.status}`;
      const ra = +res.headers.get("retry-after");
      await sleep(ra ? ra * 1000 : 1500 * 2 ** attempt);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(data.error && data.error.message) || "request failed"}`);
    return data;
  }
  throw new Error(`Claude API unavailable (${lastErr}). Try again shortly.`);
}

export const textOf = (resp) => (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

export function jsonOf(resp) {
  const t = textOf(resp);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = fence ? fence[1] : t;
  const a = Math.min(...["{", "["].map((c) => s.indexOf(c)).filter((i) => i >= 0));
  const b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (!isFinite(a) || b < a) throw new Error("No JSON in model reply");
  return JSON.parse(s.slice(a, b + 1));
}
