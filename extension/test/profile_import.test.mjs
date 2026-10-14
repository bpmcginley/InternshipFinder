import test from "node:test";
import assert from "node:assert/strict";
import { emptyStore, upgradeStore, accountFor, confirmedFacts, profileForModel } from "../lib/store.js";
import { confirmProfileValue, applyInterviewFacts, planResumeImport, applyResumeImport, mergeProfileEdits, focusStepHeading, pendingResumeReview, formatResumeValue } from "../onboarding/profile.js";

const extracted = (facts = {}, over = {}) => ({ facts, education: [], experience: [], projects: [], links: [],
  skills: { technical: [], tools: [], soft: [] }, ...over });

test("AI interview summaries cannot confirm eligibility or reuse confirmation for changed answers", () => {
  const s = emptyStore();
  s.profile.facts.work_authorized = "Yes";
  confirmProfileValue(s.profile, "facts", "work_authorized");
  applyInterviewFacts(s.profile, { work_authorized: "Yes", needs_sponsorship: "No" });
  assert.equal(confirmedFacts(s).work_authorized, "Yes", "unchanged student confirmation survives");
  assert.equal(s.profile.facts.needs_sponsorship, "No", "suggestion is visible for review");
  assert.equal(confirmedFacts(s).needs_sponsorship, "", "suggestion cannot become an automatic answer");
  applyInterviewFacts(s.profile, { work_authorized: "No", over_18: { inferred: true } });
  assert.equal(confirmedFacts(s).work_authorized, "");
  assert.equal(s.profile.facts.over_18, "", "malformed AI output is ignored");
  confirmProfileValue(s.profile, "facts", "work_authorized");
  assert.equal(confirmedFacts(s).work_authorized, "No");
});

test("new profiles leave factual eligibility/preferences unknown while retaining voluntary decline choices", () => {
  const { facts } = emptyStore().profile;
  for (const k of ["work_authorized", "needs_sponsorship", "over_18", "willing_to_relocate", "willing_to_travel", "background_check", "drug_test", "non_compete", "worked_here_before", "hours_per_week", "languages"]) assert.equal(facts[k], "", k);
  assert.equal(facts.gender, "Decline to self-identify");
  assert.equal(facts.veteran, "I don't wish to answer");
  const old = upgradeStore({ version: 3, profile: { facts: { work_authorized: "Yes", needs_sponsorship: "Yes", first_name: "Sam" } } });
  assert.equal(old.profile.facts.work_authorized, "Yes", "existing answers survive");
  assert.equal(old.profile.facts.needs_sponsorship, "Yes");
  assert.deepEqual(old.profile.sources, { facts: {}, sections: {} });
});

test("legacy eligibility remains visible but is unavailable to applications until confirmed", () => {
  const s = upgradeStore({ version: 3, profile: { facts: { work_authorized: "Yes", needs_sponsorship: "No", over_18: "Yes" } } });
  assert.equal(s.profile.facts.work_authorized, "Yes");
  assert.equal(confirmedFacts(s).work_authorized, "");
  assert.equal(profileForModel(s).facts.needs_sponsorship, "");
  for (const key of ["work_authorized", "needs_sponsorship", "over_18"]) confirmProfileValue(s.profile, "facts", key);
  assert.equal(confirmedFacts(s).work_authorized, "Yes");
  assert.equal(profileForModel(s).facts.needs_sponsorship, "No");
  s.profile.facts.work_authorized = "No";
  assert.equal(confirmedFacts(s).work_authorized, "", "an unconfirmed later mutation cannot reuse old confirmation");
});

test("replacement updates imported contact details and clears removed resume sections", () => {
  const p = emptyStore().profile;
  const first = extracted({ phone: "old-number", first_name: "Sam" }, { experience: [{ title: "Old job" }], projects: [{ name: "Old project" }] });
  applyResumeImport(p, planResumeImport(p, first));
  const next = planResumeImport(p, extracted({ phone: "new-number", first_name: "Sam" }));
  assert.equal(next.filter((e) => e.conflict).length, 0);
  applyResumeImport(p, next);
  assert.equal(p.facts.phone, "new-number");
  assert.deepEqual(p.experience, []);
  assert.deepEqual(p.projects, []);
});

test("manual and legacy values require explicit replacement, including intentionally blank fields", () => {
  const p = emptyStore().profile;
  p.facts.phone = "confirmed-number";
  confirmProfileValue(p, "facts", "phone");
  confirmProfileValue(p, "facts", "email"); // explicitly left blank
  p.projects = [{ name: "Legacy project" }];
  const plan = planResumeImport(p, extracted({ phone: "resume-number", email: "resume@example.test" }));
  assert.deepEqual(plan.filter((e) => e.conflict).map((e) => e.id), ["facts:email", "facts:phone", "sections:projects"]);
  applyResumeImport(p, plan);
  assert.equal(p.facts.phone, "confirmed-number");
  assert.equal(p.facts.email, "");
  assert.equal(p.projects[0].name, "Legacy project");
  applyResumeImport(p, plan, ["facts:phone", "sections:projects"]);
  assert.equal(p.facts.phone, "resume-number");
  assert.deepEqual(p.projects, []);
});

test("later edits during extraction/review cannot be overwritten by an earlier import plan", () => {
  const p = emptyStore().profile;
  const plan = planResumeImport(p, extracted({ phone: "resume-number" }));
  p.facts.phone = "typed-while-reading";
  confirmProfileValue(p, "facts", "phone");
  applyResumeImport(p, plan, ["facts:phone"]);
  assert.equal(p.facts.phone, "typed-while-reading");
  assert.equal(p.sources.facts.phone.source, "manual");
});

test("an extraction that matches a confirmed value does not erase its manual protection", () => {
  const p = emptyStore().profile;
  p.facts.phone = "manual-number";
  confirmProfileValue(p, "facts", "phone");
  applyResumeImport(p, planResumeImport(p, extracted({ phone: "manual-number" })));
  assert.equal(p.sources.facts.phone.source, "manual");
  assert.ok(planResumeImport(p, extracted({ phone: "other-number" })).find((e) => e.key === "phone").conflict);
});

test("incomplete extraction cannot silently clear saved sections", () => {
  assert.throws(() => planResumeImport(emptyStore().profile, { facts: {}, experience: [] }), /incomplete/);
});

test("pending resume choices survive closing/reopening onboarding without retaining another file copy", () => {
  const s = emptyStore();
  s.files.resume = { name: "fixture.txt", b64: "ZmFrZQ==" };
  s.profile.facts.phone = "old-number";
  const plan = planResumeImport(s.profile, extracted({ phone: "new-number" }));
  s.settings.resume_import = { plan };
  const reopened = structuredClone(s), pending = pendingResumeReview(reopened);
  assert.equal(pending.file, reopened.files.resume);
  assert.deepEqual(pending.plan, plan);
  assert.equal(pending.plan.find((e) => e.key === "phone").conflict, true);
});

test("page edits preserve concurrent background changes to untouched fields and allow explicit removals", () => {
  const before = emptyStore(), next = structuredClone(before), fresh = structuredClone(before);
  next.profile.facts.phone = "page-edit";
  next.profile.skills = { technical: ["New skill"] };
  fresh.profile.facts.majors = "Background major";
  fresh.profile.extra["Required question"] = "Background answer";
  fresh.accounts.push({ domain: "example.test", password: "fixture" });
  mergeProfileEdits(fresh.profile, before.profile, next.profile);
  assert.equal(fresh.profile.facts.phone, "page-edit");
  assert.equal(fresh.profile.facts.majors, "Background major");
  assert.equal(fresh.profile.extra["Required question"], "Background answer");
  assert.equal(fresh.accounts.length, 1);
  assert.deepEqual(fresh.profile.skills, { technical: ["New skill"] });
});

test("pending job-site accounts reuse credentials while still taking the signup path", () => {
  const s = emptyStore();
  s.accounts.push({ domain: "example.test", email: "sam@example.test", password: "fixture", state: "pending" });
  const pending = accountFor(s, "https://example.test/jobs");
  assert.equal(pending.isNew, true);
  assert.equal(pending.password, "fixture");
  s.accounts[0].state = "confirmed";
  assert.equal(accountFor(s, "https://example.test/jobs").isNew, false);
  delete s.accounts[0].state;
  assert.equal(accountFor(s, "https://example.test/jobs").isNew, false, "legacy saved accounts remain usable");
});

test("step focus lands on a keyboard-focusable heading without an extra scroll", () => {
  const calls = [], heading = { focus: (opts) => calls.push(opts) };
  focusStepHeading({ querySelector: (selector) => { assert.equal(selector, "h2"); return heading; } });
  assert.equal(heading.tabIndex, -1);
  assert.deepEqual(calls, [{ preventScroll: true }]);
});

test("resume comparisons display readable details and explicitly show removed sections", () => {
  assert.equal(formatResumeValue([]), "Not listed");
  assert.equal(formatResumeValue({ technical: ["JavaScript", "SQL"], tools: [], soft: [] }), "Technical: JavaScript, SQL");
  assert.equal(formatResumeValue([{ school: "Fixture University", degree: "BS", grad_term: "Spring 2027" }]), "School: Fixture University\nDegree: BS\nGrad term: Spring 2027");
});
