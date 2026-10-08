// Asking for a Chrome Web Store review (added 2026-10-07). Reviews are how other students find the
// extension, and a student is likeliest to write one right after it has done something for them, so
// the side panel shows one small card at that moment: after their 2nd filled application, and once
// more after their 10th. Never on the first, never while an application is being filled, and never
// again after "Leave a review" or "Don't ask again". The same quiet "Leave a review" link is always
// in the popup and the side panel for anyone who wants it without being asked.
//
// What the Chrome Web Store allows (developer.chrome.com/docs/webstore/program-policies/spam-and-abuse,
// "Manipulating Ratings, Reviews, and Install Counts"): no incentivized reviews or ratings. So nothing
// is given for a review (no runs, no unlock), no star count is asked for, no review text is suggested,
// and every student who reaches a milestone sees the same card: there is no "do you like it?" step that
// sends only happy students to the store. The feedback link sits beside the review button for everyone.
//
// All of it is kept in chrome.storage.local under "review_ask" on this device. None of it is sent
// anywhere, and it needs no new permission (opening a tab from an extension page needs none).

export const KEY = "review_ask";
export const STORE_REVIEWS_URL = "https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi/reviews";
// The feedback form the dashboard already points students at (docs/index.html window.CONFIG.formUrl),
// and Chrome's uninstall page (background/index.js).
export const FEEDBACK_URL = "https://docs.google.com/forms/d/e/1FAIpQLSevENYXxAtJg-suzwhBTwi8a2bosYHV27NcveE7eCYXo5Jdjw/viewform";
// Filled applications after which the card appears. Two asks at most, ever.
export const MILESTONES = [2, 10];
const MAX_IDS = 500;   // job ids already counted, so "Keep going" or a retry doesn't count a job twice

// Statuses that mean the agent finished filling: ready_to_submit is the success moment, and a job
// marked submitted got there too.
export const FILLED = new Set(["ready_to_submit", "submitted"]);

// The next milestone above `filled`, as an index into MILESTONES (MILESTONES.length when none is left).
const nextAfter = (filled) => { const i = MILESTONES.findIndex((m) => m > filled); return i < 0 ? MILESTONES.length : i; };

// A first state. `ids` are jobs already filled when this version arrives (an update, not a fresh
// install): they count toward the number on the card, but a milestone already passed is not asked
// about late, at a moment that isn't a success.
export function emptyState(ids = []) {
  const uniq = [...new Set(ids)].slice(-MAX_IDS);
  return { v: 1, filled: uniq.length, ids: uniq, next: nextAfter(uniq.length), open: false, asks: 0, done: null };
}

// One application filled. Returns a new state; the same one when this job was already counted.
export function recordFill(state, id) {
  const s = state || emptyState();
  if (!id || s.ids.includes(id)) return s;
  const out = { ...s, filled: s.filled + 1, ids: [...s.ids, id].slice(-MAX_IDS) };
  if (!out.done && out.next < MILESTONES.length && out.filled >= MILESTONES[out.next] && out.filled >= 2) {
    if (!out.open) out.asks = out.asks + 1;   // a card still showing from the last milestone stays one card
    out.open = true;
    out.next = nextAfter(out.filled);
  }
  return out;
}

// Whether the card shows now. `jobs` is the queue's jobs: while any is being filled, it waits.
export function shouldShow(state, jobs = []) {
  if (!state || !state.open || state.done || state.filled < 2) return false;
  return !jobs.some((j) => j && j.status === "working");
}

// The student's answer. "review": they went to the store (from the card or the always-there link);
// "never": Don't ask again; "later": Not now, so the next milestone may ask once more.
export function answer(state, action) {
  const s = state || emptyState();
  if (action === "review") return { ...s, open: false, done: "reviewed" };
  if (action === "never") return { ...s, open: false, done: "never" };
  if (action === "later") return { ...s, open: false };
  return s;
}

// Whether the dashboard may show its own one-line review suggestion: the student has filled a couple
// of applications and has not reviewed or said "Don't ask again" here. Handed to the dashboard in the
// ping reply (background/index.js), inside this browser only.
export const webLineOk = (state) => !!(state && !state.done && state.filled >= 2);

// The card's words. `n` is this device's count of filled applications.
export function cardCopy(n) {
  return {
    title: `Auto-Apply has filled ${n} application${n === 1 ? "" : "s"} for you.`,
    body: "Built by one student, made for all students. Reviews are how other students find it, so a sentence or two about how it went, good or bad, helps the next person decide.",
    review: "Leave a review", later: "Not now", never: "Don't ask again", feedback: "Something wrong? Tell us",
  };
}

// ---------- storage (the background is the only writer; the side panel and popup ask it by message) ----------
let lock = Promise.resolve();
function withLock(fn) {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
}
export async function loadReview() { return (await chrome.storage.local.get(KEY))[KEY] || null; }

// A job reached a filled status. `jobs` (the whole queue's jobs) seeds the count the first time.
export function noteFilled(id, jobs = []) {
  return withLock(async () => {
    const stored = await loadReview();
    const s = stored || emptyState(jobs.filter((j) => j && FILLED.has(j.status) && j.id !== id).map((j) => j.id));
    const out = recordFill(s, id);
    if (out !== stored) await chrome.storage.local.set({ [KEY]: out });
    return out;
  });
}

export function answerReview(action) {
  return withLock(async () => {
    const out = answer(await loadReview(), action);
    await chrome.storage.local.set({ [KEY]: out });
    return out;
  });
}
