import test from "node:test";
import assert from "node:assert/strict";
import { hasUnsupportedAnchors as unsupported } from "../lib/tailor_claims.js";
import { applyTailoring } from "../lib/tailoring.js";
import { applyDocTailoring } from "../lib/resume_doc.js";
import { applyDocxTailoring, bulletGroups } from "../lib/docx.js";

const storeOf = (bullets = ["Built a Python API", "Helped 40 students"]) => ({
  settings: {},
  profile: {
    facts: {},
    goals: { career: "Build Kubernetes services for 40% savings" },
    voice: { summary: "AWS expert" },
    experience: [
      { company: "Synthetic Lab", title: "Intern", bullets },
      { company: "Other", bullets: ["Used Kubernetes", "Cut costs 40%"] },
    ],
    projects: [{ name: "Tool", description: "Built a Python API" }],
    education: [],
    skills: { technical: ["AWS"], tools: [], soft: [] },
  },
});
const docOf = (bullets) => ({
  header: { name: "Synthetic", contact: [] },
  sections: [
    {
      title: "Experience",
      lines: [],
      entries: [
        { rows: [{ left: "Synthetic Lab" }], text: "Built a Python API", bullets },
        { rows: [{ left: "Other" }], text: "Used Kubernetes", bullets: ["Cut costs 40%"] },
      ],
    },
  ],
});
const wordOf = (bullets) =>
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  bullets
    .map(
      (text) =>
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`,
    )
    .join("") +
  "</w:body></w:document>";

test("quantities preserve units and their association with the exact value", () => {
  for (const [source, next] of [
    ["Helped 40 students", "Improved grades 40%"],
    ["Improved scores 40%", "Helped 40 students"],
    ["Saved $40 and 20%", "Saved 40% and $20"],
    ["Worked 2 hours", "Worked 2 years"],
    ["Rose 5 percent", "Rose 5 percentage points"],
    ["Saved $40", "Saved EUR 40"],
    ["Saved $40", "Saved USD 40"],
  ])
    assert.equal(unsupported(next, source), true, next);
  for (const [source, next] of [
    ["Saved 40%", "Reduced costs 40 percent"],
    ["Worked 2 hours", "Worked 2 hrs"],
    ["Saved US$40", "Saved 40 USD"],
    ["Saved 40 dollars", "Saved $40"],
    ["Rose 5 percentage points", "Increased 5 percent points"],
    ["Ran 40 PCR assays weekly", "Performed 40 PCR assays each week"],
  ])
    assert.equal(unsupported(next, source), false, next);
  assert.equal(unsupported("Saved 40%", ["Helped 40", "% improvement discussed elsewhere"]), true);
});

test("distinct technologies are not interchangeable; only genuine spelling aliases are", () => {
  for (const [source, next] of [
    ["Python", "Kubernetes"],
    ["SQL", "PostgreSQL"],
    ["C#", ".NET"],
    ["TensorFlow", "PyTorch"],
    ["Java", "JavaScript"],
    ["Django", "Python"],
  ])
    assert.equal(unsupported(next, source), true, next);
  for (const [source, next] of [
    ["Kubernetes", "k8s"],
    ["JavaScript", "JS"],
    ["PostgreSQL", "Postgres"],
    ["AWS", "Amazon Web Services"],
    ["Node.js", "NodeJS"],
  ])
    assert.equal(unsupported(next, source), false, next);
  assert.equal(unsupported("Coordinated records", "Kept records"), false);
  // Deliberately not a semantic oracle or a blacklist of leadership words.
  assert.equal(unsupported("Led clinical trials", "Kept lab records"), false);
});

test("profile bullet/project checks cannot borrow facts from other roles, skills or the posting", () => {
  const s = storeOf();
  const { resume, diff } = applyTailoring(s, {
    experience: [
      {
        i: 0,
        bullets: [
          { from: 0, text: "Built a Kubernetes API" },
          { from: 1, text: "Improved grades 40%" },
        ],
      },
    ],
    projects: [{ i: 0, description: "Built an AWS API" }],
  });
  assert.deepEqual(resume.experience[0].bullets, s.profile.experience[0].bullets);
  assert.equal(resume.projects[0].description, s.profile.projects[0].description);
  assert.deepEqual(diff, []);
});

test("profile summaries use factual inputs, not career aspirations, voice or hidden metadata", () => {
  const s = storeOf(["Kept lab records"]);
  s.profile.experience.length = 1;
  s.profile.skills.technical = [];
  for (const summary of ["Kubernetes expert", "Saved 40%", "AWS experience"])
    assert.equal(applyTailoring(s, { summary }).resume.summary, "");
  s.profile.skills.technical = ["AWS"];
  assert.equal(
    applyTailoring(s, { summary: "Experience with Amazon Web Services" }).resume.summary,
    "Experience with Amazon Web Services",
  );
});

test("PDF entries and bullets revert unsupported facts while retaining valid formatting and order", () => {
  const doc = docOf(["Built a Python API", "Helped 40 students"]);
  const result = applyDocTailoring(doc, {
    entries: [
      {
        s: 0,
        e: 0,
        text: "Built a Kubernetes API",
        bullets: [
          { from: 1, text: "Improved grades 40%" },
          { from: 0, text: "Created a Python API" },
        ],
      },
    ],
  });
  assert.equal(result.doc.sections[0].entries[0].text, "Built a Python API");
  assert.deepEqual(result.doc.sections[0].entries[0].bullets, [
    "Helped 40 students",
    "Created a Python API",
  ]);
  const summary = {
    ...doc,
    sections: [
      ...doc.sections,
      { title: "Summary", lines: ["Intern with lab experience"], entries: [] },
    ],
  };
  assert.equal(
    applyDocTailoring(summary, { lines: [{ s: 1, k: 0, text: "Intern with AWS experience" }] }).doc
      .sections[1].lines[0],
    "Intern with lab experience",
  );
});

test("Word bullets retain mapped facts even with matching technology in another bullet", () => {
  const xml = wordOf(["Built a Python API", "Used Kubernetes", "Helped 40 students"]);
  const { xml: next, diff } = applyDocxTailoring(xml, bulletGroups(xml), {
    groups: [
      {
        g: 0,
        bullets: [
          { from: 2, text: "Improved grades 40%" },
          { from: 0, text: "Built a Kubernetes API" },
        ],
      },
    ],
  });
  assert.ok(next.includes("Helped 40 students"));
  assert.ok(next.includes("Built a Python API"));
  assert.ok(!next.includes("Improved grades"));
  assert.ok(diff.some((x) => x.dropped)); // The existing allowed single drop remains independent.
  assert.ok(diff.some((x) => x.moved));
});

test("Kubernetes spelling alias survives the shared number check in every format", () => {
  const before = "Used Kubernetes",
    after = "Used k8s";
  const s = storeOf([before]);
  assert.equal(
    applyTailoring(s, { experience: [{ i: 0, bullets: [{ from: 0, text: after }] }] }).resume
      .experience[0].bullets[0],
    after,
  );
  assert.equal(
    applyDocTailoring(docOf([before]), {
      entries: [{ s: 0, e: 0, bullets: [{ from: 0, text: after }] }],
    }).doc.sections[0].entries[0].bullets[0],
    after,
  );
  const xml = wordOf([before]);
  assert.ok(
    applyDocxTailoring(xml, bulletGroups(xml), {
      groups: [{ g: 0, bullets: [{ from: 0, text: after }] }],
    }).xml.includes(after),
  );
});
