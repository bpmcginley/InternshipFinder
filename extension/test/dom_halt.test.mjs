// PR #94 review, P2 (2026-10-14): a prefill already running kept changing answers for about two seconds
// after Take over. background/agent.js takeBack now calls ISDom.halt(newGen) in every frame, and
// fastFill, pick, upload, act and highlight stop for a run with an older gen. Runs the real guard.js,
// actions.js and dom.js against fake <select>s, as fastfill_facts.test.mjs does.
import test from "node:test";
import assert from "node:assert/strict";

class HTMLSelectElement {
  get value() { return this.selectedIndex >= 0 ? this.options[this.selectedIndex].value : ""; }
  set value(v) { this.selectedIndex = this.options.findIndex((o) => o.value === v); }
}
let onEvent = null;
class FakeSelect extends HTMLSelectElement {
  constructor(label, options) {
    super();
    this.tagName = "SELECT"; this.nodeType = 1; this.id = ""; this.name = label.toLowerCase().replace(/\W+/g, "_");
    this.attrs = { "aria-label": label };
    this.options = ["Select...", ...options].map((text, i) => ({ text, value: i ? text : "", disabled: false }));
    this.selectedIndex = 0;
    this.disabled = false; this.required = false; this.isConnected = true; this.parentElement = null;
    this.nextElementSibling = null; this.className = ""; this.isContentEditable = false; this.innerText = ""; this.textContent = "";
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  hasAttribute(n) { return n in this.attrs; }
  removeAttribute(n) { delete this.attrs[n]; }
  closest() { return null; }
  matches(sel) { return /\bselect\b/.test(sel); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains(x) { return x === this; }
  getRootNode() { return globalThis.document; }
  getBoundingClientRect() { return { width: 200, height: 30, left: 100, top: 70, right: 300, bottom: 100 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  // The page reacting to a field being set: where the student's Take over lands in these tests.
  dispatchEvent(e) { if (onEvent && e.type === "change") onEvent(this); return true; }
  focus() {}
  scrollIntoView() { scrolled++; }
}

let page = [], scrolled = 0;
globalThis.window = globalThis;
globalThis.HTMLSelectElement = HTMLSelectElement;
globalThis.FocusEvent = class extends Event {};
globalThis.CSS = { escape: (s) => String(s) };
globalThis.requestAnimationFrame = () => 0;
globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" });
globalThis.location = { href: "https://boards.greenhouse.io/acme/jobs/1", hostname: "boards.greenhouse.io", pathname: "/acme/jobs/1" };
globalThis.document = {
  body: null, title: "Apply", visibilityState: "visible",
  querySelectorAll: (sel) => (sel === "*" ? [] : /\bselect\b/.test(sel) ? page : []),
  querySelector: () => null, getElementById: () => null,
};

await import("../agent/guard.js");
await import("../agent/actions.js");
await import("../agent/dom.js");
const D = window.ISDom;

const FACTS = { race: "Decline to self-identify", gender: "Decline to self-identify", veteran: "I don't wish to answer", job_in_us: true };
const FORM = () => [
  new FakeSelect("Race", ["Asian", "White", "Decline to self-identify"]),
  new FakeSelect("Gender", ["Male", "Female", "Decline to self-identify"]),
  new FakeSelect("Veteran status", ["I am a protected veteran", "I don't wish to answer"]),
];
const shown = () => page.map((el) => el.options[el.selectedIndex].text);
const reset = () => { delete window.__isHaltGen; onEvent = null; scrolled = 0; };

test("Take over during a prefill stops it at the next field", async () => {
  reset();
  page = FORM();
  // The student presses Take over while the first answer is being set: takeBack sends gen 4.
  onEvent = () => { onEvent = null; D.halt(4); };
  const done = await D.fastFill(FACTS, null, { gen: 3 });
  assert.equal(done.length, 1, "only the field under way when Take over landed");
  assert.deepEqual(shown(), ["Decline to self-identify", "Select...", "Select..."]);
});

test("a prefill from the stopped run that starts after Take over does nothing; the next run's does", async () => {
  reset();
  page = FORM();
  D.halt(4);
  assert.deepEqual(await D.fastFill(FACTS, null, { gen: 3 }), []);
  assert.deepEqual(shown(), ["Select...", "Select...", "Select..."]);
  // Resume bumps the gen again (agent.js resumeJob); Retry's run has the gen takeBack set.
  assert.equal((await D.fastFill(FACTS, null, { gen: 4 })).length, 3);
});

test("an action from the stopped run is refused before it touches or scrolls the page", async () => {
  reset();
  page = FORM();
  D.snapshot();
  const ref = page[0].getAttribute("data-is-ref");
  D.halt(2);
  const r = await D.act(ref, "select", { option: "Asian", gen: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.equal(page[0].selectedIndex, 0);
  assert.equal(scrolled, 0, "no scrollIntoView");
  const ok = await D.act(ref, "select", { option: "Asian", gen: 2 });
  assert.equal(ok.ok, true);
});

test("highlight from the stopped run neither outlines nor scrolls (P3)", () => {
  reset();
  page = FORM();
  D.halt(6);
  assert.deepEqual(D.highlight({ runFilled: true, gen: 5 }), { missing: 0, final: false, stopped: true });
  assert.equal(scrolled, 0);
});

test("a halt with an older gen never lowers the flag, and calls with no gen are never stopped", async () => {
  reset();
  D.halt(5); D.halt(2);
  assert.equal(window.__isHaltGen, 5);
  page = FORM();
  assert.equal((await D.fastFill(FACTS, null)).length, 3);
});
