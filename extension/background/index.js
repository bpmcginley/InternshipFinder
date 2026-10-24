// Service worker entry: message router, scheduler (max N tabs), notifications, submit detection.
import { addJobs, getQueue, getJob, updateJob, removeJob, publicQueue, publicJob, onQueueChange, jobForTab, saveMsgs, getTailoredFile, tailorWaiting, setBatchTailor, studentBusyOn } from "./queue.js";
import { holdJobs, heldJobs, heldSummary, takeHeld, clearHeld, wantedJob } from "./held.js";
import { connectOpenTabs } from "./install.js";
import { runJob, resumeJob, isRunning, stopJob, takeBack, checkSubmitted, BACKGROUND_TAB_HELP } from "./agent.js";
import { loadStore, updateStore, hasKey, isWorker, confirmedFacts, resumeReviewPending, DASHBOARD_FACTS } from "../lib/store.js";
import { getToken, authStatus, authBridge, trustedDashboard, signIn, signOut, ensureToken, getMe, deleteServerData, holdOffer, offerWaiting, acceptOffer } from "../lib/auth.js";
import { syncNow, noteEdit, flushPending, isLocalEdit, setCloudSync, forgetSynced, deleteSyncedAccount } from "../lib/sync.js";
import { spend } from "../lib/usage.js";
import { ISEval } from "./evalrec.js";
import { noteFilled, answerReview, loadReview, webLineOk, FILLED, FEEDBACK_URL } from "../lib/review.js";

// For the model comparison in scripts/eval, from this service worker's console only (evalrec.js).
self.ISEval = ISEval;

const ONBOARDING = "onboarding/onboarding.html";
const PANEL = "sidepanel/sidepanel.html";
// The feedback form the dashboard already points students at (docs/index.html window.CONFIG.formUrl).
// was: const FEEDBACK_FORM = "https://docs.google.com/forms/d/e/1FAIpQLSevENYXxAtJg-suzwhBTwi8a2bosYHV27NcveE7eCYXo5Jdjw/viewform";
// The same address now lives in lib/review.js, whose review card links it beside "Leave a review".
const FEEDBACK_FORM = FEEDBACK_URL;
const ports = new Set();
const lastStatus = new Map();

// ---------- scheduler ----------
let scheduling = false, again = false;
async function schedule() {
  if (scheduling) { again = true; return; }
  scheduling = true;
  try {
    do {
      again = false;
      const q = await getQueue();
      const s = await loadStore();
      const max = Math.max(1, Math.min(4, s.settings.max_tabs || 2));
      let active = Object.values(q.jobs).filter((j) => j.status === "working" && isRunning(j.id)).length;
      // U7: no new tab takes the screen while the student is answering or reviewing a job in the tab in
      // front. The queue goes on when they leave that tab or that job moves on (listeners below).
      if (active < max && q.order.some((id) => q.jobs[id] && q.jobs[id].status === "queued")) {
        const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        if (front && studentBusyOn(q, front.id)) break;
      }
      for (const id of q.order) {
        if (active >= max) break;
        const j = q.jobs[id];
        // U5: another job queued with this one is waiting on the tailored-resume question.
        if (j && j.status === "queued" && !tailorWaiting(q, j)) {
          active++;
          await updateJob(id, { status: "working" });
          runJob(id).finally(() => schedule());
        }
      }
    } while (again);
  } finally {
    scheduling = false;
  }
}

// ---------- helpers ----------
// `step`: open on that Deep Dive step (the side panel's "Open Quick facts"). An open Deep Dive tab is only
// brought forward, so nothing half-typed there is lost.
const DEEP_DIVE_STEPS = ["facts"];
async function openDeepDive(step) {
  const url = chrome.runtime.getURL(ONBOARDING);
  const [t] = await chrome.tabs.query({ url: url + "*" });
  if (t) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
  else await chrome.tabs.create({ url: DEEP_DIVE_STEPS.includes(step) ? `${url}?step=${step}` : url });
}

async function openPanel(sender) {
  try {
    const windowId = (sender && sender.tab && sender.tab.windowId) || (await chrome.windows.getLastFocused()).id;
    await chrome.sidePanel.open({ windowId });
    return { ok: true };
  } catch (e) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL) });
    return { ok: true, tab: true };
  }
}

async function focusJob(j) {
  if (j.tabId) {
    const t = await chrome.tabs.update(j.tabId, { active: true }).catch(() => null);
    if (t) { await chrome.windows.update(t.windowId, { focused: true }); return; }
  }
  const t = await chrome.tabs.create({ url: j.apply_url });
  await updateJob(j.id, { tabId: t.id });
}

function notify(j) {
  const ready = j.status === "ready_to_submit";
  chrome.notifications.create(j.id, {
    type: "basic", iconUrl: "icons/icon128.png",
    title: `${ready ? "Ready to submit" : "Needs you"}: ${j.company}`,
    message: (j.question || j.reason || j.summary || j.title || "").slice(0, 200),
  }, () => void chrome.runtime.lastError);
}

function watchSubmit(id, tabId) {
  for (const ms of [2500, 6000, 12000, 25000]) {
    setTimeout(async () => {
      const j = await getJob(id);
      if (!j || j.status !== "ready_to_submit") return;
      if (await checkSubmitted(tabId)) await updateJob(id, { status: "submitted", activity: "", submitted_at: Date.now() });
    }, ms);
  }
}

// ---------- control actions ----------
const TAKEOVER_FOCUS_MS = 1500;
async function control(id, action, answer) {
  // Stop locally before any storage await lets a pending response or prefill resume.
  if (["pause", "takeover", "retry", "submitted", "remove"].includes(action)) stopJob(id);
  const j = await getJob(id);
  if (!j) return { error: "No such job" };
  switch (action) {
    case "pause":
      await takeBack(id, { status: "needs_you", reason: "Paused. Press Resume to continue.", activity: "" });
      break;
    case "takeover": {
      // The tab comes forward once the page has stopped, or after TAKEOVER_FOCUS_MS, whichever is first:
      // a busy Workday page can leave the halt unanswered for up to toPage's 30 s, and the button looked
      // dead all that time. The job is already stopped (stopJob above), and the halt still reaches the
      // page. A job without a tab has nothing to halt, so its takeBack is done before focusJob opens one.
      // was: await takeBack(...); await focusJob(j); (2026-10-14 review)
      const halting = takeBack(id, { status: "needs_you", reason: "You took over. Press Resume to hand it back.", activity: "" });
      await Promise.race([halting, new Promise((r) => setTimeout(r, TAKEOVER_FOCUS_MS))]);
      await focusJob(j);
      await halting;
      break;
    }
    case "resume":
    case "answer":
      if (isRunning(id) && j.status === "working") break;
      await resumeJob(id, answer);
      schedule();
      break;
    case "retry":
      await saveMsgs(id, []);
      // Start from a clean page: reload the tab so no half-filled form or stale page script carries over.
      if (j.tabId) await chrome.tabs.update(j.tabId, { url: j.apply_url }).catch(() => {});
      // run_filled: a new run has filled nothing yet (guard.js runFilled).
      await takeBack(id, { status: "queued", pending: null, steps: 0, reason: "", question: "", summary: "", double_check: [], run_id: null, run_filled: false });
      schedule();
      break;
    case "approve_tailored":
    case "skip_tailored":
      if (!j.tailored || j.tailored.status !== "pending") return { error: "Nothing to review" };
      await updateJob(id, (x) => ({ tailored: { ...x.tailored, status: action === "approve_tailored" ? "approved" : "skipped" } }));
      await resumeJob(id);
      schedule();
      break;
    // U5: the same answer for every job queued with this one (queue.js setBatchTailor). Jobs of the batch
    // already waiting on their own tailored resume get it now; the rest use it when they get there.
    case "approve_tailored_all":
    case "skip_tailored_all": {
      if (!j.tailored || j.tailored.status !== "pending") return { error: "Nothing to review" };
      const choice = action === "approve_tailored_all" ? "approved" : "skipped";
      const waiting = j.batch ? await setBatchTailor(j.batch, choice) : [];
      for (const w of waiting.includes(id) ? waiting : [id, ...waiting]) {
        const x = await getJob(w);
        if (!x || !x.tailored || x.tailored.status !== "pending") continue;
        await updateJob(w, (y) => ({ tailored: { ...y.tailored, status: choice } }));
        await resumeJob(w);
      }
      schedule();
      break;
    }
    case "focus":
      await focusJob(j);
      break;
    case "submitted":
      await takeBack(id, { status: "submitted", activity: "", submitted_at: Date.now() });
      break;
    case "remove":
      if (j.status === "working") await updateJob(id, { status: "failed", reason: "Removed" });
      stopJob(id);   // was: the run kept filling and clicking in the tab after its job was gone
      await removeJob(id);
      break;
    default:
      return { error: "Unknown action" };
  }
  return { ok: true };
}

// ---------- dashboard profile (worker/API.md → bridge) ----------
const str = (v, n = 80) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, n) : "");
const strs = (v, max, n = 80) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((x) => str(x, n)).filter(Boolean).slice(0, max);
function cleanProfile(p) {
  if (!p || typeof p !== "object") return null;
  return { majors: strs(p.majors, 10), minors: strs(p.minors, 10), class_year: str(p.class_year, 40), grad_term: str(p.grad_term, 40),
    stages: strs(p.stages, 20, 40), terms: strs(p.terms, 20, 40), states: strs(p.states, 60, 10), work_auth: str(p.work_auth, 60) };
}

// ---------- router ----------
// auth:offer (U8): the dashboard offers its own sign-in; see lib/auth.js holdOffer for why that is safe.
// held:* and auth:accept_offer are for the extension's own pages only.
const PAGE_ALLOWED = new Set(["ping", "enqueue", "get_queue", "control", "open_deep_dive", "open_panel", "get_profile_summary",
  "profile:set", "profile:get", "auth:token", "auth:offer", "review_ask"]);

async function handle(m, sender, fromPage) {
  if (!m || typeof m !== "object") return { error: "bad message" };
  if (fromPage && !PAGE_ALLOWED.has(m.type)) return { error: "not allowed" };
  switch (m.type) {
    case "ping": {
      const s = await loadStore();
      return { ok: true, version: chrome.runtime.getManifest().version, onboarded: !!s.settings.onboarded, hasKey: !!hasKey(s), spend: await spend(),
        provider: s.ai.provider, signed_in: isWorker(s.ai) ? !!(await getToken()) : null,
        // Whether the dashboard may show its one-line review suggestion (lib/review.js webLineOk): only
        // true or false, so a "Don't ask again" here quiets the dashboard too. Stays in this browser.
        review_line: webLineOk(await loadReview()) };
    }
    case "enqueue": {
      const s = await loadStore();
      // A replaced resume waiting to be reviewed pauses Auto-Apply too (agent.js checks again when a job runs).
      // U2: the postings picked before setup are kept (held.js), and the setup page offers them once
      // setup is done. was: { error: "setup_required" } alone, and the jobs were dropped.
      if (!s.settings.onboarded || !hasKey(s) || resumeReviewPending(s)) {
        const held = await holdJobs(Array.isArray(m.jobs) ? m.jobs.slice(0, 100) : [], "dashboard").catch(() => 0);
        await openDeepDive();
        return { error: "setup_required", held };
      }
      let jobs = Array.isArray(m.jobs) ? m.jobs.slice(0, 100) : [];
      if (fromPage) jobs = jobs.map(({ tabId, ...j }) => j); // web pages may not point the agent at an existing tab
      const r = await addJobs(jobs);
      schedule();
      return r;
    }
    case "get_queue":
      return { queue: publicQueue(await getQueue()) };
    case "get_profile_summary": {
      // Only what the dashboard needs to say "you have this skill" / "you may not be eligible".
      const s = await loadStore(), p = s.profile, edu = p.education[0] || {}, f = confirmedFacts(s);
      const text = [
        [...p.skills.technical, ...p.skills.tools, ...p.skills.soft].join(", "),
        ...p.experience.map((e) => [e.title, ...(e.bullets || [])].join(". ")),
        ...p.projects.map((x) => [x.name, x.description].join(". ")),
        ...p.education.map((e) => [e.major, e.minor, e.coursework].join(". ")),
        (s.files.resume && s.files.resume.text) || "",
      ].join("\n");
      const year = String(edu.end || edu.grad_term || "").match(/20\d\d/);
      return { skills_text: text.slice(0, 30000), grad_year: year ? +year[0] : null, gpa: parseFloat(edu.gpa) || null,
        // Confirmed answers only, as on application forms. was: p.facts, interview suggestions included.
        citizenship: f.citizenship || "", needs_sponsorship: /^y/i.test(f.needs_sponsorship || ""), degree: edu.degree || "" };
    }
    case "profile:set": {
      const p = cleanProfile(m.profile);
      if (!p) return { error: "bad profile" };
      await updateStore((s) => {
        s.dashboard_profile = p;
        Object.assign(s.profile.facts, { majors: p.majors.join(", "), class_year: p.class_year, grad_term: p.grad_term });
        // The student picked these on the dashboard, so they count as confirmed (store.js factConfirmed).
        s.profile.sources ||= { facts: {}, sections: {} };
        s.profile.sources.facts ||= {};
        for (const k of DASHBOARD_FACTS) s.profile.sources.facts[k] = { source: "dashboard", value: s.profile.facts[k] };
      });
      return { ok: true };
    }
    case "profile:get": {
      const s = await loadStore(), f = s.profile.facts, d = s.dashboard_profile;
      if (!d && !f.majors && !f.class_year && !f.grad_term) return { profile: null };
      // Facts may have been edited in the Deep Dive since the dashboard sent them; facts win.
      const majors = d && d.majors.join(", ") === f.majors ? d.majors : String(f.majors || "").split(/\s*,\s*/).filter(Boolean);
      return { profile: { ...(d || {}), majors, class_year: f.class_year, grad_term: f.grad_term } };
    }
    case "auth:token":
      // was: { token: await getToken() }. A session also says whose it is and until when (lib/auth.js bridgeReply).
      // A session lasts a year, where the ID token this used to hand out lasted an hour, so only the
      // real dashboard gets it: internscout.org, or a local copy of the site on an unpacked (developer)
      // build. The bridge also runs on localhost for development, and any local page could ask there.
      if (fromPage && !trustedDashboard(sender, !chrome.runtime.getManifest().update_url)) return { token: null };
      return authBridge();
    case "auth:offer":
      // Only the real dashboard (Chrome says which page sent it; the page can't), and never from a content
      // script or extension page, which have their own sign-in. Answers only true or false.
      if (!fromPage || !trustedDashboard(sender, !chrome.runtime.getManifest().update_url)) return { ok: false };
      return { ok: await holdOffer(typeof m.token === "string" ? m.token : "").catch(() => false) };
    case "auth:offer_status":
      return { waiting: await offerWaiting() };
    case "auth:accept_offer": {
      // The student pressed "Use my dashboard sign-in" on an extension page.
      const r = await acceptOffer();
      if (r.error) return r;
      const sync = await syncNow().catch(() => null);
      return { ...(await authStatus()), restored: !!(sync && sync.state === "restored") };
    }
    // U2: what was picked before setup (held.js). Only the student's press on the setup page starts them.
    case "held:get":
      return { jobs: heldSummary(await heldJobs()) };
    case "held:start": {
      const s = await loadStore();
      if (!s.settings.onboarded || !hasKey(s) || resumeReviewPending(s)) return { error: "setup_required" };
      const r = await addJobs(await takeHeld());
      schedule();
      return r;
    }
    case "held:clear":
      await clearHeld();
      return { ok: true };
    case "auth:signin": {
      // Runs here, not in the popup: the popup closes when the sign-in window takes focus.
      // No provider given (the side panel's "Sign in & resume"): signIn reuses the last one, else Google.
      await signIn({ interactive: true, provider: ["google", "microsoft"].includes(m.provider) ? m.provider : undefined });
      // Then fetch the Deep Dive saved to the account, so a new device skips straight past it.
      const sync = await syncNow().catch(() => null);
      return { ...(await authStatus()), restored: !!(sync && sync.state === "restored") };
    }
    case "auth:signout":
      // 2026-10-23: invalidate pending profile replies before sign-out's network wait (EXT-2).
      // was: signOut then forgetSynced. Revert: restore that order.
      await forgetSynced({ finish: signOut });
      return { ok: true };
    case "auth:delete": {
      // DELETE /me on the Worker (which also deletes the saved Deep Dive and every sign-in), then sign out.
      // Saving to the account is switched off too, so signing in again doesn't quietly upload it all again.
      // A refusal (a live subscription) is passed back as it is.
      const r = await deleteSyncedAccount(deleteServerData);
      if (r.ok) await signOut();
      return r;
    }
    case "sync:set":
      // The Deep Dive's "Save my Deep Dive to my account" switch.
      return setCloudSync(!!m.on);
    case "auth:status":
      return authStatus();
    case "auth:me": {
      // Sign-in status plus this month's allowance. An expired token is refreshed silently, never with a window.
      const token = await ensureToken();
      return { ...(await authStatus()), me: token ? await getMe(token) : null };
    }
    case "control": {
      // Content scripts on job sites may only control the job running in their own tab.
      if (!fromPage && sender.tab && !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
        const j = await getJob(m.id);
        if (!j || j.tabId !== sender.tab.id) return { error: "not allowed" };
      }
      return control(m.id, m.action, m.answer);
    }
    case "get_tailored": {
      return { file: await getTailoredFile(m.id) };   // was: getJob(m.id).tailored.file, when the bytes sat on the job
    }
    // The review card's buttons and the "Leave a review" links (lib/review.js). The dashboard can say so
    // too, so a review left from there stops the card. Only "review", "never" and "later" do anything.
    case "review_ask":
      return { ok: true, state: await answerReview(String(m.action || "")) };
    case "open_deep_dive":
      await openDeepDive(m.step);
      return { ok: true };
    case "open_panel":
      return openPanel(sender);
    case "overlay_hello": {
      const j = sender.tab ? await jobForTab(sender.tab.id) : null;
      return { job: publicJob(j) };
    }
    case "maybe_submitted": {
      const j = sender.tab ? await jobForTab(sender.tab.id) : null;
      if (j && j.status === "ready_to_submit") watchSubmit(j.id, sender.tab.id);
      return { ok: true };
    }
    case "schedule":
      schedule();
      return { ok: true };
  }
  return { error: "unknown message" };
}

chrome.runtime.onMessage.addListener((m, sender, send) => {
  handle(m, sender, false).then(send, (e) => send({ error: e.message }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bridge") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (m) => {
    const result = await handle(m && m.msg, port.sender, true).catch((e) => ({ error: e.message }));
    try { port.postMessage({ reqId: m && m.reqId, result }); } catch (e) {}
  });
});

onQueueChange((q) => {
  const pub = publicQueue(q);
  for (const p of ports) try { p.postMessage({ push: "queue", queue: pub }); } catch (e) {}
  for (const j of Object.values(q.jobs)) {
    const prev = lastStatus.get(j.id);
    if (prev !== j.status) {
      lastStatus.set(j.id, j.status);
      // U7: a job the student was busy with moved on, so a job held back from taking the screen may start.
      if (prev === "needs_you" || prev === "ready_to_submit") schedule();
      if (prev && (j.status === "needs_you" || j.status === "ready_to_submit")) notify(j);
      // An application just finished filling: count it for the review card (lib/review.js). Only a real
      // change seen by this worker counts (prev is set), and each job counts once however often it does.
      if (prev && FILLED.has(j.status)) noteFilled(j.id, Object.values(q.jobs)).catch(() => {});
    }
    if (j.tabId) chrome.tabs.sendMessage(j.tabId, { type: "overlay", job: publicJob(j) }, { frameId: 0 }).catch(() => {});
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  const j = await getJob(id);
  if (j) focusJob(j);
});

chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId }) => {
  if (frameId !== 0) return;
  const j = await jobForTab(tabId);
  if (!j) return;
  if (j.status === "ready_to_submit") {
    if (await checkSubmitted(tabId)) await updateJob(j.id, { status: "submitted", activity: "", submitted_at: Date.now() });
  }
  if (j.status === "ready_to_submit" || j.status === "needs_you") {
    chrome.scripting.executeScript({ target: { tabId }, files: ["agent/guard.js", "agent/overlay.js"] }).catch(() => {});
  }
});

// A run paused only because its tab went to sleep in the background needs nothing from the student
// but the tab itself. Bringing it to the front is the answer, so resume then rather than making them
// also press Resume. The short wait lets the page draw a frame before the next snapshot.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  schedule();   // U7: the student left a job they were busy with, so a held-back job may start now
  const j = await jobForTab(tabId);
  // Matched on the opening sentence, current or earlier wording, so jobs paused before an update count too.
  const first = (r) => String(r || "").split(".")[0];
  const asleep = (r) => [BACKGROUND_TAB_HELP, "Chrome puts a tab you've switched away from to sleep, and this page stopped drawing."].some((h) => first(h) === first(r));
  if (!j || j.status !== "needs_you" || !asleep(j.reason)) return;
  setTimeout(() => control(j.id, "resume"), 800);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const j = await jobForTab(tabId);
  if (j && j.status !== "working") await updateJob(j.id, { tabId: null });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const s = await loadStore(); // also migrates v0.1 storage
  // U1: the internscout.org tabs open now get the bridge, so the dashboard sees the extension without a
  // reload; U2: and the posting the offer bar remembered there is kept for after setup. On install only:
  // after an update the old bridge in those tabs still answers ("reload the page"), and a second one
  // would race it.
  if (reason === "install") {
    connectOpenTabs().then(({ wanted }) => {
      const jobs = wanted.map((w) => wantedJob(w)).filter(Boolean);
      if (jobs.length) return holdJobs(jobs, "offer");
    }).catch(() => {});
  }
  if (reason === "install" || !s.settings.onboarded) openDeepDive();
  syncNow().catch(() => {});   // an update: fetch or send the Deep Dive saved to the account (lib/sync.js)
});

// Browser startup: the account may hold a Deep Dive edited on another device since this one last ran.
chrome.runtime.onStartup.addListener(() => { syncNow().catch(() => {}); });

// An edit to the part of the store that is saved to the account (lib/sync.js): send it after a short pause.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.store && isLocalEdit(ch.store.oldValue, ch.store.newValue)) noteEdit().catch(() => {});
});

// An uninstall is the only thing a student does that the extension can never report: the profile is
// gone before any of our code runs again. Chrome will open one page on removal, so point it at the
// same feedback form the dashboard uses and read the answers in one place. Set on every worker start
// rather than in onInstalled alone, because anyone who installed before 0.4.2 never sees another
// install event and would carry no URL at all. It writes a string inside Chrome — no network, nothing
// to await. The guard is for old Chromium builds and for Firefox, which expose chrome.runtime but
// not setUninstallURL; calling a missing method here would throw on every worker start.
// was: "...guarded because the API is absent outside a real extension (tests, non-Chrome)" - not
// true of this file, which already calls chrome.tabs.onActivated unguarded 17 lines above.
if (chrome.runtime.setUninstallURL) chrome.runtime.setUninstallURL(FEEDBACK_FORM, () => void chrome.runtime.lastError);

// Service worker (re)start: jobs marked working lost their loop; requeue them.
(async () => {
  const q = await getQueue();
  for (const j of Object.values(q.jobs)) {
    lastStatus.set(j.id, j.status);
    if (j.status === "working" && !isRunning(j.id)) await updateJob(j.id, { status: "queued" });
  }
  schedule();
  // An edit noted just before Chrome stopped the worker last time is sent now.
  flushPending().catch(() => {});
})();
