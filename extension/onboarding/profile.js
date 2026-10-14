// Import only resume-derived values automatically. Explicit edits and older profiles
// without provenance need review when a resume disagrees with them.
import { RESUME_FACTS, factConfirmed, factFallback } from "../lib/store.js";

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

export function planResumeImport(profile, extracted) {
  if (!extracted?.facts || typeof extracted.facts !== "object" || Array.isArray(extracted.facts)
    || SECTIONS.some((k) => k === "skills" ? !extracted[k] || typeof extracted[k] !== "object" || Array.isArray(extracted[k]) : !Array.isArray(extracted[k]))) {
    throw new Error("The resume details were incomplete. Read your resume again before saving them.");
  }
  const entries = [];
  const add = (kind, key, next) => {
    const before = kind === "facts" ? profile.facts[key] : profile[key];
    const origin = profile.sources?.[kind]?.[key];
    const derived = origin?.source === "resume" && equal(origin.value, before);
    entries.push({ id: `${kind}:${key}`, kind, key, before: clone(before), next: clone(next),
      conflict: !equal(before, next) && (!empty(before) || origin?.source === "manual") && !derived });
  };
  for (const key of CONTACT) add("facts", key, typeof extracted.facts[key] === "string" ? extracted.facts[key] : "");
  for (const key of SECTIONS) add("sections", key, extracted[key]);
  return entries;
}

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
