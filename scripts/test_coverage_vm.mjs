import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { coverageOptions } from "./coverage-vm.mjs";

const source = "globalThis.answer = 6 * 7;";
const files = new Map([[source, "/fixture/answer.js"], ["duplicate", null]]);

test("coverage attributes only exact, unambiguous full sources", () => {
  assert.equal(coverageOptions(source, undefined, files).filename, "/fixture/answer.js");
  for (const code of [source.slice(0, -1), source + "\n", "duplicate", "unknown"]) {
    assert.equal(coverageOptions(code, undefined, files), undefined);
  }
});

test("coverage preserves explicit VM filenames and other options", () => {
  for (const options of ["caller.js", { filename: "caller.js" }, { filename: undefined }, null, false]) {
    assert.equal(coverageOptions(source, options, files), options);
  }
  const options = { timeout: 1000, lineOffset: 3 };
  assert.deepEqual(coverageOptions(source, options, files), { ...options, filename: "/fixture/answer.js" });
  assert.deepEqual(options, { timeout: 1000, lineOffset: 3 });
});

test("filename attribution preserves VM values, state, and thrown errors", () => {
  const plain = {}, covered = {};
  assert.equal(vm.runInNewContext(source, plain), vm.runInNewContext(source, covered, coverageOptions(source, undefined, files)));
  assert.equal(covered.answer, plain.answer);
  const broken = "throw new Error('fixture failure');";
  const options = coverageOptions(broken, undefined, new Map([[broken, "/fixture/broken.js"]]));
  assert.throws(() => vm.runInNewContext(broken, {}, options), error =>
    error.message === "fixture failure" && error.stack.includes("/fixture/broken.js"));
});
