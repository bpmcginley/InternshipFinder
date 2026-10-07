// The review card's timing and dismissal (lib/review.js): when it shows, how often it can ever show,
// that "Don't ask again" and "Leave a review" are for good, that the first application never asks,
// and that it waits while a form is being filled. Also the card's words: no incentive, no star count.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data = {};
globalThis.chrome = { storage: { local: {
  async get(k) { return typeof k === "string" ? { [k]: data[k] } : Object.fromEntries([].concat(k).map((x) => [x, data[x]])); },
  async set(o) { for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
  async remove(k) { for (const x of [].concat(k)) delete data[x]; },
} } };

const R = await import("../lib/review.js");
const { emptyState, recordFill, shouldShow, answer, webLineOk, cardCopy, MILESTONES, KEY } = R;

const fills = (n, s = emptyState(), from = 0) => { for (let i = 0; i < n; i++) s = recordFill(s, "j" + (from + i)); return s; };
const idle = [{ id: "a", status: "ready_to_submit" }, { id: "b", status: "submitted" }];

test("the first filled application never asks; the second does", () => {
  const one = fills(1);
  assert.equal(one.filled, 1);
  assert.equal(shouldShow(one, idle), false);
  const two = recordFill(one, "j1");
  assert.equal(two.filled, 2);
  assert.equal(shouldShow(two, idle), true);
  assert.equal(two.asks, 1);
  // Even a state edited to look open is not shown below two fills.
  assert.equal(shouldShow({ ...one, open: true }, idle), false);
});

test("it waits while any application is being filled, and shows once none is", () => {
  const s = fills(2);
  assert.equal(shouldShow(s, [...idle, { id: "c", status: "working" }]), false);
  assert.equal(shouldShow(s, [...idle, { id: "c", status: "queued" }]), true);
  assert.equal(shouldShow(s, []), true);
});

test("the same job counts once, however many times it reaches Ready", () => {
  let s = fills(1);
  s = recordFill(s, "j0");
  s = recordFill(s, "j0");
  assert.equal(s.filled, 1);
  assert.equal(shouldShow(s, idle), false);
  assert.equal(recordFill(s, "j0"), s, "unchanged state is the same object, so nothing is written");
});

test("Not now waits for the next milestone, and nothing asks between milestones", () => {
  let s = answer(fills(2), "later");
  assert.equal(shouldShow(s, idle), false);
  for (let n = 3; n < MILESTONES[1]; n++) {
    s = recordFill(s, "j" + (n - 1));
    assert.equal(shouldShow(s, idle), false, `no ask at ${n}`);
  }
  s = recordFill(s, "later-10");
  assert.equal(s.filled, MILESTONES[1]);
  assert.equal(shouldShow(s, idle), true);
  assert.equal(s.asks, 2);
});

test("at most two asks ever, even for a student who always says Not now", () => {
  let s = emptyState(), shown = 0;
  for (let i = 0; i < 500; i++) {
    s = recordFill(s, "j" + i);
    if (shouldShow(s, idle)) { shown++; s = answer(s, "later"); }
  }
  assert.equal(shown, MILESTONES.length);
  assert.equal(MILESTONES.length, 2);
  assert.equal(s.asks, 2);
  assert.equal(s.filled, 500);
});

test("Don't ask again is permanent", () => {
  let s = answer(fills(2), "never");
  assert.equal(s.done, "never");
  s = fills(200, s, 2);
  assert.equal(shouldShow(s, idle), false);
  assert.equal(s.asks, 1);
  assert.equal(webLineOk(s), false, "the dashboard's line stays quiet too");
  assert.equal(answer(s, "later").done, "never", "a later Not now cannot undo it");
});

test("Leave a review is the last ask too, from the card or from the always-there link", () => {
  let s = answer(fills(2), "review");
  s = fills(50, s, 2);
  assert.equal(shouldShow(s, idle), false);
  // The passive link, clicked before any card: no card afterwards either.
  let t = answer(emptyState(), "review");
  t = fills(20, t);
  assert.equal(shouldShow(t, idle), false);
  assert.equal(t.asks, 0);
});

test("a card left unanswered stays one card when the next milestone passes", () => {
  const s = fills(MILESTONES[1]);
  assert.equal(shouldShow(s, idle), true);
  assert.equal(s.asks, 1);
  const after = fills(30, answer(s, "later"), MILESTONES[1]);
  assert.equal(shouldShow(after, idle), false, "both milestones are used");
});

test("an update with applications already filled counts them but does not ask late", () => {
  const s = emptyState(["a", "b", "c", "a"]);
  assert.equal(s.filled, 3);
  assert.equal(s.open, false);
  assert.equal(shouldShow(s, idle), false);
  let t = s;
  for (let i = 4; i < MILESTONES[1]; i++) t = recordFill(t, "n" + i);
  assert.equal(shouldShow(t, idle), false);
  t = recordFill(t, "n10");
  assert.equal(t.filled, 10);
  assert.equal(shouldShow(t, idle), true);
});

test("the dashboard's line is allowed after two fills until the student reviews or opts out", () => {
  assert.equal(webLineOk(null), false);
  assert.equal(webLineOk(fills(1)), false);
  assert.equal(webLineOk(fills(2)), true);
  assert.equal(webLineOk(answer(fills(2), "later")), true);
  assert.equal(webLineOk(answer(fills(2), "review")), false);
});

test("noteFilled seeds from the queue once, then counts each job; answerReview is kept in local storage", async () => {
  for (const k of Object.keys(data)) delete data[k];
  // A fresh install: the first fill is one, and asks nothing.
  let s = await R.noteFilled("x1", [{ id: "x1", status: "ready_to_submit" }]);
  assert.equal(s.filled, 1);
  assert.equal(data[KEY].filled, 1);
  // Two jobs finishing at once (two tabs): both counted, one card.
  await Promise.all([R.noteFilled("x2"), R.noteFilled("x3")]);
  assert.equal(data[KEY].filled, 3);
  assert.equal(data[KEY].open, true);
  assert.equal(data[KEY].asks, 1);
  await R.answerReview("never");
  assert.equal(data[KEY].done, "never");
  await R.noteFilled("x4");
  assert.equal(shouldShow(await R.loadReview(), []), false);
  assert.deepEqual(Object.keys(data), [KEY], "one key, nothing else written");
});

test("the card asks honestly: no incentive, no star count, no suggested text, the same for everyone", () => {
  const c = cardCopy(3);
  assert.equal(c.title, "Auto-Apply has filled 3 applications for you.");
  assert.equal(cardCopy(1).title, "Auto-Apply has filled 1 application for you.");
  const all = Object.values(c).join(" ");
  assert.doesNotMatch(all, /star|5\s*\/\s*5|five|rating of|bonus|free run|extra|unlock|reward|in exchange/i);
  assert.match(all, /Built by one student, made for all students\./);
  assert.match(all, /good or bad/);
  assert.ok(c.never && c.later && c.feedback);
  assert.match(R.STORE_REVIEWS_URL, /^https:\/\/chromewebstore\.google\.com\/detail\/internscout-auto-apply\/hpnbbpmalfjijnmpoihhjgjolhabjpgi\/reviews$/);
});

test("the review card needs no new permission and sends nothing anywhere", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["storage", "unlimitedStorage", "tabs", "tabGroups", "scripting", "webNavigation", "sidePanel", "notifications", "identity"]);
  const src = readFileSync(new URL("../lib/review.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /fetch\(|sendBeacon|XMLHttpRequest/, "nothing about reviews is sent anywhere");
  const panel = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
  assert.match(panel, /shouldShow\(rv, jobs\)/);
});
