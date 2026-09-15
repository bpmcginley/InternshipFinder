import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG, FLASH } from "../src/config.js";
import { costCents, readUsageFromSSE, sanitizeRequest } from "../src/gemini.js";

const contents = [{ role: "user", parts: [{ text: "hi" }] }];

test("sanitizer drops unknown fields and paid tools", () => {
  const out = sanitizeRequest({
    contents,
    model: "gemini-3.1-pro-preview",
    safetySettings: [],
    cachedContent: "cachedContents/abc",
    labels: { a: "b" },
    systemInstruction: { parts: [{ text: "be brief" }] },
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "fill" }], codeExecution: {} }],
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
    generationConfig: { temperature: 0.2, candidateCount: 4, responseLogprobs: true, foo: 1, responseMimeType: "application/json" },
  }, "autofill", CONFIG);
  assert.deepEqual(Object.keys(out).sort(), ["contents", "generationConfig", "systemInstruction", "toolConfig", "tools"]);
  assert.deepEqual(out.tools, [{ functionDeclarations: [{ name: "fill" }] }]);
  assert.deepEqual(Object.keys(out.generationConfig).sort(),
    ["maxOutputTokens", "responseMimeType", "temperature", "thinkingConfig"]);

  const noTools = sanitizeRequest({ contents, tools: [{ googleSearch: {} }], toolConfig: {} }, "autofill", CONFIG);
  assert.equal(noTools.tools, undefined);
  assert.equal(noTools.toolConfig, undefined);
});

test("sanitizer clamps output tokens and thinking to the task ceiling", () => {
  const gen = (task, g) => sanitizeRequest({ contents, generationConfig: g }, task, CONFIG).generationConfig;
  assert.equal(gen("autofill", { maxOutputTokens: 999999 }).maxOutputTokens, 4096);
  assert.equal(gen("autofill", { maxOutputTokens: 100 }).maxOutputTokens, 100);
  assert.equal(gen("autofill", {}).maxOutputTokens, 4096);
  assert.equal(gen("autofill", { maxOutputTokens: -5 }).maxOutputTokens, 4096);
  assert.deepEqual(gen("resume_tailor", { thinkingConfig: { thinkingLevel: "HIGH" } }).thinkingConfig, { thinkingLevel: "medium" });
  assert.deepEqual(gen("resume_tailor", { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } }).thinkingConfig,
    { thinkingLevel: "low", includeThoughts: true });
  assert.deepEqual(gen("field_match", {}).thinkingConfig, { thinkingLevel: "minimal" });
  // Flash has no "minimal": a lower request steps up to its lowest level
  assert.deepEqual(gen("autofill", { thinkingConfig: { thinkingLevel: "minimal" } }).thinkingConfig, { thinkingLevel: "low" });

  // a budget-style model (not in THINKING_LEVELS) gets thinkingBudget clamped instead
  const cfg = { ...CONFIG, TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, model: "gemini-2.5-flash" } } };
  const budget = (tc) => sanitizeRequest({ contents, generationConfig: { thinkingConfig: tc } }, "autofill", cfg)
    .generationConfig.thinkingConfig;
  assert.deepEqual(budget({ thinkingBudget: 100000 }), { thinkingBudget: 2048 });
  assert.deepEqual(budget({ thinkingBudget: -1 }), { thinkingBudget: 2048 });
  assert.deepEqual(budget({ thinkingBudget: 512 }), { thinkingBudget: 512 });
});

test("sanitizer rejects a body with no contents", () => {
  for (const bad of [undefined, {}, { contents: [] }, { contents: "hi" }]) {
    assert.throws(() => sanitizeRequest(bad, "autofill", CONFIG), (e) => e.status === 400 && e.code === "bad_request");
  }
});

test("cost uses the dated price row, cache price and a high fallback", () => {
  const usage = { promptTokenCount: 1_000_000, cachedContentTokenCount: 400_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 100_000 };
  const before = costCents(FLASH, usage, CONFIG, new Date("2026-12-31T23:00:00Z"));
  assert.ok(Math.abs(before - (0.6 * 0.75 + 0.4 * 0.075 + 0.2 * 3.75) * 100) < 1e-9);
  const after = costCents(FLASH, usage, CONFIG, new Date("2027-01-01T00:00:00Z"));
  assert.ok(Math.abs(after - (0.6 * 1.5 + 0.4 * 0.15 + 0.2 * 7.5) * 100) < 1e-9);
  assert.ok(costCents("gemini-unknown", usage, CONFIG, new Date()) > after);
  assert.equal(costCents(FLASH, undefined, CONFIG, new Date()), 0);
});

test("SSE reader keeps the last usageMetadata", async () => {
  const text = 'data: {"usageMetadata":{"promptTokenCount":1}}\r\n\r\ndata: {"usageMetadata":{"promptTokenCount":9}}';
  const stream = new Response(text).body;
  assert.deepEqual(await readUsageFromSSE(stream), { promptTokenCount: 9 });
});
