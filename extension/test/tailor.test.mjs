import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTailoring, canTailor, hasNewNumbers } from "../lib/tailoring.js";
import { clearTailored, readTailored, tailorKey, writeTailored } from "../lib/tailor_cache.js";
import { renderResume, wrap, clean } from "../lib/pdf.js";

const store = () => ({
  settings: { signup_email: "student@example.edu" },
  profile: {
    facts: { first_name: "Sam", last_name: "Lee", phone: "555-0100", city: "Amherst", state: "MA", linkedin: "https://www.linkedin.com/in/sam/" },
    education: [{ school: "UMass Amherst", degree: "BS", major: "Biology", gpa: "3.6", end: "May 2028" }],
    experience: [{ company: "Lab", title: "Research Assistant", start: "2025", end: "Present", bullets: ["Ran 40 PCR assays weekly", "Kept lab notebook", "Ordered supplies"] }],
    projects: [{ name: "Tide model", description: "Modeled tides in Python" }],
    skills: { technical: ["PCR", "Python", "R"], tools: [], soft: ["Teamwork"] },
    goals: { career: "" }, voice: { summary: "" },
  },
});

test("rewording kept, invented numbers reverted, one bullet may drop", () => {
  const { resume, diff } = applyTailoring(store(), {
    summary: "Biology student with wet-lab experience.",
    experience: [{ i: 0, bullets: [{ from: 0, text: "Performed 40 PCR assays each week" }, { from: 1, text: "Documented 200 experiments" }] }],
    skills: { technical: ["R", "Made-up skill"] },
  });
  const b = resume.experience[0].bullets;
  assert.deepEqual(b, ["Performed 40 PCR assays each week", "Kept lab notebook"]);
  assert.equal(diff.length, 1);
  assert.deepEqual(resume.skills.technical, ["R", "PCR", "Python"]);
  assert.equal(resume.summary, "Biology student with wet-lab experience.");
  assert.equal(resume.contact[0], "student@example.edu");
  assert.equal(resume.contact[3], "linkedin.com/in/sam");
});

test("bad model output falls back to the original", () => {
  const s = store();
  const { resume } = applyTailoring(s, { experience: [{ i: 0, bullets: [{ from: 9, text: "x" }] }], summary: "Led a 12 person team" });
  assert.deepEqual(resume.experience[0].bullets, s.profile.experience[0].bullets);
  assert.equal(resume.summary, "");
  assert.ok(applyTailoring(s, null).resume.experience[0].bullets.length === 3);
});

test("number check and eligibility", () => {
  assert.ok(hasNewNumbers("Cut costs 30%", "Cut costs"));
  assert.ok(!hasNewNumbers("Served 1,200 users", "Grew to 1,200 users"));
  assert.ok(!canTailor(store(), { description: "short" }));
  assert.ok(canTailor(store(), { description: "x".repeat(300) }));
});

test("pdf is well formed", () => {
  const { resume } = applyTailoring(store(), {});
  resume.experience[0].bullets.push("A very long bullet ".repeat(60));
  const bytes = renderResume(resume);
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  const xref = +text.match(/startxref\n(\d+)/)[1];
  assert.ok(text.slice(xref).startsWith("xref"));
  for (const m of text.matchAll(/(\d+) 0 obj/g)) {
    const off = +text.slice(xref).split("\n")[2 + +m[1]].slice(0, 10);
    assert.ok(text.slice(off).startsWith(`${m[1]} 0 obj`), `offset for obj ${m[1]}`);
  }
  assert.ok(wrap("word ".repeat(200), 10, false, 500).length > 3);
  assert.equal(clean("“Résumé” – café"), '"Resume" - cafe');
});


// A fake chrome.storage.local: one object, the same get/set/remove shape, and a switch for failing.
function fakeStore() {
  let data = {}, fail = false;
  return {
    get: async (k) => (fail ? Promise.reject(new Error("quota")) : { [k]: data[k] }),
    set: async (o) => { if (fail) throw new Error("quota"); Object.assign(data, o); },
    remove: async (k) => { delete data[k]; },
    break: (v) => { fail = v; },
    raw: () => data,
  };
}

test("tailor cache key depends on every input, and cannot be forged by shifting them", async () => {
  const k = await tailorKey("gemini-3.8-flash", "SYS", "JOB");
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, await tailorKey("gemini-3.8-flash", "SYS", "JOB"));
  assert.notEqual(k, await tailorKey("claude-haiku-4-5", "SYS", "JOB"));   // a different model
  assert.notEqual(k, await tailorKey("gemini-3.8-flash", "SYS2", "JOB"));  // a reworded system prompt
  assert.notEqual(k, await tailorKey("gemini-3.8-flash", "SYS", "JOB2"));  // a different posting
  // Length prefixes are what stop a boundary shift from colliding: "SY"+"SJOB" must not equal "SYS"+"JOB".
  assert.notEqual(k, await tailorKey("gemini-3.8-flash", "SY", "SJOB"));
});

test("a tailored resume is stored, read back, and capped at 12 entries", async () => {
  const st = fakeStore();
  assert.equal(await readTailored("missing", st), null);

  await writeTailored("k1", { summary: "hi", diff: [] }, st);
  assert.deepEqual(await readTailored("k1", st), { summary: "hi", diff: [] });

  for (let i = 0; i < 20; i++) await writeTailored(`n${i}`, { summary: `r${i}`, diff: [] }, st);
  const kept = Object.keys(st.raw().tailor_cache);
  assert.equal(kept.length, 12);
  assert.ok(kept.includes("n19"), "the newest entry survives");
  assert.equal(await readTailored("k1", st), null, "the oldest was evicted");

  await clearTailored(st);
  assert.equal(await readTailored("n19", st), null);
});

test("entries written in the same millisecond still evict oldest first", async () => {
  // The real case: a dozen tailorings in a row all stamp the same `at`, so `at` decides nothing and
  // the order of the stored object is the only thing left to go on. The test above hits this only
  // when the machine is fast enough for the writes to tie, which is why it is pinned down here.
  const st = fakeStore();
  const now = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    for (let i = 0; i < 20; i++) await writeTailored(`n${i}`, { summary: `r${i}` }, st);
  } finally {
    Date.now = now;
  }
  const kept = Object.keys(st.raw().tailor_cache);
  assert.equal(kept.length, 12);
  assert.deepEqual(kept.slice().sort(), Array.from({ length: 12 }, (_, i) => `n${i + 8}`).sort());
  assert.equal(await readTailored("n7", st), null, "everything older than the last twelve is gone");
  assert.deepEqual(await readTailored("n19", st), { summary: "r19" });
});

test("a broken cache costs an AI call, never the tailoring", async () => {
  const st = fakeStore();
  st.break(true);
  assert.equal(await readTailored("k1", st), null);          // a failed read is simply a miss
  await writeTailored("k1", { summary: "hi" }, st);          // and a failed write must not throw
  st.break(false);
  assert.equal(await readTailored("k1", st), null);
});
