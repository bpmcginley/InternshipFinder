// Import only resume-derived values automatically. Explicit edits and older profiles
// without provenance need review when a resume disagrees with them.
import { RESUME_FACTS, CONFIRMATION_FACTS, ELIGIBILITY_FACTS, factConfirmed, factFallback } from "../lib/store.js";

const clone = (v) => structuredClone(v);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SECTIONS = ["education", "experience", "projects", "links", "skills"];
const CONTACT = RESUME_FACTS;   // was: the same list, here
const empty = (v) => !v || (Array.isArray(v) && !v.length) || (typeof v === "object" && Object.values(v).every(empty));

export function confirmProfileValue(profile, kind, key) {
  profile.sources ||= { facts: {}, sections: {} };
  profile.sources[kind] ||= {};
  const value = kind === "facts" ? profile.facts[key] : profile[key];
  profile.sources[kind][key] = { source: "manual", value: clone(value) };
}

// An AI summary is a suggestion, even when its prompt asks for literal student facts. A value that is
// already in use and the same is left alone; anything new waits on Quick facts (lib/store.js
// confirmedFacts) and is not used meanwhile. The answer it would replace is kept beside it, so turning
// the suggestion down there brings that answer back.
// was: only the 11 CONFIRMATION_FACTS were held back; race, veteran status, citizenship and the rest
// were used as soon as the interview summary named them.
export function applyInterviewFacts(profile, facts) {
  profile.sources ||= { facts: {}, sections: {} };
  profile.sources.facts ||= {};
  for (const [key, value] of Object.entries(facts || {})) {
    if (typeof value !== "string" || !value || !Object.hasOwn(profile.facts, key)) continue;
    const ok = factConfirmed(profile, key);
    if (ok && equal(profile.facts[key], value)) continue;
    const kept = ok ? profile.facts[key] : profile.sources.facts[key]?.kept;
    profile.facts[key] = value;
    const real = typeof kept === "string" && kept && kept !== factFallback(key);   // not just the decline default
    profile.sources.facts[key] = { source: "interview", value: clone(value), ...(real ? { kept } : {}) };
  }
}

// Quick facts: the student turns a suggestion down, and their earlier answer (or unknown, or decline for
// the self-identification six) is their answer again. Taking one is confirmProfileValue: the suggested
// value is already in facts.
export function dismissSuggestion(profile, key) {
  const kept = profile.sources?.facts?.[key]?.kept;
  profile.facts[key] = typeof kept === "string" && kept ? kept : factFallback(key);
  confirmProfileValue(profile, "facts", key);
}

// What the AI returned, with anything it left out filled in as "not read" (undefined), so a reply that
// misses a section can still be saved. A missing section or contact field is left as it is, never
// cleared; only a value the resume gives (including "" or []) replaces anything.
// was: any missing or malformed section threw "The resume details were incomplete", and with no other
// way to finish reading a resume, Auto-Apply could not be turned on at all.
export function normalizeExtracted(extracted) {
  const x = extracted && typeof extracted === "object" && !Array.isArray(extracted) ? extracted : {};
  const facts = x.facts && typeof x.facts === "object" && !Array.isArray(x.facts) ? x.facts : {};
  const out = { facts: {} };
  for (const key of CONTACT) if (typeof facts[key] === "string") out.facts[key] = facts[key];
  for (const key of SECTIONS) {
    const v = x[key];
    if (key === "skills") {
      if (v && typeof v === "object" && !Array.isArray(v)) out.skills = { technical: [], tools: [], soft: [], ...v };
    } else if (Array.isArray(v)) out[key] = v;
  }
  if (!Object.keys(out.facts).length && SECTIONS.every((k) => !(k in out))) {
    throw new Error("Nothing could be read from your resume. Read it again, or enter your details yourself.");
  }
  return out;
}

// `options.legacyResume`: the profile was filled from a resume before sources were recorded
// (settings.extracted_from is set). A field with no record there most likely came from that resume, so
// where the new resume differs, its box is ticked already (`preselect`): the student sees the change and
// can untick it if they had typed the value themselves.
// was: such fields counted as the student's own, so the first re-import kept old contact details and
// removed jobs unless every box was ticked by hand.
// What Quick facts' "Confirm answers shown" confirms: the answers that need confirming, except ones with
// an interview suggestion waiting (`skip`) and old work authorization, sponsorship and age answers, which
// each have their own Confirm button. was: all of CONFIRMATION_FACTS, so one click confirmed
// "authorized: Yes, sponsorship: No, 18+: Yes" that an older version had filled in for everyone.
export const bulkConfirmKeys = (profile, skip = new Set()) => CONFIRMATION_FACTS.filter((key) => !skip.has(key)
  && !(ELIGIBILITY_FACTS.includes(key) && profile.facts?.[key] && !profile.sources?.facts?.[key]));

export function planResumeImport(profile, extracted, { legacyResume = false } = {}) {
  const x = normalizeExtracted(extracted);
  const entries = [];
  const add = (kind, key, next) => {
    const before = kind === "facts" ? profile.facts[key] : profile[key];
    const origin = profile.sources?.[kind]?.[key];
    const derived = origin?.source === "resume" && equal(origin.value, before);
    const conflict = !equal(before, next) && (!empty(before) || origin?.source === "manual") && !derived;
    entries.push({ id: `${kind}:${key}`, kind, key, before: clone(before), next: clone(next), conflict,
      ...(conflict && legacyResume && !origin ? { preselect: true } : {}) });
  };
  for (const key of CONTACT) if (key in x.facts) add("facts", key, x.facts[key]);
  for (const key of SECTIONS) if (key in x) add("sections", key, x[key]);
  return entries;
}

// The boxes ticked when the review opens (onboarding.js drawResumeReview).
export const preselectedImports = (plan) => plan.filter((e) => e.conflict && e.preselect).map((e) => e.id);

export function applyResumeImport(profile, plan, accepted = []) {
  const chosen = new Set(accepted);
  profile.sources ||= { facts: {}, sections: {} };
  for (const e of plan) {
    const current = e.kind === "facts" ? profile.facts[e.key] : profile[e.key];
    // A student may have edited another step while extraction/review was running.
    if (!equal(current, e.before) || (e.conflict && !chosen.has(e.id))) continue;
    if (e.kind === "facts") profile.facts[e.key] = clone(e.next);
    else profile[e.key] = clone(e.next);
    profile.sources[e.kind] ||= {};
    // A manually confirmed value stays protected even if a resume happens to agree.
    if (profile.sources[e.kind][e.key]?.source !== "manual" || !equal(e.before, e.next)) {
      profile.sources[e.kind][e.key] = { source: "resume", value: clone(e.next) };
    }
  }
  return profile;
}

// Apply only this page's changed values to the latest store, preserving concurrent
// background changes to untouched fields. Arrays are an explicit whole-field edit.
export function mergeProfileEdits(fresh, before, next) {
  for (const key of Object.keys(before || {})) if (!(key in (next || {}))) delete fresh[key];
  for (const key of Object.keys(next || {})) {
    if (equal(before?.[key], next[key])) continue;
    const value = next[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      fresh[key] ||= {};
      mergeProfileEdits(fresh[key], before?.[key], value);
    } else fresh[key] = clone(value);
  }
  return fresh;
}

export function focusStepHeading(main) {
  const heading = main.querySelector("h2");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

export function pendingResumeReview(store) {
  return store.files.resume && Array.isArray(store.settings.resume_import?.plan)
    ? { file: store.files.resume, plan: store.settings.resume_import.plan } : null;
}

export function formatResumeValue(value) {
  if (empty(value)) return "Not listed";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.every((v) => typeof v === "string")
    ? value.join(", ") : value.map(formatResumeValue).join("\n\n");
  if (typeof value === "object") return Object.entries(value).filter(([, v]) => !empty(v)).map(([key, v]) => {
    const label = key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    return `${label}: ${formatResumeValue(v)}`;
  }).join("\n");
  return String(value);
}

// Setup's "Email for applications" box, one keystroke at a time (onboarding.js setup()). The profile's
// email follows the box while it is empty or still the box's earlier value, so it ends up as the whole
// address. An email the student gave elsewhere (Quick facts, a resume read) is left alone.
// was: if (!facts.email) { facts.email = v; ... }, which set it on the first keystroke only, so it kept
// the first letter ("j"), marked as the student's own answer, and the first resume read asked about it.
export function setSetupEmail(S, value) {
  const v = String(value ?? "").trim();
  const was = S.settings.signup_email || "";
  S.settings.signup_email = v;
  if (!S.profile.facts.email || S.profile.facts.email === was) {
    S.profile.facts.email = v;
    confirmProfileValue(S.profile, "facts", "email");
  }
  return S;
}

// A profile that already has that first letter (saved by 0.5.6 or earlier): the profile email is a short
// start of the sign-up email with no "@", set by hand. It becomes the whole address, and a resume review
// waiting on it compares against the whole address instead. Returns true when anything changed.
export function repairSetupEmail(S) {
  const f = S.profile && S.profile.facts, signup = (S.settings && S.settings.signup_email) || "";
  const bad = f && f.email;
  if (!bad || bad.includes("@") || bad.length >= signup.length || !signup.startsWith(bad)) return false;
  if (S.profile.sources?.facts?.email?.source !== "manual") return false;
  f.email = signup;
  confirmProfileValue(S.profile, "facts", "email");
  const plan = S.settings.resume_import && S.settings.resume_import.plan;
  for (const e of Array.isArray(plan) ? plan : []) {
    if (e.kind === "facts" && e.key === "email" && e.before === bad) { e.before = signup; e.conflict = !equal(signup, e.next); }
  }
  return true;
}
