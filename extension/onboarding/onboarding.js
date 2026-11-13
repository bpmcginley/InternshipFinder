// Deep Dive starts with the resume. Returning students can reopen any step.
import { loadStore, updateStore, hasKey, isGemini, isWorker, modelFor, modeOf, PRESETS, CONFIRMATION_FACTS, ELIGIBILITY_FACTS, confirmedFacts, factFallback, factSuggestions, resumeReviewPending, unconfirmedOldFacts, workAuthMismatch, manualDetailsMissing } from "../lib/store.js";
import { allowanceLines, tierNote, MAIN_TASKS, PROVIDER_LABELS, OFFER_KEY, SESSION_KEY } from "../lib/auth.js";
import { BACKGROUND_SETTINGS, RESTORED_KEY, restoredMessage, loadProfileWithRestore, restoredAt } from "../lib/sync.js";
import { callAI, textOf, jsonOf } from "../background/claude.js";
import { DEFAULT_PRICES, loadUsage, saveUsage, priceFor, spend, money } from "../lib/usage.js";
import { quickStartReady, finishOnboarding, digestLink, enterDetailsManually, manualPathOpen, pausedMessage, shouldRevealQuick, revealQuick, setupDone, signInNeeded, readAfterSignIn } from "./quickstart.js";
import { heldLine } from "../background/held.js";
import { confirmProfileValue, applyInterviewFacts, dismissSuggestion, planResumeImport, applyResumeImport, preselectedImports, bulkConfirmKeys, mergeProfileEdits, focusStepHeading, pendingResumeReview, formatResumeValue, setSetupEmail, repairSetupEmail } from "./profile.js";

import { readFile, docBlock } from "./files.js";
import { SLOTS, FACTS, VOICE_FIELDS, JSON_SECTIONS, GOAL_FIELDS } from "./field-options.js";
import { interviewSystem } from "./interview-prompt.js";

const main = document.getElementById("main");
const stepsEl = document.getElementById("steps");
const STEPS = [
  ["files", "Resume"], ["setup", "Setup"], ["facts", "Quick facts"],
  ["interview", "Interview"], ["voice", "Voice"], ["review", "Review"],
];
// Auto-Apply can be turned on from Files (2026-10-04); these three make its answers better and are
// labelled as optional in the step bar. doneFor() still counts them, so the side panel still suggests them.
const OPTIONAL_STEPS = ["facts", "interview", "voice"];
let S, savedSnapshot, pendingResumeImport;
let saveChain = Promise.resolve();
let restoreChain = Promise.resolve();
let latestRestore;
let renderEpoch = 0;
let interviewChat = null;
let interviewWrites = Promise.resolve();
let rerun;
const requestedStep = new URLSearchParams(location.search).get("step");
const explicitStep = STEPS.some(([id]) => id === requestedStep);
let step, seenRestore;   // the current step and the revision of its loaded profile
let restoredNote = "";                  // shown above the current step until the student moves on
// Signed in to InternScout's AI: true, false, or null until the background has said (refreshSignIn).
// dashOffer: the dashboard has offered its own sign-in and the Worker has said it is live (U8).
let signedIn = null, dashOffer = false;
let queuedResume = null;
let signingIn = false;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (sel) => main.querySelector(sel);
const practiceLink = `<span class="small" style="display:block;margin:6px 0 0"><a id="practice-link" href="../practice/practice.html" target="_blank" rel="noopener">Practice Auto-Apply</a></span>`;

// ---------- persistence ----------
// The service worker also writes the store (accounts, answers, learned answers), so merge instead of overwrite.
// It also restores the Deep Dive from the student's account (lib/sync.js): when that happened after this
// page loaded, this page's copy is out of date and must not be written over it; the page reloads instead.
let saveTimer = null;
function queueStoreWrite(write) {
  saveChain = saveChain.then(write, write);
  return saveChain;
}
function save(now) {
  clearTimeout(saveTimer);
  const run = () => {
    const store = S, revision = seenRestore;
    // Navigation during a story commit must save the profile as it looks after that commit settles.
    const queuedSnapshot = interviewChat?.savingStories ? null : structuredClone(store);
    return queueStoreWrite(async () => {
      if (S !== store) return;
      const snapshot = queuedSnapshot ?? structuredClone(store);
      let applied = false;
      await updateStore(async (fresh) => {
        if ((await restoredAt()) !== revision || S !== store) return;
        for (const key of ["profile", "files", "ai"]) mergeProfileEdits(fresh[key], savedSnapshot[key], snapshot[key]);
        const editable = (settings) => Object.fromEntries(Object.entries(settings).filter(([k]) => !BACKGROUND_SETTINGS.includes(k)));
        mergeProfileEdits(fresh.settings, editable(savedSnapshot.settings), editable(snapshot.settings));
        applied = true;
      });
      if (applied && S === store) savedSnapshot = snapshot;
    });
  };
  if (now) return run();
  saveTimer = setTimeout(run, 300);
}
window.addEventListener("beforeunload", () => { if (S) save(true); });

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

// ---------- nav ----------
function doneFor(id) {
  const p = S.profile;
  return {
    // was: !!(hasKey(S) && S.settings.signup_email), ticked without sign-in (U4, quickstart.js setupDone).
    setup: setupDone(S, signedIn),
    files: !!S.files.resume,
    facts: !!(p.facts.first_name && p.facts.email && p.facts.available_start),
    interview: p.stories.length >= 3,
    voice: !!p.voice.summary,
    review: !!S.settings.onboarded,
  }[id];
}
let quickWasReady = null;   // the "Ready to apply" card on this visit to Files (drawQuick)
function go(id) { save(true); step = id; quickWasReady = null; restoredNote = ""; render(); scrollTo(0, 0); if (id !== "interview") focusStepHeading(main); }
function navButtons(prev, next, nextLabel = "Next") {
  return `<div class="nav"><div>${prev ? `<button class="btn" data-go="${prev}">← Back</button>` : ""}</div><div>${next ? `<button class="btn primary" data-go="${next}">${nextLabel} →</button>` : ""}</div></div>`;
}
function wireNav() {
  main.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
}
// The step bar alone, so a sign-in can tick Setup without redrawing the step. was: part of render().
function drawSteps() {
  const tab = ([id, t]) => `<button data-step="${id}" ${id === step ? 'aria-current="step"' : ""} class="${id === step ? "on" : ""} ${doneFor(id) ? "done" : ""}">${t}</button>`;
  // was: stepsEl.innerHTML = STEPS.map(tab).join("");
  const opt = STEPS.filter(([id]) => OPTIONAL_STEPS.includes(id));
  stepsEl.innerHTML = STEPS.filter(([id]) => id === "setup" || id === "files").map(tab).join("")
    + `<div class="optgrp"><span class="optlabel">Optional: better answers</span><div class="steps">${opt.map(tab).join("")}</div></div>`
    + STEPS.filter(([id]) => id === "review").map(tab).join("");
  stepsEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(b.dataset.step)));
}
function render() {
  const epoch = ++renderEpoch;
  drawSteps();
  if (step === "interview") interview(epoch);
  else ({ setup, files, facts, voice, review })[step]();
  if (restoredNote) main.insertAdjacentHTML("afterbegin", `<div class="banner">${esc(restoredNote)}</div>`);
  wireNav();
}

// The background restored the Deep Dive from the student's account (after they signed in here or in the
// popup, or at startup). Reload it, so a student on a new computer isn't sent through the Deep Dive again.
function useProfile({ store, revision, notice }) {
  S = store;
  seenRestore = revision;
  savedSnapshot = structuredClone(S);
  pendingResumeImport = pendingResumeReview(S);
  queuedResume = null;
  rerun = !!S.settings.onboarded;
  restoredNote = notice
    ? restoredMessage(notice) + (S.files.resume ? "" : " Your files stay on each device, so add your resume under Resume.")
    : "";
}
function retireInterviewForRestore(revision) {
  const previous = interviewChat;
  const next = interviewChat = interviewConversation(null, revision);
  next.restoring = true;
  next.interrupted = !!(previous?.pending || previous?.failed || previous?.interrupted);
  previous?.pending?.abort();
  clearTimeout(saveTimer);
  return next;
}
const restoreTime = (revision) => Date.parse(revision) || 0;
chrome.storage.onChanged.addListener((ch, area) => {
  const change = area === "local" && ch[RESTORED_KEY];
  const revision = change?.newValue?.at;
  const time = restoreTime(revision);
  const loadedOrQueued = Math.max(restoreTime(seenRestore), restoreTime(latestRestore));
  if (revision === change?.oldValue?.at || time <= loadedOrQueued) return;
  latestRestore = revision;
  if (S) retireInterviewForRestore(revision);
  const refresh = async () => {
    await startup;
    if (latestRestore !== revision || time <= restoreTime(seenRestore)) return;
    const profile = await loadProfileWithRestore();
    const loaded = restoreTime(profile.revision);
    // A queued read can claim a newer notice than the event that requested it.
    if (loaded < restoreTime(latestRestore) || loaded <= restoreTime(seenRestore)) return;
    const next = interviewChat?.restoring ? interviewChat : retireInterviewForRestore(profile.revision);
    next.revision = profile.revision;
    next.restoring = false;
    useProfile(profile);
    if (profile.notice && rerun) step = "review";
    render();
    scrollTo(0, 0);
    focusStepHeading(main);
  };
  restoreChain = restoreChain.then(refresh, refresh);
});

// ---------- 1. setup ----------
// On InternScout's AI, Setup is two things: sign in, and the email for job-site accounts. Everything
// else keeps its default and sits under Advanced, closed (2026-10-04), with the same ids so the
// handlers below still bind. A student on their own API key gets Advanced open, since their key is there.
// was: AI provider, Tailored resumes, AI spending and Job-site accounts (email, passwords, tabs) as open cards.
function setup(advOpen = false) {
  main.innerHTML = `
    ${rerun ? `<div class="banner">You've set this up before. Everything you entered is kept, so just update what changed.</div>` : ""}
    <h2>Setup</h2><p class="lead">${isWorker(S.ai)
      ? "Auto-Apply uses InternScout's free AI: sign in with Google or Microsoft and there's nothing else to set up. Your passwords stay in this browser."
      : "Auto-Apply uses your own AI API key. The key and your passwords stay in this browser."}</p>
    ${isWorker(S.ai) ? `<div class="card"><h3>Sign in</h3>
      <div id="acct"><span class="small muted"><span class="spin"></span>Checking sign-in…</span></div>
    </div>` : ""}
    <div class="card"><h3>Email for applications</h3>
      <p class="small muted" style="margin-top:0">Workday, iCIMS and similar sites need an account. The agent creates it for you with this email. Passwords are filled in by the extension itself and never shown to the AI.</p>
      <label class="f" style="margin-bottom:0"><span>Email for applications and sign-ups</span><input type="email" id="email" value="${esc(S.settings.signup_email || S.profile.facts.email)}"></label>
    </div>
    <details class="adv" ${advOpen || !isWorker(S.ai) ? "open" : ""}><summary>Advanced</summary>
    <div class="card"><h3>AI provider</h3>
      <label class="f"><span>Provider</span><select id="provider">
        <option value="internscout">InternScout (free, sign in with Google or Microsoft)</option>
        <option value="anthropic">Your own Anthropic (Claude) key</option>
        <option value="gemini">Your own Google (Gemini) key</option></select></label>
      ${isWorker(S.ai)
        ? `<p class="small muted" style="margin:0">InternScout's AI is free within a monthly allowance. To use your own Anthropic or Google API key instead, pick it here.</p>`
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
      <p class="small muted" style="margin-top:0">Before each application, the AI rewords your existing resume bullets toward the posting and keeps your own layout: a Word resume is edited in place, and a PDF is rebuilt to match its fonts, sections and spacing. It can't add jobs, skills or numbers you didn't list; changed numbers are thrown out automatically. About 1 to 5 cents per job.</p>
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
      <label class="f"><span>Passwords</span><select id="pwmode">
        <option value="unique">A unique strong password per site (saved in the Accounts tab)</option>
        <option value="master">One password I choose for every site</option></select></label>
      <label class="f" id="masterwrap"><span>Your password (must satisfy strict rules: 12+ chars, upper, lower, number, symbol)</span><input type="password" id="master" value="${esc(S.settings.master_password)}"></label>
      <label class="f" style="margin-bottom:0"><span>Applications to work on at once</span><select id="tabs">${[1, 2, 3, 4].map((n) => `<option ${n === S.settings.max_tabs ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    </div>
    </details>
    <div id="need" class="small warn"></div>
    ${S.files.resume ? navButtons("files", "facts") : navButtons(null, "files", "Add your resume")}`;
  drawNeed();
  $("#provider").value = isWorker(S.ai) ? "internscout" : isGemini(S.ai) ? "gemini" : "anthropic";
  if (isWorker(S.ai)) fillAccount();
  const syncMode = () => { if ($("#mode")) { $("#mode").value = modeOf(S); $("#modeblurb").textContent = PRESETS[modeOf(S)].blurb; } };
  syncMode();
  $("#tailor").value = S.settings.tailor_resume || "review";
  $("#provider").addEventListener("change", (e) => {
    S.ai.provider = e.target.value;
    S.ai.model = modelFor(S, "agent");
    save();
    setup(true);   // stay open on the choice just made
  });
  $("#pwmode").value = S.settings.password_mode;
  const syncMaster = () => { $("#masterwrap").hidden = $("#pwmode").value !== "master"; };
  syncMaster();
  const bind = (id, fn) => $(id).addEventListener("input", (e) => { fn(e.target.value); save(); });
  if ($("#key")) bind("#key", (v) => { if (isGemini(S.ai)) S.ai.geminiKey = v.trim(); else S.ai.apiKey = v.trim(); });
  if ($("#mode")) bind("#mode", (v) => { S.settings.ai_mode = v; S.ai.model = modelFor(S, "agent"); syncMode(); });
  bind("#tailor", (v) => { S.settings.tailor_resume = v; });
  // was: { S.settings.signup_email = v.trim(); if (!S.profile.facts.email) { ...first keystroke only } } (U3).
  bind("#email", (v) => { setSetupEmail(S, v); });
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
  signedIn = !!(a && !a.error && a.signedIn);
  if (signedIn) dashOffer = false;
  drawSteps();
  drawNeed();
  if (!a || a.error || !a.signedIn) {
    // was: "Sign in with Google (UMass email)", which read as a button only UMass students could use.
    // "Larger", not "twice": the Worker gives a non-.edu account half the allowance rounded down
    // (GENERAL_ALLOWANCE_PCT), so 25 Auto-Apply runs against 12, not exactly double.
    box.innerHTML = `
      <p class="small" style="margin:0 0 10px">Sign in to use the AI. Any Google account or personal Microsoft account works. School Microsoft accounts (like @umass.edu Outlook) need IT approval, so sign in with Google using your school email.</p>
      ${signInRow()}
      <p class="small muted" style="margin:6px 0 0">A school .edu email gives a larger free monthly allowance.</p>
      ${note || (a && a.error ? `<p class="small err" style="margin:8px 0 0">${esc(a.error)}</p>` : "")}`;
    wireSignIn(box, (err) => fillAccount(err));
    return;
  }
  const lines = allowanceLines(a.me, MAIN_TASKS);
  const synced = (await loadStore()).settings.cloud_sync !== false;   // the background's copy, not this page's
  if (!$("#acct")) return;
  box.innerHTML = `
    <p class="small" style="margin:0 0 8px">Signed in${a.provider ? ` with ${esc(PROVIDER_LABELS[a.provider] || a.provider)}` : ""}${a.email ? ` as <b>${esc(a.email)}</b>` : ""}. <a href="#" id="signout">Sign out</a> &middot; <a href="#" id="deldata">Delete my data</a></p>
    ${lines.length ? `<ul class="small" style="margin:0 0 6px;padding-left:18px">${lines.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <p class="small ${!a.me || a.me.error ? "err" : "muted"}" style="margin:0">${esc(tierNote(a.me))}</p>
    <label class="check small" style="margin:12px 0 0"><input type="checkbox" id="cloudsync" ${synced ? "checked" : ""}><span>Save my Deep Dive to my account, so it's there on my other devices</span></label>
    <p class="small muted" style="margin:4px 0 0 21px">Your resume and other files, your demographic answers and your saved logins stay on this device.</p>
    <p class="small" id="syncmsg" style="margin:4px 0 0 21px" hidden></p>${note}`;
  // Off: asks first, then the background deletes the account's copy (DELETE /profile) and stops saving.
  // On again: the background sends this device's Deep Dive (or takes a newer one from the account).
  $("#cloudsync").addEventListener("change", async (e) => {
    const cb = e.target, on = cb.checked, out = $("#syncmsg");
    if (!on && !confirm("Stop saving your Deep Dive to your account? The copy saved there will be deleted. Everything on this device stays as it is.")) { cb.checked = true; return; }
    cb.disabled = true;
    out.hidden = false; out.className = "small muted"; busy(out, on ? "Saving your Deep Dive to your account…" : "Deleting the copy in your account…");
    const r = await chrome.runtime.sendMessage({ type: "sync:set", on }).catch((err) => ({ error: err.message }));
    cb.disabled = false;
    if (!r || !r.ok) {
      cb.checked = !on;
      out.className = "small err";
      out.textContent = on ? "Couldn't turn this on right now. Try again in a moment."
        : "Couldn't delete the copy in your account, so saving is still on. Check your connection or sign in again, then try again.";
      return;
    }
    S.settings.cloud_sync = on;
    out.className = "small ok";
    out.textContent = on
      ? (r.state === "pushed" || r.state === "same" || r.state === "restored" ? "Turned on. Your Deep Dive is saved to your account." : "Turned on. It will be saved to your account when InternScout can take it.")
      : "Turned off. The copy in your account was deleted.";
  });
  $("#signout").addEventListener("click", async (e) => {
    e.preventDefault();
    await chrome.runtime.sendMessage({ type: "auth:signout" });
    fillAccount();
  });
  // The privacy page tells students to press "Delete my data" in the extension, and there was no such
  // control here: lib/auth.js had deleteServerData() with nothing calling it. It removes what the
  // server holds (chosen states, plan record, earlier months) and signs out. What is in this browser
  // - profile, files, saved logins - is the student's own copy and goes when the extension is removed.
  $("#deldata").addEventListener("click", async (e) => {
    e.preventDefault();
    // was: "(your chosen states, plan record and past months' counts)". The server now also keeps the saved
    // Deep Dive and the sign-ins, and DELETE /me removes both.
    if (!confirm("Delete what InternScout's server holds about you (your saved Deep Dive, your sign-ins, your chosen states, plan record and past months' counts)? This month's counts stay until the month ends. Your profile and files in this browser are not touched.")) return;
    const r = await chrome.runtime.sendMessage({ type: "auth:delete" });
    if (r && r.ok) { alert("Deleted. You have been signed out."); fillAccount(); }
    // An expired sign-in came back as {error: "auth"} with no message, and was reported as a
    // connection problem while the box went on saying "Signed in", so every retry failed the same way.
    else if (r && r.error === "auth") { alert("Your sign-in has expired. Sign in again, then press Delete my data."); fillAccount(); }
    else alert(r && r.error === "subscribed" ? (r.message || "Cancel your paid plan first, then delete your data.") : "Couldn't delete right now" + (r && r.message ? ": " + r.message : ". Check your connection and try again."));
  });
}

// The sign-in buttons, on Setup and on the Files step (U4). "Use my dashboard sign-in" comes first when
// the dashboard has offered its sign-in and the Worker said it is live (U8, lib/auth.js holdOffer).
// was: Google and Microsoft only, on Setup only.
function signInRow() {
  return `<div class="row">${dashOffer ? `<button class="btn primary" data-signin="dashboard">Use my dashboard sign-in</button>` : ""}`
    + `<button class="btn${dashOffer ? "" : " primary"}" data-signin="google">Sign in with Google</button><button class="btn" data-signin="microsoft">Sign in with Microsoft</button><span class="small signin-msg"></span></div>`
    + (dashOffer ? `<p class="small muted" style="margin:6px 0 0">You're signed in on the InternScout dashboard in this browser. Use that sign-in here too, or sign in again.</p>` : "");
}
// `done(error)` runs after the attempt, with "" when it worked.
function wireSignIn(box, done) {
  box.querySelectorAll("[data-signin]").forEach((b) => b.addEventListener("click", async () => {
    if (signingIn) return;
    signingIn = true;
    box.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    const dash = b.dataset.signin === "dashboard";
    busy(box.querySelector(".signin-msg"), dash ? "Checking that sign-in…" : "Waiting for the sign-in window…");
    const r = await chrome.runtime.sendMessage(dash ? { type: "auth:accept_offer" } : { type: "auth:signin", provider: b.dataset.signin }).catch((e) => ({ error: e.message }));
    signingIn = false;
    if (dash) dashOffer = false;   // used once, whichever way it went
    if (r && !r.error && r.signedIn) signedIn = true;
    drawSteps();
    done(r && r.error ? r.error : "");
    // Setup's reply can arrive after the student has already returned to Resume.
    if (step === "files" && box.id !== "files-signin") drawFilesSignIn();
    if ($("#extract")) $("#extract").disabled = !canReadResume();
  }));
}

// Setup's one-line warning while signed out (U4).
function drawNeed() {
  const el = $("#need");
  if (el) el.textContent = signInNeeded(S, signedIn) ? "You aren't signed in yet. Reading your resume and Auto-Apply both need it, so sign in above first." : "";
}

// Asks the background whether this browser is signed in and whether the dashboard offered its sign-in,
// then updates what depends on it. Runs once on load; a sign-in on this page updates `signedIn` itself.
async function refreshSignIn() {
  const [a, o] = await Promise.all([
    chrome.runtime.sendMessage({ type: "auth:status" }).catch(() => null),
    chrome.runtime.sendMessage({ type: "auth:offer_status" }).catch(() => null),
  ]);
  signedIn = !!(a && a.signedIn);
  dashOffer = !signedIn && !!(o && o.waiting);
  drawSteps();
  drawNeed();
  if (step === "setup" && $("#acct")) fillAccount();
  drawFilesSignIn();
  if ($("#extract")) $("#extract").disabled = !canReadResume();
}

// The dashboard's offer usually arrives just after this page opens (the install opens this page and
// connects the dashboard tab at the same moment), and a sign-in in the popup or side panel changes the
// session too, so either one updates the buttons and the step bar here.
chrome.storage.onChanged.addListener((ch, area) => {
  if ((area === "session" && ch[OFFER_KEY]) || (area === "local" && ch[SESSION_KEY])) startup.then(refreshSignIn);
});

// The Files step's sign-in (U4): the resume can't be read while signed out on InternScout's AI, so the
// "Read my files" card asks for sign-in itself, and reads a chosen resume straight after.
// was: the automatic read failed with "Sign in ... in the InternScout popup or Setup", and the student had to
// go back to Setup and then press "Read my resume" again.
function drawFilesSignIn(msg = "") {
  const box = $("#files-signin");
  if (!box) return;
  box.hidden = !S.files.resume || !signInNeeded(S, signedIn);
  if (box.hidden) { box.innerHTML = ""; return; }
  box.innerHTML = `<p class="small" style="margin:12px 0 8px"><b>Sign in to read your resume.</b> Any Google account or personal Microsoft account works.</p>${signInRow()}`
    + (msg ? `<p class="small err" style="margin:8px 0 0">${esc(msg)}</p>` : "");
  wireSignIn(box, (err) => {
    if (step !== "files") return;
    if (err || !signedIn) { drawFilesSignIn(err || ""); return; }
    drawFilesSignIn();
    if (readAfterSignIn(S, { extracting, pending: !!pendingResumeImport })) extract($("#extract"), $("#exout")).catch((e) => { const f = $("#ferr"); if (f) f.textContent = e.message || String(e); });
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
const canReadResume = () =>
  !!S.files.resume && !extracting && !signingIn && hasKey(S) && (!isWorker(S.ai) || signedIn === true);

function readQueuedResume() {
  if (!queuedResume || queuedResume !== S.files.resume || !$("#extract") || !canReadResume()) return;
  extract($("#extract"), $("#exout")).catch(() => {});
}

function files() {
  const fmt = (f) => f ? `${esc(f.name)} · ${Math.max(1, Math.round(f.size / 1024))} KB` : "No file";
  const optionalOpen = $("#optional-files")?.open;
  const slot = ([k, t, d]) => `
    <div class="slot"><div class="name"><b>${t}</b><span class="small muted">${d}</span><div class="small ${S.files[k] ? "ok" : "muted"}">${fmt(S.files[k])}</div></div>
      <input type="file" data-slot="${k}" accept=".pdf,.docx,.txt,.md" hidden>
      <button class="btn small${k === "resume" && !S.files[k] ? " primary" : ""}" data-pick="${k}">${S.files[k] ? "Replace" : k === "resume" ? "Choose resume" : "Choose"}</button>
      ${S.files[k] ? `<button class="btn small" data-clear="${k}">Remove</button>` : ""}</div>`;
  main.innerHTML = `
    <h2>${rerun ? "Your resume" : "Start with your resume"}</h2><p class="lead">Add your resume to build a profile you can review and edit. PDF works best. DOCX, TXT and Markdown are fine too.</p>
    <div class="card">${slot(SLOTS[0])}
    </div>
    <div class="card"${S.files.resume ? "" : " hidden"}><h3>Read my resume</h3>
      <p class="small muted" style="margin-top:0">${isWorker(S.ai) ? "InternScout's AI" : isGemini(S.ai) ? "Gemini" : "Claude"} reads your resume${S.files.cv ? " and CV" : ""} and fills in your education, experience, projects, skills and contact info. You can edit all of it.</p>
      <div id="files-signin" hidden></div>
      <div class="row"><button class="btn primary" id="extract" ${canReadResume() ? "" : "disabled"}>Read my resume</button><span id="exout" role="status" class="small">${extracting ? `<span class="spin"></span>Reading your resume… (about 30 seconds)` : S.settings.resume_details_ready && S.settings.extracted_from ? `<span class="ok">Last read: ${esc(S.settings.extracted_from)}</span>` : ""}</span></div>
    </div>
    <div class="card" id="resume-review" hidden></div>
    <div class="card" id="resume-profile" hidden></div>
    <div class="card" id="quick" hidden></div>
    <div id="ferr" class="err small" role="status"></div>
    <details class="adv" id="optional-files" ${optionalOpen ? "open" : ""}><summary>Optional files and writing samples</summary>
    <div class="card">${SLOTS.slice(1).map(slot).join("")}</div>
    <div class="card"><h3>Writing samples and "you" material</h3>
      <p class="small muted" style="margin-top:0">Essays, personal statements, blog posts, or anything that shows how you write and who you are. The AI studies these to write short answers in your voice.</p>
      ${S.files.samples.map((f, i) => `<div class="slot"><div class="name"><b>${esc(f.name)}</b><span class="small muted">${f.text ? `${f.text.length.toLocaleString()} characters` : fmt(f)}</span></div><button class="btn small" data-rms="${i}">Remove</button></div>`).join("")}
      <div class="row" style="margin-top:10px"><input type="file" id="samples" accept=".pdf,.docx,.txt,.md" multiple hidden><button class="btn small" id="addsamples">Add files</button></div>
      <label class="f" style="margin-top:12px"><span>…or paste text</span><textarea id="paste" placeholder="Paste an essay, a LinkedIn About section, anything."></textarea></label>
      <button class="btn small" id="addpaste">Add pasted text</button>
    </div>
    </details>
    <div class="nav"><div></div><button class="btn" data-go="setup">Continue to setup</button></div>`;
  const err = (e) => { $("#ferr").textContent = e.message || String(e); };
  main.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => main.querySelector(`[data-slot=${b.dataset.pick}]`).click()));
  // A new or removed resume pauses Auto-Apply through resume_details_ready (store.js resumeReviewPending)
  // until the new one is read and reviewed. was: also onboarded = false here, in the remove handler and in
  // extract(), which lib/sync.js read as a device that never finished and restored the account's older copy.
  main.querySelectorAll("[data-slot]").forEach((inp) => inp.addEventListener("change", async () => {
    try {
      S.files[inp.dataset.slot] = await readFile(inp.files[0]);
      if (inp.dataset.slot === "resume") {
        pendingResumeImport = null;
        queuedResume = S.files.resume;
        S.settings.resume_import = null;
        S.settings.resume_details_ready = false;
      }
      await save(true);
      if (step !== "files") return;
      files(); wireNav();
    } catch (e) { err(e); return; }
    // A new resume is read straight away (2026-10-04) rather than waiting for "Read my resume", which
    // students skipped: the profile stayed empty and every application had to ask the model for it.
    // Not while signed out on InternScout's AI (U4): the card asks for sign-in and reads it straight after.
    if (inp.dataset.slot === "resume") {
      const signIn = $("#files-signin button");
      if (signIn) signIn.focus();
      else focusStepHeading(main);
      readQueuedResume();
    }
  }));
  main.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", async () => { S.files[b.dataset.clear] = null; if (b.dataset.clear === "resume") { pendingResumeImport = null; queuedResume = null; S.settings.resume_import = null; S.settings.resume_details_ready = false; } await save(true); files(); wireNav(); }));
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
  drawResumeReview();
  drawResumeProfile();
  drawQuick();
  drawFilesSignIn();
}

function drawResumeProfile() {
  const box = $("#resume-profile");
  if (!box) return;
  box.hidden = !(
    S.files.resume && S.settings.extracted_from === S.files.resume.name &&
    S.settings.resume_details_ready && !S.settings.resume_details_manual && !pendingResumeImport
  );
  if (box.hidden) return;
  const p = S.profile;
  const name = [p.facts.first_name, p.facts.last_name].filter(Boolean).join(" ");
  const contact = [name, p.facts.email, p.facts.phone]
    .filter(Boolean).join(" · ");
  const sections = JSON_SECTIONS.slice(0, 5)
    .map(([key, label]) => [label, formatResumeValue(p[key])])
    .filter(([, value]) => value && value !== "Not listed");
  box.innerHTML = `<h3 tabindex="-1">Review your resume details</h3>
    <p class="small">Check these details and correct anything before turning on Auto-Apply.</p>
    ${contact ? `<p>${esc(contact)}</p>` : ""}
    ${sections.map(([label, value]) =>
      `<details><summary>${label}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(value)}</pre></details>`).join("")}
    <div class="row" style="margin-top:12px"><button class="btn small" id="edit-contact">Edit contact details</button><button class="btn small" id="edit-resume-profile">Edit profile sections</button></div>`;
  $("#edit-contact").onclick = () => go("facts");
  $("#edit-resume-profile").onclick = () => go("review");
}

function drawResumeReview() {
  const box = $("#resume-review");
  if (!box) return;
  box.hidden = !pendingResumeImport;
  if (!pendingResumeImport) return;
  const pending = pendingResumeImport;
  const names = { first_name: "First name", last_name: "Last name", email: "Email", phone: "Phone", city: "City", state: "State", zip: "ZIP", linkedin: "LinkedIn", github: "GitHub", website: "Website", education: "Education", experience: "Experience", projects: "Projects", links: "Links", skills: "Skills" };
  const show = formatResumeValue;
  const ticked = new Set(preselectedImports(pending.plan));
  box.innerHTML = `<h3>Review resume updates</h3><p class="small">These details differ from values you entered or previously saved. Your current values are kept unless you choose an update. Other resume details will update when you save.</p>`
    + (ticked.size ? `<p class="small">Ticked boxes are details that most likely came from your earlier resume, so the new resume replaces them. Untick any you typed in yourself.</p>` : "")
    + pending.plan.filter((e) => e.conflict).map((e) => `<details style="margin-bottom:12px" ${ticked.has(e.id) ? "open" : ""}><summary>${esc(names[e.key] || e.key)}</summary><div class="grid"><div><b>Current</b><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(show(e.before))}</pre></div><div><b>New resume</b><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(show(e.next))}</pre></div></div><label><input type="checkbox" data-import="${esc(e.id)}" ${ticked.has(e.id) ? "checked" : ""}> Use the new resume value for ${esc(names[e.key] || e.key)}</label></details>`).join("")
    + '<button class="btn primary" id="save-resume-details">Save resume details</button>';
  $("#save-resume-details").onclick = async () => {
    if (pending !== pendingResumeImport || S.files.resume?.b64 !== pending.file.b64) return;
    const selected = [...box.querySelectorAll("[data-import]:checked")].map((el) => el.dataset.import);
    applyResumeImport(S.profile, pending.plan, selected);
    S.settings.resume_import = null;
    S.settings.resume_details_ready = true;
    S.settings.resume_details_manual = false;
    S.settings.extracted_from = pending.file.name;
    if (!S.settings.signup_email && S.profile.facts.email) S.settings.signup_email = S.profile.facts.email;
    await save(true);
    pendingResumeImport = null;
    files(); wireNav();
    // The "Ready to apply" card may have just taken focus (drawQuick); otherwise the heading takes it.
    if (document.activeElement?.id !== "quickgo") focusStepHeading(main);
  };
}

// "Turn on Auto-Apply now" on the Files step, once the AI, a resume and the sign-up email are there:
// the same finish as Review's button (finishOnboarding), so a student can start applying without the
// optional steps. Redrawn after a resume is read, since reading it can fill in the sign-up email.
function drawQuick(msg = "", offerPractice = false) {
  const box = $("#quick");
  if (!box) return;
  // A resume that couldn't be read (or wasn't), or details still missing after choosing to enter them:
  // say Auto-Apply is paused and why, and offer the way past that doesn't need the AI.
  const manual = manualPathOpen(S, { extracting, pending: !!pendingResumeImport });
  const paused = (!!S.settings.onboarded && resumeReviewPending(S)) || manual || manualDetailsMissing(S).length > 0;
  box.hidden = !paused && (!quickStartReady(S) || extracting || !!pendingResumeImport);
  const was = quickWasReady;
  quickWasReady = !box.hidden && !paused && !S.settings.onboarded;
  if (box.hidden) return;
  if (paused) {
    box.innerHTML = `<p class="small" style="margin:0"><b>Auto-Apply is paused.</b> ${esc(pausedMessage(S))}</p>`
      + (manual ? `<div class="row" style="margin-top:8px"><button class="btn small" id="manualgo">I'll enter my details myself</button></div>` : "")
      + (manualDetailsMissing(S).length ? `<div class="row" style="margin-top:8px"><button class="btn small" id="factsgo">Go to Quick facts</button></div>` : "");
    $("#manualgo")?.addEventListener("click", async () => {
      enterDetailsManually(S);
      pendingResumeImport = null;
      await save(true);
      go("facts");
    });
    $("#factsgo")?.addEventListener("click", () => go("facts"));
    return;
  }
  box.innerHTML = S.settings.onboarded
    ? `<p class="small" style="margin:0"><span class="ok">${esc(msg || "Auto-Apply is on.")}</span> <a href="https://internscout.org/" target="_blank">Open the internship dashboard ↗</a></p>
       ${digestLink()}
       ${offerPractice ? practiceLink : ""}
       <div id="held" hidden></div>
       <p class="small muted" style="margin:6px 0 0">Quick facts, Interview and Voice are optional. They make the answers on your applications better, and you can do them any time.</p>`
    : `<h3>Ready to apply</h3>
       <p class="small muted" style="margin-top:0">Your resume and your email for applications are in, which is all Auto-Apply needs. Quick facts, Interview and Voice are optional: they make the answers better, and you can do them later.</p>
       <div class="row"><button class="btn primary" id="quickgo">Turn on Auto-Apply now</button></div>`;
  if (shouldRevealQuick(was, quickWasReady)) {
    const profileBox = $("#resume-profile");
    const preview = profileBox && !profileBox.hidden && !rerun;
    revealQuick(preview ? profileBox : box, preview ? profileBox.querySelector("h3") : $("#quickgo"),
      matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  if ($("#quickgo")) $("#quickgo").addEventListener("click", async () => {
    $("#quickgo").disabled = true;
    const finished = await finishAndRender();
    if (!finished) return;
    drawQuick("Saved. Auto-Apply is on.", true);
    $("#practice-link")?.focus();
  });
  if (S.settings.onboarded) drawHeld();
}

// U2: the postings the student picked before setup (background/held.js), offered once setup is done.
// Nothing starts until they press the button.
async function drawHeld() {
  const box = $("#held");
  if (!box) return;
  const r = await chrome.runtime.sendMessage({ type: "held:get" }).catch(() => null);
  const jobs = (r && r.jobs) || [];
  if (!box.isConnected || !jobs.length) { box.hidden = true; return; }
  const one = jobs.length === 1;
  box.hidden = false;
  box.innerHTML = `<p class="small" style="margin:10px 0 6px">${esc(heldLine(jobs))}</p>
    <div class="row"><button class="btn primary small" id="heldgo">${one ? "Auto-Apply it now" : `Auto-Apply all ${jobs.length} now`}</button><button class="btn small" id="heldno">Not now</button><span class="small" id="heldmsg"></span></div>`;
  $("#heldgo").addEventListener("click", async () => {
    box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    const x = await chrome.runtime.sendMessage({ type: "held:start" }).catch((e) => ({ error: e.message }));
    if (!x || x.error) { $("#heldmsg").innerHTML = `<span class="err">${esc(x && x.error === "setup_required" ? "Finish setup first, then try again." : "Couldn't add them to the queue. Try again.")}</span>`; box.querySelectorAll("button").forEach((b) => { b.disabled = false; }); return; }
    const n = (x.added || []).length;
    box.innerHTML = `<p class="small ok" style="margin:10px 0 0">${n ? `Added ${n === 1 ? "1 application" : `${n} applications`} to your queue. Each one is filled in and left for you to check and submit.` : "Those are already in your queue."}</p>`;
    chrome.runtime.sendMessage({ type: "open_panel" }).catch(() => {});
  });
  $("#heldno").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "held:clear" }).catch(() => {});
    box.hidden = true;
  });
}

// Both finish buttons (Files' quick start, Review's finish). was: the body of Review's #finishall handler.
async function finishAndRender() {
  const currentStore = S, revision = seenRestore;
  await finishOnboarding(S, save);
  const finished = (await restoredAt()) === revision && S === currentStore;
  render();
  return finished;
}

// One read at a time: the automatic one when a resume is chosen and the button can overlap, and two
// reads of one resume would be two AI calls for the same answer.
let extracting = false;
async function extract(btn, out) {
  if (!canReadResume()) return;
  queuedResume = null;
  extracting = true;
  pendingResumeImport = null;
  S.settings.resume_details_ready = false;
  drawQuick();
  drawResumeReview();
  drawResumeProfile();
  // files() redraws itself (another file added meanwhile), so write to whatever is on the page now.
  const live = (el, sel) => (el && el.isConnected ? el : $(sel));
  if (btn) btn.disabled = true;
  if (out) busy(out, "Reading your resume… (about 30 seconds)");
  // The file this read is about. A different resume chosen while it runs is read straight after (below),
  // and "Last read" names the file that was read, not whichever one is chosen when the answer comes back.
  const currentStore = S, revision = seenRestore, file = S.files.resume;
  const stillCurrent = async () => (await restoredAt()) === revision && S === currentStore &&
    S.files.resume?.b64 === file.b64 && S.files.resume?.name === file.name;
  try {
    await save(true);
    if (!(await stillCurrent())) return;
    const content = [docBlock(file, "Resume"), docBlock(S.files.cv, "CV")].filter(Boolean);
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
    if (!(await stillCurrent())) return;
    const p = S.profile, plan = planResumeImport(p, x, { legacyResume: !!S.settings.extracted_from });
    if (plan.some((e) => e.conflict)) {
      pendingResumeImport = { file, plan };
      S.settings.resume_import = { plan };
      await save(true);
      const o = live(out, "#exout");
      if (o) o.textContent = "Review the resume updates below before saving.";
      drawResumeReview();
      return;
    }
    applyResumeImport(p, plan);
    S.settings.resume_import = null;
    S.settings.resume_details_ready = true;
    S.settings.resume_details_manual = false;
    if (!S.settings.signup_email && p.facts.email) S.settings.signup_email = p.facts.email;
    S.settings.extracted_from = file.name;   // was: S.files.resume.name
    await save(true);
    const o = live(out, "#exout");
    if (o) o.innerHTML = `<span class="ok">Found ${p.education.length} school(s), ${p.experience.length} role(s), ${p.projects.length} project(s).</span>`;
  } catch (e) {
    pendingResumeImport = pendingResumeReview(S);
    drawResumeReview();
    const o = live(out, "#exout");
    if (o) o.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    extracting = false;
    const b = live(btn, "#extract");
    if (b) b.disabled = !canReadResume();
    drawResumeProfile();
    drawQuick();   // reading the resume can fill in the sign-up email
    const now = S.files.resume;
    if (now && !(file && now.name === file.name && now.b64 === file.b64)) readQueuedResume();
  }
}

// ---------- 3. facts ----------
function facts() {
  const f = S.profile.facts;
  const ready = confirmedFacts(S);
  // Values the interview suggested (onboarding/profile.js applyInterviewFacts). Each field shows the answer
  // Auto-Apply uses now, with the suggestion under it to take or turn down. was: the suggested value sat in
  // the field as if it were the student's own answer, and was used.
  const suggested = new Map(factSuggestions(S.profile).map((x) => [x.key, x]));
  const shown = (k) => (suggested.has(k) ? factFallback(k) : f[k]);
  const unconfirmed = CONFIRMATION_FACTS.some((key) => !suggested.has(key) && f[key] && !ready[key]);
  // Older answers nobody confirmed (store.js unconfirmedOldFacts). The ones still equal to the old default
  // for everyone are flagged, and work authorization, sponsorship and age each get their own button:
  // "Confirm answers shown" leaves those three alone. was: one button confirmed all eleven old defaults.
  const old = new Map(unconfirmedOldFacts(S.profile).filter((x) => !suggested.has(x.key)).map((x) => [x.key, x]));
  const mismatch = workAuthMismatch(S);
  const missingManual = manualDetailsMissing(S);
  const hint = (k) => {
    const x = suggested.get(k);
    const o = old.get(k);
    if (!x && o) {
      const flag = o.legacy ? "Old default. Earlier versions of InternScout filled this in for everyone, so you may never have picked it." : "Saved before answers needed confirming.";
      return `<div class="small suggest" style="margin:-6px 0 12px">${esc(flag)} Not used until you confirm it.
        ${ELIGIBILITY_FACTS.includes(k) ? `<div class="row" style="margin-top:4px"><button class="btn small" data-confirm="${k}">Confirm: ${esc(o.value)}</button></div>` : ""}</div>`;
    }
    if (!x) return "";
    const from = x.source === "interview" ? "Suggested from your interview" : "Suggested";
    return `<div class="small suggest" style="margin:-6px 0 12px">${from}, not used until you confirm: <b>${esc(x.value)}</b>${x.kept ? ` (your earlier answer: ${esc(x.kept)})` : ""}
      <div class="row" style="margin-top:4px"><button class="btn small" data-use="${k}">Use this answer</button><button class="btn small" data-dismiss="${k}">${x.kept ? "Keep my earlier answer" : "Dismiss"}</button></div></div>`;
  };
  const field = ([k, label, opts]) => `<div>${opts
    ? `<label class="f"><span>${esc(label)}</span><select data-fact="${k}">${[...new Set([...opts, shown(k)])].map((o) => `<option ${o === shown(k) ? "selected" : ""} value="${esc(o)}">${esc(o || "Not answered (ask me if needed)")}</option>`).join("")}</select></label>`
    : `<label class="f"><span>${esc(label)}</span><input type="text" data-fact="${k}" value="${esc(shown(k))}"></label>`}${hint(k)}</div>`;
  main.innerHTML = `<h2>Quick facts</h2><p class="lead">The questions nearly every application asks. Answer once; the agent reuses them everywhere.</p>
    ${suggested.size ? `<div class="banner">Your interview suggested some answers below. Auto-Apply won't use them until you press Use this answer or pick an answer yourself.</div>` : ""}
    ${missingManual.length ? `<div class="banner">Auto-Apply is paused until your first name, last name and email are filled in below.</div>` : ""}
    ${mismatch ? `<div class="banner">${esc(mismatch)}</div>` : ""}
    ${unconfirmed ? `<div class="banner">Some saved answers need confirmation before Auto-Apply can use them. Check the flagged ones below. Work authorization, sponsorship and 18 or older each need their own Confirm button; Confirm answers shown covers the rest. Unanswered questions stay unknown.</div>` : ""}
    ${FACTS.map(([t, note, list]) => `<div class="card"><h3>${t}</h3>${note ? `<p class="small muted" style="margin-top:0">${note}</p>` : ""}<div class="grid">${list.map(field).join("")}</div></div>`).join("")}
    <div class="card"><h3>Education</h3>${S.profile.education.length
      ? S.profile.education.map((e) => `<div>${esc(e.school)} · ${esc([e.degree, e.major].filter(Boolean).join(", "))} · ${esc(e.grad_term || e.end)}${e.gpa ? ` · GPA ${esc(e.gpa)}` : ""}</div>`).join("")
      : `<span class="muted small">Nothing yet. Read your resume, or add education in Review.</span>`}</div>
    <div class="card"><button class="btn primary" id="confirm-facts">Confirm answers shown</button> <span id="facts-confirmed" role="status" class="small"></span></div>
    ${navButtons("setup", "interview")}`;
  // A field the student changes is their own answer, suggestion or not.
  main.querySelectorAll("[data-fact]").forEach((el) => el.addEventListener("input", () => {
    f[el.dataset.fact] = el.value; confirmProfileValue(S.profile, "facts", el.dataset.fact); save();
    if (suggested.has(el.dataset.fact) || old.has(el.dataset.fact)) { suggested.delete(el.dataset.fact); old.delete(el.dataset.fact); el.closest("div").querySelector(".suggest")?.remove(); }
  }));
  const decide = (attr, fn) => main.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener("click", async () => {
    fn(b.getAttribute(attr));
    await save(true);
    facts(); wireNav();
  }));
  decide("data-use", (k) => confirmProfileValue(S.profile, "facts", k));
  decide("data-confirm", (k) => confirmProfileValue(S.profile, "facts", k));
  decide("data-dismiss", (k) => dismissSuggestion(S.profile, k));
  $("#confirm-facts").onclick = async () => {
    // Suggestions are left as they are: the field shows the answer in use, not the suggested value.
    for (const key of bulkConfirmKeys(S.profile, new Set(suggested.keys()))) confirmProfileValue(S.profile, "facts", key);
    await save(true);
    facts(); wireNav();
    const waiting = ELIGIBILITY_FACTS.some((k) => old.has(k));
    $("#facts-confirmed").textContent = "Confirmed. Unanswered questions will still be asked when needed." + (waiting ? " Work authorization, sponsorship and 18 or older still need their own Confirm button." : "");
  };
}

// ---------- 4. interview ----------
const CHAT_KEY = "deepdive_chat";
function interviewConversation(messages = null, revision = seenRestore) {
  return { revision, messages, draft: "", pending: null, finishing: false, failed: false };
}

async function currentInterview(conversation) {
  const revision = await restoredAt();
  return interviewChat === conversation && conversation.revision === revision;
}

function persistInterview(conversation, messages, beforeReply) {
  // Start over and post-restore reads wait for any write this document has already issued.
  const storage = chrome.storage.local;
  const write = async () => {
    const revision = await restoredAt();
    if (interviewChat !== conversation || conversation.revision !== revision) return false;
    await storage.set({ [CHAT_KEY]: messages });
    const restored = (await restoredAt()) !== revision;
    if (restored && beforeReply) {
      // Restore only our own exact late reply and retain the already saved user answer.
      const current = (await storage.get(CHAT_KEY))[CHAT_KEY];
      if (current?.length === messages.length && messages.every((message, i) =>
        current[i]?.role === message.role && current[i].content === message.content)) {
        await storage.set({ [CHAT_KEY]: beforeReply });
      }
    }
    return interviewChat === conversation && !restored;
  };
  const result = interviewWrites.then(write);
  interviewWrites = result.catch(() => {});
  return result;
}

async function requestInterview(conversation) {
  if (conversation.pending || conversation.finishing || interviewChat !== conversation) return;
  if (!conversation.messages.length) {
    conversation.messages.push({ role: "user", content: `(Begin the interview. Greet me${S.profile.facts.first_name ? ` as ${S.profile.facts.first_name}` : ""} in one short sentence and ask the first question.)` });
  }
  const controller = new AbortController();
  conversation.pending = controller;
  conversation.failed = false;
  conversation.status = null;
  conversation.draw?.();
  try {
    const { messages } = conversation;
    if (!conversation.reply) {
      if (!(await persistInterview(conversation, messages)) || !(await currentInterview(conversation))) return;
      const r = await ai({ model: M().agent, max_tokens: 1024, system: interviewSystem(S), messages, signal: controller.signal });
      if (!(await currentInterview(conversation))) return;
      conversation.reply = { role: "assistant", content: textOf(r) };
    }
    const completed = [...messages, conversation.reply];
    if (!(await persistInterview(conversation, completed, messages))) return;
    conversation.messages = completed;
    conversation.reply = null;
    if (/\[\[DONE\]\]/.test(completed.at(-1).content)) {
      conversation.status = { text: "All topics covered. Press Finish & save." };
    }
  } catch (e) {
    conversation.failed = true;
    conversation.status = { text: e.message, tone: "err" };
  } finally {
    conversation.pending = null;
    conversation.draw?.(true);
  }
}

async function interview(epoch) {
  const conversation = interviewChat ??= interviewConversation();
  if (conversation.restoring) return;
  if (!conversation.messages) {
    await interviewWrites;
    const stored = (await chrome.storage.local.get(CHAT_KEY))[CHAT_KEY] || [];
    if (interviewChat !== conversation) return;
    if (!conversation.messages) {
      conversation.messages = stored;
      if (conversation.interrupted && stored.at(-1)?.role === "user") {
        conversation.failed = true;
        conversation.status = { text: "Interview paused after your profile was restored." };
      }
      conversation.interrupted = false;
    }
  }
  if (epoch !== renderEpoch || step !== "interview") return;
  main.innerHTML = `<h2>Interview</h2><p class="lead">The optional Deep Dive, part 1: a 10 to 15 minute conversation about your experiences and goals. Short, honest answers are perfect. Stop any time; what you've said is saved.</p>
    <div class="card"><div class="chat" id="chat"></div>
      <textarea id="say" placeholder="Type your answer… (Ctrl+Enter to send)"></textarea>
      <div class="row" style="margin-top:8px;justify-content:space-between">
        <div class="row"><button class="btn primary" id="send">Send</button><span id="cstat" class="small muted" role="status"></span></div>
        <div class="row"><button class="btn small" id="restart">Start over</button><button class="btn primary" id="finish">Finish & save stories</button></div></div>
    </div>
    ${S.profile.stories.length ? `<div class="card"><h3>Saved stories (${S.profile.stories.length})</h3>${S.profile.stories.map((s) => `<div class="story"><b>${esc(s.theme)}</b><div class="small muted">${esc(s.situation)}</div></div>`).join("")}</div>` : ""}
    ${navButtons("facts", "voice")}`;
  wireNav();
  focusStepHeading(main);
  const chat = $("#chat"), say = $("#say"), stat = $("#cstat");
  const sendBtn = $("#send"), finishBtn = $("#finish"), restartBtn = $("#restart");
  say.value = conversation.draft;
  const isView = () => epoch === renderEpoch && step === "interview" && interviewChat === conversation;
  conversation.draw = (focus = false) => {
    if (!isView()) return;
    chat.innerHTML = conversation.messages.slice(1).map((m) => `<div class="msg ${m.role === "user" ? "u" : "a"}">${esc(String(m.content).replace("[[DONE]]", "").trim())}</div>`).join("");
    chat.scrollTop = chat.scrollHeight;
    sendBtn.disabled = finishBtn.disabled = !!conversation.pending || conversation.finishing;
    restartBtn.disabled = !!conversation.savingStories;
    sendBtn.textContent = conversation.failed ? "Retry" : "Send";
    const status = conversation.status;
    if (conversation.pending) busy(stat, "Thinking…");
    else if (conversation.finishing) busy(stat, "Turning the conversation into stories… (about a minute)");
    else if (status?.tone) stat.innerHTML = `<span class="${status.tone}">${esc(status.text)}</span>`;
    else stat.textContent = status?.text ?? "";
    if (focus) say.focus();
  };
  const send = () => {
    if (!isView() || conversation.pending || conversation.finishing) return;
    if (!conversation.failed) {
      const text = say.value.trim();
      if (!text) return;
      conversation.messages.push({ role: "user", content: text });
      conversation.draft = say.value = "";
    }
    requestInterview(conversation);
  };
  sendBtn.addEventListener("click", send);
  say.addEventListener("input", () => { if (isView()) conversation.draft = say.value; });
  say.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (!e.repeat && !conversation.failed) send();
  });
  restartBtn.addEventListener("click", async () => {
    if (!isView() || conversation.savingStories) return;
    if (conversation.messages.length > 2 && !confirm("Clear this conversation? Stories you already saved are kept.")) return;
    conversation.pending?.abort();
    const next = interviewChat = interviewConversation([]);
    try {
      await persistInterview(next, []);
    } catch (e) {
      next.failed = true;
      next.status = { text: e.message, tone: "err" };
    }
    if (interviewChat === next && step === "interview") go("interview");
  });
  finishBtn.addEventListener("click", async () => {
    if (!isView() || conversation.pending || conversation.finishing) return;
    if (conversation.messages.length < 3) {
      conversation.status = { text: "Answer a few questions first." };
      conversation.draw();
      return;
    }
    conversation.finishing = true;
    conversation.draw();
    try {
      if (!(await currentInterview(conversation))) return;
      const x = await distill(conversation.messages);
      if (!(await currentInterview(conversation))) return;
      // Start over can retire a pending request. Once the profile commit starts, finish that save first.
      conversation.savingStories = true;
      conversation.draw();
      if (!(await saveInterviewStories(conversation, x))) return;
      conversation.status = { text: `Saved ${S.profile.stories.length} stories and your goals.`, tone: "ok" };
      setTimeout(() => { if (isView()) go("voice"); }, 900);
    } catch (e) {
      conversation.status = { text: e.message, tone: "err" };
    } finally {
      conversation.savingStories = false;
      conversation.finishing = false;
      conversation.draw();
    }
  });
  conversation.draw();
  if (!conversation.failed && conversation.messages.at(-1)?.role !== "assistant") {
    requestInterview(conversation);
  }
}

function saveInterviewStories(conversation, x) {
  const store = S;
  const owns = () => S === store && interviewChat === conversation;
  return queueStoreWrite(async () => {
    if (!owns()) return false;
    const before = structuredClone(store.profile);
    const proposed = structuredClone(before);
    if (Array.isArray(x.stories)) proposed.stories = x.stories;
    for (const [k, v] of Object.entries(x.goals || {})) if (v) proposed.goals[k] = v;
    applyInterviewFacts(proposed, x.facts);

    let applied = false;
    await updateStore(async (fresh) => {
      if ((await restoredAt()) !== conversation.revision || !owns()) return;
      mergeProfileEdits(fresh.profile, before, proposed);
      applied = true;
    });
    if (!applied || (await restoredAt()) !== conversation.revision || !owns()) return false;

    // Update the saved baseline, then layer any edits made while storage was pending onto the live profile.
    mergeProfileEdits(savedSnapshot.profile, before, proposed);
    const current = structuredClone(store.profile);
    mergeProfileEdits(proposed, before, current);
    // A manually edited fact and its provenance must stay together.
    for (const [key, value] of Object.entries(current.facts)) {
      const source = current.sources?.facts?.[key];
      if (value === before.facts[key] && JSON.stringify(source) === JSON.stringify(before.sources?.facts?.[key])) continue;
      proposed.facts[key] = value;
      if (source) proposed.sources.facts[key] = source;
      else delete proposed.sources.facts[key];
    }
    mergeProfileEdits(store.profile, current, proposed);
    return true;
  });
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
  return jsonOf(r);
}

// ---------- 5. voice ----------
function voice() {
  const v = S.profile.voice;
  const n = S.files.samples.length + (S.files.cover_letter ? 1 : 0);
  main.innerHTML = `<h2>Your voice</h2><p class="lead">The optional Deep Dive, part 2: so generated answers sound like you and not like a template.</p>
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
      if (!content.length && chat.length < 200) throw new Error("Add a writing sample under Resume or do some of the interview first.");
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
// The JSON lists sit under "Edit raw data", closed (2026-10-04). was: one open code box per list,
// which made Review read as something a student had to check line by line before finishing.
function review() {
  const p = S.profile;
  const missing = STEPS.filter(([id]) => id !== "review" && !doneFor(id)).map(([, t]) => t);
  main.innerHTML = `<h2>Review</h2><p class="lead">Everything the agent knows about you. Edit anything; changes save automatically.</p>
    ${missing.length ? `<div class="card warn">Still to do: ${missing.join(", ")}. Auto-Apply works best with everything filled.</div>` : ""}
    <div class="card"><h3>Goals</h3>${GOAL_FIELDS.map(([k, t]) => `<label class="f"><span>${t}</span><textarea data-goal="${k}" style="min-height:54px">${esc(p.goals[k])}</textarea></label>`).join("")}</div>
    <details class="adv" ${!rerun && S.settings.extracted_from ? "open" : ""}><summary>Edit profile sections</summary>
    ${JSON_SECTIONS.map(([k, t]) => `<div class="card"><h3>${t}</h3><textarea class="code" data-json="${k}">${esc(JSON.stringify(p[k], null, 2))}</textarea><div class="small" data-jerr="${k}"></div></div>`).join("")}
    </details>
    <div class="card"><div class="row"><button class="btn primary" id="finishall" ${quickStartReady(S) && !extracting && !pendingResumeImport ? "" : "disabled"}>${rerun ? "Save changes" : "Finish, turn on Auto-Apply"}</button><span id="rstat" class="small muted">${extracting || pendingResumeImport || S.settings.resume_details_ready === false ? "Auto-Apply is paused. Return to Resume to finish reading your resume, or to enter your details yourself." : manualDetailsMissing(S).length ? `Auto-Apply is paused. ${esc(pausedMessage(S))}` : quickStartReady(S) ? "" : "Set up AI, add a resume, and add your application email first."}</span></div><div id="held" hidden></div></div>
    ${navButtons("voice", null)}`;
  main.querySelectorAll("[data-goal]").forEach((el) => el.addEventListener("input", () => { p.goals[el.dataset.goal] = el.value; save(); }));
  main.querySelectorAll("[data-json]").forEach((el) => el.addEventListener("input", () => {
    const k = el.dataset.json, msg = main.querySelector(`[data-jerr=${k}]`);
    try {
      const v = JSON.parse(el.value);
      if (Array.isArray(p[k]) !== Array.isArray(v)) throw new Error(Array.isArray(p[k]) ? "Must be a [list]" : "Must be an {object}");
      p[k] = v;
      confirmProfileValue(p, "sections", k);
      msg.textContent = "";
      save();
    } catch (e) { msg.innerHTML = `<span class="err">Not saved: ${esc(e.message)}</span>`; }
  }));
  $("#finishall").addEventListener("click", async () => {
    const finished = await finishAndRender();
    if (!finished) return;
    // The weekly email's link under it (2026-10-06), as on the Files step's finish (drawQuick).
    const status = $("#rstat");
    if (!status) return;
    status.innerHTML = `<span class="ok">Saved. Auto-Apply is on.</span> <a href="https://internscout.org/" target="_blank">Open the internship dashboard ↗</a>${digestLink()}${practiceLink}`;
    $("#practice-link")?.focus();
    drawHeld();
  });
  if (S.settings.onboarded) drawHeld();
}

// Register for restores before reading the startup profile so a newer write can always trigger a reload.
const startup = loadProfileWithRestore().then((profile) => {
  useProfile(profile);
  step = explicitStep ? requestedStep : rerun ? "review" : "files";
  // The Setup email saved as its first letter by 0.5.6 and earlier (U3): put the whole address back.
  if (repairSetupEmail(S)) { pendingResumeImport = pendingResumeReview(S); save(true); }
  render();
});
await startup;
refreshSignIn();
