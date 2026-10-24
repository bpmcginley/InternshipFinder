// PR #94 review, P2 "Profiles and setup": older profiles' default Yes/No answers, the first re-import
// for profiles read before sources were recorded, and a way past a resume the AI couldn't read.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} } };
const { emptyStore, upgradeStore, confirmedFacts, autoApplyReady, resumeReviewPending, unconfirmedOldFacts, workAuthMismatch,
  factCheckNote, manualDetailsMissing, LEGACY_DEFAULTS, ELIGIBILITY_FACTS, CONFIRMATION_FACTS, EMPTY_FACTS } = await import("../lib/store.js");
const { confirmProfileValue, bulkConfirmKeys, planResumeImport, applyResumeImport, preselectedImports } = await import("../onboarding/profile.js");
const { quickStartReady, finishOnboarding, enterDetailsManually, manualPathOpen, pausedMessage } = await import("../onboarding/quickstart.js");

// A profile saved by a version before PR #94, which gave everyone these answers.
const legacy = (facts = {}) => upgradeStore({ version: 3, profile: { facts: { ...LEGACY_DEFAULTS, first_name: "Sam", ...facts } } });

test("old default answers are flagged, and only those still equal to the old default", () => {
  const s = legacy({ willing_to_travel: "No", hours_per_week: "" });
  const old = new Map(unconfirmedOldFacts(s.profile).map((x) => [x.key, x]));
  assert.equal(old.get("work_authorized").legacy, true);
  assert.equal(old.get("needs_sponsorship").legacy, true);
  assert.equal(old.get("over_18").legacy, true);
  assert.equal(old.get("how_heard").legacy, true, "the invented how-heard answer is flagged too");
  assert.equal(old.get("willing_to_travel").legacy, false, "a changed answer is unconfirmed but not called a default");
  assert.ok(!old.has("hours_per_week"), "a blank answer has nothing to confirm");
  for (const k of old.keys()) assert.equal(confirmedFacts(s)[k], "", `${k} is not used before it is confirmed`);
  confirmProfileValue(s.profile, "facts", "work_authorized");
  assert.ok(!unconfirmedOldFacts(s.profile).some((x) => x.key === "work_authorized"));
  assert.deepEqual(unconfirmedOldFacts(emptyStore().profile), [], "a new profile has nothing to flag");
});

test("Confirm answers shown leaves work authorization, sponsorship and 18+ to their own buttons", () => {
  const s = legacy();
  const keys = bulkConfirmKeys(s.profile);
  for (const k of ELIGIBILITY_FACTS) assert.ok(!keys.includes(k), k);
  for (const k of keys) confirmProfileValue(s.profile, "facts", k);
  const ready = confirmedFacts(s);
  for (const k of ELIGIBILITY_FACTS) assert.equal(ready[k], "", `${k} is still waiting after the bulk confirm`);
  assert.equal(ready.willing_to_relocate, "Yes", "the rest are confirmed in one go");
  // Each confirmed on its own (the per-field Confirm button), then they are used.
  for (const k of ELIGIBILITY_FACTS) confirmProfileValue(s.profile, "facts", k);
  assert.deepEqual(ELIGIBILITY_FACTS.map((k) => confirmedFacts(s)[k]), ["Yes", "No", "Yes"]);
  // Once chosen, the three are part of the bulk confirm again, and suggestions waiting are skipped.
  assert.ok(bulkConfirmKeys(s.profile).includes("work_authorized"));
  assert.ok(!bulkConfirmKeys(s.profile, new Set(["languages"])).includes("languages"));
  // Blank eligibility answers on a new profile can be confirmed as unknown in bulk.
  assert.deepEqual(bulkConfirmKeys(emptyStore().profile), CONFIRMATION_FACTS);
});

test("a dashboard work authorization that disagrees with the Deep Dive is pointed out", () => {
  const withAuth = (work_auth, facts) => { const s = emptyStore(); s.dashboard_profile = { work_auth }; Object.assign(s.profile.facts, facts); return s; };
  assert.match(workAuthMismatch(withAuth("visa", { needs_sponsorship: "No" })), /student visa.*don't need sponsorship/);
  assert.match(workAuthMismatch(withAuth("visa", { citizenship: "U.S. citizen" })), /citizenship here is "U.S. citizen"/);
  assert.match(workAuthMismatch(withAuth("citizen", { needs_sponsorship: "Yes" })), /U.S. citizen.*need visa sponsorship/);
  assert.match(workAuthMismatch(withAuth("permanent", { work_authorized: "No" })), /permanent resident.*not authorized/);
  assert.match(workAuthMismatch(withAuth("citizen", { citizenship: "F-1 student visa" })), /F-1 student visa/);
  for (const [auth, facts] of [["visa", { needs_sponsorship: "Yes", citizenship: "F-1 student visa" }], ["citizen", { needs_sponsorship: "No", work_authorized: "Yes" }],
    ["canada", { needs_sponsorship: "Yes" }], ["other", { needs_sponsorship: "No" }], ["", { needs_sponsorship: "Yes" }], ["citizen", {}]]) {
    assert.equal(workAuthMismatch(withAuth(auth, facts)), "", `${auth} ${JSON.stringify(facts)}`);
  }
  assert.equal(workAuthMismatch(emptyStore()), "", "no dashboard profile");
  // A legacy "needs sponsorship: No" against a dashboard student visa is the case the review reproduced.
  const s = legacy(); s.dashboard_profile = { work_auth: "visa" };
  assert.match(factCheckNote(s), /disagree/);
});

test("the side panel note shows for unconfirmed eligibility answers and goes once they are confirmed", () => {
  const s = legacy();
  assert.match(factCheckNote(s), /never confirmed/);
  for (const k of ELIGIBILITY_FACTS) confirmProfileValue(s.profile, "facts", k);
  assert.equal(factCheckNote(s), "", "other unconfirmed answers don't need a side panel note");
  assert.equal(factCheckNote(emptyStore()), "");
  const raw = { settings: {}, profile: { facts: { work_authorized: "Yes" } } };   // as chrome.storage hands it over
  assert.match(factCheckNote(raw), /never confirmed/);
});

test("how_heard starts blank for new profiles", () => {
  assert.equal(EMPTY_FACTS.how_heard, "");
  assert.equal(emptyStore().profile.facts.how_heard, "");
  assert.equal(confirmedFacts(legacy()).how_heard, "", "an old invented default isn't sent until confirmed");
});

const extracted = (facts = {}, over = {}) => ({ facts, education: [], experience: [], projects: [], links: [],
  skills: { technical: [], tools: [], soft: [] }, ...over });

test("the first re-import for a profile read before sources were kept ticks the old resume's values", () => {
  const s = upgradeStore({ version: 3, settings: { extracted_from: "old.pdf" },
    profile: { facts: { phone: "old-number", email: "old@school.edu" }, experience: [{ title: "Removed job" }] } });
  confirmProfileValue(s.profile, "facts", "email");   // typed in by hand since: stays unticked
  const plan = planResumeImport(s.profile, extracted({ phone: "new-number", email: "new@school.edu" }), { legacyResume: !!s.settings.extracted_from });
  assert.deepEqual(plan.filter((e) => e.conflict).map((e) => e.id).sort(), ["facts:email", "facts:phone", "sections:experience"]);
  assert.deepEqual(preselectedImports(plan).sort(), ["facts:phone", "sections:experience"]);
  applyResumeImport(s.profile, plan, preselectedImports(plan));   // saved without changing the boxes
  assert.equal(s.profile.facts.phone, "new-number");
  assert.deepEqual(s.profile.experience, [], "a job removed from the resume is removed");
  assert.equal(s.profile.facts.email, "old@school.edu", "a value the student entered is kept unless chosen");
  assert.equal(s.profile.sources.facts.phone.source, "resume", "and from now on the record says where it came from");
  // A profile never read from a resume: its values are the student's own, so nothing is ticked.
  const typed = upgradeStore({ version: 3, profile: { facts: { phone: "typed" } } });
  assert.deepEqual(preselectedImports(planResumeImport(typed.profile, extracted({ phone: "resume" }), { legacyResume: false })), []);
});

const student = (over = {}) => {
  const s = emptyStore();
  s.files.resume = { name: "cv.pdf", type: "application/pdf", size: 1, b64: "AA==" };
  s.settings.signup_email = "sam@school.edu";
  s.settings.resume_details_ready = false;   // the AI read failed
  Object.assign(s.settings, over);
  return s;
};

test("a failed resume read has a manual way past it, and Auto-Apply stays paused until the details are in", async () => {
  const s = student();
  assert.equal(quickStartReady(s), false);
  assert.equal(manualPathOpen(s), true);
  assert.equal(manualPathOpen(s, { extracting: true }), false, "not while a read is running");
  assert.equal(manualPathOpen(s, { pending: true }), false, "not while resume updates wait for review");
  assert.equal(manualPathOpen(student({ resume_import: { plan: [] } })), false);
  assert.equal(manualPathOpen(student({ resume_details_ready: true })), false);
  assert.match(pausedMessage(s), /enter your details yourself/);

  enterDetailsManually(s);
  assert.equal(manualPathOpen(s), false);
  assert.deepEqual(manualDetailsMissing(s), ["first_name", "last_name", "email"]);
  assert.ok(resumeReviewPending(s), "the background and the agent loop see the pause too");
  assert.equal(pausedMessage(s), "Add your first name, last name and email in Quick facts. Auto-Apply starts when they are filled in.");
  await assert.rejects(finishOnboarding(s, async () => {}), /first name, last name and email/);
  assert.equal(s.settings.onboarded, false);

  Object.assign(s.profile.facts, { first_name: "Sam", last_name: "Lee" });
  assert.equal(pausedMessage(s), "Add your email in Quick facts. Auto-Apply starts when they are filled in.");
  s.profile.facts.email = "sam@school.edu";
  assert.equal(quickStartReady(s), true);
  await finishOnboarding(s, async () => {});
  assert.ok(autoApplyReady(s));
  // Clearing a name later pauses Auto-Apply again.
  s.profile.facts.last_name = " ";
  assert.equal(autoApplyReady(s), false);
});

test("the manual flag only matters when the student chose it", () => {
  const s = student({ resume_details_ready: true });
  assert.deepEqual(manualDetailsMissing(s), [], "a read resume with no name is not held up by this");
  assert.equal(resumeReviewPending(s), false);
  s.settings.resume_details_manual = false;   // a later successful read clears it (onboarding.js)
  assert.deepEqual(manualDetailsMissing(s), []);
});

test("restored completion requires a local file, and PDF/DOCX resumes remain usable (EXT-5)", () => {
  const s = student({ onboarded: true, deep_dive_at: 123, resume_details_ready: true });
  for (const bad of [null, { name: "cv.pdf" }, { name: "cv.pdf", b64: "" }, { name: "", b64: "AA==" }]) {
    s.files.resume = bad;
    assert.equal(autoApplyReady(s), false); assert.equal(quickStartReady(s), false);
    assert.match(pausedMessage(s), /Add your resume/);
    assert.equal(s.settings.onboarded, true); assert.equal(s.settings.deep_dive_at, 123);
  }
  for (const [name, type] of [["cv.pdf", "application/pdf"], ["cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]]) {
    s.files.resume = { name, type, size: 1, b64: "AA==" };
    assert.equal(autoApplyReady(s), true); assert.equal(quickStartReady(s), true);
  }
});
