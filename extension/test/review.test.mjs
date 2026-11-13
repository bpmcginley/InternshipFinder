// The review card's timing and dismissal (lib/review.js): when it shows, how often it can ever show,
// that "Don't ask again" and "Leave a review" are for good, that the first application never asks,
// and that it waits while a form is being filled. Also the card's words: no incentive, no star count.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        return typeof k === "string"
          ? { [k]: data[k] }
          : Object.fromEntries([].concat(k).map((x) => [x, data[x]]));
      },
      async set(o) {
        for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v));
      },
      async remove(k) {
        for (const x of [].concat(k)) delete data[x];
      },
    },
  },
};

const R = await import("../lib/review.js");
const { emptyState, recordFill, shouldShow, answer, webLineOk, cardCopy, MILESTONES, KEY } = R;

const fills = (n, s = emptyState(), from = 0) => {
  for (let i = 0; i < n; i++) s = recordFill(s, "j" + (from + i));
  return s;
};
const idle = [
  { id: "a", status: "ready_to_submit" },
  { id: "b", status: "submitted" },
];

test("only the third successful fill opens one lifetime prompt", () => {
  assert.deepEqual(MILESTONES, [3]);
  let s = emptyState();
  for (let i = 1; i <= 20; i++) {
    s = recordFill(s, "job" + i);
    assert.equal(shouldShow(s, idle), i >= 3);
    assert.equal(s.asks, i < 3 ? 0 : 1);
  }
  assert.equal(shouldShow({ ...s, filled: 2 }, idle), false);
});

test("Not now consumes the opportunity, including after restart and hundreds more fills", () => {
  let s = answer(fills(3), "later");
  for (let i = 3; i < 600; i++) s = recordFill(JSON.parse(JSON.stringify(s)), "j" + i);
  assert.equal(s.asks, 1);
  assert.equal(shouldShow(s, idle), false);
  assert.equal(s.done, null);
});

test("permanent review and never decisions survive later answers and more fills", () => {
  for (const [action, done] of [
    ["review", "reviewed"],
    ["never", "never"],
  ]) {
    let s = answer(fills(3), action);
    s = fills(25, answer(s, "later"), 3);
    assert.equal(s.done, done);
    assert.equal(shouldShow(s, idle), false);
  }
  assert.equal(shouldShow(fills(4, answer(emptyState(), "review")), idle), false);
});

test("all earlier v1 asks, open cards and permanent choices consume the opportunity", () => {
  for (const extra of [
    { asks: 1 },
    { asks: 2 },
    { open: true },
    { done: "never" },
    { done: "reviewed" },
  ]) {
    const old = {
      v: 1,
      filled: 2,
      ids: ["a", "b"],
      next: 1,
      open: false,
      asks: 0,
      done: null,
      ...extra,
    };
    const before = JSON.stringify(old),
      next = R.migrateReview(old);
    assert.equal(next.v, 2);
    assert.deepEqual(next.ids, old.ids);
    assert.equal(next.filled, 2);
    assert.equal(next.asks, old.asks);
    assert.equal(next.done, old.done);
    assert.equal(next.open, false);
    assert.equal(shouldShow(fills(20, next), idle), false);
    assert.equal(JSON.stringify(old), before);
  }
});

test("legacy users below three with no ask remain eligible; past milestones are never asked late", () => {
  const old = (n) => ({
    v: 1,
    filled: n,
    ids: Array.from({ length: n }, (_, i) => "old" + i),
    next: 1,
    open: false,
    asks: 0,
    done: null,
  });
  assert.equal(shouldShow(recordFill(R.migrateReview(old(2)), "new"), idle), true);
  for (const n of [3, 9, 10, 40])
    assert.equal(shouldShow(recordFill(R.migrateReview(old(n)), "new"), idle), false);
  assert.equal(shouldShow(recordFill(emptyState(["a", "b", "c"]), "new"), idle), false);
});

test("only Ready transitions count new success; manual Submitted and repeated Ready do not", () => {
  for (const previous of ["working", "needs_you", "queued"])
    assert.equal(R.fillTransition(previous, "ready_to_submit"), true);
  for (const [previous, status] of [
    [null, "ready_to_submit"],
    ["ready_to_submit", "ready_to_submit"],
    ["working", "submitted"],
    ["failed", "submitted"],
    ["ready_to_submit", "submitted"],
  ])
    assert.equal(R.fillTransition(previous, status), false);
  let s = fills(2);
  s = recordFill(s, "j1");
  assert.equal(s.filled, 2);
  s = recordFill(s, "new");
  assert.equal(recordFill(s, "new"), s);
  const source = readFileSync(new URL("../background/index.js", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(fillTransition\(prev, j.status\)\) noteFilled\(j.id, Object.values\(q.jobs\)\)/,
  );
  assert.doesNotMatch(source, /FILLED.has\(j.status\)/);
});

test("an active fill hides the prompt while queued and human-review jobs do not", () => {
  const s = fills(3);
  assert.equal(shouldShow(s, [...idle, { id: "busy", status: "working" }]), false);
  assert.equal(shouldShow(s, [...idle, { id: "next", status: "queued" }]), true);
  assert.equal(shouldShow(s, []), true);
});

test("dashboard proactive line stays off; the side panel is the sole proactive surface", () => {
  for (const s of [null, fills(2), fills(3), fills(20), answer(fills(3), "later")])
    assert.equal(webLineOk(s), false);
  const panel = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
  const popup = readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
  assert.match(panel, /if \(e.showReview\).*Leave a review/);
  assert.match(popup, /review_ask/);
});

test("serialized fills deduplicate concurrent completions and preserve a concurrent dismissal", async () => {
  for (const k of Object.keys(data)) delete data[k];
  await R.noteFilled("x1", [{ id: "x1", status: "ready_to_submit" }]);
  await Promise.all([R.noteFilled("x2"), R.noteFilled("x3"), R.noteFilled("x3")]);
  assert.equal(data[KEY].filled, 3);
  assert.equal(data[KEY].asks, 1);
  assert.equal(data[KEY].v, 2);
  await Promise.all([R.answerReview("later"), R.noteFilled("x4")]);
  assert.equal(shouldShow(await R.loadReview(), []), false);
  assert.equal(data[KEY].filled, 4);
  assert.deepEqual(Object.keys(data), [KEY]);
});

test("missing history never treats manually Submitted jobs as proof of filling", async () => {
  delete data[KEY];
  const jobs = [
    { id: "manual1", status: "submitted" },
    { id: "manual2", status: "submitted" },
    { id: "new", status: "ready_to_submit" },
  ];
  let s = await R.noteFilled("new", jobs);
  assert.equal(s.filled, 1);
  assert.equal(shouldShow(s, []), false);
  s = await R.noteFilled("second");
  assert.equal(s.filled, 2);
  assert.equal(shouldShow(s, []), false);
  s = await R.noteFilled("third");
  assert.equal(s.filled, 3);
  assert.equal(shouldShow(s, []), true);
  await R.noteFilled("third");
  assert.equal(data[KEY].filled, 3);
  const old = { v: 1, filled: 2, ids: ["a", "b"], next: 1, open: false, asks: 1, done: null };
  data[KEY] = old;
  await R.noteFilled("c");
  assert.equal(data[KEY].v, 2);
  assert.equal(data[KEY].filled, 3);
  assert.equal(data[KEY].asks, 1);
  assert.equal(data[KEY].open, false);
});

test("the card asks honestly: no incentive, no star count, no suggested text, the same for everyone", () => {
  const c = cardCopy(3);
  assert.equal(c.title, "Auto-Apply has filled 3 applications for you.");
  assert.equal(cardCopy(1).title, "Auto-Apply has filled 1 application for you.");
  const all = Object.values(c).join(" ");
  assert.doesNotMatch(
    all,
    /star|5\s*\/\s*5|five|rating of|bonus|free run|extra|unlock|reward|in exchange/i,
  );
  assert.match(all, /Built by one student, made for all students\./);
  assert.match(all, /good or bad/);
  assert.ok(c.never && c.later && c.feedback);
  assert.match(
    R.STORE_REVIEWS_URL,
    /^https:\/\/chromewebstore\.google\.com\/detail\/internscout-auto-apply\/hpnbbpmalfjijnmpoihhjgjolhabjpgi\/reviews$/,
  );
});

test("the review card needs no new permission and sends nothing anywhere", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, [
    "storage",
    "unlimitedStorage",
    "tabs",
    "tabGroups",
    "scripting",
    "webNavigation",
    "sidePanel",
    "notifications",
    "identity",
  ]);
  const src = readFileSync(new URL("../lib/review.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    src,
    /fetch\(|sendBeacon|XMLHttpRequest/,
    "nothing about reviews is sent anywhere",
  );
  const panel = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
  assert.match(panel, /shouldShow\(rv, currentJobs\)/);
});
