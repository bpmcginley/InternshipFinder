import assert from "node:assert/strict";
import test from "node:test";
import { javascriptDiagnostics, pythonDiagnostics, summarize } from "./type_report.mjs";

test("Python reports retain locations and rules without messages or unknown fields", () => {
  const result = pythonDiagnostics({ summary: {}, generalDiagnostics: [{
    file: "backend/internscout/config.py", severity: "error", rule: "reportAssignmentType",
    range: { start: { line: 4, character: 2 } }, message: "private-test-sentinel", value: "private-test-sentinel",
  }] });
  assert.deepEqual(result, [{ file: "backend/internscout/config.py", line: 5, column: 3,
    severity: "error", rule: "reportAssignmentType" }]);
  assert.ok(!JSON.stringify(result).includes("private-test-sentinel"));
});

test("TypeScript reports discard source literals and continuation lines", () => {
  const result = javascriptDiagnostics("worker/src/index.js(12,8): error TS2345: private-test-sentinel\n  private-test-sentinel\n", "worker");
  assert.deepEqual(result, [{ file: "worker/src/index.js", line: 12, column: 8,
    severity: "error", rule: "TS2345" }]);
  assert.equal(summarize("typescript", result).errors, 1);
});

test("browser reports keep area-specific JS and MJS locations without messages", () => {
  const site = javascriptDiagnostics(
    "docs/js/app/entry.mjs(8,2): error TS2322: private-test-sentinel\n  private-test-sentinel\n"
      + "docs/widget/builder.js(5,1): error TS2554: private-test-sentinel\n",
    "site",
  );
  const extension = javascriptDiagnostics(
    "extension/background/agent.js(2,4): error TS2304: private-test-sentinel\n",
    "extension",
  );
  assert.deepEqual(site, [
    { file: "docs/js/app/entry.mjs", line: 8, column: 2, severity: "error", rule: "TS2322" },
    { file: "docs/widget/builder.js", line: 5, column: 1, severity: "error", rule: "TS2554" },
  ]);
  assert.deepEqual(extension, [
    { file: "extension/background/agent.js", line: 2, column: 4, severity: "error", rule: "TS2304" },
  ]);
  assert.ok(!JSON.stringify({ site, extension }).includes("private-test-sentinel"));
});

test("TypeScript rejects diagnostics outside the selected production area", () => {
  const misplaced = [
    ["worker", "docs/js/app/entry.mjs"],
    ["site", "extension/background/agent.js"],
    ["site", "docs/js/qrcode.min.js"],
    ["site", "docs/js/app-modules/0123/entry.mjs"],
    ["extension", "worker/src/index.js"],
    ["extension", "extension/test/auth.test.mjs"],
    ["extension", "extension/vendor/mammoth.browser.min.js"],
  ];
  for (const [area, file] of misplaced) {
    assert.throws(() => javascriptDiagnostics(
      file + "(1,2): error TS2304: private-test-sentinel",
      area,
    ), { message: "Unexpected diagnostic path" });
  }
  assert.throws(() => javascriptDiagnostics("", "__proto__"), { message: "Unknown area" });
});

test("configuration failures and outside diagnostic paths are not accepted as clean reports", () => {
  assert.throws(() => javascriptDiagnostics("error TS5023: private-test-sentinel", "worker"));
  assert.throws(() => javascriptDiagnostics("outside/private-test-sentinel.js(1,1): error TS1: hidden", "worker"));
  assert.throws(() => pythonDiagnostics({}));
  const result = pythonDiagnostics({ summary: {}, generalDiagnostics: [{
    file: "../private-test-sentinel.py", severity: "private-test-sentinel", rule: "private-test-sentinel",
  }] });
  assert.ok(!JSON.stringify(result).includes("private-test-sentinel"));
});
