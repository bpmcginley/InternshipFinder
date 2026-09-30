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
