import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTailoring, canTailor, hasNewNumbers } from "../lib/tailoring.js";
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
