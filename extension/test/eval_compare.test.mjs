// scripts/eval/autofill_models.mjs: how a replayed step is scored against the recorded one. The
// verdict on Flash-Lite rests on these, so they are tested with the rest of the extension.
import test from "node:test";
import assert from "node:assert/strict";

const { decisions, compare, labelsOf, SENSITIVE_RE, sameMeaning, monthOf, routable, savings, claudeMessages, claudeCents } = await import("../../scripts/eval/autofill_models.mjs");

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


// The savings section (2026-10-04): which steps a router would send to the cheaper model, and the sums.
const snapMsg = (body, extra = []) => [{ role: "user", content: [...extra, { type: "text", text: "SNAPSHOT\n" + body }] }];

test("only plain form steps count as routable", () => {
  assert.equal(routable(snapMsg('[0:f1] select *"Veteran status" = "" options: Yes | No\n[0:f2] text "First name" = "Ada"')), true);
  // an empty free-text box to write: production's model
  assert.equal(routable(snapMsg('[0:f3] textarea *"Why do you want to work here?" = ""')), false);
  assert.equal(routable(snapMsg('[0:f4] rich_text "Cover letter" = ""')), false);
  // a filled one is fine
  assert.equal(routable(snapMsg('[0:f3] textarea "Why us?" = "Because..."')), true);
  // the "is it finished" step, and the step after a failed action
  assert.equal(routable(snapMsg('[0:b1] "Submit" BLOCKED (final submit, human only)')), false);
  assert.equal(routable(snapMsg('[0:f1] text "City" = ""', [{ type: "tool_result", tool_use_id: "t1", content: "no such option", is_error: true }])), false);
  assert.equal(routable([{ role: "user", content: [{ type: "text", text: "no snapshot" }] }]), false);
});

test("savings: routed steps take the cheaper cost, and the plan margins follow the config", () => {
  const row = (app, routable, cheap, prod) => ({ app, routable, cheap: { now: cheap, later: cheap }, prod: { now: prod, later: prod * 2 } });
  const rows = [row("a", true, 0.2, 0.5), row("a", false, 0.2, 0.5), row("b", true, 0.2, 0.5), row("b", true, 0.2, 0.5)];
  const config = { TASKS: { autofill: { allowance: 25 } }, PAID_PLANS: ["supporter"], PLANS: { supporter: { multiplier: 2 } }, NET_CENTS: { supporter: 340 } };
  const s = savings(rows, config);
  assert.equal(s.apps, 2);
  assert.equal(s.routableSteps, 3);
  assert.ok(Math.abs(s.now.prodOnly - 1.0) < 1e-9);            // 4 steps x 0.5c over 2 applications
  assert.ok(Math.abs(s.now.routed - 0.55) < 1e-9);             // (3 x 0.2 + 0.5) / 2
  assert.ok(Math.abs(s.later.routed - 0.8) < 1e-9);            // (3 x 0.2 + 1.0) / 2
  assert.deepEqual(s.plans.map((p) => [p.plan, p.runs, p.net]), [["supporter", 50, 340]]);
  assert.ok(Math.abs(s.plans[0].later.prodOnly - (340 - 50 * 2) / 340) < 1e-9);
});

// Claude Haiku 5.5 in the comparison (2026-10-09): the recorded history goes to the Anthropic API as is,
// minus what only Gemini understands, and its cost is priced from Claude's own usage fields.
test("the recorded history reaches Claude without Gemini's leftovers, and tool ids still pair up", () => {
  const out = claudeMessages([
    { role: "user", content: [{ type: "text", text: "SNAPSHOT [f1] text \"Name\" = \"\"" }] },
    { role: "assistant", content: [{ type: "text", text: "", _sig: "abc" }, { type: "tool_use", id: "fc/1:x", name: "fill", input: { ref: "f1", text: "Jordan" }, _sig: "def" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "fc/1:x", content: "ok" }] },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[1].content, [{ type: "tool_use", id: "fc_1_x", name: "fill", input: { ref: "f1", text: "Jordan" } }]);
  assert.equal(out[2].content[0].tool_use_id, "fc_1_x");
  assert.ok(!JSON.stringify(out).includes("_sig"));
});

test("Claude Haiku 5.5 is priced per token, at the higher rate past 100K prompt tokens", () => {
  // 20K in, 500 out: 20000 * $0.10 + 500 * $0.50 per 1M = $0.00225 = 0.225 cents
  assert.ok(Math.abs(claudeCents("claude-haiku-5-5", { input_tokens: 20000, output_tokens: 500 }) - 0.225) < 1e-9);
  // 150K in: the long-prompt rate ($0.50 / $2.50)
  assert.ok(Math.abs(claudeCents("claude-haiku-5-5", { input_tokens: 150000, output_tokens: 0 }) - 7.5) < 1e-9);
  assert.equal(claudeCents("claude-unknown", { input_tokens: 1000 }), 0);
});
