// scripts/eval/form_bench.mjs: the offline benchmark's answer key rules, value matching and scoring.
// The Haiku-vs-Flash verdict rests on these, so they are tested with the rest of the extension.
import test from "node:test";
import assert from "node:assert/strict";

const L = await import("../../scripts/eval/bench_lib.mjs");
const F = await import("../../scripts/eval/bench_forms.mjs");
const { benchStore } = await import("../../scripts/eval/bench_profile.mjs");
const profile = benchStore().profile;

test("the fictional profile has the extension's own shape and nothing real in it", () => {
  const s = benchStore();
  assert.equal(s.profile.facts.first_name, "Jordan");
  assert.ok(Array.isArray(s.profile.education) && s.profile.education[0].school === "Example State University");
  for (const v of [s.profile.facts.linkedin, s.profile.facts.github, s.profile.facts.website, s.profile.facts.email]) assert.match(v, /example\.com/);
  assert.ok(s.files.resume.b64.length > 100);
});

test("dates are read in the ways forms write them", () => {
  assert.deepEqual(L.dateOf("05/24/2027"), { y: 2027, m: 5, d: 24 });
  assert.deepEqual(L.dateOf("2027-05-24"), { y: 2027, m: 5, d: 24 });
  assert.deepEqual(L.dateOf("May 24th, 2027"), { y: 2027, m: 5, d: 24 });
  assert.deepEqual(L.dateOf("May 2028"), { y: 2028, m: 5 });
  assert.deepEqual(L.dateOf("2028"), { y: 2028 });
  assert.equal(L.dateOf("soon"), null);
});

test("matching a final value against the key", () => {
  assert.ok(L.matches("(555) 010-4477", { expect: ["555-010-4477"], match: "phone" }));
  assert.ok(L.matches("https://www.example.com/in/jordan-rivera/", { expect: ["https://example.com/in/jordan-rivera"], match: "url" }));
  assert.ok(L.matches("05/24/2027", { expect: ["May 24, 2027"], match: "date" }));
  assert.ok(!L.matches("06/24/2027", { expect: ["May 24, 2027"], match: "date" }));
  assert.ok(L.matches("May 2028", { expect: ["May 2028"], match: "date" }));
  assert.ok(L.matches("3.60", { expect: ["3.6"], match: "number" }));
  assert.ok(L.matches("Springfield, IL", { expect: ["Springfield"], match: "contains" }));
  assert.ok(L.matches("", { expect: [""], match: "blank" }) && !L.matches("Sangamon", { expect: [""], match: "blank" }));
  assert.ok(L.matches(true, { expect: ["true"], match: "exact" }) && !L.matches(false, { expect: ["true"], match: "exact" }));
  assert.ok(L.matches("Decline to self-identify", { expect: ["Decline To Self Identify"], match: "exact" }));
  assert.ok(!L.matches("Yes", { expect: ["No"], match: "exact" }));
});

test("rule keys: contact, EEO, authorization, and turned questions", () => {
  const k = (f) => L.ruleKey({ required: false, ...f }, profile);
  assert.deepEqual(k({ kind: "text", label: "First Name*" }).expect, ["Jordan"]);
  assert.equal(k({ kind: "text", label: "Phone" }).match, "phone");
  assert.deepEqual(k({ kind: "file", label: "Resume/CV*" }).expect, ["Jordan_Rivera_Resume.pdf"]);
  assert.equal(k({ kind: "file", label: "Cover Letter" }).match, "blank");
  const g = k({ kind: "select", label: "Gender", options: ["Male", "Female", "Decline To Self Identify"] });
  assert.deepEqual(g.expect, ["Decline To Self Identify"]);
  assert.ok(g.sensitive);
  assert.deepEqual(k({ kind: "select", label: "Will you now or in the future require sponsorship?", options: ["Yes", "No"] }).expect, ["No"]);
  assert.deepEqual(k({ kind: "select", label: "Are you able to work in the US without sponsorship?", options: ["Yes", "No"] }).expect, ["Yes"]);
  assert.deepEqual(k({ kind: "select", label: "Are you under the age of 18?", options: ["Yes", "No"] }).expect, ["No"]);
  assert.deepEqual(k({ kind: "select", label: "Are you legally authorized to work in the United States?", options: ["Yes", "No"] }).expect, ["Yes"]);
  // A follow-up that only applies after a "no" is left for the reader of the key.
  assert.equal(k({ kind: "select", label: "If not, do you now or will you in the future need sponsorship?", options: ["Yes", "No", "Not applicable"] }), null);
  // No decline option: needs a reader too.
  assert.equal(k({ kind: "radio_group", label: "What gender do you identify as?", options: ["Female", "Male", "Non-binary"] }), null);
  assert.equal(k({ kind: "textarea", label: "Why do you want to work here?" }), null);
});

test("scoring: the model's share, restraint, sensitive errors, broken pre-fills", () => {
  const key = {
    a: { cls: "objective", expect: ["Jordan"], match: "exact", label: "First", required: true },
    b: { cls: "objective", expect: ["No"], match: "exact", label: "Sponsorship", sensitive: true, required: true },
    c: { cls: "objective", expect: [""], match: "blank", label: "Middle initial" },
    d: { cls: "objective", kind: "checkbox", expect: ["false"], match: "exact", label: "LinkedIn" },
    e: { cls: "objective", expect: ["No"], match: "exact", label: "Under 18?", sensitive: true },
    f: { cls: "free", label: "Why us?", required: true },
    g: { cls: "skip", label: "Date" },
    h: { cls: "objective", expect: ["May 2028"], match: "date", label: "Graduation", required: true },
  };
  const before = { a: "Jordan", b: "", c: "", d: false, e: "Yes", f: "", g: "", h: "" };
  const after = { a: "Jordan", b: "Yes", c: "Q", d: true, e: "No", f: "", g: "x", h: "" };
  const s = L.scoreForm(key, before, after, [{ ok: true }, { ok: false, error: "unknown ref" }, { ok: false, control: true }]);
  assert.equal(s.objective, 3);           // b, e (a wrong pre-fill), h; a was right already, c and d are restraint
  assert.equal(s.correct, 1);             // e fixed
  assert.equal(s.prefillFixed, 1);
  assert.deepEqual(s.sensitiveWrong.map((x) => x.ref), ["b"]);
  assert.deepEqual(s.hallucinated.map((x) => x.ref), ["c"]);
  assert.deepEqual(s.wrongTicks.map((x) => x.ref), ["d"]);
  assert.deepEqual(s.missedRequired.map((x) => x.ref).sort(), ["f", "h"]);
  assert.equal(s.invalid, 1);
  const broke = L.scoreForm(key, before, { ...after, a: "Jordy" });
  assert.deepEqual(broke.prefillBroken.map((x) => x.ref), ["a"]);
  assert.deepEqual(s.counted.map((x) => [x.ref, x.ok]), [["b", false], ["e", true], ["h", false]]);
  assert.deepEqual(s.skipAnswered.map((x) => x.ref), ["g"]);   // a question only the human can answer
});

test("scoring: a right pre-fill overwritten on a sensitive field is a sensitive error", () => {
  const key = {
    race: { cls: "objective", kind: "radio_group", expect: ["Decline to self-identify"], match: "exact", label: "Race", sensitive: true },
    city: { cls: "objective", expect: ["Springfield"], match: "contains", label: "City" },
  };
  const before = { race: "Decline to self-identify", city: "Springfield" };
  const s = L.scoreForm(key, before, { race: "Hispanic or Latino", city: "Chicago" }, [{ name: "click", ref: "[race]", ok: true }]);
  assert.deepEqual(s.prefillBroken.map((x) => x.ref), ["race", "city"]);
  assert.deepEqual(s.sensitiveWrong.map((x) => [x.ref, x.prefill]), [["race", "Decline to self-identify"]]);
  assert.equal(s.objective, 0);           // both were right before the model acted: not its share
  assert.equal(s.misused, 1);             // a click aimed at a field, brackets and all
  assert.equal(L.misusedCalls(key, [{ name: "click", ref: "0:99", ok: true }, { name: "select", ref: "race", ok: true }]), 0);
});

test("consistency counts objective fields that two runs left the same", () => {
  const key = { a: { cls: "objective" }, b: { cls: "objective" }, c: { cls: "free" } };
  assert.deepEqual(L.consistency(key, { a: "Yes", b: "May 2028", c: "x" }, { a: "yes", b: "05/2028", c: "y" }), { n: 2, same: 2 });
  assert.deepEqual(L.consistency(key, { a: "Yes", b: "" }, { a: "No", b: "" }), { n: 2, same: 1 });
});

test("the text a step wrote, with or without brackets around the ref", () => {
  const content = [{ type: "tool_use", name: "fill", input: { ref: "[0:4]", text: "first" } }, { type: "tool_use", name: "fill", input: { ref: "0:4", text: "second" } },
    { type: "tool_use", name: "select", input: { ref: "0:5", option: "No" } }];
  assert.equal(L.writtenText(content, "0:4"), "second");
  assert.equal(L.writtenText(content, "0:5"), "No");
  assert.equal(L.writtenText(content, "0:6"), null);
});

test("an application's cost: the fixed opening written once, then read from the cache", () => {
  const p = { input: 1, output: 10, cached: 0.1, write: 1.25 };
  // 1,000,000 prompt tokens of which 800,000 are the fixed opening, 100,000 output; two steps.
  const c = L.appCents({ prompt: 1e6, output: 1e5, prefix: 8e5 }, 2, p);
  assert.equal(Math.round(c * 100) / 100, Math.round(((2e5 * 1 + 8e5 * 1.25 + 1e5 * 10) + (2e5 * 1 + 8e5 * 0.1 + 1e5 * 10)) / 1e4 * 100) / 100);
  assert.ok(L.opusCents({ input_tokens: 1e6, output_tokens: 0 }) === 400);
});

test("posting URLs, kinds of internship, and questions from the ATS's own data", () => {
  assert.deepEqual(F.parseAts("https://job-boards.greenhouse.io/acme/jobs/123"), { ats: "greenhouse", token: "acme", id: "123" });
  assert.equal(F.parseAts("https://jobs.lever.co/acme/5209b801-0b36-4d0f-95bf-06dbf982e024/apply").ats, "lever");
  assert.equal(F.parseAts("https://jobs.ashbyhq.com/acme/5209b801-0b36-4d0f-95bf-06dbf982e024/application").ats, "ashby");
  assert.equal(F.parseAts("https://www.acme.com/careers/?gh_jid=1"), null);
  assert.equal(F.categoryOf(["swe", "finance"]), "finance");
  assert.equal(F.categoryOf(["ml"]), "data");
  assert.equal(F.categoryOf(["law"]), null);
  const gh = { questions: [{ label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] },
    { label: "Why us?", required: true, fields: [{ name: "question_1", type: "textarea", values: [] }] },
    { label: "Term", required: true, fields: [{ name: "question_2[]", type: "multi_value_multi_select", values: [{ label: "Summer", value: 1 }] }] }] };
  const qs = F.questionsOf("greenhouse", gh);
  assert.deepEqual(qs.map((q) => q.type), ["text", "textarea", "multi"]);
  assert.deepEqual(F.customQuestions(qs).map((q) => q.label), ["Why us?", "Term"]);
  const html = F.renderGreenhouse({ title: "Intern", company: "Acme", location: "Chicago, IL" }, gh);
  assert.match(html, /<label for="question_1"[^>]*>Why us\?<span class="required"/);
  assert.match(html, /type="checkbox"[^>]*name="question_2\[\]"/);
  assert.match(html, /Submit application/);
});
