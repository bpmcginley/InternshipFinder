// A recorder for the model comparison in scripts/eval (is Flash-Lite good enough for Auto-Apply?).
//
// Off unless someone turns it on from this extension's service-worker console:
//   await ISEval.start()                              then run a few applications as usual
//   copy(JSON.stringify(await ISEval.export()))      and paste into a .json file for scripts/eval
//   await ISEval.stop(); await ISEval.clear()
// Each step keeps the exact request the model was sent (rules, the candidate's profile, the job, the
// page) and the answer it gave, so a step can be replayed later against another model. That is the
// student's own data, so it stays in this browser's storage and goes nowhere by itself; recording is
// meant for a developer testing on their own profile, and nothing in the product turns it on.
const ON = "eval_recording";
const KEY = "eval_steps";
const MAX = 300;          // about 25 KB a step: a few dozen applications

export async function recording() {
  return !!(await chrome.storage.local.get(ON))[ON];
}

export async function recordStep(step) {
  try {
    if (!(await recording())) return;
    const cur = (await chrome.storage.local.get(KEY))[KEY] || [];
    cur.push(JSON.parse(JSON.stringify(step)));
    while (cur.length > MAX) cur.shift();
    await chrome.storage.local.set({ [KEY]: cur });
  } catch (e) {
    // Recording must never be the reason an application stops.
  }
}

export const ISEval = {
  start: async () => { await chrome.storage.local.set({ [ON]: true }); return "recording Auto-Apply steps"; },
  stop: async () => { await chrome.storage.local.set({ [ON]: false }); return "stopped"; },
  count: async () => ((await chrome.storage.local.get(KEY))[KEY] || []).length,
  export: async () => ({ version: 1, exported: new Date().toISOString(), steps: (await chrome.storage.local.get(KEY))[KEY] || [] }),
  clear: async () => { await chrome.storage.local.remove(KEY); return "cleared"; },
};
