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
async function write(q) {
  await chrome.storage.local.set({ [KEY]: q });
  for (const f of listeners) try { f(q); } catch (e) {}
}

export const onQueueChange = (fn) => listeners.add(fn);
export const getQueue = read;
export async function getJob(id) { return (await read()).jobs[id]; }

export function publicJob(j) {
  if (!j) return null;
  const { pending, fastDone, ...rest } = j;
  return { ...rest, waiting: !!(pending && pending.waitId) };
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
    Object.assign(q.jobs[id], typeof patch === "function" ? patch(q.jobs[id]) : patch, { updated: Date.now() });
    await write(q);
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
    await chrome.storage.local.remove("msgs_" + id);
    await write(q);
  });
}

export async function jobForTab(tabId) {
  const q = await read();
  return Object.values(q.jobs).find((j) => j.tabId === tabId && !["submitted", "failed"].includes(j.status)) || null;
}

export async function saveMsgs(id, msgs) { await chrome.storage.local.set({ ["msgs_" + id]: msgs }); }
export async function loadMsgs(id) { return (await chrome.storage.local.get("msgs_" + id))["msgs_" + id] || []; }
