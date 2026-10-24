// Storage schema + migration from the v0.1 flat keys (internscout / ai / files).
// Works in the service worker (ES module import) and in extension pages (<script type=module>).

export const MODELS = {
  agent: "claude-sonnet-5",
  deep: "claude-opus-5",
  fast: "claude-haiku-4-5",
};

export const GEMINI_MODELS = {
  agent: "gemini-3.8-flash",
  deep: "gemini-3.8-flash",
  fast: "gemini-3.8-flash",
};

// Providers: "internscout" (default; the InternScout Worker with Google/Microsoft sign-in, no key in the extension),
// "anthropic" or "gemini" (Advanced: the student's own key).
export const isWorker = (ai) => (ai && ai.provider) === "internscout";
export const isGemini = (ai) => (ai && ai.provider) === "gemini";
export const modelsFor = (ai) => (isGemini(ai) || isWorker(ai) ? GEMINI_MODELS : MODELS);
export const keyFor = (ai) => (isGemini(ai) ? ai.geminiKey : ai.apiKey) || "";
// "AI is set up". InternScout needs no key; sign-in is checked when a call is made (lib/auth.js).
export const hasKey = (s) => isWorker(s.ai) || !!keyFor(s.ai);

// Cost presets. Tasks: agent (fills forms, many calls), deep (one-time profile extraction / voice),
// interview (chat turns), tailor (one call per job), fast (checks and tiny replies).
export const PRESETS = {
  economy: {
    label: "Economy", blurb: "Cheapest. Haiku everywhere; fine for simple forms, weaker on tricky widgets and essays.",
    anthropic: { agent: MODELS.fast, deep: MODELS.agent, interview: MODELS.fast, tailor: MODELS.fast, fast: MODELS.fast },
  },
  balanced: {
    label: "Balanced", blurb: "Recommended. Sonnet fills forms and tailors; Haiku does the small stuff.",
    anthropic: { agent: MODELS.agent, deep: MODELS.agent, interview: MODELS.fast, tailor: MODELS.agent, fast: MODELS.fast },
  },
  best: {
    label: "Best", blurb: "Most careful. Opus reads your files once and tailors; Sonnet fills forms.",
    anthropic: { agent: MODELS.agent, deep: MODELS.deep, interview: MODELS.agent, tailor: MODELS.deep, fast: MODELS.fast },
  },
};
export const modeOf = (s) => (PRESETS[s.settings && s.settings.ai_mode] ? s.settings.ai_mode : "balanced");
export function modelFor(s, task) {
  // The Worker picks its own model per task; the id is only a label there.
  if (isGemini(s.ai) || isWorker(s.ai)) return GEMINI_MODELS[task] || GEMINI_MODELS.agent;
  return PRESETS[modeOf(s)].anthropic[task] || MODELS.agent;
}

export const EMPTY_FACTS = {
  first_name: "", last_name: "", preferred_name: "", pronouns: "", email: "", phone: "",
  address: "", city: "", state: "", zip: "", country: "United States",
  linkedin: "", github: "", website: "",
  work_authorized: "", needs_sponsorship: "", citizenship: "", clearance_eligible: "",
  willing_to_relocate: "", available_start: "", available_end: "", earliest_start: "",
  // was: how_heard: "Online job board", an answer nobody gave. Blank now; the agent asks when a form needs it.
  hours_per_week: "", salary_expectation: "", how_heard: "",
  worked_here_before: "", languages: "", willing_to_travel: "",
  over_18: "", background_check: "", drug_test: "", non_compete: "",
  gender: "Decline to self-identify", race: "Decline to self-identify", hispanic: "Decline to self-identify",
  veteran: "I don't wish to answer", disability: "I don't wish to answer", lgbtq: "Decline to self-identify",
  majors: "", class_year: "", grad_term: "", // from the dashboard profile (bridge profile:set); majors comma-joined
};

// Older profiles have no way to distinguish default Yes/No answers from deliberate
// ones. Keep their displayed values, but require a recorded confirmation before use.
export const CONFIRMATION_FACTS = ["work_authorized", "needs_sponsorship", "over_18", "willing_to_relocate",
  "willing_to_travel", "background_check", "drug_test", "non_compete", "worked_here_before", "hours_per_week", "languages", "how_heard"];
// What every new profile was given before 2026-10 (PR #94), whether or not the student agreed with it. An
// older profile that still has one of these, with no record of the student choosing it, is flagged on
// Quick facts as an answer they may never have picked.
export const LEGACY_DEFAULTS = {
  work_authorized: "Yes", needs_sponsorship: "No", over_18: "Yes", willing_to_relocate: "Yes", willing_to_travel: "Yes",
  background_check: "Yes", drug_test: "Yes", non_compete: "No", worked_here_before: "No", hours_per_week: "40",
  languages: "English", how_heard: "Online job board",
};
// Work authorization, sponsorship and age: each is its own choice on Quick facts, never part of
// "Confirm answers shown", since a wrong one can make an application untrue.
export const ELIGIBILITY_FACTS = ["work_authorized", "needs_sponsorship", "over_18"];
// The voluntary self-identification answers. They never leave the device (lib/sync.js), and an answer
// nobody confirmed falls back to the decline default in EMPTY_FACTS.
export const DEMOGRAPHIC_KEYS = ["gender", "race", "hispanic", "veteran", "disability", "lgbtq"];
// The facts a resume import fills in (onboarding/profile.js), which the student reviews there, and the
// ones the dashboard sends (background/index.js profile:set), which the student picked there.
export const RESUME_FACTS = ["first_name", "last_name", "email", "phone", "city", "state", "zip", "linkedin", "github", "website"];
export const DASHBOARD_FACTS = ["majors", "class_year", "grad_term"];
const TRUSTED_SOURCES = { manual: null, resume: RESUME_FACTS, dashboard: DASHBOARD_FACTS };

// Whether Auto-Apply and the model may use a fact: the student entered or confirmed it, or it came from a
// reviewed resume or the dashboard and is unchanged since. Anything else, such as an interview summary,
// is a suggestion until it is confirmed on Quick facts. A fact with no record predates provenance and
// counts, except the 11 above.
// was: only CONFIRMATION_FACTS were checked, so an interview's race, veteran status, citizenship or
// clearance went straight to fastFill and the model.
export function factConfirmed(profile, key) {
  const record = profile.sources?.facts?.[key];
  if (!record) return !CONFIRMATION_FACTS.includes(key);
  if (!Object.hasOwn(TRUSTED_SOURCES, record.source)) return false;
  const keys = TRUSTED_SOURCES[record.source];
  return (!keys || keys.includes(key)) && record.value === profile.facts[key];
}
// What is used instead of an unconfirmed fact: unknown (the agent asks when it must), or decline for
// the six. Not an earlier answer the suggestion disagrees with: which one is right is the student's call.
export const factFallback = (key) => (DEMOGRAPHIC_KEYS.includes(key) ? EMPTY_FACTS[key] : "");
export function confirmedFacts(s) {
  const facts = { ...s.profile.facts };
  for (const key of Object.keys(facts)) if (!factConfirmed(s.profile, key)) facts[key] = factFallback(key);
  return facts;
}
// Older answers with no record of the student choosing them (CONFIRMATION_FACTS), which Auto-Apply leaves
// blank until confirmed. `legacy` marks the ones that still match the old default for everyone.
export function unconfirmedOldFacts(profile) {
  return CONFIRMATION_FACTS.filter((key) => profile.facts?.[key] && !profile.sources?.facts?.[key])
    .map((key) => ({ key, value: profile.facts[key], legacy: profile.facts[key] === LEGACY_DEFAULTS[key] }));
}

// The dashboard's "Work authorization" choice (docs/js/core.js WORK_AUTH) against the Deep Dive's answers.
// Returns a sentence for the student when they disagree, else "". Only clear contradictions count:
// "canada", "other" and no choice say nothing about U.S. work.
export function workAuthMismatch(s) {
  const auth = s.dashboard_profile?.work_auth || "", f = s.profile?.facts || {};
  const yes = (v) => /^y/i.test(v || ""), no = (v) => /^n/i.test(v || "");
  const usStatus = /citizen|permanent/i.test(f.citizenship || "") && !/visa|other/i.test(f.citizenship || "");
  if (auth === "citizen" || auth === "permanent") {
    const said = auth === "citizen" ? "a U.S. citizen" : "a U.S. permanent resident";
    if (yes(f.needs_sponsorship)) return `On the dashboard you said you are ${said}, but here you answered that you need visa sponsorship. Check which is right.`;
    if (no(f.work_authorized)) return `On the dashboard you said you are ${said}, but here you answered that you are not authorized to work in the US. Check which is right.`;
    if (/visa/i.test(f.citizenship || "")) return `On the dashboard you said you are ${said}, but your citizenship here is "${f.citizenship}". Check which is right.`;
  }
  if (auth === "visa") {
    if (no(f.needs_sponsorship)) return "On the dashboard you said you are on a student visa and will need sponsorship, but here you answered that you don't need sponsorship. Check which is right.";
    if (usStatus) return `On the dashboard you said you are on a student visa, but your citizenship here is "${f.citizenship}". Check which is right.`;
  }
  return "";
}

// The side panel's note (sidepanel.js): eligibility answers Auto-Apply can't use yet, or a disagreement
// with the dashboard. Empty when there is nothing to check.
export function factCheckNote(s) {
  if (workAuthMismatch(s)) return "Your work authorization answers here and on the dashboard disagree. Check them in Quick facts.";
  const old = unconfirmedOldFacts(s.profile).filter((x) => ELIGIBILITY_FACTS.includes(x.key));
  if (old.length) return "Some saved answers, like work authorization, were never confirmed. Auto-Apply leaves them blank until you confirm them in Quick facts.";
  return "";
}

// Suggested values waiting on Quick facts: [{key, value, source, kept}], kept being the student's earlier
// answer when there was one (onboarding/profile.js applyInterviewFacts).
export function factSuggestions(profile) {
  return Object.keys(profile.facts || {}).filter((key) => profile.sources?.facts?.[key] && !factConfirmed(profile, key)
    && !Object.hasOwn(TRUSTED_SOURCES, profile.sources.facts[key].source) && profile.facts[key])
    .map((key) => ({ key, value: profile.facts[key], source: profile.sources.facts[key].source, kept: profile.sources.facts[key].kept || "" }));
}

// A replaced or removed resume pauses Auto-Apply until the new one is read and its details reviewed
// (onboarding.js). Kept apart from `onboarded`, which only ever goes from false to true: lib/sync.js
// treats an unfinished device as one that gives way to the account's copy.
// A student who chose "I'll enter my details myself" (onboarding.js) after a resume read failed or was
// skipped: Auto-Apply stays paused until the contact details a resume would have given are filled in.
export const MANUAL_DETAILS = ["first_name", "last_name", "email"];
export const manualDetailsMissing = (s) => (s.settings.resume_details_manual
  ? MANUAL_DETAILS.filter((k) => !String(s.profile?.facts?.[k] || "").trim()) : []);
// 2026-10-23: cloud restore deliberately omits files; completion never proves local upload bytes (EXT-5).
// was: a restored completed profile could queue work with resume=null. Revert: remove this prerequisite.
export const hasLocalResume = (s) => !!(s.files?.resume && String(s.files.resume.name || "").trim()
  && typeof s.files.resume.b64 === "string" && s.files.resume.b64.trim());
export const resumeReviewPending = (s) => !hasLocalResume(s) || s.settings.resume_details_ready === false || !!s.settings.resume_import
  || manualDetailsMissing(s).length > 0;
// Auto-Apply may fill forms: the Deep Dive is finished and no resume is waiting to be reviewed.
export const autoApplyReady = (s) => !!s.settings.onboarded && !resumeReviewPending(s);

export const STORE_VERSION = 3;

export function emptyStore() {
  return {
    version: STORE_VERSION,
    profile: {
      facts: { ...EMPTY_FACTS },
      education: [],   // {school, degree, major, minor, gpa, start, end, grad_term, coursework}
      experience: [],  // {company, title, location, start, end, bullets[]}
      projects: [],    // {name, role, dates, description, link}
      skills: { technical: [], tools: [], soft: [] },
      links: [],       // {label, url}
      stories: [],     // {theme, situation, task, action, result, reflection}
      goals: { career: "", why_field: "", interests: "", strengths: "", growth_areas: "", why_internship: "" },
      voice: { summary: "", tone: "", sentence_style: "", vocabulary: "", avoid: "", sample: "" },
      extra: {},       // answers to ask_user questions: {question_text: answer}
      sources: { facts: {}, sections: {} }, // origin and last imported value; never sent to the model
    },
    files: { resume: null, cv: null, transcript: null, cover_letter: null, samples: [] }, // {name, type, b64, size, text?}
    ai: { provider: "internscout", apiKey: "", geminiKey: "", model: GEMINI_MODELS.agent },
    dashboard_profile: null, // last profile the dashboard sent: {majors, minors, class_year, grad_term, stages, terms, states, work_auth}
    accounts: [],      // {domain, email, password, created}
    settings: {
      signup_email: "", password_mode: "unique", master_password: "",
      max_tabs: 2, onboarded: false, deep_dive_at: null, deep_dive_run: null,
      ai_mode: "balanced",       // economy | balanced | best (see PRESETS)
      tailor_resume: "review",   // off | review (you approve each one) | auto
      // Saving the Deep Dive to the student's account (lib/sync.js). On by default; the switch is in the
      // Deep Dive's account box. The other two are the background's bookkeeping: when the synced part of
      // the profile last changed (ISO), and a hash of it as of the last time it matched the account's copy.
      cloud_sync: true, profile_updated_at: null, profile_synced_hash: null,
    },
    answers: [],       // log: {jobId, company, title, question, answer, at}
  };
}

export function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === "object") {
    const out = { ...base };
    for (const k of Object.keys(over || {})) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined || over === null ? base : over;
}

// v0.1 stored a flat profile under "internscout", {apiKey, model} under "ai", {resume, transcript, cover} under "files".
export function migrate(old) {
  const s = emptyStore();
  const p = old.internscout || {};
  for (const k of Object.keys(EMPTY_FACTS)) if (p[k]) s.profile.facts[k] = p[k];
  if (p.full_name && !p.first_name) {
    const [f, ...rest] = String(p.full_name).split(" ");
    s.profile.facts.first_name = f; s.profile.facts.last_name = rest.join(" ");
  }
  if (p.school || p.degree || p.major) s.profile.education.push({
    school: p.school || "", degree: p.degree || "", major: p.major || "", minor: "", gpa: p.gpa || "",
    start: [p.edu_start_month, p.edu_start_year].filter(Boolean).join(" "),
    end: [p.edu_end_month, p.edu_end_year].filter(Boolean).join(" "), grad_term: p.grad_term || "", coursework: "",
  });
  if (p.background) s.profile.goals.interests = p.background;
  if (p.resume_text) s.files.resume_text = p.resume_text;
  const a = old.ai || {};
  if (a.apiKey) Object.assign(s.ai, { provider: "anthropic", apiKey: a.apiKey, model: MODELS.agent });
  const f = old.files || {};
  const conv = (x) => x && (x.data || x.b64) ? { name: x.name, type: x.type, b64: x.b64 || x.data, size: x.size || 0 } : null;
  s.files.resume = conv(f.resume); s.files.transcript = conv(f.transcript); s.files.cover_letter = conv(f.cover);
  if (p.email) s.settings.signup_email = p.email;
  return s;
}

// v2 → v3: InternScout becomes the AI provider, unless a key was saved (then the student's provider stays).
export function upgradeStore(stored) {
  const s = deepMerge(emptyStore(), stored);
  if (stored.version === 2) {
    const a = stored.ai || {};
    if (!a.apiKey && !a.geminiKey) Object.assign(s.ai, { provider: "internscout", model: GEMINI_MODELS.agent });
    else if (!a.provider) s.ai.provider = a.geminiKey && !a.apiKey ? "gemini" : "anthropic";
  }
  s.version = STORE_VERSION;
  return s;
}

// was: chrome.storage.local.get(null). That reads everything the extension keeps, and since the
// tailored resumes moved out of the queue that means every tailored_<id> file, the tailor cache
// (twelve more files) and each job's messages: megabytes, on every queue change in the side panel
// and on every step of the agent, to use one key of a few kilobytes. The review measured 3.6 MB
// read for a 1.6 KB store. Only the store and the three keys a first-version install had are asked for.
const STORE_KEYS = ["store", "internscout", "ai", "files"];
// Extension pages and the service worker share an origin, so Web Locks serialize the
// complete read/modify/write across contexts, including first-load migration.
let localWrites = Promise.resolve();
function withStoreLock(fn) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request("internscout-store", fn);
  // Chrome 114+ supplies Web Locks in extension pages and workers. Fail closed if a
  // browser does not: an in-memory queue cannot protect other extension contexts.
  if (globalThis.chrome?.runtime?.id) return Promise.reject(new Error("Update your browser to safely save profile changes."));
  const next = localWrites.then(fn, fn); // non-browser test harnesses
  localWrites = next.catch(() => {});
  return next;
}
async function loadStoreUnlocked() {
  const raw = await chrome.storage.local.get(STORE_KEYS);
  if (raw.store && raw.store.version === STORE_VERSION) return deepMerge(emptyStore(), raw.store);
  if (raw.store && raw.store.version === 2) {
    const s = upgradeStore(raw.store);
    await chrome.storage.local.set({ store: s });
    return s;
  }
  const s = (raw.internscout || raw.ai || raw.files) ? migrate(raw) : emptyStore();
  await chrome.storage.local.set({ store: s });
  if (raw.internscout || raw.ai || raw.files) await chrome.storage.local.remove(["internscout", "ai", "files"]);
  return s;
}

export function loadStore() { return withStoreLock(loadStoreUnlocked); }

export async function saveStore(s) {
  return withStoreLock(async () => { await chrome.storage.local.set({ store: s }); return s; });
}

// 2026-10-23: let sync consume its pending marker only after the revision is durably saved,
// while still holding the same lock as noteEdit. was: no post-save locked callback.
// Revert: remove the afterSave option together with sync's locked marker consumption.
export async function updateStore(fn, { afterSave } = {}) {
  return withStoreLock(async () => {
    const s = await loadStoreUnlocked();
    const out = (await fn(s)) || s;
    await chrome.storage.local.set({ store: out });
    if (afterSave) await afterSave(out);
    return out;
  });
}

// Profile as sent to the model: no files, no passwords, no API key.
export function profileForModel(s) {
  const { education, experience, projects, skills, links, stories, goals, voice, extra } = s.profile;
  const facts = confirmedFacts(s);
  return { facts, education, experience, projects, skills, links, stories, goals, voice, extra,
    signup_email: s.settings.signup_email || facts.email,
    files_available: Object.entries(s.files).filter(([k, v]) => k !== "samples" && v && v.b64).map(([k]) => k) };
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function genPassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_+?"];
  const all = sets.join("");
  const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = sets.map((set) => set[rnd(set.length)]);
  while (chars.length < 18) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

// Returns {domain, email, password}; creates (but does not persist) a new account if none exists.
export function accountFor(s, url) {
  const domain = domainOf(url);
  // Workday tenants share accounts per tenant host; everything else per registrable host.
  const found = s.accounts.find((a) => a.domain === domain);
  if (found) return { ...found, isNew: found.state === "pending" };
  const password = s.settings.password_mode === "master" && s.settings.master_password ? s.settings.master_password : genPassword();
  return { domain, email: s.settings.signup_email || s.profile.facts.email, password, created: Date.now(), isNew: true };
}
