import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/render\(\);\s*$/, "");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  let jobs = { a: { id: "a", status: "ready_to_submit", company: "Fixture" } },
    review = { filled: 3, open: true },
    listener,
    release,
    hold = false,
    commits = 0;
  const queueButton = {
    focus() {
      document.activeElement = queueButton;
    },
  };
  const control = { dataset: { review: "later" }, matches: () => false };
  const card = {
    contains: (el) => el === control,
    remove() {
      main.html = main.html.replace(/REVIEW/, "");
    },
  };
  const main = {
    html: "",
    contains: (el) => el === control,
    set innerHTML(value) {
      this.html = value;
      commits++;
    },
    querySelectorAll: () => [],
    querySelector: (selector) =>
      selector === ".card.review"
        ? main.html.includes("REVIEW")
          ? card
          : null
        : { addEventListener() {} },
  };
  const document = {
    activeElement: null,
    querySelectorAll: () => [],
    getElementById: (id) => (id === "main" ? main : {}),
    querySelector: () => queueButton,
  };
  const ctx = {
    document,
    chrome: {
      runtime: {
        sendMessage: async () => ({
          queue: { order: Object.keys(jobs), jobs: structuredClone(jobs) },
        }),
      },
      storage: {
        onChanged: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    loadStore: async () => ({}),
    loadReview: async () => {
      if (hold) {
        hold = false;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return review;
    },
    entryState: () => ({ stage: "ready", showEdit: true, showReview: true }),
    factCheckNote: () => "",
    shouldShow: (state, list) => state.open && !list.some((j) => j.status === "working"),
    cardCopy: (n) => ({
      title: `REVIEW ${n}`,
      body: "",
      review: "Review",
      later: "Later",
      never: "Never",
      feedback: "Feedback",
    }),
    esc: (value) => value,
    jobCard: () => "JOB",
    spend: async () => ({}),
    perApplication: () => null,
    EDIT_LABEL: "Edit setup",
    REVIEW_KEY: "review_ask",
    LABEL: { ready_to_submit: "Ready" },
    setTimeout: () => 1,
    clearTimeout() {},
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(source + "\nglobalThis.draw = render;", ctx);
  return {
    ctx,
    document,
    main,
    control,
    queueButton,
    get commits() {
      return commits;
    },
    draw: async () => {
      ctx.draw();
      await tick();
    },
    hold: () => {
      hold = true;
    },
    release: () => release(),
    working(notify = true) {
      jobs = { a: { id: "a", status: "working" } };
      if (notify) listener({ queue: { newValue: { jobs } } }, "local");
    },
    dismiss() {
      review = { filled: 3, open: false };
      listener({ review_ask: { newValue: review } }, "local");
    },
  };
}

test("a working queue removes a visible card immediately and preserves focus before deferred typing redraw", async () => {
  const h = harness();
  await h.draw();
  assert.match(h.main.html, /REVIEW/);
  h.document.activeElement = h.control;
  h.working();
  assert.doesNotMatch(h.main.html, /REVIEW/);
  assert.equal(h.document.activeElement, h.queueButton);
  h.document.activeElement = { matches: () => true };
  await h.draw();
  assert.doesNotMatch(h.main.html, /REVIEW/);
});

test("an invalidated delayed review read cannot repaint the card while typing defers the next draw", async () => {
  const h = harness();
  h.hold();
  await h.draw();
  h.working();
  h.document.activeElement = { matches: () => true };
  await h.draw();
  h.release();
  await tick();
  assert.equal(h.commits, 0);
  assert.doesNotMatch(h.main.html, /REVIEW/);
});

test("final queue revalidation suppresses the card even before the storage event arrives", async () => {
  const h = harness();
  h.hold();
  await h.draw();
  h.working(false);
  h.release();
  await tick();
  assert.doesNotMatch(h.main.html, /REVIEW/);
});

test("dismissal immediately removes a card and invalidates a delayed render", async () => {
  const h = harness();
  await h.draw();
  h.hold();
  await h.draw();
  h.dismiss();
  assert.doesNotMatch(h.main.html, /REVIEW/);
  h.release();
  await tick();
  assert.doesNotMatch(h.main.html, /REVIEW/);
});
