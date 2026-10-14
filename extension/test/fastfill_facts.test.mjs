// The rule-based prefill (agent/dom.js fastFill) on an EEO and work-eligibility form, with the facts the
// agent hands it (background/agent.js: confirmedFacts). An interview's suggested race, gender, veteran
// status or sponsorship answer must not reach the form; the voluntary questions get the decline option
// (PR #94 review, P1 #1). Runs the real guard.js, actions.js and dom.js against a few fake <select>s.
import test from "node:test";
import assert from "node:assert/strict";

class HTMLSelectElement {
  get value() { return this.selectedIndex >= 0 ? this.options[this.selectedIndex].value : ""; }
  set value(v) { this.selectedIndex = this.options.findIndex((o) => o.value === v); }
}
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
  dispatchEvent() { return true; }
  focus() {}
}

let page = [];
globalThis.window = globalThis;
globalThis.HTMLSelectElement = HTMLSelectElement;
globalThis.FocusEvent = class extends Event {};
globalThis.CSS = { escape: (s) => String(s) };
globalThis.requestAnimationFrame = () => 0;   // dom.js keeps a frame clock for frozen-tab detection
globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" });
globalThis.location = { href: "https://boards.greenhouse.io/acme/jobs/1" };
globalThis.document = {
  body: null, title: "Apply", visibilityState: "visible",
  querySelectorAll: (sel) => (sel === "*" ? [] : /\bselect\b/.test(sel) ? page : []),
  querySelector: () => null, getElementById: () => null,
};

await import("../agent/guard.js");
await import("../agent/actions.js");
await import("../agent/dom.js");
const { emptyStore, confirmedFacts, EMPTY_FACTS } = await import("../lib/store.js");
const { applyInterviewFacts, confirmProfileValue } = await import("../onboarding/profile.js");

const FORM = [
  ["Race", ["American Indian or Alaska Native", "Asian", "White", "Decline to self-identify"]],
  ["Gender", ["Male", "Female", "Decline to self-identify"]],
  ["Are you Hispanic or Latino?", ["Yes", "No", "Decline to self-identify"]],
  ["Veteran status", ["I am a protected veteran", "I am not a protected veteran", "I don't wish to answer"]],
  ["Disability status", ["Yes, I have a disability (or previously had one)", "No, I do not have a disability", "I don't wish to answer"]],
  ["Will you now or in the future require sponsorship for employment visa status in the United States?", ["Yes", "No"]],
];
const SUGGESTED = { race: "Asian", gender: "Female", hispanic: "Yes", veteran: "I am a protected veteran",
  disability: "Yes, I have a disability (or previously had one)", needs_sponsorship: "No" };

async function prefill(store) {
  page = FORM.map(([label, opts]) => new FakeSelect(label, opts));
  // As background/agent.js builds them for fastFill.
  const ready = confirmedFacts(store);
  const facts = { ...ready, email: store.settings.signup_email || ready.email, job_in_us: true };
  await window.ISDom.fastFill(facts, null);
  return Object.fromEntries(page.map((el) => [el.getAttribute("aria-label"), el.options[el.selectedIndex].text]));
}

test("interview suggestions never reach an EEO form: the voluntary questions are declined and sponsorship is left alone", async () => {
  const s = emptyStore();
  applyInterviewFacts(s.profile, SUGGESTED);
  assert.equal(s.profile.facts.race, "Asian", "the suggestion is kept for Quick facts to show");
  const shown = await prefill(s);
  assert.deepEqual(shown, {
    "Race": "Decline to self-identify",
    "Gender": "Decline to self-identify",
    "Are you Hispanic or Latino?": "Decline to self-identify",
    "Veteran status": "I don't wish to answer",
    "Disability status": "I don't wish to answer",
    "Will you now or in the future require sponsorship for employment visa status in the United States?": "Select...",
  });
});

test("an answer the student confirmed on Quick facts is what the form gets", async () => {
  const s = emptyStore();
  applyInterviewFacts(s.profile, SUGGESTED);
  for (const k of ["race", "needs_sponsorship"]) confirmProfileValue(s.profile, "facts", k);   // "Use this answer"
  const shown = await prefill(s);
  assert.equal(shown["Race"], "Asian");
  assert.equal(shown["Will you now or in the future require sponsorship for employment visa status in the United States?"], "No");
  assert.equal(shown["Gender"], "Decline to self-identify", "the others are still only suggestions");
  assert.equal(shown["Veteran status"], EMPTY_FACTS.veteran);
});
