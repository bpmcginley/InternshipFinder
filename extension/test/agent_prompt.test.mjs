// The fixed opening of every Auto-Apply request (buildSystem) and the history trim. Gemini serves a
// repeated opening from its cache only when it is byte-for-byte the same and long enough, so both
// properties are what the September cost fix rests on.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} }, tabs: {}, scripting: {} };
const { buildSystem, trimHistory } = await import("../background/agent.js");

const store = { profile: { facts: { first_name: "Ada" }, education: [], experience: [], projects: [], skills: [], links: [],
  stories: [], goals: "", voice: "", extra: "" }, settings: {}, files: {} };
const job = { company: "Acme", title: "Data Intern", location: "Boston, MA", apply_url: "https://x/1", description: "d".repeat(9000) };

test("the fixed opening holds the rules, the candidate and the job, the same on every step", () => {
  const a = JSON.stringify(buildSystem(store, job)), b = JSON.stringify(buildSystem(store, { ...job }));
  assert.equal(a, b);
  const text = buildSystem(store, job).map((p) => p.text).join("\n");
  assert.match(text, /CANDIDATE PROFILE/);
  assert.match(text, /JOB\nCompany: Acme/);
  assert.equal((text.match(/d{8000}/) || [""])[0].length, 8000);    // the description, cut at 8,000
});

test("only the latest page snapshot is kept in the history", () => {
  const snap = (n) => ({ role: "user", content: [{ type: "text", text: `SNAPSHOT\npage ${n}` }] });
  const msgs = [snap(1), { role: "assistant", content: [] }, snap(2), { role: "assistant", content: [] }, snap(3)];
  trimHistory(msgs);
  assert.deepEqual(msgs.filter((m) => m.role === "user").map((m) => m.content[0].text),
    ["SNAPSHOT (older page state removed)", "SNAPSHOT (older page state removed)", "SNAPSHOT\npage 3"]);
});

// ---------- 2026-10-04: shorter old tool results, brief filled dropdowns, the no-progress breaker ----------
const { formatSnapshot, preFilledLine, progressCheck, freshProgress, SAME_SNAPSHOTS_MAX, TURNS_PER_PAGE_MAX } = await import("../background/agent.js");

test("tool results older than the last two model turns are cut to ok / failed, ids intact", () => {
  const use = (id) => ({ type: "tool_use", id, name: "select", input: { ref: "0:1", option: "x" } });
  const ok = (id) => ({ type: "tool_result", tool_use_id: id, content: JSON.stringify({ ok: true, chosen: "Massachusetts", value: "v".repeat(400) }) });
  const bad = (id) => ({ type: "tool_result", tool_use_id: id, is_error: true,
    content: JSON.stringify({ ok: false, error: "No option matches. Options: " + "Alabama | ".repeat(60) }) });
  const human = (id) => ({ type: "tool_result", tool_use_id: id, content: "The human answered: May 2027" });
  const snap = (n, ...results) => ({ role: "user", content: [...results, { type: "text", text: `SNAPSHOT\npage ${n}` }] });
  const msgs = [
    snap(0),
    { role: "assistant", content: [use("a"), use("b"), use("h")] }, snap(1, ok("a"), bad("b"), human("h")),
    { role: "assistant", content: [use("c")] }, snap(2, bad("c")),
    { role: "assistant", content: [use("d")] }, snap(3, ok("d")),
  ];
  const before = JSON.stringify(msgs.slice(3));
  trimHistory(msgs);
  const r1 = msgs[2].content;
  assert.equal(r1[0].content, "ok");
  assert.match(r1[1].content, /^failed: No option matches\. Options: Alabama/);
  assert.equal(r1[1].content.length, "failed: ".length + 120);
  assert.equal(r1[2].content, "The human answered: May 2027");     // a human's answer is kept
  assert.deepEqual(r1.slice(0, 3).map((b) => b.tool_use_id), ["a", "b", "h"]);
  assert.equal(r1[1].is_error, true);
  // The last two turns' results are untouched (the snapshots are trimmed as before, separately).
  const after = msgs.slice(3);
  assert.equal(JSON.stringify(after.map((m) => m.content.filter((b) => b.type !== "text"))),
    JSON.stringify(JSON.parse(before).map((m) => m.content.filter((b) => b.type !== "text"))));
  // Every tool_use still has its tool_result, and trimming again changes nothing.
  const uses = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.content.map((b) => b.id));
  const results = msgs.filter((m) => m.role === "user").flatMap((m) => m.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id));
  assert.deepEqual(results, uses);
  const once = JSON.stringify(msgs);
  trimHistory(msgs);
  assert.equal(JSON.stringify(msgs), once);
});

const STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts",
  "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey"];
const HEARD = ["Company Website", "LinkedIn", "Job Board", "Referral", "Career Fair", "Handshake"];
const page = (state, heard) => [{
  frameId: 0, url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Intern_JR1/apply/applyManually",
  title: "Apply", headings: ["My Information"], step: "Step 2 of 5: My Information", errors: [], captcha: false, text: "",
  elements: [
    { ref: "1", kind: "text", label: "Legal First Name", required: true, value: "Ada" },
    { ref: "2", kind: "select", label: "State", required: true, value: state, options: STATES, placeholder: "Select One" },
    { ref: "3", kind: "react_select", label: "How did you hear about us?", required: true, value: heard, options: HEARD, placeholder: "Select..." },
  ],
  buttons: [{ ref: "9", text: "Save and Continue" }],
}];

test("a filled dropdown shows its option count; an empty or failed one keeps its list", () => {
  const empty = formatSnapshot(page("", ""), {}).text;
  const filled = formatSnapshot(page("Massachusetts", "LinkedIn"), {}).text;
  assert.match(empty, /"State" = "" options: Alabama \| Alaska/);
  assert.match(empty, /placeholder="Select One"/);
  assert.match(filled, /"State" = "Massachusetts" \(30 options\)/);
  assert.match(filled, /"How did you hear about us\?" = "LinkedIn" \(6 options\)/);
  assert.doesNotMatch(filled, /Alabama|placeholder=/);
  assert.ok(filled.length < empty.length * 0.6, `${filled.length} vs ${empty.length}`);
  // A select that failed keeps its choices even with a value, so the model can pick a real one.
  const failed = formatSnapshot(page("Massachusetts", "LinkedIn"), { "0:2": 1 }).text;
  assert.match(failed, /"State" = "Massachusetts" options: Alabama/);
  assert.match(failed, /"How did you hear about us\?" = "LinkedIn" \(6 options\)/);
});

test("the Pre-filled line names only what the snapshot doesn't already show", () => {
  const { shown } = formatSnapshot(page("Massachusetts", ""), {});
  assert.equal(preFilledLine([], shown), "");
  assert.equal(preFilledLine(["Legal First Name = Ada", "Resume = cv.pdf"], shown), "Pre-filled: Resume = cv.pdf");
  assert.match(preFilledLine(["Legal First Name = Ada", "State = Massachusetts"], shown), /^Pre-filled 2 field\(s\).*in the snapshot/);
  assert.equal(preFilledLine(["How did you hear about us? = LinkedIn"], shown), "Pre-filled: How did you hear about us? = LinkedIn");
});

test("the breaker stops on a page that comes back unchanged, before another model turn", () => {
  let s = freshProgress(), stops = [];
  for (let i = 0; i < 5; i++) { const r = progressCheck(s, "same page", "u | Step 2"); s = r.state; stops.push(r.stop); }
  // The 1st snapshot is new; the 2nd-4th are repeats, and the third repeat stops before its turn.
  assert.deepEqual(stops, [false, false, false, true, true]);
  assert.equal(SAME_SNAPSHOTS_MAX, 3);
  // A changed page resets the count; so does a sleeping tab (the sleepy gate handles that one).
  s = freshProgress();
  for (const t of ["a", "a", "b", "b", "b"]) s = progressCheck(s, t, "u").state;
  assert.equal(s.stuckSame, 2);
  assert.equal(progressCheck(s, "b", "u", true).state.stuckSame, 0);
});

test("the breaker stops after twelve turns on one page even when the page keeps changing", () => {
  let s = freshProgress(), first = -1;
  for (let i = 0; i < 20; i++) {
    const r = progressCheck(s, `page text ${i}`, "u | Step 3: My Experience");
    s = r.state;
    if (r.stop && first < 0) first = i;
  }
  assert.equal(TURNS_PER_PAGE_MAX, 12);
  assert.equal(first, 12);                      // turns 0..11 ran; the 13th look stops before a 13th turn
  // Moving on (a new URL, or Workday's next step on the same URL) starts the count again.
  s = freshProgress();
  for (let i = 0; i < 11; i++) s = progressCheck(s, `t${i}`, "u | Step 3").state;
  const moved = progressCheck(s, "t11", "u | Step 4");
  assert.equal(moved.stop, false);
  assert.equal(moved.state.turnsHere, 0);
});
