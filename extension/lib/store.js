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

export const isGemini = (ai) => (ai && ai.provider) === "gemini";
export const modelsFor = (ai) => (isGemini(ai) ? GEMINI_MODELS : MODELS);
export const keyFor = (ai) => (isGemini(ai) ? ai.geminiKey : ai.apiKey) || "";
export const hasKey = (s) => !!keyFor(s.ai);
// The saved model, unless it belongs to the other provider.
export function agentModel(ai) {
  const m = ai.model || "";
  return m && m.startsWith("gemini") === isGemini(ai) ? m : modelsFor(ai).agent;
}

export const EMPTY_FACTS = {
  first_name: "", last_name: "", preferred_name: "", pronouns: "", email: "", phone: "",
  address: "", city: "", state: "", zip: "", country: "United States",
  linkedin: "", github: "", website: "",
  work_authorized: "Yes", needs_sponsorship: "No", citizenship: "", clearance_eligible: "",
  willing_to_relocate: "Yes", available_start: "", available_end: "", earliest_start: "",
  hours_per_week: "40", salary_expectation: "", how_heard: "Online job board",
  worked_here_before: "No", languages: "English", willing_to_travel: "Yes",
  over_18: "Yes", background_check: "Yes", drug_test: "Yes", non_compete: "No",
  gender: "Decline to self-identify", race: "Decline to self-identify", hispanic: "Decline to self-identify",
  veteran: "I don't wish to answer", disability: "I don't wish to answer", lgbtq: "Decline to self-identify",
};

export function emptyStore() {
  return {
    version: 2,
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
    },
    files: { resume: null, cv: null, transcript: null, cover_letter: null, samples: [] }, // {name, type, b64, size, text?}
    ai: { provider: "anthropic", apiKey: "", geminiKey: "", model: MODELS.agent },
    accounts: [],      // {domain, email, password, created}
    settings: {
      signup_email: "", password_mode: "unique", master_password: "",
      max_tabs: 2, onboarded: false, deep_dive_at: null,
    },
    answers: [],       // log: {jobId, company, title, question, answer, at}
  };
}

function deepMerge(base, over) {
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
  if (a.apiKey) s.ai.apiKey = a.apiKey;
  const f = old.files || {};
  const conv = (x) => x && (x.data || x.b64) ? { name: x.name, type: x.type, b64: x.b64 || x.data, size: x.size || 0 } : null;
  s.files.resume = conv(f.resume); s.files.transcript = conv(f.transcript); s.files.cover_letter = conv(f.cover);
  if (p.email) s.settings.signup_email = p.email;
  return s;
}

export async function loadStore() {
  const raw = await chrome.storage.local.get(null);
  if (raw.store && raw.store.version === 2) return deepMerge(emptyStore(), raw.store);
  const s = (raw.internscout || raw.ai || raw.files) ? migrate(raw) : emptyStore();
  await chrome.storage.local.set({ store: s });
  if (raw.internscout || raw.ai || raw.files) await chrome.storage.local.remove(["internscout", "ai", "files"]);
  return s;
}

export async function saveStore(s) {
  await chrome.storage.local.set({ store: s });
  return s;
}

export async function updateStore(fn) {
  const s = await loadStore();
  const out = (await fn(s)) || s;
  return saveStore(out);
}

// Profile as sent to the model: no files, no passwords, no API key.
export function profileForModel(s) {
  const { facts, education, experience, projects, skills, links, stories, goals, voice, extra } = s.profile;
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
  if (found) return { ...found, isNew: false };
  const password = s.settings.password_mode === "master" && s.settings.master_password ? s.settings.master_password : genPassword();
  return { domain, email: s.settings.signup_email || s.profile.facts.email, password, created: Date.now(), isNew: true };
}
