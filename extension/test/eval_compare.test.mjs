// scripts/eval/autofill_models.mjs: how a replayed step is scored against the recorded one. The
// verdict on Flash-Lite rests on these, so they are tested with the rest of the extension.
import test from "node:test";
import assert from "node:assert/strict";

const { decisions, compare, labelsOf, SENSITIVE_RE, sameMeaning, monthOf } = await import("../../scripts/eval/autofill_models.mjs");

const use = (name, input) => ({ type: "tool_use", name, input });

test("a step's decisions are the fields it set and where it went next", () => {
  const d = decisions([use("fill", { ref: "f1", text: "Ada" }), use("select", { ref: "f2", option: "No" }),
    use("check", { ref: "f3", checked: true }), use("wait", { seconds: 1 }), use("click", { ref: "b9" })]);
  assert.deepEqual(d.fields, { f1: { tool: "fill", value: "Ada" }, f2: { tool: "select", value: "No" }, f3: { tool: "check", value: "true" } });
  assert.deepEqual(d.moves, ["click b9"]);
});

test("agreement, disagreement, missed and extra fields, and prose set aside for a person", () => {
  const long = "I want to work at Acme because ".repeat(3);
  const base = decisions([use("fill", { ref: "f1", text: "Ada" }), use("select", { ref: "f2", option: "No" }),
    use("select", { ref: "f3", option: "Yes" }), use("fill", { ref: "f4", text: long }), use("click", { ref: "b1" })]);
  const cand = decisions([use("fill", { ref: "f1", text: " ada " }), use("select", { ref: "f2", option: "Yes" }),
    use("fill", { ref: "f4", text: long + "!" }), use("fill", { ref: "f5", text: "x" }), use("click", { ref: "b1" })]);
  const c = compare(base, cand, { f2: "Will you require visa sponsorship?", f3: "Over 18?" });
  assert.equal(c.same, 2);                                   // f1 (case and spaces) and f4 (prose)
  assert.deepEqual(c.differ.map((d) => [d.ref, d.sensitive]), [["f2", true]]);
  assert.deepEqual(c.missed.map((d) => d.ref), ["f3"]);
  assert.deepEqual(c.extra.map((d) => d.ref), ["f5"]);
  assert.deepEqual(c.prose.map((d) => d.ref), ["f4"]);
  assert.equal(c.movesAgree, true);
});

test("labels come from the step's latest full snapshot", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "SNAPSHOT (older page state removed)" }] },
    { role: "user", content: [{ type: "text", text: 'SNAPSHOT\nACCOUNT: none\n[f2] select *"Veteran status" = ""\n[f7] text "First name" = "Ada"' }] },
  ];
  assert.deepEqual(labelsOf(msgs), { f2: "Veteran status", f7: "First name" });
});

test("sensitive questions are the ones where a wrong answer does harm", () => {
  for (const q of ["Are you authorized to work in the US?", "Veteran status", "Are you at least 18?", "Expected salary"]) assert.match(q, SENSITIVE_RE, q);
  for (const q of ["First name", "LinkedIn profile", "Page 2 of 3", "Manager's name"]) assert.doesNotMatch(q, SENSITIVE_RE, q);
});


test("one date or amount written two ways counts as the same answer; different ones do not", () => {
  assert.deepEqual(monthOf("05/01/2028"), { y: 2028, m: 5 });
  assert.deepEqual(monthOf("2028-05-31"), { y: 2028, m: 5 });
  assert.deepEqual(monthOf("May 2028"), { y: 2028, m: 5 });
  assert.ok(sameMeaning("05/01/2028", "05/2028"));
  assert.ok(sameMeaning("01/04/2027", "1/4/2027"));
  assert.ok(sameMeaning("$33/hour", "$33/hour base"));
  assert.ok(sameMeaning("Negotiable", "Competitive / Negotiable"));
  // Real differences stay differences.
  assert.ok(!sameMeaning("2025", "2024"));
  assert.ok(!sameMeaning("September", "January"));
  assert.ok(!sameMeaning("05/01/2028", "05/01/2027"));
  assert.ok(!sameMeaning("$33/hour", "$40/hour"));
  assert.ok(!sameMeaning("Yes", "No"));
  const c = compare(decisions([use("fill", { ref: "d", text: "05/01/2028" })]), decisions([use("fill", { ref: "d", text: "2028-05-31" })]), { d: "Graduation date" });
  assert.equal(c.same, 1);
  assert.equal(c.differ.length, 0);
  assert.equal(c.reworded.length, 1);
});

