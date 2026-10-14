// U3 (2026-10-14 UX audit): typing the email in Setup one key at a time saved the full address as the
// sign-up email but only its first letter ("j") as the profile email, marked as the student's own answer.
// The first resume read then asked a brand-new student to choose between "j" and their real address.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} } };
const { setSetupEmail, planResumeImport } = await import("../onboarding/profile.js");

const fresh = () => ({
  settings: { signup_email: "" },
  profile: { facts: { email: "", first_name: "" }, sources: { facts: {}, sections: {} },
    education: [], experience: [], projects: [], links: [], skills: { technical: [], tools: [], soft: [] } },
});
const typeInto = (S, text) => { for (let i = 1; i <= text.length; i++) setSetupEmail(S, text.slice(0, i)); return S; };

test("typing the Setup email key by key keeps the whole address in the profile too", () => {
  const S = typeInto(fresh(), "jane.doe@umass.edu");
  assert.equal(S.settings.signup_email, "jane.doe@umass.edu");
  assert.equal(S.profile.facts.email, "jane.doe@umass.edu");
  assert.equal(S.profile.sources.facts.email.value, "jane.doe@umass.edu");
});

test("a first resume read with the same email finds no conflict to review", () => {
  const S = typeInto(fresh(), "jane.doe@umass.edu");
  const plan = planResumeImport(S.profile, { facts: { email: "jane.doe@umass.edu", first_name: "Jane" } });
  assert.deepEqual(plan.filter((e) => e.conflict), []);
});

test("an email given elsewhere first is not replaced by the Setup box", () => {
  const S = fresh();
  S.profile.facts.email = "jane@gmail.com";
  typeInto(S, "jane.doe@umass.edu");
  assert.equal(S.settings.signup_email, "jane.doe@umass.edu");
  assert.equal(S.profile.facts.email, "jane@gmail.com");
});

test("editing the Setup email later keeps the two in step, and clearing it clears both", () => {
  const S = typeInto(fresh(), "jane@umass.edu");
  setSetupEmail(S, "jane@umass.ed");
  setSetupEmail(S, "jane.d@umass.edu");
  assert.equal(S.profile.facts.email, "jane.d@umass.edu");
  setSetupEmail(S, "");
  assert.equal(S.profile.facts.email, "");
});

test("a profile saved with the first letter is repaired, and a waiting resume review stops asking about it", async () => {
  const { repairSetupEmail } = await import("../onboarding/profile.js");
  const S = fresh();
  S.settings.signup_email = "jane.doe@umass.edu";
  S.profile.facts.email = "j";
  S.profile.sources.facts.email = { source: "manual", value: "j" };
  S.settings.resume_import = { plan: [{ id: "facts:email", kind: "facts", key: "email", before: "j", next: "jane.doe@umass.edu", conflict: true }] };
  assert.equal(repairSetupEmail(S), true);
  assert.equal(S.profile.facts.email, "jane.doe@umass.edu");
  assert.equal(S.settings.resume_import.plan[0].conflict, false);
  assert.equal(S.settings.resume_import.plan[0].before, "jane.doe@umass.edu");
  assert.equal(repairSetupEmail(S), false, "nothing to do the second time");
  // A real, different email is never touched.
  const T = fresh();
  T.settings.signup_email = "jane.doe@umass.edu";
  T.profile.facts.email = "jd@x.org";
  T.profile.sources.facts.email = { source: "manual", value: "jd@x.org" };
  assert.equal(repairSetupEmail(T), false);
  // Nor is a short value that came from a resume rather than the Setup box.
  const R = fresh();
  R.settings.signup_email = "jane.doe@umass.edu";
  R.profile.facts.email = "jane";
  R.profile.sources.facts.email = { source: "resume", value: "jane" };
  assert.equal(repairSetupEmail(R), false);
});

test("the Setup page uses it, and repairs an affected profile when it opens", async () => {
  const { readFileSync } = await import("node:fs");
  const onb = readFileSync(new URL("../onboarding/onboarding.js", import.meta.url), "utf8");
  assert.match(onb, /bind\("#email", \(v\) => \{ setSetupEmail\(S, v\); \}\);/);
  assert.match(onb, /if \(repairSetupEmail\(S\)\) \{ pendingResumeImport = pendingResumeReview\(S\); save\(true\); \}/);
  // Called after every declaration save() needs (it runs at the top level of a module).
  assert.ok(onb.indexOf("if (repairSetupEmail(S))") > onb.indexOf("let saveTimer = null;"));
});
