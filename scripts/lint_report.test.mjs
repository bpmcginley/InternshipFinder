import assert from "node:assert/strict";
import test from "node:test";
import { sanitize } from "./lint_report.mjs";
import { getFileInfo } from "prettier";

test("Ruff findings omit source, fix content, messages, and outside paths", () => {
  const result = sanitize("python", [{ filename: "backend/internscout/config.py", code: "F701",
    location: { row: 3, column: 4 }, message: "private-sentinel", fix: { content: "private-sentinel" } },
  { filename: "../private-sentinel.py", code: "private-sentinel", message: "private-sentinel" }]);
  assert.deepEqual(result[0], { file: "backend/internscout/config.py", line: 3, column: 4,
    severity: "error", rule: "F701" });
  assert.ok(!JSON.stringify(result).includes("private-sentinel"));
});

test("ESLint findings omit messages, suggestions, source, and exception values", () => {
  const result = sanitize("javascript", [{ filePath: "worker/src/index.js", source: "private-sentinel",
    messages: [{ ruleId: "valid-typeof", severity: 2, line: 5, column: 6,
      message: "private-sentinel", suggestions: [{ fix: "private-sentinel" }] }] }]);
  assert.deepEqual(result, [{ file: "worker/src/index.js", line: 5, column: 6,
    severity: "error", rule: "valid-typeof" }]);
  assert.ok(!JSON.stringify(result).includes("private-sentinel"));
});

test("unusable linter reports are rejected", () => {
  assert.throws(() => sanitize("python", {}));
  assert.throws(() => sanitize("javascript", [{}]));
});

test("the future formatter excludes the guard and every guard-exercising test", async () => {
  const files = ["extension/agent/guard.js", "extension/test/guard.test.mjs",
    "extension/test/guard_review_consent.test.mjs", "extension/test/guard_filled_spa.test.mjs",
    "extension/test/ats_forms.test.mjs", "extension/test/dom_halt.test.mjs",
    "extension/test/fastfill_facts.test.mjs", "extension/test/workday_takeover.test.mjs",
    "extension/test/agent_prompt.test.mjs", "extension/test/agent_takeover.test.mjs",
    "extension/test/worker.test.mjs", "extension/test/eval_compare.test.mjs",
    "extension/test/form_bench.test.mjs", "extension/test/selector_takeover.test.mjs",
    "extension/test/batch_focus.test.mjs",
    "extension/vendor/example.js", "docs/js/example.min.js", "MuseWork.md"];
  for (const file of files) {
    assert.equal((await getFileInfo(file, { ignorePath: ".prettierignore" })).ignored, true, file);
  }
});
