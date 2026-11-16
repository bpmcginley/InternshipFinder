import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG } from "../../worker/src/config.js";
import { acceptLiteReply, buildLiteRequest, exactOption, fixtures } from "./field_match.mjs";

test("rules and validated Lite agree across exact, ambiguous and unknown fixture outcomes", () => {
  const existingFlashFlow = Symbol("existing Auto-Apply flow");
  const choose = (field, index) =>
    index === null ? existingFlashFlow : field.options[index].label;
  for (const field of fixtures) {
    const expected = choose(field, field.expected);
    assert.equal(choose(field, exactOption(field)), expected, field.name);
    const providerReply = JSON.stringify({ index: field.expected ?? -1 });
    assert.equal(choose(field, acceptLiteReply(providerReply, field, field)), expected, field.name);
    assert.equal(Boolean(buildLiteRequest(field)), field.expected !== null, field.name);
  }
});

test("candidate sends only the confirmed value and enabled option labels through field_match", () => {
  const field = {
    confirmed: true,
    value: "Boston",
    options: [
      { label: "Please select" },
      { label: "Boston", disabled: true },
      { label: "Cambridge" },
      { label: "Boston" },
    ],
    profile: "Fictional context outside the candidate request",
  };
  const request = buildLiteRequest(field);
  assert.deepEqual(JSON.parse(request.contents[0].parts[0].text), {
    value: "Boston",
    choices: [
      { index: 2, label: "Cambridge" },
      { index: 3, label: "Boston" },
    ],
  });
  assert.equal(CONFIG.TASKS.field_match.model, "gemini-3.5-flash-lite");
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
  assert.equal(request.generationConfig.maxOutputTokens, 32);
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(request.tools, undefined);
});

test("refuses wrong, missing and malformed output instead of returning a field choice", () => {
  const field = fixtures[0];
  for (const text of [
    '{"index":0}',
    '{"index":-1}',
    '{"index":"1"}',
    '{"index":1,"action":"click"}',
    '{"index":100}',
    '{"index":',
    "null",
    "",
  ]) {
    assert.equal(acceptLiteReply(text, field, field), null, text);
  }
});

test("refuses stale evidence before an option could be selected", () => {
  const field = fixtures[0];
  const fresh = [
    { ...field, confirmed: false },
    { ...field, value: "Connecticut" },
    { ...field, options: field.options.toReversed() },
    { ...field, options: [...field.options, { label: "Maine" }] },
    { ...field, options: [field.options[0], { label: "Massachusetts", disabled: true }] },
  ];
  for (const current of fresh) {
    assert.equal(acceptLiteReply('{"index":1}', field, current), null);
  }
  assert.equal(acceptLiteReply('{"index":1}', field, structuredClone(field)), 1);
});
