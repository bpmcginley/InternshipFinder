// Service worker entry: message router, scheduler (max N tabs), notifications, submit detection.
import { addJobs, getQueue, getJob, updateJob, removeJob, publicQueue, publicJob, onQueueChange, jobForTab, saveMsgs } from "./queue.js";
import { runJob, resumeJob, isRunning, checkSubmitted } from "./agent.js";
import { loadStore, hasKey } from "../lib/store.js";

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
      await updateJob(id, { status: "queued", pending: null, steps: 0, reason: "", question: "", summary: "", double_check: [] });
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

// ---------- router ----------
const PAGE_ALLOWED = new Set(["ping", "enqueue", "get_queue", "control", "open_deep_dive", "open_panel"]);

async function handle(m, sender, fromPage) {
  if (!m || typeof m !== "object") return { error: "bad message" };
  if (fromPage && !PAGE_ALLOWED.has(m.type)) return { error: "not allowed" };
  switch (m.type) {
    case "ping": {
      const s = await loadStore();
      return { ok: true, version: chrome.runtime.getManifest().version, onboarded: !!s.settings.onboarded, hasKey: !!hasKey(s) };
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
    case "control": {
      // Content scripts on job sites may only control the job running in their own tab.
      if (!fromPage && sender.tab && !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
        const j = await getJob(m.id);
        if (!j || j.tabId !== sender.tab.id) return { error: "not allowed" };
      }
      return control(m.id, m.action, m.answer);
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
