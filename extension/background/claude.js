// Minimal Anthropic Messages API client (raw fetch; MV3 cannot load the SDK from a CDN and the
// extension has no bundler). The key never leaves the extension except to api.anthropic.com.
import { callGemini, callWorker, taskFor } from "./gemini.js";
import { recordUsage } from "../lib/usage.js";
import { WORKER_URL } from "../lib/config.js";
import { ensureToken } from "../lib/auth.js";

const URL = "https://api.anthropic.com/v1/messages";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// provider "internscout": the InternScout Worker with the Google/Microsoft sign-in token. Not billed to the student,
// so nothing is added to the local spend meter. task defaults from kind (see taskFor); run_id groups the
// calls of one Auto-Apply or Deep Dive run into one allowance unit.
// Otherwise routes by model id: gemini-* goes to Google with the Gemini key, everything else to Anthropic.
// Every own-key call is priced and added to the monthly total; the cost comes back as resp.cost_usd.
export async function callAI({ ai, model, kind, task, run_id, ...opts }) {
  if (ai && ai.provider === "internscout") {
    const resp = await callWorker({ url: WORKER_URL, token: await ensureToken(), refreshToken: ensureToken, task: task || taskFor(kind), run_id, ...opts });
    resp.cost_usd = 0;
    return resp;
  }
  const resp = String(model).startsWith("gemini")
    ? await callGemini({ apiKey: ai.geminiKey, model, ...opts })
    : await callClaude({ apiKey: ai.apiKey, model, ...opts });
  try { resp.cost_usd = await recordUsage(model, resp.usage, kind); } catch (e) { resp.cost_usd = 0; }
  return resp;
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
