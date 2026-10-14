// Persisted job queue. Statuses: queued → working → needs_you → ready_to_submit → submitted | failed.
const KEY = "queue";
let lock = Promise.resolve();
const listeners = new Set();

function withLock(fn) {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
}
async function read() {
  return (await chrome.storage.local.get(KEY))[KEY] || { jobs: {}, order: [] };
}
// A tailored resume's bytes are kept under a key of their own, not on the job. They used to sit on
// the job as tailored.file.b64, up to a megabyte each, and every update - each log line, each
// "activity" change, several a second while a form fills - reads the whole queue and writes it back.
// With a few tailored jobs queued that was megabytes through chrome.storage per log line, which is
// what made the side panel lag. write() moves the bytes out the moment a patch puts them on a job
// (so callers still hand updateJob the whole file, and a queue saved by an older version is migrated
// on its first write), and getTailoredFile() is how anything that needs the bytes asks for them.
const BLOB = (id) => "tailored_" + id;
// was: write(q). `fresh` is the one job whose patch has just put a file on it (updateJob says which).
// Any other job still carrying bytes is one saved by an older version, and if the move fails for it
// the bytes stay where they already were: the review found that a failed migration write threw away
// a resume the student had already approved, and perhaps already uploaded.
async function write(q, fresh = null) {
  for (const j of Object.values(q.jobs)) {
    const f = j.tailored && j.tailored.file;
    if (!f || !f.b64) continue;
    const { b64, ...meta } = f;
    try {
      await chrome.storage.local.set({ [BLOB(j.id)]: b64 });
      j.tailored = { ...j.tailored, file: meta };
    } catch (e) {
      if (j.id !== fresh) continue; // an older job: leave its file on it, as it was, and try again next write
      // Storage refused the file. The job must not be lost over it: it goes on with the original resume.
      j.tailored = { status: "failed", error: "The browser had no room to keep the tailored resume, so your original is used." };
    }
  }
  await chrome.storage.local.set({ [KEY]: q });
  for (const f of listeners) try { f(q); } catch (e) {}
}

export const onQueueChange = (fn) => listeners.add(fn);
export const getQueue = read;
export async function getJob(id) { return (await read()).jobs[id]; }
// The tailored file with its bytes, or null. A job saved before the bytes moved still has them on it.
export async function getTailoredFile(id) {
  const j = await getJob(id);
  const f = j && j.tailored && j.tailored.file;
  if (!f) return null;
  if (f.b64) return f;
  const b64 = (await chrome.storage.local.get(BLOB(id)))[BLOB(id)];
  return b64 ? { ...f, b64 } : null;
}

export function publicJob(j) {
  if (!j) return null;
  const { pending, fastDone, tailored, ...rest } = j;
  const t = tailored && { ...tailored, file: tailored.file ? { name: tailored.file.name, size: tailored.file.size } : null };
  return { ...rest, tailored: t || null, waiting: !!(pending && pending.waitId) };
}
export function publicQueue(q) {
  // was: publicJob(v) alone. tailor_wait and batch_left (U5) are worked out from the whole queue.
  return { order: q.order, jobs: Object.fromEntries(Object.entries(q.jobs).map(([k, v]) => [k, {
    ...publicJob(v), tailor_wait: tailorWaiting(q, v), batch_left: batchLeft(q, v) }])) };
}

// ---------- tailored resumes in a batch (U5, 2026-10-14 UX audit) ----------
// With "Tailor it, and let me approve each one" (the default), every job used to tailor its resume and
// then stop on "Review the tailored resume" before its tab even opened, and stopped jobs don't count
// against the tab limit, so a batch of 10 became 10 "Needs you" cards before one form was filled.
// Now the jobs queued together (one Auto-Apply press, `batch`) ask once: while one of them waits on that
// question, the others stay queued (tailor_wait) instead of tailoring and stopping too. The card offers
// "for all" answers (batch_tailor on every job of the batch): tailored for all, or the original for all.
// Answering only for that one job ("Use tailored", "Use my original") keeps asking job by job, as before.
// The student still checks every application and presses Submit themselves.
const pendingTailor = (k) => k.status === "needs_you" && !!k.tailored && k.tailored.status === "pending";

// A queued job that waits because another job of its batch is waiting on the tailored-resume question.
export function tailorWaiting(q, j) {
  if (!j || j.status !== "queued" || !j.batch || j.batch_tailor) return false;
  return Object.values(q.jobs).some((k) => k.id !== j.id && k.batch === j.batch && pendingTailor(k));
}

// How many other jobs of this job's batch a "for all" answer would still decide: ones waiting on their own
// tailored resume, and unfinished ones that haven't been tailored yet. One already filling with its resume
// chosen isn't counted.
export function batchLeft(q, j) {
  if (!j || !j.batch) return 0;
  return Object.values(q.jobs).filter((k) => k.id !== j.id && k.batch === j.batch
    && (pendingTailor(k) || (["queued", "needs_you"].includes(k.status) && !k.tailored))).length;
}

// The "for all" answer: every job of the batch remembers it; returns the ids of jobs of the batch whose
// tailored resume was waiting, so the caller can answer and resume them too.
export function setBatchTailor(batch, choice) {
  return withLock(async () => {
    const q = await read();
    const waiting = [];
    if (!batch || !["approved", "skipped"].includes(choice)) return waiting;
    for (const j of Object.values(q.jobs)) {
      if (j.batch !== batch) continue;
      j.batch_tailor = choice;
      j.updated = Date.now();
      if (pendingTailor(j)) waiting.push(j.id);
    }
    await write(q);
    return waiting;
  });
}

// What happens to a tailored resume once it is made (agent.js tailorStep): "auto" (used without asking),
// "original" (the student's own file goes out) or "review" (the job asks). `mode` is the setting
// (off | review | auto); `batch` is a "for all" answer from the same batch, which wins over "review".
export function tailorChoice(mode, batch) {
  if (batch === "skipped") return "original";
  if (mode === "auto" || batch === "approved") return "auto";
  return "review";
}

// ---------- not taking the screen (U7, 2026-10-14 UX audit) ----------
// A new application tab has to open in front (agent.js ensureTab says why), and it used to do that
// whenever a job started, even while the student was answering a question in another job's tab or
// checking it before pressing Submit. Now a job waits to start while the tab in front is a job that is
// waiting on the student; background/index.js schedule() asks this before starting one.
export function studentBusyOn(q, activeTabId) {
  if (activeTabId == null) return null;
  return Object.values(q.jobs).find((j) => j.tabId === activeTabId && ["needs_you", "ready_to_submit"].includes(j.status)) || null;
}

export function addJobs(list) {
  return withLock(async () => {
    const q = await read();
    const added = [], skipped = [];
    // One Auto-Apply press is one batch (U5): the jobs it adds ask the tailored-resume question once.
    const batch = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    for (const l of list) {
      if (!l || !/^https?:\/\//i.test(String(l.apply_url || ""))) continue;
      const dup = Object.values(q.jobs).find((j) => ((l.id != null && j.listingId === l.id) || j.apply_url === l.apply_url) && !["failed"].includes(j.status));
      if (dup) { skipped.push(dup.id); continue; }
      const id = "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      q.jobs[id] = {
        id, listingId: l.id ?? null, company: l.company || "", title: l.title || "", location: l.location || "",
        apply_url: l.apply_url, description: String(l.description || "").slice(0, 6000),
        status: "queued", reason: "", question: "", activity: "", summary: "", double_check: [],
        tabId: l.tabId ?? null, steps: 0, log: [], created: Date.now(), updated: Date.now(), batch,
      };
      q.order.push(id);
      added.push(id);
    }
    await write(q);
    return { added, skipped };
  });
}

export function updateJob(id, patch) {
  return withLock(async () => {
    const q = await read();
    if (!q.jobs[id]) return null;
    const had = !!(q.jobs[id].tailored && q.jobs[id].tailored.file && q.jobs[id].tailored.file.b64);
    Object.assign(q.jobs[id], typeof patch === "function" ? patch(q.jobs[id]) : patch, { updated: Date.now() });
    await write(q, had ? null : id);   // was: await write(q);
    return q.jobs[id];
  });
}

export function appendLog(id, entry) {
  return updateJob(id, (j) => ({ log: [...(j.log || []), { at: Date.now(), ...entry }].slice(-200) }));
}

export function removeJob(id) {
  return withLock(async () => {
    const q = await read();
    delete q.jobs[id];
    q.order = q.order.filter((x) => x !== id);
    await chrome.storage.local.remove(["msgs_" + id, BLOB(id)]);   // was: only "msgs_" + id
    await write(q);
  });
}

export async function jobForTab(tabId) {
  const q = await read();
  return Object.values(q.jobs).find((j) => j.tabId === tabId && !["submitted", "failed"].includes(j.status)) || null;
}

export async function saveMsgs(id, msgs) { await chrome.storage.local.set({ ["msgs_" + id]: msgs }); }
export async function loadMsgs(id) { return (await chrome.storage.local.get("msgs_" + id))["msgs_" + id] || []; }
