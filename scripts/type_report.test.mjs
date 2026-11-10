import assert from "node:assert/strict";
import test from "node:test";
import { pythonDiagnostics, summarize, workerDiagnostics } from "./type_report.mjs";

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
  const result = workerDiagnostics("worker/src/index.js(12,8): error TS2345: private-test-sentinel\n  private-test-sentinel\n");
  assert.deepEqual(result, [{ file: "worker/src/index.js", line: 12, column: 8,
    severity: "error", rule: "TS2345" }]);
  assert.equal(summarize("typescript", result).errors, 1);
});

test("configuration failures and outside diagnostic paths are not accepted as clean reports", () => {
  assert.throws(() => workerDiagnostics("error TS5023: private-test-sentinel"));
  assert.throws(() => workerDiagnostics("outside/private-test-sentinel.js(1,1): error TS1: hidden"));
  assert.throws(() => pythonDiagnostics({}));
  const result = pythonDiagnostics({ summary: {}, generalDiagnostics: [{
    file: "../private-test-sentinel.py", severity: "private-test-sentinel", rule: "private-test-sentinel",
  }] });
  assert.ok(!JSON.stringify(result).includes("private-test-sentinel"));
});
