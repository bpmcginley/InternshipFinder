// Service worker entry: message router, scheduler (max N tabs), notifications, submit detection.
import { addJobs, getQueue, getJob, updateJob, removeJob, publicQueue, publicJob, onQueueChange, jobForTab, saveMsgs, getTailoredFile } from "./queue.js";
import { runJob, resumeJob, isRunning, checkSubmitted, BACKGROUND_TAB_HELP } from "./agent.js";
import { loadStore, updateStore, hasKey, isWorker } from "../lib/store.js";
import { getToken, authStatus, signIn, signOut, ensureToken, getMe, deleteServerData } from "../lib/auth.js";
import { spend } from "../lib/usage.js";

const ONBOARDING = "onboarding/onboarding.html";
const PANEL = "sidepanel/sidepanel.html";
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
      for (const id of q.order) {
        if (active >= max) break;
        const j = q.jobs[id];
        if (j && j.status === "queued") {
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
async function openDeepDive() {
  const url = chrome.runtime.getURL(ONBOARDING);
  const [t] = await chrome.tabs.query({ url: url + "*" });
  if (t) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
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
async function control(id, action, answer) {
  const j = await getJob(id);
  if (!j) return { error: "No such job" };
  switch (action) {
    case "pause":
      await updateJob(id, { status: "needs_you", reason: "Paused. Press Resume to continue.", activity: "" });
      break;
    case "takeover":
      await updateJob(id, { status: "needs_you", reason: "You took over. Press Resume to hand it back.", activity: "" });
      await focusJob(j);
      break;
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
      await updateJob(id, { status: "queued", pending: null, steps: 0, reason: "", question: "", summary: "", double_check: [], run_id: null });
      schedule();
      break;
    case "approve_tailored":
    case "skip_tailored":
      if (!j.tailored || j.tailored.status !== "pending") return { error: "Nothing to review" };
      await updateJob(id, (x) => ({ tailored: { ...x.tailored, status: action === "approve_tailored" ? "approved" : "skipped" } }));
      await resumeJob(id);
      schedule();
      break;
    case "focus":
      await focusJob(j);
      break;
    case "submitted":
      await updateJob(id, { status: "submitted", activity: "", submitted_at: Date.now() });
      break;
    case "remove":
      if (j.status === "working") await updateJob(id, { status: "failed", reason: "Removed" });
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
const PAGE_ALLOWED = new Set(["ping", "enqueue", "get_queue", "control", "open_deep_dive", "open_panel", "get_profile_summary",
  "profile:set", "profile:get", "auth:token"]);

async function handle(m, sender, fromPage) {
  if (!m || typeof m !== "object") return { error: "bad message" };
  if (fromPage && !PAGE_ALLOWED.has(m.type)) return { error: "not allowed" };
  switch (m.type) {
    case "ping": {
      const s = await loadStore();
      return { ok: true, version: chrome.runtime.getManifest().version, onboarded: !!s.settings.onboarded, hasKey: !!hasKey(s), spend: await spend(),
        provider: s.ai.provider, signed_in: isWorker(s.ai) ? !!(await getToken()) : null };
    }
    case "enqueue": {
      const s = await loadStore();
      if (!s.settings.onboarded || !hasKey(s)) { await openDeepDive(); return { error: "setup_required" }; }
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
      const s = await loadStore(), p = s.profile, edu = p.education[0] || {};
      const text = [
        [...p.skills.technical, ...p.skills.tools, ...p.skills.soft].join(", "),
        ...p.experience.map((e) => [e.title, ...(e.bullets || [])].join(". ")),
        ...p.projects.map((x) => [x.name, x.description].join(". ")),
        ...p.education.map((e) => [e.major, e.minor, e.coursework].join(". ")),
        (s.files.resume && s.files.resume.text) || "",
      ].join("\n");
      const year = String(edu.end || edu.grad_term || "").match(/20\d\d/);
      return { skills_text: text.slice(0, 30000), grad_year: year ? +year[0] : null, gpa: parseFloat(edu.gpa) || null,
        citizenship: p.facts.citizenship || "", needs_sponsorship: /^y/i.test(p.facts.needs_sponsorship || ""), degree: edu.degree || "" };
    }
    case "profile:set": {
      const p = cleanProfile(m.profile);
      if (!p) return { error: "bad profile" };
      await updateStore((s) => {
        s.dashboard_profile = p;
        Object.assign(s.profile.facts, { majors: p.majors.join(", "), class_year: p.class_year, grad_term: p.grad_term });
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
      return { token: await getToken() };
    case "auth:signin":
      // Runs here, not in the popup: the popup closes when the sign-in window takes focus.
      // No provider given (the side panel's "Sign in & resume"): signIn reuses the last one, else Google.
      await signIn({ interactive: true, provider: ["google", "microsoft"].includes(m.provider) ? m.provider : undefined });
      return authStatus();
    case "auth:signout":
      await signOut();
      return { ok: true };
    case "auth:delete": {
      // DELETE /me on the Worker, then sign out. A refusal (a live subscription) is passed back as it is.
      const r = await deleteServerData();
      if (r.ok) await signOut();
      return r;
    }
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
    case "open_deep_dive":
      await openDeepDive();
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
      if (prev && (j.status === "needs_you" || j.status === "ready_to_submit")) notify(j);
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
  if (reason === "install" || !s.settings.onboarded) openDeepDive();
});

// Service worker (re)start: jobs marked working lost their loop; requeue them.
(async () => {
  const q = await getQueue();
  for (const j of Object.values(q.jobs)) {
    lastStatus.set(j.id, j.status);
    if (j.status === "working" && !isRunning(j.id)) await updateJob(j.id, { status: "queued" });
  }
  schedule();
})();
