// Deep Dive: setup → files → facts → interview → voice → review. Re-runnable; keeps existing answers.
import { loadStore, updateStore, hasKey, isGemini, isWorker, modelFor, modeOf, PRESETS } from "../lib/store.js";
import { allowanceLines, tierNote, MAIN_TASKS, PROVIDER_LABELS } from "../lib/auth.js";
import { callAI, textOf, jsonOf } from "../background/claude.js";
import { DEFAULT_PRICES, loadUsage, saveUsage, priceFor, spend, money } from "../lib/usage.js";

const main = document.getElementById("main");
const stepsEl = document.getElementById("steps");
const STEPS = [
  ["setup", "Setup"], ["files", "Files"], ["facts", "Quick facts"],
  ["interview", "Interview"], ["voice", "Voice"], ["review", "Review"],
];
let S = await loadStore();
const rerun = !!S.settings.onboarded;
let step = new URLSearchParams(location.search).get("step") || (rerun ? "review" : "setup");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (sel) => main.querySelector(sel);

// ---------- persistence ----------
// The service worker also writes the store (accounts, answers, learned answers), so merge instead of overwrite.
let saveTimer = null;
function save(now) {
  clearTimeout(saveTimer);
  const run = () => updateStore((fresh) => {
    fresh.profile = { ...S.profile, extra: { ...fresh.profile.extra, ...S.profile.extra } };
    fresh.files = S.files; fresh.ai = S.ai; fresh.settings = S.settings;
  });
  if (now) return run();
  saveTimer = setTimeout(run, 300);
}
window.addEventListener("beforeunload", () => save(true));

// One Deep Dive is one run to the Worker, however many questions it asks, so every call carries the
// same run_id: minted on first use, kept across reloads, retired when the Deep Dive is finished so
// the next one is a new run. Without it each interview reply was its own run, so the per-run call
// limit never applied and, while the Deep Dive still had a monthly cap, two replies used it up.
const runId = () => {
  if (!S.settings.deep_dive_run) { S.settings.deep_dive_run = crypto.randomUUID(); save(); }
  return S.settings.deep_dive_run;
};
const ai = (opts) => callAI({ ai: S.ai, kind: "deep_dive", run_id: runId(), ...opts });
const M = () => ({ fast: modelFor(S, "fast"), deep: modelFor(S, "deep"), agent: modelFor(S, "interview") });
const busy = (el, text) => { el.innerHTML = `<span class="spin"></span>${esc(text)}`; };

// ---------- file helpers ----------
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function readFile(file) {
  if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} is over 15 MB.`);
  const buf = await file.arrayBuffer();
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isDocx = /\.docx$/i.test(file.name);
  const out = { name: file.name, type: isPdf ? "application/pdf" : file.type || "application/octet-stream", size: file.size, b64: toB64(buf) };
  if (isDocx) {
    if (!window.mammoth) throw new Error("DOCX reader failed to load. Save the file as PDF instead.");
    out.text = (await window.mammoth.extractRawText({ arrayBuffer: buf })).value;
  } else if (!isPdf) {
    out.text = new TextDecoder().decode(buf);
  }
  return out;
}
function docBlock(f, title) {
  if (!f) return null;
  if (f.type === "application/pdf" && f.b64) return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.b64 }, title };
  if (f.text) return { type: "document", source: { type: "text", media_type: "text/plain", data: f.text.slice(0, 60000) }, title };
  return null;
}

// ---------- nav ----------
function doneFor(id) {
  const p = S.profile;
  return {
    setup: !!(hasKey(S) && S.settings.signup_email),
    files: !!S.files.resume,
    facts: !!(p.facts.first_name && p.facts.email && p.facts.available_start),
    interview: p.stories.length >= 3,
    voice: !!p.voice.summary,
    review: !!S.settings.onboarded,
  }[id];
}
function go(id) { save(true); step = id; render(); scrollTo(0, 0); }
function navButtons(prev, next, nextLabel = "Next") {
  return `<div class="nav"><div>${prev ? `<button class="btn" data-go="${prev}">← Back</button>` : ""}</div><div>${next ? `<button class="btn blue" data-go="${next}">${nextLabel} →</button>` : ""}</div></div>`;
}
function wireNav() {
  main.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
}
function render() {
  stepsEl.innerHTML = STEPS.map(([id, t]) => `<button data-step="${id}" class="${id === step ? "on" : ""} ${doneFor(id) ? "done" : ""}">${t}</button>`).join("");
  stepsEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(b.dataset.step)));
  ({ setup, files, facts, interview, voice, review })[step]();
  wireNav();
}

// ---------- 1. setup ----------
function setup() {
  main.innerHTML = `
    ${rerun ? `<div class="banner">You've done the Deep Dive before. Everything you entered is kept, so just update what changed.</div>` : ""}
    <h2>Setup</h2><p class="lead">${isWorker(S.ai)
      ? "Auto-Apply uses InternScout's free AI: sign in with Google or Microsoft and there's nothing else to set up. Your passwords stay in this browser."
      : "Auto-Apply uses your own AI API key. The key and your passwords stay in this browser."}</p>
    <div class="card"><h3>AI provider</h3>
      <label class="f"><span>Provider</span><select id="provider">
        <option value="internscout">InternScout (free, sign in with Google or Microsoft)</option>
        <option value="anthropic">Your own Anthropic (Claude) key</option>
        <option value="gemini">Your own Google (Gemini) key</option></select></label>
      ${isWorker(S.ai)
        ? `<div id="acct"><span class="small muted"><span class="spin"></span>Checking sign-in…</span></div>`
        : isGemini(S.ai)
        ? `<label class="f"><span>Gemini key (from aistudio.google.com → Get API key)</span><input type="password" id="key" value="${esc(S.ai.geminiKey)}" placeholder="AIza…"></label>`
        : `<label class="f"><span>Anthropic key (from console.anthropic.com → API keys)</span><input type="password" id="key" value="${esc(S.ai.apiKey)}" placeholder="sk-ant-…"></label>`}
      ${isWorker(S.ai) ? "" : `<div class="row"><button class="btn small" id="test">Test key</button><span id="testout" class="small"></span></div>`}
      ${isWorker(S.ai) ? "" : isGemini(S.ai)
        ? `<p class="small muted" style="margin:12px 0 0">Gemini 3.8 Flash is used for everything. Google's free tier covers light use. Your resume, files and interview go to Google when Gemini is used.</p>`
        : `<label class="f" style="margin-top:12px"><span>Quality vs. cost</span><select id="mode">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("")}</select></label>
      <p class="small muted" id="modeblurb" style="margin:0"></p>`}
    </div>
    <div class="card"><h3>Tailored resumes</h3>
      <p class="small muted" style="margin-top:0">Before each application, the AI rewords your existing resume bullets toward the posting and makes a clean one-page-style PDF. It can't add jobs, skills or numbers you didn't list; changed numbers are thrown out automatically. About 1 to 5 cents per job.</p>
      <label class="f"><span>When applying</span><select id="tailor">
        <option value="review">Tailor it, and let me approve each one (recommended)</option>
        <option value="auto">Tailor it and use it automatically</option>
        <option value="off">Always upload my original resume</option></select></label>
    </div>
    ${isWorker(S.ai) ? "" : `<div class="card"><h3>AI spending</h3>
      <p class="small muted" style="margin-top:0">Every AI call is priced and added up. When the monthly budget is reached, applications pause until you raise it. Prices are estimates in USD per million tokens; correct them from your provider's pricing page if they differ.</p>
      <p class="small" id="spent" style="margin-top:0"></p>
      <label class="f"><span>Monthly budget in USD (0 = no limit)</span><input type="number" id="budget" min="0" step="1"></label>
      <div id="prices" class="grid"></div>
    </div>`}
    <div class="card"><h3>Job-site accounts</h3>
      <p class="small muted" style="margin-top:0">Workday, iCIMS and similar sites need an account. The agent creates it for you with this email. Passwords are filled in by the extension itself and never shown to the AI.</p>
      <label class="f"><span>Email for applications and sign-ups</span><input type="email" id="email" value="${esc(S.settings.signup_email || S.profile.facts.email)}"></label>
      <label class="f"><span>Passwords</span><select id="pwmode">
        <option value="unique">A unique strong password per site (saved in the Accounts tab)</option>
        <option value="master">One password I choose for every site</option></select></label>
      <label class="f" id="masterwrap"><span>Your password (must satisfy strict rules: 12+ chars, upper, lower, number, symbol)</span><input type="password" id="master" value="${esc(S.settings.master_password)}"></label>
      <label class="f"><span>Applications to work on at once</span><select id="tabs">${[1, 2, 3, 4].map((n) => `<option ${n === S.settings.max_tabs ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    </div>
    <div id="need" class="small warn"></div>
    ${navButtons(null, "files")}`;
  $("#provider").value = isWorker(S.ai) ? "internscout" : isGemini(S.ai) ? "gemini" : "anthropic";
  if (isWorker(S.ai)) fillAccount();
  const syncMode = () => { if ($("#mode")) { $("#mode").value = modeOf(S); $("#modeblurb").textContent = PRESETS[modeOf(S)].blurb; } };
  syncMode();
  $("#tailor").value = S.settings.tailor_resume || "review";
  $("#provider").addEventListener("change", (e) => {
    S.ai.provider = e.target.value;
    S.ai.model = modelFor(S, "agent");
    save();
    setup();
  });
  $("#pwmode").value = S.settings.password_mode;
  const syncMaster = () => { $("#masterwrap").hidden = $("#pwmode").value !== "master"; };
  syncMaster();
  const bind = (id, fn) => $(id).addEventListener("input", (e) => { fn(e.target.value); save(); });
  if ($("#key")) bind("#key", (v) => { if (isGemini(S.ai)) S.ai.geminiKey = v.trim(); else S.ai.apiKey = v.trim(); });
  if ($("#mode")) bind("#mode", (v) => { S.settings.ai_mode = v; S.ai.model = modelFor(S, "agent"); syncMode(); });
  bind("#tailor", (v) => { S.settings.tailor_resume = v; });
  bind("#email", (v) => { S.settings.signup_email = v.trim(); if (!S.profile.facts.email) S.profile.facts.email = v.trim(); });
  bind("#pwmode", (v) => { S.settings.password_mode = v; syncMaster(); });
  bind("#master", (v) => { S.settings.master_password = v; });
  bind("#tabs", (v) => { S.settings.max_tabs = +v; });
  fillSpending();
  if ($("#test")) $("#test").addEventListener("click", async () => {
    const out = $("#testout");
    busy(out, "Checking…");
    try {
      await ai({ model: M().fast, max_tokens: 5, messages: [{ role: "user", content: "Reply OK" }] });
      out.innerHTML = `<span class="ok">Key works.</span>`;
    } catch (e) { out.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  });
}

// InternScout AI: sign-in state and this month's allowance, from the background (auth:me).
async function fillAccount(msg) {
  const box = $("#acct");
  if (!box) return;
  const a = await chrome.runtime.sendMessage({ type: "auth:me" }).catch((e) => ({ error: e.message }));
  if (!$("#acct")) return; // moved to another step meanwhile
  const note = msg ? `<p class="small err" style="margin:8px 0 0">${esc(msg)}</p>` : "";
  if (!a || a.error || !a.signedIn) {
    box.innerHTML = `
      <p class="small" style="margin:0 0 10px">Sign in to use the AI. Any Google account or personal Microsoft account works. School Microsoft accounts (like @umass.edu Outlook) need IT approval, so use Google with your school email for the larger .edu allowance.</p>
      <div class="row"><button class="btn blue" data-signin="google">Sign in with Google (UMass email)</button><button class="btn" data-signin="microsoft">Sign in with Microsoft</button><span id="signin-msg" class="small"></span></div>
      ${note || (a && a.error ? `<p class="small err" style="margin:8px 0 0">${esc(a.error)}</p>` : "")}`;
    box.querySelectorAll("[data-signin]").forEach((b) => b.addEventListener("click", async () => {
      box.querySelectorAll("button").forEach((x) => { x.disabled = true; });
      busy($("#signin-msg"), "Waiting for the sign-in window…");
      const r = await chrome.runtime.sendMessage({ type: "auth:signin", provider: b.dataset.signin }).catch((e) => ({ error: e.message }));
      fillAccount(r && r.error ? r.error : "");
    }));
    return;
  }
  const lines = allowanceLines(a.me, MAIN_TASKS);
  box.innerHTML = `
    <p class="small" style="margin:0 0 8px">Signed in${a.provider ? ` with ${esc(PROVIDER_LABELS[a.provider] || a.provider)}` : ""}${a.email ? ` as <b>${esc(a.email)}</b>` : ""}. <a href="#" id="signout">Sign out</a></p>
    ${lines.length ? `<ul class="small" style="margin:0 0 6px;padding-left:18px">${lines.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <p class="small ${!a.me || a.me.error ? "err" : "muted"}" style="margin:0">${esc(tierNote(a.me))}</p>${note}`;
  $("#signout").addEventListener("click", async (e) => {
    e.preventDefault();
    await chrome.runtime.sendMessage({ type: "auth:signout" });
    fillAccount();
  });
}

async function fillSpending() {
  const u = await loadUsage(), sp = await spend();
  if (!$("#prices")) return;
  $("#spent").textContent = `This month so far: ${money(sp.month_usd)} across ${sp.calls} AI calls.`;
  $("#budget").value = u.budget || 0;
  $("#budget").addEventListener("input", (e) => saveUsage({ budget: Math.max(0, +e.target.value || 0) }));
  const models = Object.keys(DEFAULT_PRICES).filter((m) => m.startsWith("gemini") === isGemini(S.ai));
  $("#prices").innerHTML = models.map((m) => {
    const p = priceFor(m, u.prices);
    return `<label class="f"><span>${esc(m)}: input / output</span><div class="row" style="flex-wrap:nowrap"><input type="number" min="0" step="0.01" data-m="${m}" data-k="in" value="${p.in}"><input type="number" min="0" step="0.01" data-m="${m}" data-k="out" value="${p.out}"></div></label>`;
  }).join("");
  $("#prices").querySelectorAll("input").forEach((inp) => inp.addEventListener("input", async () => {
    const prices = (await loadUsage()).prices;
    prices[inp.dataset.m] = { ...priceFor(inp.dataset.m, prices), [inp.dataset.k]: Math.max(0, +inp.value || 0) };
    await saveUsage({ prices });
  }));
}

// ---------- 2. files ----------
const SLOTS = [
  ["resume", "Resume", "Required. Used for every application and uploaded where asked."],
  ["cv", "CV", "Optional longer version with everything."],
  ["transcript", "Transcript", "Optional. Uploaded when a site asks for one."],
  ["cover_letter", "Cover letter", "Optional. A past letter you like, used as a style reference and uploaded if asked."],
];
function files() {
  const fmt = (f) => f ? `${esc(f.name)} · ${Math.max(1, Math.round(f.size / 1024))} KB` : "No file";
  main.innerHTML = `
    <h2>Your files</h2><p class="lead">PDF works best. DOCX, TXT and Markdown are fine too.</p>
    <div class="card">${SLOTS.map(([k, t, d]) => `
      <div class="slot"><div class="name"><b>${t}</b><span class="small muted">${d}</span><div class="small ${S.files[k] ? "ok" : "muted"}">${fmt(S.files[k])}</div></div>
        <input type="file" data-slot="${k}" accept=".pdf,.docx,.txt,.md" hidden>
        <button class="btn small" data-pick="${k}">${S.files[k] ? "Replace" : "Choose"}</button>
        ${S.files[k] ? `<button class="btn small" data-clear="${k}">Remove</button>` : ""}</div>`).join("")}
    </div>
    <div class="card"><h3>Writing samples and "you" material</h3>
      <p class="small muted" style="margin-top:0">Essays, personal statements, blog posts, or anything that shows how you write and who you are. The AI studies these to write short answers in your voice.</p>
      ${S.files.samples.map((f, i) => `<div class="slot"><div class="name"><b>${esc(f.name)}</b><span class="small muted">${f.text ? `${f.text.length.toLocaleString()} characters` : fmt(f)}</span></div><button class="btn small" data-rms="${i}">Remove</button></div>`).join("")}
      <div class="row" style="margin-top:10px"><input type="file" id="samples" accept=".pdf,.docx,.txt,.md" multiple hidden><button class="btn small" id="addsamples">Add files</button></div>
      <label class="f" style="margin-top:12px"><span>…or paste text</span><textarea id="paste" placeholder="Paste an essay, a LinkedIn About section, anything."></textarea></label>
      <button class="btn small" id="addpaste">Add pasted text</button>
    </div>
    <div class="card"><h3>Read my files</h3>
      <p class="small muted" style="margin-top:0">Claude reads your resume${S.files.cv ? " and CV" : ""} and fills in your education, experience, projects, skills and contact info. You can edit all of it in Review.</p>
      <div class="row"><button class="btn primary" id="extract" ${S.files.resume ? "" : "disabled"}>Read my resume</button><span id="exout" class="small">${S.settings.extracted_from ? `<span class="ok">Last read: ${esc(S.settings.extracted_from)}</span>` : ""}</span></div>
    </div>
    <div id="ferr" class="err small"></div>
    ${navButtons("setup", "facts")}`;
  const err = (e) => { $("#ferr").textContent = e.message || String(e); };
  main.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => main.querySelector(`[data-slot=${b.dataset.pick}]`).click()));
  main.querySelectorAll("[data-slot]").forEach((inp) => inp.addEventListener("change", async () => {
    try { S.files[inp.dataset.slot] = await readFile(inp.files[0]); await save(true); files(); wireNav(); } catch (e) { err(e); }
  }));
  main.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", async () => { S.files[b.dataset.clear] = null; await save(true); files(); wireNav(); }));
  main.querySelectorAll("[data-rms]").forEach((b) => b.addEventListener("click", async () => { S.files.samples.splice(+b.dataset.rms, 1); await save(true); files(); wireNav(); }));
  $("#addsamples").addEventListener("click", () => $("#samples").click());
  $("#samples").addEventListener("change", async (e) => {
    try { for (const f of e.target.files) S.files.samples.push(await readFile(f)); await save(true); files(); wireNav(); } catch (x) { err(x); }
  });
  $("#addpaste").addEventListener("click", async () => {
    const t = $("#paste").value.trim();
    if (!t) return;
    S.files.samples.push({ name: `Pasted text (${t.slice(0, 30)}…)`, type: "text/plain", size: t.length, text: t });
    await save(true); files(); wireNav();
  });
  $("#extract").addEventListener("click", () => extract($("#extract"), $("#exout")).catch(err));
}

async function extract(btn, out) {
  btn.disabled = true;
  busy(out, "Reading your resume… (about 30 seconds)");
  try {
    const content = [docBlock(S.files.resume, "Resume"), docBlock(S.files.cv, "CV")].filter(Boolean);
    if (!content.length) throw new Error("Couldn't read the resume file. Try a PDF.");
    content.push({ type: "text", text: `Extract this applicant's details as JSON only, no commentary. Use "" or [] when unknown; never guess.
{"facts":{"first_name":"","last_name":"","email":"","phone":"","city":"","state":"","zip":"","linkedin":"","github":"","website":""},
 "education":[{"school":"","degree":"","major":"","minor":"","gpa":"","start":"","end":"","grad_term":"","coursework":""}],
 "experience":[{"company":"","title":"","location":"","start":"","end":"","bullets":[""]}],
 "projects":[{"name":"","role":"","dates":"","description":"","link":""}],
 "skills":{"technical":[],"tools":[],"soft":[]},
 "links":[{"label":"","url":""}]}
Dates as "Mon YYYY" or "Present". Keep bullet wording faithful to the document.` });
    const r = await ai({ model: M().deep, max_tokens: 12000, thinking: { type: "adaptive" }, messages: [{ role: "user", content }] });
    const x = jsonOf(r);
    const p = S.profile;
    for (const [k, v] of Object.entries(x.facts || {})) if (v && !p.facts[k]) p.facts[k] = v;
    // The resume is the source of truth for these lists; replace them when a (new) resume is read.
    for (const k of ["education", "experience", "projects", "links"]) if (Array.isArray(x[k]) && x[k].length) p[k] = x[k];
    if (x.skills) p.skills = { technical: x.skills.technical || [], tools: x.skills.tools || [], soft: x.skills.soft || [] };
    if (!S.settings.signup_email && p.facts.email) S.settings.signup_email = p.facts.email;
    S.settings.extracted_from = S.files.resume.name;
    await save(true);
    out.innerHTML = `<span class="ok">Found ${p.education.length} school(s), ${p.experience.length} role(s), ${p.projects.length} project(s).</span>`;
  } catch (e) {
    out.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally { btn.disabled = false; }
}

// ---------- 3. facts ----------
const YN = ["Yes", "No"];
const FACTS = [
  ["Contact", "", [
    ["first_name", "First name"], ["last_name", "Last name"], ["preferred_name", "Preferred name"], ["pronouns", "Pronouns"],
    ["email", "Email"], ["phone", "Phone"], ["address", "Street address"], ["city", "City"], ["state", "State"], ["zip", "ZIP"],
    ["country", "Country"], ["linkedin", "LinkedIn URL"], ["github", "GitHub URL"], ["website", "Website / portfolio"]]],
  ["Work eligibility", "", [
    ["work_authorized", "Authorized to work in the US?", YN],
    ["needs_sponsorship", "Need visa sponsorship now or later?", YN],
    ["citizenship", "Citizenship", ["", "U.S. citizen", "U.S. permanent resident", "F-1 student visa", "Other"]],
    ["clearance_eligible", "Eligible for a security clearance?", ["", "Yes", "No", "Not sure"]],
    ["over_18", "18 or older?", YN], ["background_check", "OK with a background check?", YN],
    ["drug_test", "OK with a drug test?", YN], ["non_compete", "Bound by a non-compete?", YN]]],
  ["Availability and defaults", "", [
    ["available_start", "Internship start date (e.g. May 2027)"], ["available_end", "Internship end date (e.g. August 2027)"],
    ["earliest_start", "Earliest start date"], ["hours_per_week", "Hours per week"],
    ["willing_to_relocate", "Willing to relocate for the summer?", YN], ["willing_to_travel", "Willing to travel?", YN],
    ["salary_expectation", "Pay expectation (blank = \"flexible\")"], ["how_heard", "\"How did you hear about us?\" default"],
    ["worked_here_before", "\"Worked here before?\" default", YN], ["languages", "Languages you speak"]]],
  ["Voluntary self-identification", "These questions are optional and can't affect your eligibility. The default is to decline.", [
    ["gender", "Gender", ["Decline to self-identify", "Male", "Female", "Non-binary"]],
    ["hispanic", "Hispanic or Latino?", ["Decline to self-identify", "Yes", "No"]],
    ["race", "Race", ["Decline to self-identify", "American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or more races"]],
    ["veteran", "Veteran status", ["I don't wish to answer", "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran"]],
    ["disability", "Disability", ["I don't wish to answer", "No, I do not have a disability", "Yes, I have a disability (or previously had one)"]],
    ["lgbtq", "LGBTQ+?", ["Decline to self-identify", "Yes", "No"]]]],
];
function facts() {
  const f = S.profile.facts;
  const field = ([k, label, opts]) => opts
    ? `<label class="f"><span>${esc(label)}</span><select data-fact="${k}">${[...new Set([...opts, f[k]])].map((o) => `<option ${o === f[k] ? "selected" : ""} value="${esc(o)}">${esc(o || "—")}</option>`).join("")}</select></label>`
    : `<label class="f"><span>${esc(label)}</span><input type="text" data-fact="${k}" value="${esc(f[k])}"></label>`;
  main.innerHTML = `<h2>Quick facts</h2><p class="lead">The questions nearly every application asks. Answer once; the agent reuses them everywhere.</p>
    ${FACTS.map(([t, note, list]) => `<div class="card"><h3>${t}</h3>${note ? `<p class="small muted" style="margin-top:0">${note}</p>` : ""}<div class="grid">${list.map(field).join("")}</div></div>`).join("")}
    <div class="card"><h3>Education</h3>${S.profile.education.length
      ? S.profile.education.map((e) => `<div>${esc(e.school)} · ${esc([e.degree, e.major].filter(Boolean).join(", "))} · ${esc(e.grad_term || e.end)}${e.gpa ? ` · GPA ${esc(e.gpa)}` : ""}</div>`).join("")
      : `<span class="muted small">Nothing yet. Read your resume in Files, or add it in Review.</span>`}</div>
    ${navButtons("files", "interview")}`;
  main.querySelectorAll("[data-fact]").forEach((el) => el.addEventListener("input", () => { f[el.dataset.fact] = el.value; save(); }));
}

// ---------- 4. interview ----------
const CHAT_KEY = "deepdive_chat";
const COVERAGE = `1. The project they're proudest of (what they built, their exact role, technical depth, result)
2. A hard challenge or obstacle they worked through
3. Leadership or taking initiative
4. Teamwork and collaboration
5. A failure or mistake, and what they changed afterward
6. A disagreement or conflict and how they handled it
7. Career goals (next 1–2 years and longer term)
8. Why their field / major
9. What they want out of an internship, and the kinds of companies/teams that excite them
10. Strengths, and one honest growth area
11. Interests and life outside class, and anything that makes them distinct`;

function interviewSystem() {
  const p = S.profile;
  const { voice, extra, ...rest } = p;
  return `You are running the InternScout Deep Dive, a friendly, efficient interview of a college student who is applying to internships. An application agent will later use what you learn to answer essay and short-answer questions truthfully and specifically, in the student's voice.

What we already know (JSON):
${JSON.stringify(rest)}

Cover these topics:
${COVERAGE}

How to interview:
- Ask ONE question at a time, 1–3 sentences, warm and plain. No lists of questions.
- Dig for specifics with a follow-up or two when an answer is vague: numbers, their exact contribution, tools used, the outcome, what they learned.
- Build on their resume: reference actual projects and roles by name.
- Skip or shorten topics that existing stories already cover well${p.stories.length ? " (this is a re-run: focus on gaps and on anything new since last time)" : ""}.
- Never invent details. Don't write essays for them.
- When every topic is covered (or the student asks to stop), thank them in one sentence and end your message with [[DONE]].`;
}

async function interview() {
  let msgs = (await chrome.storage.local.get(CHAT_KEY))[CHAT_KEY] || [];
  main.innerHTML = `<h2>Interview</h2><p class="lead">A 10–15 minute conversation about your experiences and goals. Short, honest answers are perfect. Stop any time; what you've said is saved.</p>
    <div class="card"><div class="chat" id="chat"></div>
      <textarea id="say" placeholder="Type your answer… (Ctrl+Enter to send)"></textarea>
      <div class="row" style="margin-top:8px;justify-content:space-between">
        <div class="row"><button class="btn blue" id="send">Send</button><span id="cstat" class="small muted"></span></div>
        <div class="row"><button class="btn small" id="restart">Start over</button><button class="btn primary" id="finish">Finish & save stories</button></div></div>
    </div>
    ${S.profile.stories.length ? `<div class="card"><h3>Saved stories (${S.profile.stories.length})</h3>${S.profile.stories.map((s) => `<div class="story"><b>${esc(s.theme)}</b><div class="small muted">${esc(s.situation)}</div></div>`).join("")}</div>` : ""}
    ${navButtons("facts", "voice")}`;
  const chat = $("#chat"), say = $("#say"), stat = $("#cstat");
  const draw = () => {
    chat.innerHTML = msgs.slice(1).map((m) => `<div class="msg ${m.role === "user" ? "u" : "a"}">${esc(String(m.content).replace("[[DONE]]", "").trim())}</div>`).join("");
    chat.scrollTop = chat.scrollHeight;
  };
  const persist = () => chrome.storage.local.set({ [CHAT_KEY]: msgs });
  const turn = async () => {
    $("#send").disabled = true;
    busy(stat, "Thinking…");
    try {
      const r = await ai({ model: M().agent, max_tokens: 1024, system: interviewSystem(), messages: msgs });
      msgs.push({ role: "assistant", content: textOf(r) });
      await persist();
      draw();
      stat.textContent = /\[\[DONE\]\]/.test(textOf(r)) ? "All topics covered. Press Finish & save." : "";
    } catch (e) {
      stat.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    } finally { $("#send").disabled = false; say.focus(); }
  };
  const send = async () => {
    const t = say.value.trim();
    if (!t) return;
    msgs.push({ role: "user", content: t });
    say.value = "";
    draw();
    await persist();
    await turn();
  };
  $("#send").addEventListener("click", send);
  say.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); });
  $("#restart").addEventListener("click", async () => {
    if (msgs.length > 2 && !confirm("Clear this conversation? Stories you already saved are kept.")) return;
    msgs = [];
    await persist();
    interview().then(wireNav);
  });
  $("#finish").addEventListener("click", async () => {
    if (msgs.length < 3) { stat.textContent = "Answer a few questions first."; return; }
    $("#finish").disabled = true;
    busy(stat, "Turning the conversation into stories… (about a minute)");
    try {
      await distill(msgs);
      stat.innerHTML = `<span class="ok">Saved ${S.profile.stories.length} stories and your goals.</span>`;
      setTimeout(() => go("voice"), 900);
    } catch (e) {
      stat.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      $("#finish").disabled = false;
    }
  });
  if (!msgs.length) {
    msgs.push({ role: "user", content: `(Begin the interview. Greet me${S.profile.facts.first_name ? ` as ${S.profile.facts.first_name}` : ""} in one short sentence and ask the first question.)` });
    await turn();
  } else {
    draw();
    if (msgs[msgs.length - 1].role === "user") await turn();
  }
}

async function distill(msgs) {
  const transcript = msgs.slice(1).map((m) => `${m.role === "user" ? "STUDENT" : "INTERVIEWER"}: ${m.content}`).join("\n\n");
  const r = await ai({
    model: M().deep, max_tokens: 16000, thinking: { type: "adaptive" },
    messages: [{ role: "user", content: `Turn this Deep Dive interview into reusable application material. Use only what the student actually said (plus existing material). Keep their wording and concrete details; do not embellish.

Existing stories: ${JSON.stringify(S.profile.stories)}
Existing goals: ${JSON.stringify(S.profile.goals)}

Transcript:
${transcript}

Return JSON only:
{"stories":[{"theme":"proudest project|challenge|leadership|teamwork|failure|conflict|other: …","situation":"","task":"","action":"","result":"","reflection":""}],
 "goals":{"career":"","why_field":"","interests":"","strengths":"","growth_areas":"","why_internship":""},
 "facts":{}}
- "stories": the full merged list. Keep existing stories unless the transcript updates or replaces them; add new ones. One story per distinct experience.
- "goals": merged; keep an existing value when the transcript says nothing new.
- "facts": only clear factual updates the student stated, using these keys: ${Object.keys(S.profile.facts).join(", ")}.` }],
  });
  const x = jsonOf(r);
  if (Array.isArray(x.stories)) S.profile.stories = x.stories;
  for (const [k, v] of Object.entries(x.goals || {})) if (v) S.profile.goals[k] = v;
  for (const [k, v] of Object.entries(x.facts || {})) if (v && k in S.profile.facts) S.profile.facts[k] = v;
  await save(true);
}

// ---------- 5. voice ----------
const VOICE_FIELDS = [
  ["summary", "In a sentence, how you come across"], ["tone", "Tone"], ["sentence_style", "Sentence style"],
  ["vocabulary", "Word choice"], ["avoid", "Things to avoid"], ["sample", "A sample answer in your voice"],
];
function voice() {
  const v = S.profile.voice;
  const n = S.files.samples.length + (S.files.cover_letter ? 1 : 0);
  main.innerHTML = `<h2>Your voice</h2><p class="lead">So generated answers sound like you and not like a template.</p>
    <div class="card"><div class="row"><button class="btn primary" id="analyze">Analyze my writing</button><span id="vstat" class="small muted">Uses ${n} writing sample${n === 1 ? "" : "s"} plus your interview answers.</span></div></div>
    <div class="card">${VOICE_FIELDS.map(([k, t]) => `<label class="f"><span>${t}</span><textarea data-voice="${k}" ${k === "sample" ? 'style="min-height:120px"' : 'style="min-height:54px"'}>${esc(v[k])}</textarea></label>`).join("")}</div>
    ${navButtons("interview", "review")}`;
  main.querySelectorAll("[data-voice]").forEach((el) => el.addEventListener("input", () => { v[el.dataset.voice] = el.value; save(); }));
  $("#analyze").addEventListener("click", async () => {
    const stat = $("#vstat"), btn = $("#analyze");
    btn.disabled = true;
    busy(stat, "Reading your writing…");
    try {
      const chat = ((await chrome.storage.local.get(CHAT_KEY))[CHAT_KEY] || []).filter((m, i) => i > 0 && m.role === "user").map((m) => m.content).join("\n---\n");
      const content = [...S.files.samples.map((f) => docBlock(f, f.name)), docBlock(S.files.cover_letter, "Cover letter")].filter(Boolean);
      if (!content.length && chat.length < 200) throw new Error("Add a writing sample in Files or do some of the interview first.");
      content.push({ type: "text", text: `${chat ? `The student's own interview replies (casual register):\n${chat.slice(0, 20000)}\n\n` : ""}Describe this student's writing voice so another writer can imitate it in internship application answers (formal register, but recognizably them). Return JSON only:
{"summary":"one sentence","tone":"","sentence_style":"length, rhythm, structure","vocabulary":"word choice, jargon level, favorite constructions","avoid":"clichés or habits that would sound fake for them","sample":"a 90–120 word answer to 'Why are you interested in this internship?' written in their voice, using only facts from the material"}` });
      const r = await ai({ model: M().deep, max_tokens: 8000, thinking: { type: "adaptive" }, messages: [{ role: "user", content }] });
      Object.assign(S.profile.voice, jsonOf(r));
      await save(true);
      voice(); wireNav();
    } catch (e) {
      stat.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      btn.disabled = false;
    }
  });
}

// ---------- 6. review ----------
const JSON_SECTIONS = [
  ["education", "Education"], ["experience", "Experience"], ["projects", "Projects"],
  ["skills", "Skills"], ["links", "Links"], ["stories", "Stories"], ["extra", "Answers learned while applying"],
];
const GOAL_FIELDS = [
  ["career", "Career goals"], ["why_field", "Why this field"], ["why_internship", "What you want from an internship"],
  ["interests", "Interests"], ["strengths", "Strengths"], ["growth_areas", "Growth areas"],
];
function review() {
  const p = S.profile;
  const missing = STEPS.filter(([id]) => id !== "review" && !doneFor(id)).map(([, t]) => t);
  main.innerHTML = `<h2>Review</h2><p class="lead">Everything the agent knows about you. Edit anything; changes save automatically.</p>
    ${missing.length ? `<div class="card warn">Still to do: ${missing.join(", ")}. Auto-Apply works best with everything filled.</div>` : ""}
    <div class="card"><h3>Goals</h3>${GOAL_FIELDS.map(([k, t]) => `<label class="f"><span>${t}</span><textarea data-goal="${k}" style="min-height:54px">${esc(p.goals[k])}</textarea></label>`).join("")}</div>
    ${JSON_SECTIONS.map(([k, t]) => `<div class="card"><h3>${t}</h3><textarea class="code" data-json="${k}">${esc(JSON.stringify(p[k], null, 2))}</textarea><div class="small" data-jerr="${k}"></div></div>`).join("")}
    <div class="card"><div class="row"><button class="btn primary" id="finishall" ${hasKey(S) && S.files.resume ? "" : "disabled"}>${rerun ? "Save Deep Dive" : "Finish, turn on Auto-Apply"}</button><span id="rstat" class="small muted">${hasKey(S) && S.files.resume ? "" : "Needs an API key and a resume first."}</span></div></div>
    ${navButtons("voice", null)}`;
  main.querySelectorAll("[data-goal]").forEach((el) => el.addEventListener("input", () => { p.goals[el.dataset.goal] = el.value; save(); }));
  main.querySelectorAll("[data-json]").forEach((el) => el.addEventListener("input", () => {
    const k = el.dataset.json, msg = main.querySelector(`[data-jerr=${k}]`);
    try {
      const v = JSON.parse(el.value);
      if (Array.isArray(p[k]) !== Array.isArray(v)) throw new Error(Array.isArray(p[k]) ? "Must be a [list]" : "Must be an {object}");
      p[k] = v;
      msg.textContent = "";
      save();
    } catch (e) { msg.innerHTML = `<span class="err">Not saved: ${esc(e.message)}</span>`; }
  }));
  $("#finishall").addEventListener("click", async () => {
    S.settings.onboarded = true;
    S.settings.deep_dive_at = Date.now();
    S.settings.deep_dive_run = null;   // the next Deep Dive is a new run
    await save(true);
    render();
    $("#rstat").innerHTML = `<span class="ok">Saved. Auto-Apply is on.</span> <a href="https://bpmcginley.github.io/InternshipFinder/" target="_blank">Open the internship dashboard ↗</a>`;
  });
}

render();
