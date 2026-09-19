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
  return { order: q.order, jobs: Object.fromEntries(Object.entries(q.jobs).map(([k, v]) => [k, publicJob(v)])) };
}

export function addJobs(list) {
  return withLock(async () => {
    const q = await read();
    const added = [], skipped = [];
    for (const l of list) {
      if (!l || !/^https?:\/\//i.test(String(l.apply_url || ""))) continue;
      const dup = Object.values(q.jobs).find((j) => ((l.id != null && j.listingId === l.id) || j.apply_url === l.apply_url) && !["failed"].includes(j.status));
      if (dup) { skipped.push(dup.id); continue; }
      const id = "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      q.jobs[id] = {
        id, listingId: l.id ?? null, company: l.company || "", title: l.title || "", location: l.location || "",
        apply_url: l.apply_url, description: String(l.description || "").slice(0, 6000),
        status: "queued", reason: "", question: "", activity: "", summary: "", double_check: [],
        tabId: l.tabId ?? null, steps: 0, log: [], created: Date.now(), updated: Date.now(),
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
