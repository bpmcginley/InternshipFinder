// The Auto-Apply loop: snapshot the page → Claude picks actions (tool use) → execute with
// verify-after-set → repeat, across page navigations, until ready_to_submit / needs_you.
import { callAI } from "./claude.js";
import { NEEDS_YOU_CODES } from "./gemini.js";
import { hasHostAccess, hostOf } from "../lib/hosts.js";
import { loadStore, updateStore, confirmedFacts, accountFor, domainOf, hasKey, isGemini, isWorker, modelFor, hasLocalResume, autoApplyReady, manualDetailsMissing } from "../lib/store.js";
import { ensureToken } from "../lib/auth.js";
import { tailorResume } from "./tailor.js";
import { canTailor } from "../lib/tailoring.js";
import { getJob, updateJob, appendLog, saveMsgs, loadMsgs, getTailoredFile, tailorChoice } from "./queue.js";
import { spend, money } from "../lib/usage.js";
import { recordStep } from "./evalrec.js";
// Side-effect import: guard.js is an IIFE that hangs ISGuard off globalThis. We want detectGate
// here (in the worker) as well as in the page, and this keeps one copy with one set of tests.
import "../agent/guard.js";

import { pageGone, postingGone, pageBulk, deadPage } from "./page-state.js";
export { pageGone, postingGone, pageBulk, deadPage };

import { TOOLS, trimHistory, toolResult, buildSystem } from "./agent-prompt.js";
import { MAX_FIELD_FAILS, formatSnapshot, preFilledLine, NO_PROGRESS_HELP, freshProgress, progressCheck, pageKey } from "./agent-snapshot.js";
export { TOOLS, trimHistory, buildSystem };
export { formatSnapshot, preFilledLine, SAME_SNAPSHOTS_MAX, TURNS_PER_PAGE_MAX, NO_PROGRESS_HELP, freshProgress, progressCheck } from "./agent-snapshot.js";

const MAX_STEPS = 40;
const PAGE_FILES = ["agent/guard.js", "agent/actions.js", "agent/dom.js"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tab + page plumbing ----------
async function ensureTab(job) {
  if (job.tabId) {
    const t = await chrome.tabs.get(job.tabId).catch(() => null);
    // Resume is pressed from the InternScout panel, which is a tab of its own, so without this the
    // job tab would still be the one in the background and the run would pause again at once.
    if (t) { await chrome.tabs.update(t.id, { active: true }).catch(() => {}); return t.id; }
  }
  // Foreground, and it has to be. Chrome gives a tab the student has switched away from no
  // requestAnimationFrame at all and one timer per second: measured on a real form, five chained
  // 100ms timers took 6.8 seconds, and a Turbo page changed its URL and then never drew the new
  // one. A tab opened with active:false is born in that state, so every run was working blind
  // against a page that could barely move. Borrowing the foreground is the smaller cost, and the
  // student is meant to be watching this tab anyway: it is where they press Resume.
  const t = await chrome.tabs.create({ url: job.apply_url, active: true });
  try {
    let { groupId } = await chrome.storage.session.get("groupId");
    if (groupId != null) await chrome.tabGroups.get(groupId).catch(() => { groupId = null; });
    groupId = await chrome.tabs.group(groupId != null ? { tabIds: [t.id], groupId } : { tabIds: [t.id] });
    await chrome.tabGroups.update(groupId, { title: "InternScout", color: "blue" });
    await chrome.storage.session.set({ groupId });
  } catch (e) { /* tab groups unsupported (e.g. Edge variants) */ }
  return t.id;
}

async function groupTab(tabId) {
  try {
    const { groupId } = await chrome.storage.session.get("groupId");
    if (groupId != null) await chrome.tabs.group({ tabIds: [tabId], groupId });
  } catch (e) { /* group gone or unsupported */ }
}

async function waitForTab(tabId, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("The application tab was closed.");
    if (t.status === "complete") return t;
    await sleep(300);
  }
  return chrome.tabs.get(tabId);
}

// A page can wedge its own renderer so thoroughly that nothing sent into it ever comes back: ADP
// Workforce Now's recruitment page stops answering scripts altogether, and Chrome neither returns a
// result nor reports an error. Every trip into the page therefore gets a deadline, because a run
// that is merely waiting looks exactly like a run that is working, and says nothing to the student.
//
// The deadline is long because missing it has to mean something. Workday blocks its own main thread
// in bursts while it hydrates - long enough that a trivial script sent into a perfectly healthy
// Workday page can go unanswered for the better part of a minute, and answer instantly a moment
// later. A deadline short enough to catch ADP quickly would end every Workday application.
export const FROZEN_PAGE = "The page stopped responding. Open the tab and reload it, then Retry.";
export function toPage(p, ms = 30000) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(FROZEN_PAGE)), ms); }),
  ]);
}

async function inject(tabId) {
  try {
    await toPage(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files: PAGE_FILES }));
  } catch (e) {
    for (let attempt = 0; ; attempt++) {
      try {
        await toPage(chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: PAGE_FILES }));
        break;
      } catch (err) {
        // A page busy enough to miss one deadline is usually a page that is busy, not broken, so wait
        // and ask again before saying anything to the student. No reload here, unlike the error-page
        // case below: this runs before every snapshot, including halfway through an application, and
        // a reload there would throw away everything the student had already filled in.
        if (err.message === FROZEN_PAGE) {
          if (attempt >= 2) throw err;
          await sleep(4000);
          continue;
        }
        // Chrome's own error page (network blip, site block): reload a couple of times before giving up.
        if (!/error page/i.test(err.message) || attempt >= 2) {
          throw /error page/i.test(err.message) ? new Error("The site showed a load error (it may block automated browsing or be down). Open the tab, then Retry.") : err;
        }
        await chrome.tabs.reload(tabId).catch(() => {});
        await sleep(3000);
        await waitForTab(tabId);
      }
    }
  }
  try {
    await toPage(chrome.scripting.executeScript({ target: { tabId }, files: ["agent/guard.js", "agent/overlay.js"] }));
  } catch (e) {}
}

async function inFrames(tabId, func, args = []) {
  try {
    const res = await toPage(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func, args }));
    return res.filter((r) => r && r.result);
  } catch (e) {
    return [];
  }
}

// Every frame's mark(), in one string. An empty answer means the page was not reachable at that
// moment — mid-navigation, or before the scripts are back — which is a change by itself, so an
// empty mark on either side never counts as "nothing happened".
async function pageMark(tabId) {
  const rs = await inFrames(tabId, () => (window.ISDom && window.ISDom.mark ? window.ISDom.mark() : ""));
  return rs.map((r) => `${r.frameId}=${r.result}`).join("~");
}
export const noChange = (before, after) => !!before && !!after && before === after;

async function act(tabId, fullRef, action, payload) {
  const [fid, local] = String(fullRef).split(":");
  try {
    const [r] = await toPage(chrome.scripting.executeScript({
      target: { tabId, frameIds: [Number(fid)] }, world: "MAIN",
      func: (ref, a, p) => (window.ISDom ? window.ISDom.act(ref, a, p) : { ok: false, error: "Page changed. Use the new snapshot." }),
      args: [local, action, payload],
    }));
    return (r && r.result) || { ok: false, error: "No result (frame navigated?)" };
  } catch (e) {
    return { ok: false, error: "Could not reach the page: " + e.message };
  }
}

// A code sitting in your inbox is yours to fetch, so the agent stops there and hands the tab
// back. Checked here, before the model gets a turn, so the pause costs no AI call and does not
// depend on the model choosing to call pause_for_user.
const GATE_HELP = {
  email_verification: "This site emailed you a verification code. Enter it in the tab, then press Resume.",
  captcha: "The site wants you to prove you're human. Solve the check in the tab, then press Resume.",
  human_check: "This form asks a question meant to prove a person is applying, not a program. Answer that one yourself in the tab, then press Resume.",
  background_tab: "Chrome slows down tabs you've switched away from, and this page stopped responding. Bring the application tab back to the front and it carries on by itself. If the tab is waiting on you (a pop-up, a sign-in), deal with that first, then press Resume.",
};
// index.js resumes a job paused for this reason by itself once its tab is brought to the front.
export const BACKGROUND_TAB_HELP = GATE_HELP.background_tab;

function gateIn(frames) {
  for (const f of frames) {
    const g = globalThis.ISGuard.detectGate(f);
    if (g) return g;
  }
  return null;
}

function accountLine(store, url) {
  const a = accountFor(store, url);
  if (a.state === "pending") return `ACCOUNT (${a.domain}): saved credentials, but sign-up is not confirmed. Continue sign-up with email ${a.email}; if the site offers Sign in or says the email already exists, try those same saved credentials. Use fill_secret for the password.`;
  return a.isNew
    ? `ACCOUNT (${a.domain}): none saved. If an account is required, create one with email ${a.email}.`
    : `ACCOUNT (${a.domain}): exists. Sign in with email ${a.email}; use fill_secret for the password.`;
}

export function accountCreationConfirmed(frame) {
  if (!frame || (frame.errors || []).length || (frame.elements || []).some(e => e.kind === "password")
      || globalThis.ISGuard.detectGate(frame)) return false;
  const text = [...(frame.headings || []), frame.text || ""].join(" ");
  if (/\b(not created|could not|unable to|failed|unsuccessful|error)\b/i.test(text)) return false;
  return /\b(your account (has been |was )?(successfully )?created|account (has been |was )?successfully created|account created successfully|registration (was |is )?successful)\b/i.test(text);
}

async function confirmAccounts(store, frames, active) {
  const domains = new Set(frames.filter(accountCreationConfirmed).map(f => domainOf(f.url)));
  if (!store.accounts.some(a => a.state === "pending" && domains.has(a.domain))) return;
  const fresh = await updateStore(async s => {
    if (!(await active())) return s;
    for (const a of s.accounts) if (a.state === "pending" && domains.has(a.domain)) a.state = "confirmed";
  });
  store.accounts = fresh.accounts;
}

// ---------- tailored resume ----------
// own: loop()'s status writer, so a Pause pressed while the resume is tailored is not overwritten.
async function tailorStep(id, job, store, own = (patch) => updateJob(id, patch)) {
  await updateJob(id, { activity: "Tailoring your resume to this posting…" });
  try {
    const { cost_usd, reused, ...t } = await tailorResume(store, job);
    // Nothing worth changing for this posting: the student's own file is the better thing to send than
    // a re-saved or redrawn copy of it, and there is nothing to ask them to review.
    if (!Array.isArray(t.diff) || !t.diff.length) {
      job = await updateJob(id, (j) => ({ tailored: { status: "skipped", error: "nothing to change" }, cost_usd: (j.cost_usd || 0) + cost_usd }));
      await appendLog(id, { kind: "tailor", text: "Your resume already fits this posting as written. Using your original." });
      return job;
    }
    // A "for all" answer on another job of the same batch (U5, queue.js setBatchTailor), read fresh because
    // it may have been given while this one was being tailored: tailored for all counts as auto, and the
    // original for all means this one goes out as the original too, without asking.
    // was: const auto = store.settings.tailor_resume === "auto";
    const choice = tailorChoice(store.settings.tailor_resume, ((await getJob(id)) || job).batch_tailor);
    if (choice === "original") {
      job = await updateJob(id, (j) => ({ tailored: { status: "skipped", error: "you chose your original resume for these applications" }, cost_usd: (j.cost_usd || 0) + cost_usd }));
      await appendLog(id, { kind: "tailor", text: "Using your original resume, as you chose for the applications queued with this one." });
      return job;
    }
    const auto = choice === "auto";
    job = await updateJob(id, (j) => ({ tailored: { ...t, status: auto ? "approved" : "pending" }, cost_usd: (j.cost_usd || 0) + cost_usd }));
    // The queue can refuse the file (no room left in the browser's storage) and hands back
    // tailored.status "failed". This step used to carry on regardless: it logged "used automatically"
    // while the original went out, or paused the job on "Review the tailored resume" with nothing
    // in the side panel to review.
    if (job && job.tailored && job.tailored.status === "failed") {
      await appendLog(id, { kind: "tailor", text: `${job.tailored.error || "The tailored resume could not be kept."} Using your original.` });
      return job;
    }
    await appendLog(id, { kind: "tailor", text: `Tailored resume: ${t.diff.length} change(s)${reused ? ", reused from an earlier run at no cost" : ""}${auto ? ", used automatically" : ""}.` });
    if (!auto) job = await own({ status: "needs_you", reason: "Review the tailored resume: use it, or keep your original.", question: "", activity: "" });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // was: job = await updateJob(id, { tailored: { status: "failed", error: msg } });
    // A failure can still have cost something (the layout of a PDF was read before it was refused).
    job = await updateJob(id, (j) => ({ tailored: { status: "failed", error: msg }, cost_usd: (j.cost_usd || 0) + (Number(e && e.cost_usd) || 0) }));
    await appendLog(id, { kind: "tailor", text: `Couldn't tailor the resume (${e && e.code ? msg : msg.slice(0, 160)}). Using your original.` });   // was: msg.slice(0, 80), which cut the reason off
  }
  return job;
}

// ---------- main loop ----------
export const RESUME_REVIEW_HELP = "Finish reviewing your resume in Auto-Apply setup, then press Resume.";
export const NO_RESUME_HELP = "Add your resume in Auto-Apply setup, then press Resume.";
export const NOT_SET_UP_HELP = "Set up Auto-Apply (about 2 minutes), then press Resume.";
// The student chose "I'll enter my details myself" and some of those details are still empty
// (store.js manualDetailsMissing). Same wording as the Deep Dive's banner (onboarding/quickstart.js
// pausedMessage). was: "Finish reviewing your resume", which sent them to a review there was none of.
const DETAIL_NAMES = { first_name: "first name", last_name: "last name", email: "email" };
const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
export const manualDetailsHelp = (missing) => `Add your ${andList(missing.map((k) => DETAIL_NAMES[k] || k))} in Quick facts, then press Resume.`;
const notReadyHelp = (store) => {
  if (!store.settings.onboarded) return NOT_SET_UP_HELP;
  const missing = store.settings.resume_import ? [] : manualDetailsMissing(store);
  if (missing.length) return manualDetailsHelp(missing);
  return hasLocalResume(store) ? RESUME_REVIEW_HELP : NO_RESUME_HELP;
};
// A page whose only held-back buttons are Accept or I agree (formatSnapshot consentOnly).
export const CONSENT_HELP = "This page asks you to agree to something. Read it, press the button yourself, then press Resume.";
const running = new Set();
export const isRunning = (id) => running.has(id);
// Pause, Take over, Resume, Retry, "I submitted it" and Remove all bump job.gen (index.js control,
// resumeJob). A run owns its job only while the job is still "working" at the gen it started with.
// Before this the loop checked the status once per turn, at the top: an AI reply already on its way
// when the student pressed Take over still filled fields and clicked buttons, then wrote its own
// status over "You took over" (it could even turn Submitted back into Needs you).
export const owns = (j, gen) => !!j && j.status === "working" && (j.gen || 0) === gen;
// The AI call in flight for each running job, so Pause and Take over can cut it off (stopJob).
const aborts = new Map();
// runJob was asked for while an older run of the same job was still winding down (Pause, then Resume
// inside one AI call). It starts again once that one has gone, instead of leaving the job on "Working"
// with no run behind it.
const rerun = new Set();
export function stopJob(id) {
  const c = aborts.get(id);
  if (c) c.abort();
}
// The student's own status (Pause, Take over, Retry, "I submitted it"; index.js control), written with
// a new gen so a run still in flight knows the job is no longer its own, and with that run's AI call
// cut off. was: the status alone, which a late AI reply then acted on and wrote over.
// The page is told too (dom.js halt): a prefill or a dropdown pick already running in the tab stops at
// its next field, and a late highlight() no longer scrolls the page the student has taken back.
export async function takeBack(id, patch) {
  stopJob(id);
  const j = await updateJob(id, (x) => ({ ...patch, gen: (x.gen || 0) + 1 }));
  if (j && j.tabId != null) await haltPage(j.tabId, j.gen);
  return j;
}
async function haltPage(tabId, gen) {
  await inFrames(tabId, (g) => (window.ISDom && window.ISDom.halt ? window.ISDom.halt(g) : false), [gen]);
}

// A sign-in or sign-up step: a password box, or nothing to fill but an email address (the "enter your
// email, then Next" first page of Workday, iCIMS and Oracle sign-in). Filling one is not filling the
// application, and the posting's own Apply or Accept button often comes after it (guard.js runFilled).
// was: only a page with a password box; an email-only step counted as filled (PR #94 review, P2).
const EMAIL_RE = /e-?mail/i;
export function signInStep(frames) {
  const els = (frames || []).flatMap((f) => (f && f.elements) || []);
  if (els.some((e) => e.kind === "password")) return true;
  const asks = els.filter((e) => e.kind !== "checkbox");
  return asks.length > 0 && asks.every((e) => e.type === "email" || EMAIL_RE.test([e.label, e.question].filter(Boolean).join(" ")));
}

// The address a stored password belongs to: the frame the password box is in. An ATS form inside an
// employer's careers page (Greenhouse, iCIMS, Workday embeds) keeps its accounts on its own domain, and
// accountCreationConfirmed reads that frame's url, so keying the password to the top page meant the
// sign-up was never confirmed. was: tab.url || ctx.url (PR #94 review, P2).
export function secretUrl(entry, tabUrl, fallback) {
  return (entry && entry.url) || tabUrl || fallback || "";
}

export async function runJob(id) {
  if (running.has(id)) { rerun.add(id); return; }
  running.add(id);
  const ctrl = new AbortController();
  aborts.set(id, ctrl);
  const run = { gen: null, signal: ctrl.signal };
  // Chrome stops an idle MV3 service worker after 30 s, and a slow AI reply counts as idle.
  // Calling any extension API resets that timer, so a job in progress is not cut off mid-step.
  const keepalive = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch {} }, 20000);
  try {
    await loop(id, run);
  } catch (e) {
    // was: written whatever the job's status. A run the student stopped ends quietly.
    if (!ctrl.signal.aborted) await updateJob(id, (j) => ((run.gen == null ? !!j && j.status === "working" : owns(j, run.gen))
      ? { status: "failed", reason: String((e && e.message) || e), activity: "" } : {}));
  } finally {
    clearInterval(keepalive);
    running.delete(id);
    if (aborts.get(id) === ctrl) aborts.delete(id);
  }
  if (rerun.delete(id)) {
    const j = await getJob(id);
    if (j && j.status === "working") await runJob(id);
  }
}

async function loop(id, run) {
  let job = await getJob(id);
  if (!job) return;
  const gen = run.gen = job.gen || 0;
  const active = async () => {
    if (run.signal.aborted) return false;
    const current = await getJob(id);
    return !run.signal.aborted && owns(current, gen);
  };
  // Every status this run decides goes through here, so none of it lands on a job the student has
  // paused, taken over, finished or restarted since. A function patch sees the job as stored.
  const own = (patch) => updateJob(id, (j) => (owns(j, gen) ? (typeof patch === "function" ? patch(j) : patch) : {}));
  let store = await loadStore();
  // The same gate as queueing (index.js enqueue), checked again here because a job queued earlier, or
  // resumed, can run after the resume was replaced. Nothing is filled with a profile that isn't ready.
  // was: checked only when jobs were added.
  if (!autoApplyReady(store)) {
    await own({ status: "needs_you", activity: "", question: "", reason: notReadyHelp(store) });
    return;
  }
  if (!hasKey(store)) {
    await own({ status: "needs_you", reason: `Add your ${isGemini(store.ai) ? "Gemini" : "Anthropic"} API key (Auto-Apply setup → Setup), then Resume.` });
    return;
  }
  if (isWorker(store.ai) && !(await ensureToken())) {
    // needs_auth gives the card a "Sign in & resume" button. A plain Resume only re-ran this check, and an
    // expired sign-in (they last an hour) that could not refresh silently stayed stuck here.
    await own({ status: "needs_you", needs_auth: true, needs_host: "", reason: "Your InternScout sign-in has expired (they last an hour). Sign in again to keep going.", activity: "" });
    return;
  }
  // The manifest only covers the big applicant-tracking systems. An employer that runs its own careers
  // site needs the student's say-so, and Chrome only grants that from a click on an extension page, so
  // the side panel asks and this run waits. Checked before the tab opens: a tab we cannot script is
  // just a confusing window.
  if (!(await hasHostAccess(job.apply_url))) {
    // Flags outlive the pause that set them, and the side panel checks needs_auth before needs_host,
    // so clear the other one here or a sign-in that expired earlier hides the Allow button.
    await own({ status: "needs_you", needs_host: job.apply_url, needs_auth: false, activity: "",
      reason: `InternScout needs your permission to work on ${hostOf(job.apply_url)}. Allow it below, then Resume.` });
    return;
  }
  // One Auto-Apply run = one allowance unit on the InternScout Worker; kept across Resume, reset by Retry.
  if (!job.run_id) job = await updateJob(id, { run_id: crypto.randomUUID() });
  // A Pause or Take over that landed while the checks above were awaited: stop before the paid
  // tailoring call. was: first checked after tailoring (PR #94 review, P3).
  if (!(await active())) return;
  // batch_tailor "skipped": "Use my original for all" on another job of this batch (U5), so nothing is
  // tailored, and none of the allowance is spent on it.
  if (!job.tailored && (store.settings.tailor_resume || "off") !== "off" && job.batch_tailor !== "skipped" && canTailor(store, job) && (isWorker(store.ai) || !(await spend()).over)) {
    job = await tailorStep(id, job, store, own);
    if (!owns(job, gen)) return; // waiting for the human to approve it, or stopped meanwhile
  }
  if (!(await active())) return;
  let tabId = await ensureTab(job);
  // was: { tabId, status: "working", ... } written whatever had happened meanwhile, which undid a
  // Pause pressed while the resume was being tailored or the tab was opening.
  const fresh = { status: "working", reason: "", question: "", needs_host: "", needs_auth: false, upgrade: null };
  job = await updateJob(id, (j) => (owns(j, gen) ? { tabId, ...fresh } : { tabId }));
  if (!owns(job, gen)) return;
  const msgs = await loadMsgs(id);
  const fails = {};
  let pending = job.pending || null;
  let steps = job.steps || 0;
  // Snapshots in a row that came back identical while the tab was asleep. See the gate below.
  let sleepy = 0, sleepText = null;
  // The no-progress breaker's counters (progressCheck). Started fresh here, so Resume gets a clean count.
  let progress = freshProgress();
  // Whether this run has filled answers on an earlier page (guard.js allowClick runFilled). Kept on the
  // job so Resume keeps it; Retry clears it with the rest of the run. Sign-in and sign-up pages (any
  // with a password box) do not count: the posting's own Apply button often comes after them.
  let runFilled = !!job.run_filled;
  const noteFilled = async () => { if (!runFilled) { runFilled = true; await updateJob(id, { run_filled: true }); } };
  const shot = () => inFrames(tabId, (o) => window.ISDom && window.ISDom.snapshot(o), [{ runFilled }]);

  while (true) {
    job = await getJob(id);
    // was: if (!job || job.status !== "working") return;
    if (!owns(job, gen)) return;
    if (steps >= MAX_STEPS) {
      await own({ status: "needs_you", reason: `Stopped after ${MAX_STEPS} steps. Finish by hand, or Resume to let it keep going.`, steps: 0, pending });
      await saveMsgs(id, msgs);
      return;
    }
    const sp = await spend();
    if (sp.over && !isWorker(store.ai)) {
      await own({ status: "needs_you", reason: `Monthly AI budget reached (${money(sp.month_usd)} of ${money(sp.budget)}). Raise it in Auto-Apply setup → Setup, then Resume.`, pending, activity: "" });
      await saveMsgs(id, msgs);
      return;
    }

    const cur = await waitForTab(tabId);
    // A redirect or a new tab can land on a site the student never allowed (company page -> external ATS).
    if (cur && cur.url && !(await hasHostAccess(cur.url))) {
      await own({ status: "needs_you", needs_host: cur.url, needs_auth: false, pending, activity: "",
        reason: `The application moved to ${hostOf(cur.url)}. Allow InternScout there below, then Resume.` });
      await saveMsgs(id, msgs);
      return;
    }
    await sleep(800);
    if (!(await active())) return;
    await inject(tabId);
    store = await loadStore();
    // The resume was replaced while this run was going: stop before filling anything more.
    if (!autoApplyReady(store)) {
      await own({ status: "needs_you", reason: notReadyHelp(store), question: "", pending, activity: "" });
      await saveMsgs(id, msgs);
      return;
    }
    // job_in_us: for fastFill's "authorized to work in the country where this position is based".
    // was: email: ... || store.profile.facts.email, which skipped the confirmation check.
    const ready = confirmedFacts(store);
    const facts = { ...ready, email: store.settings.signup_email || ready.email,
      job_in_us: globalThis.ISGuard.jobInUS(job.location) };
    // The resume goes in with the contact details when the page has one obvious box for it, on the
    // same rules-first principle: a turn spent telling the model to attach the file it was always
    // going to attach is a turn nobody gets back. Same choice of file as the upload tool makes.
    // The job carries the tailored file's name only; its bytes are fetched here (see queue.js).
    // Was: (... && job.tailored.file) || store.files.resume || null
    const resume = (job.tailored && job.tailored.status === "approved" && job.tailored.file && await getTailoredFile(job.id)) || store.files.resume || null;
    if (!(await active())) return;
    let pre = (await inFrames(tabId, (f, file, g) => window.ISDom && window.ISDom.fastFill(f, file, { gen: g }), [facts, resume, gen]))
      .flatMap((r) => r.result || []);

    let frames = (await shot()).map((r) => ({ frameId: r.frameId, ...r.result }));
    // Single-page apps (Workday, Oracle, SuccessFactors) show a spinner for several seconds after the tab
    // reports "complete". A model turn spent on an empty loading page is wasted, so wait it out here.
    //
    // Wait on the whole "nothing here" condition, not just on an empty frame, because a dead link and
    // a page that has not drawn itself yet look identical in one snapshot and only time tells them
    // apart. Workable is the clearest case: for its first few seconds a live job page is a header and
    // a "Cookie settings" button - enough to pass "this frame has something in it", and enough to fail
    // every test for a live application - so a real posting was being handed back to the student as a
    // dead one. Waiting costs a few seconds on links that really are dead; not waiting cost the
    // application.
    // How long to wait is the page's business, not ours. A fixed number of seconds is either too
    // short for Workable, whose application form took half a minute to arrive on a cold cache, or too
    // long for every dead link. So watch whether the page is still arriving - more elements, more
    // buttons, more text than the look before - and keep waiting while it is. A page that has stopped
    // growing twice over has nothing more to show, and by then we have waited about six seconds.
    for (let i = 0, was = -1, still = 0; i < 12
      && (deadPage(frames) || (!frames.some((f) => f.elements.length) && frames.some((f) => f.busy))); i++) {
      const now = pageBulk(frames);
      still = now === was ? still + 1 : 0;
      was = now;
      if (i >= 3 && still >= 2) break;
      await sleep(i ? 2000 : 2500);
      await inject(tabId);
      frames = (await shot()).map((r) => ({ frameId: r.frameId, ...r.result }));
    }
    // fastFill ran before that wait, so on a page that had not drawn itself yet it was handed an empty
    // form and filled nothing. Now that the fields exist, give the rules their turn: every field the
    // profile can answer here is a field the model does not have to, and that is the student's
    // allowance. Re-snapshot afterwards so the model is shown the values that were just typed.
    if (!pre.length && frames.some((f) => f.elements.length)) {
      if (!(await active())) return;
      pre = (await inFrames(tabId, (f, file, g) => window.ISDom && window.ISDom.fastFill(f, file, { gen: g }), [facts, resume, gen]))
        .flatMap((r) => r.result || []);
      if (pre.length) frames = (await shot()).map((r) => ({ frameId: r.frameId, ...r.result }));
    }
    // A page Chrome has put to sleep answers every snapshot with whatever was on screen when the
    // student left, so acting on it would be acting on a photograph. Say so instead of guessing.
    // Confirmed a second time first: another window passing over this one counts as hidden for a
    // moment, and that is not worth stopping a run for.
    let asleep = frames.some((f) => f.frozen);
    if (asleep) {
      await sleep(2500);
      await inject(tabId);
      frames = (await shot()).map((r) => ({ frameId: r.frameId, ...r.result }));
      asleep = frames.some((f) => f.frozen);
    }

    if (!(await active())) return;
    await confirmAccounts(store, frames, active);
    const snap = formatSnapshot(frames, fails);
    snap.tabId = tabId;
    const url = (snap.top && snap.top.url) || job.apply_url;
    const accountPage = signInStep(frames);
    if (pre.length && !accountPage) await noteFilled();

    // A sleeping tab still runs its scripts, just slowly, so its DOM is real and a CAPTCHA or a
    // login wall found in it is real too. Name that instead when there is one: it is the more
    // useful thing to tell the student, and bringing the tab forward is part of answering it anyway.
    // A background tab used to pause the run at once. That broke running more than one application at
    // a time (the max_tabs setting), since only one tab per window is ever in front, so every other
    // job stopped at its first step. A hidden tab still runs its scripts and its DOM is live, only
    // slower, and on most forms the run gets there. So carry on, and pause only when sleep is actually
    // stopping progress: the page has come back unchanged three snapshots running while asleep.
    if (asleep) { sleepy = snap.text === sleepText ? sleepy + 1 : 0; sleepText = snap.text; }
    else { sleepy = 0; sleepText = null; }
    const check = progressCheck(progress, snap.text, pageKey(url, frames), asleep);
    progress = check.state;
    const stuckAsleep = asleep && sleepy >= 2;
    const gate = gateIn(frames) || (stuckAsleep ? { kind: "background_tab", reason: "this tab is asleep in the background and the page stopped changing" } : null);
    if (gate) {
      await appendLog(job.id, { kind: "gate", text: `Paused: ${gate.reason}` });
      await own({ status: "needs_you", reason: GATE_HELP[gate.kind], question: "", pending, activity: "" });
      await saveMsgs(id, msgs);
      return;
    }

    if (!msgs.length && (postingGone(job, snap, frames) || pageGone(frames))) {
      await appendLog(job.id, { kind: "gate", text: "Paused: this is not the posting you picked." });
      await own({ status: "needs_you", pending, activity: "", question: "",
        reason: `The link for "${job.title}" opened somewhere else, so the employer has most likely closed the posting. Look at the tab: if the job is gone, remove this one; if you find it, open it yourself and press Resume.` });
      await saveMsgs(id, msgs);
      return;
    }

    if (!msgs.length && deadPage(frames)) {
      await appendLog(job.id, { kind: "gate", text: "Paused: nothing loaded on this page." });
      await own({ status: "needs_you", pending, activity: "", question: "",
        reason: "Nothing loaded on that page: no application and no Apply button. The link is probably dead, or the site is not letting us in. Have a look in the tab: if you get to a form, press Resume." });
      await saveMsgs(id, msgs);
      return;
    }

    if (!msgs.length && globalThis.ISGuard.nothingLeftForAI(frames, pre.length)) {
      // The blocked button is only an Accept or I agree: not ready to submit, but the student's to agree to.
      if (snap.consentOnly) {
        await appendLog(job.id, { kind: "gate", text: "Paused: this page asks you to agree to something." });
        await own({ status: "needs_you", reason: CONSENT_HELP, question: "", pending, activity: "" });
        await saveMsgs(id, msgs);
        return;
      }
      await appendLog(job.id, { kind: "note", text: `Filled ${pre.length} field(s) from your profile; no AI was needed.` });
      const hl = (await inFrames(tabId, (o) => window.ISDom && window.ISDom.highlight(o), [{ runFilled, gen }])).map((r) => r.result);
      const missing = hl.reduce((n, h) => n + ((h && h.missing) || 0), 0);
      // highlight() re-reads the page after the fills settled, so it is the last word: if it finds a
      // hole the snapshot missed, say so rather than claiming the form is done.
      await own({
        status: "ready_to_submit", activity: "", steps: 0,
        summary: `Filled ${pre.length} field(s) from your profile. Nothing on this page needed AI, so it cost you no allowance. Check every answer before you submit.`,
        double_check: missing ? [`${missing} required field(s) look empty (amber outline).`] : [],
      });
      await saveMsgs(id, msgs);
      return;
    }

    // Checked after the gates above, which say something more useful when one of them applies, and
    // before the model is called, so a stuck page costs no further AI call. `pending` is kept, as in
    // the MAX_STEPS stop, so the last turn's tool results still go out on Resume.
    if (check.stop) {
      await appendLog(job.id, { kind: "gate", text: progress.stuckSame >= SAME_SNAPSHOTS_MAX
        ? `Paused: the page came back unchanged ${progress.stuckSame} times in a row.`
        : `Paused: ${progress.turnsHere} turns on this page without moving on.` });
      await own({ status: "needs_you", reason: NO_PROGRESS_HELP, question: "", steps: 0, pending, activity: "" });
      await saveMsgs(id, msgs);
      return;
    }

    // The account the password box belongs to, which is an ATS iframe's own when the form is embedded.
    const pwFrame = frames.find((f) => (f.elements || []).some((e) => e.kind === "password"));
    const content = [];
    if (pending && pending.results) content.push(...pending.results);
    // was: if (!msgs.length) content.push({ type: "text", text: jobIntro(job) }); the job is in buildSystem now.
    if (pending && pending.note) content.push({ type: "text", text: pending.note });
    if (pre.length) content.push({ type: "text", text: preFilledLine(pre, snap.shown) });
    content.push({ type: "text", text: `SNAPSHOT\n${accountLine(store, (pwFrame && pwFrame.url) || url)}\n${snap.text}` });
    msgs.push({ role: "user", content });
    const prevPending = pending;
    pending = null;
    trimHistory(msgs);

    const system = buildSystem(store, job);
    let resp;
    try {
      resp = await callAI({ ai: store.ai, model: modelFor(store, "agent"), system, messages: msgs, tools: TOOLS, max_tokens: 8000, kind: "agent", run_id: job.run_id, signal: run.signal });
    } catch (e) {
      // Pause or Take over cut the call off. The stored messages and pending results are still the ones
      // from before this turn, so Resume picks up from there, and the student's status stands.
      if (run.signal.aborted || !owns(await getJob(id), gen)) return;
      // Sign-in, allowance, rate or pause: hand the job to the student instead of failing it; Resume retries this step.
      if (!NEEDS_YOU_CODES.has(e && e.code)) throw e;
      msgs.pop();
      // was: await updateJob(id, { status: "needs_you", reason: e.message, pending: prevPending, activity: "", needs_auth: e.code === "auth" });
      // `upgrade` (a used-up allowance with a bigger plan on offer) puts an Upgrade button on the job card.
      await own({ status: "needs_you", reason: e.message, pending: prevPending, activity: "", needs_auth: e.code === "auth",
        upgrade: e.code === "cap" && e.offer ? e.offer : null });
      await saveMsgs(id, msgs);
      return;
    }
    // Only when a developer has turned recording on (evalrec.js); the step as the model saw it.
    await recordStep({ at: new Date().toISOString(), host: hostOf(url), company: job.company, title: job.title,
      model: modelFor(store, "agent"), system, messages: msgs, response: resp.content, usage: resp.usage || null });
    // A reply that arrives after Pause or Take over is dropped unread: nothing it asks for is done, and
    // the turn stays out of the history, as if the call had been cut off. What it cost still counts.
    if (!owns(await getJob(id), gen)) {
      if (resp.cost_usd) await updateJob(id, (j) => ({ cost_usd: (j.cost_usd || 0) + resp.cost_usd }));
      return;
    }
    msgs.push({ role: "assistant", content: resp.content });
    steps++;

    const uses = resp.content.filter((b) => b.type === "tool_use");
    const say = resp.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    await updateJob(id, (j) => ({ cost_usd: (j.cost_usd || 0) + (resp.cost_usd || 0),
      ...(owns(j, gen) ? { steps, activity: (say || uses.map((u) => u.name).join(", ")).slice(0, 160) } : {}) }));

    if (!uses.length) {
      pending = { results: [], note: resp.stop_reason === "max_tokens"
        ? "Your reply was cut off. Use fewer, shorter tool calls per turn."
        : "Continue using the tools. If only the final submit remains, call ready_to_submit." };
      await updateJob(id, { pending });
      await saveMsgs(id, msgs);
      continue;
    }

    const results = [];
    let stop = null, stopped = false;
    for (const u of uses) {
      if (stop) { results.push(toolResult(u.id, "Not run: the job paused.")); continue; }
      // Checked before every action, not once per turn: the student can press Pause or Take over while
      // this reply is being carried out, and from then on the page is theirs.
      if (!stopped && !owns(await getJob(id), gen)) stopped = true;
      if (stopped) { results.push(toolResult(u.id, "Not run: the student paused the job or took over the tab.")); continue; }
      if (tabId !== snap.tabId) { results.push(toolResult(u.id, "Not run: the application opened in a new tab. Continue from the new snapshot.")); continue; }
      const r = await execTool(u, { tabId, index: snap.index, hasFinal: snap.hasFinal, reviewStep: snap.reviewStep, consentOnly: snap.consentOnly, runFilled, store, job, fails, url, active, gen });
      if (["fill", "select", "check", "upload"].includes(u.name) && !r.isError && !accountPage) await noteFilled();
      if (r.newTab) {
        tabId = r.newTab;
        await groupTab(tabId);
        await updateJob(id, { tabId });
        await appendLog(job.id, { kind: "nav", text: "The site opened the application in a new tab; following it." });
      }
      if (r.stop) {
        stop = { ...r, id: u.id };
        if (r.content != null) results.push(toolResult(u.id, r.content));
        continue;
      }
      results.push(toolResult(u.id, r.content, r.isError));
    }

    if (!stop) {
      pending = { results };
      await updateJob(id, { pending });
      await saveMsgs(id, msgs);
      if (stopped) return;   // the student has the tab; Resume sends these results with a fresh snapshot
      continue;
    }

    await saveMsgs(id, msgs);
    // pending is written either way, since the history just saved ends with this turn; the status only
    // while this run still owns the job.
    if (stop.kind === "ready") {
      const hl = owns(await getJob(id), gen) ? (await inFrames(tabId, (o) => window.ISDom && window.ISDom.highlight(o), [{ runFilled, gen }])).map((r) => r.result) : [];
      const missing = hl.reduce((n, h) => n + ((h && h.missing) || 0), 0);
      const dc = [...(stop.double_check || [])];
      if (missing) dc.unshift(`${missing} required field(s) look empty (amber outline).`);
      await updateJob(id, (j) => (owns(j, gen) ? { status: "ready_to_submit", summary: stop.summary || "", double_check: dc, activity: "", pending: { results } } : { pending: { results } }));
      return;
    }
    const waitPending = { results, waitId: stop.id }; // tool_result for the waiting tool is added on resume
    const asked = stop.kind === "ask"
      ? { status: "needs_you", question: stop.question, reason: stop.why || "The agent needs an answer.", activity: "" }
      : { status: "needs_you", reason: stop.reason, question: "", activity: "" };
    await updateJob(id, (j) => (owns(j, gen) ? { ...asked, pending: waitPending } : { pending: waitPending }));
    return;
  }
}

// Names no button that could be the final one: only the ways to a next page.
export const EARLY_READY_PUSHBACK = "No blocked final button is visible yet, so there may be more pages. If there is a Next, Continue or Save and Continue button, use it and keep filling. If this page only shows your answers for review, or nothing is left but the final button, call ready_to_submit again.";

async function execTool(u, ctx) {
  const { name, input = {} } = u;
  const { tabId, index, store, job, fails } = ctx;
  // gen goes with every action, so the page refuses one from a run the student has stopped (dom.js halt).
  const checkedAct = async (tab, ref, action, payload = {}) => {
    if (ctx.active && !(await ctx.active())) return { ok: false, cancelled: true, error: "The student stopped this run." };
    return act(tab, ref, action, ctx.gen == null ? payload : { ...payload, gen: ctx.gen });
  };
  const needsRef = ["fill", "select", "check", "upload", "click", "fill_secret"].includes(name);
  const t = needsRef ? index[input.ref] : null;
  if (needsRef && !t) return { content: `Unknown ref ${input.ref}. Use refs from the latest snapshot.`, isError: true };
  if (needsRef && (fails[input.ref] || 0) >= MAX_FIELD_FAILS) return { content: "This field already failed 3 times. Skip it, or pause_for_user if it is required.", isError: true };

  let r;
  switch (name) {
    case "fill":
      r = await checkedAct(tabId, input.ref, "fill", { text: String(input.text ?? "") });
      if (r.ok) await logAnswer(job, t.label, input.text, t.kind);
      break;
    case "select":
      r = await checkedAct(tabId, input.ref, "select", { option: String(input.option ?? "") });
      if (r.ok) await logAnswer(job, t.label, r.chosen || input.option, t.kind);
      break;
    case "check":
      r = await checkedAct(tabId, input.ref, "check", { checked: !!input.checked });
      break;
    case "upload": {
      // Was: ... && job.tailored.file; the bytes now live off the job (see queue.js).
      const tailored = input.file === "resume" && job.tailored && job.tailored.status === "approved" && job.tailored.file && await getTailoredFile(job.id);
      const file = tailored || store.files[input.file];
      if (!file || !file.b64) return { content: `No ${input.file} file saved. Skip unless required; if required, ask_user.`, isError: true };
      r = await checkedAct(tabId, input.ref, "upload", { file: { name: file.name, type: file.type, b64: file.b64 } });
      break;
    }
    case "fill_secret": {
      const tab = await chrome.tabs.get(tabId);
      let acct;
      // Reserve one password under the shared lock before two applications on the same
      // employer can choose different passwords. Reservation is pending, not a signup claim.
      const fresh = await updateStore(async s => {
        if (ctx.active && !(await ctx.active())) return s;
        acct = accountFor(s, secretUrl(t, tab.url, ctx.url));
        if (acct.isNew && !s.accounts.some(a => a.domain === acct.domain)) {
          const { isNew, ...saved } = acct;
          s.accounts.push({ ...saved, state: "pending" });
        }
      });
      if (!acct) return { content: "The student stopped this run.", isError: true };
      store.accounts = fresh.accounts;
      r = await checkedAct(tabId, input.ref, "fill", { text: acct.password, secret: true });
      if (r.ok && acct.isNew) {
        await appendLog(job.id, { kind: "account", text: `Password saved for ${acct.domain}; sign-up is not yet confirmed.` });
      }
      delete r.value;
      break;
    }
    case "click": {
      // "Apply" links often carry target=_blank (Oracle, company career pages, iCIMS portals). The agent
      // would keep reading the old tab forever, so notice a tab this click opened and move to it.
      const opened = [];
      const onNew = (t) => { if (t.openerTabId === tabId) opened.push(t.id); };
      chrome.tabs.onCreated.addListener(onNew);
      const before = await pageMark(tabId);
      try {
        r = await checkedAct(tabId, input.ref, "click", { runFilled: !!ctx.runFilled });
        if (r.ok) { await sleep(1500); await waitForTab(tabId).catch(() => {}); }
      } finally {
        chrome.tabs.onCreated.removeListener(onNew);
      }
      if (r.blocked) return { content: `${r.error}. Do not click it. If everything else is complete, call ready_to_submit; otherwise keep filling fields.`, isError: true };
      const newTab = opened.length && (await chrome.tabs.get(opened[opened.length - 1]).catch(() => null));
      if (r.ok && newTab) return { content: { ...r, note: "Opened a new tab; the next snapshot is from that tab." }, newTab: newTab.id };
      // A click that reports success and changes nothing is the quietest way an application stalls:
      // the script that would have answered it had not loaded yet. Nothing in the next snapshot says
      // it is the same page as the last one, so say it here, while it is still one button's fault.
      if (r.ok && noChange(before, await pageMark(tabId))) {
        return { content: { ...r, note: "The page looks the same as before the click; the button may not have been wired up yet. Wait a few seconds and click it once more before trying something else." } };
      }
      break;
    }
    case "wait":
      await sleep(Math.min(10, Math.max(1, Number(input.seconds) || 2)) * 1000);
      return { content: "Waited." };
    case "ask_user":
      return { stop: true, kind: "ask", question: input.question, why: input.why };
    case "pause_for_user":
      return { stop: true, kind: "pause", reason: input.reason };
    case "ready_to_submit":
      // A page held back only by an Accept or I agree is not a finished application: the student reads
      // it and agrees themselves, then Resume carries on. Checked first, so neither the pushback below
      // nor a second call can turn it into "Ready to submit".
      if (ctx.consentOnly) return { stop: true, kind: "pause", reason: CONSENT_HELP };
      // Guard against stopping early: with no blocked final button in view, push back once. Not on a
      // page that says it is the review step, where stopping is exactly right.
      // was: "...Click Apply / Next / Save and Continue to reach the last page...". On a read-only review
      // step whose final button said Apply, that sent the model to press it.
      if (!ctx.hasFinal && !ctx.reviewStep && !fails.__earlyReady) {
        fails.__earlyReady = 1;
        return { content: EARLY_READY_PUSHBACK, isError: true };
      }
      return { stop: true, kind: "ready", summary: input.summary, double_check: input.double_check, content: "Marked ready. The human will review and submit." };
    default:
      return { content: `Unknown tool ${name}`, isError: true };
  }
  if (!r.ok) fails[input.ref] = (fails[input.ref] || 0) + 1;
  return { content: r, isError: !r.ok };
}

async function logAnswer(job, label, answer, kind) {
  const a = String(answer || "");
  if (!label || (!["textarea", "rich_text"].includes(kind) && a.length < 60 && !/\?/.test(label))) return;
  await appendLog(job.id, { kind: "answer", question: label, answer: a });
  await updateStore((s) => {
    s.answers = [...(s.answers || []), { jobId: job.id, company: job.company, title: job.title, question: label, answer: a, at: Date.now() }].slice(-500);
  });
}

// Resume after ask_user / pause_for_user / manual pause.
export async function resumeJob(id, answer) {
  const job = await getJob(id);
  if (!job) return;
  let pending = job.pending || { results: [] };
  if (pending.waitId) {
    const text = answer ? `The human answered: ${answer}` : "The human handled it. Continue from the new snapshot.";
    pending = { results: [...(pending.results || []), toolResult(pending.waitId, text)] };
    if (answer && job.question) await updateStore((s) => { s.profile.extra[job.question] = answer; });
  } else if (job.status === "ready_to_submit") {
    pending = { results: pending.results || [], note: "The human asked you to keep going: re-check the page for anything unfilled or wrong, then call ready_to_submit again." };
  }
  // gen: a run still winding down from before the pause must not carry on as this one (agent.js owns).
  await updateJob(id, (j) => ({ status: "queued", pending, question: "", reason: "", steps: 0, gen: (j.gen || 0) + 1 }));
}

export async function checkSubmitted(tabId) {
  const res = await inFrames(tabId, () => {
    const t = (document.body && document.body.innerText) || "";
    return /thank(s| you)[^.\n]{0,60}(appl|submi|interest)|application (has been |was )?(successfully )?(submitted|received|complete)|we('ve| have) received your application|successfully (applied|submitted)|you('ve| have) (successfully )?applied/i.test(t);
  });
  return res.some((r) => r.result === true);
}

export { domainOf };
