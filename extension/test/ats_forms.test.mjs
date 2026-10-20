// Synthetic Lever/Ashby shapes, not captured employer forms or a claim of live compatibility.
// Run the actual page scripts against a minimal DOM, without Chrome, network or model calls.
// Static HTML companions in fixtures/ can also be opened for manual browser checks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { emptyStore, confirmedFacts } from "../lib/store.js";
import { applyInterviewFacts, confirmProfileValue } from "../onboarding/profile.js";

function harness(platform) {
  const fields = [], events = [];
  let onChange = null;
  class Input {
    constructor(label, type = "text", id = label.toLowerCase().replace(/\W+/g, "_")) {
      Object.assign(this, { tagName: "INPUT", nodeType: 1, type, id, name: id, disabled: false,
        isConnected: true, required: false, parentElement: null, nextElementSibling: null,
        className: "", innerText: "", textContent: "", files: [], checked: false, _value: "" });
      this.attrs = { "aria-label": label, type, id, name: id };
    }
    get value() { return this._value; }
    set value(v) { this._value = String(v); }
    getAttribute(n) { return this.attrs[n] ?? null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    hasAttribute(n) { return n in this.attrs; }
    removeAttribute(n) { delete this.attrs[n]; }
    closest() { return null; }
    matches(sel) { return /\binput\b/.test(sel); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    contains(el) { return el === this; }
    getRootNode() { return doc; }
    getBoundingClientRect() { return { width: 240, height: 32, left: 10, top: 10, right: 250, bottom: 42 }; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    dispatchEvent(e) { events.push([this.id, e.type]); if (e.type === "change") onChange?.(this); return true; }
    click() { this.checked = true; this.dispatchEvent(new Event("change")); }
    focus() {}
    scrollIntoView() {}
  }
  class Select extends Input {
    constructor(label) {
      super(label); this.tagName = "SELECT"; this.type = "select-one"; this.attrs.type = "select-one";
      this.options = ["Select...", "Yes", "No"].map((text, i) => ({ text, value: i ? text : "", disabled: false }));
      this.selectedIndex = 0;
    }
    get value() { return this.options[this.selectedIndex]?.value || ""; }
    set value(v) { this.selectedIndex = this.options.findIndex((o) => o.value === v); }
    matches(sel) { return /\bselect\b/.test(sel); }
  }
  const doc = {
    body: null, title: `${platform} synthetic application`, visibilityState: "visible",
    querySelectorAll(sel) {
      if (sel === "*") return [];
      const radioName = /^input\[type="radio"\]\[name="([^"]+)"\]$/.exec(sel);
      if (radioName) return fields.filter((el) => el.type === "radio" && el.name === radioName[1]);
      return fields.filter((el) => el.isConnected && (el.tagName === "SELECT" ? /\bselect\b/.test(sel) : /\binput\b/.test(sel)));
    },
    querySelector() { return null; }, getElementById() { return null; },
  };
  class Transfer { constructor() { this.files = []; this.items = { add: (f) => this.files.push(f) }; } }
  const url = platform === "Lever" ? "https://jobs.lever.co/example/fictional/apply" : "https://jobs.ashbyhq.com/example/fictional/application";
  const context = vm.createContext({ document: doc, location: new URL(url), HTMLInputElement: Input,
    HTMLTextAreaElement: Input, HTMLSelectElement: Select, File, DataTransfer: Transfer, Event,
    FocusEvent: class extends Event {}, CSS: { escape: String }, atob, Uint8Array,
    requestAnimationFrame() {}, getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    setTimeout, clearTimeout, scrollX: 0, scrollY: 0 });
  context.window = context;
  for (const f of ["guard", "actions", "dom"]) vm.runInContext(readFileSync(new URL(`../agent/${f}.js`, import.meta.url), "utf8"), context);
  const add = (label, type, id) => { const el = new Input(label, type, id); fields.push(el); return el; };
  const select = (label) => { const el = new Select(label); fields.push(el); return el; };
  const radioGroup = (question) => {
    const radios = ["Yes", "No"].map((answer) => add(answer, "radio", `sponsorship-${answer.toLowerCase()}`));
    const caption = { innerText: question, textContent: question, htmlFor: "sponsorship", contains: () => false,
      closest: () => null, getAttribute: (n) => n === "class" ? "question-title required" : null };
    const group = { querySelectorAll: () => [caption], querySelector: () => null };
    for (const radio of radios) {
      radio.name = radio.attrs.name = "sponsorship";
      radio.closest = (sel) => /fieldset|radiogroup/.test(sel) ? group : null;
    }
    return radios;
  };
  return { D: context.ISDom, G: context.ISGuard, fields, events, add, select, radioGroup,
    onChange(fn) { onChange = fn; }, replace(old) {
      old.isConnected = false;
      const next = new Input(old.getAttribute("aria-label"), old.type, old.id);
      fields.splice(fields.indexOf(old), 1, next); return next;
    } };
}

const RESUME = { name: "Jordan_Rivera_Resume.pdf", type: "application/pdf", b64: "JVBERi0xLjQKJSBTeW50aGV0aWMgb2ZmbGluZSBmaXh0dXJlCg==" };
const FACTS = { first_name: "Jordan", last_name: "Rivera", email: "jordan@example.com", phone: "555-010-0100", linkedin: "https://example.com/jordan" };
const sponsorship = "Will you now or in the future require sponsorship?";

for (const platform of ["Lever", "Ashby"]) {
  test(`${platform}: contact prefill attaches only the application resume and leaves unconfirmed eligibility alone`, async () => {
    const h = harness(platform);
    const name = h.add(platform === "Lever" ? "Full name ✱" : "Name", "text");
    const email = h.add("Email", "email"), phone = h.add("Phone", "tel"), linkedin = h.add("LinkedIn URL");
    const parser = platform === "Ashby" ? h.add("Autofill from resume", "file") : null;
    const resume = h.add(platform === "Lever" ? "Resume/CV ✱" : "Resume", "file");
    const cover = h.add("Cover Letter", "file"), eligibility = h.select(sponsorship);
    const s = emptyStore(); Object.assign(s.profile.facts, FACTS);
    applyInterviewFacts(s.profile, { needs_sponsorship: "No" });
    const done = await h.D.fastFill({ ...confirmedFacts(s), job_in_us: true }, RESUME, { gen: 1 });
    assert.equal(name.value, "Jordan Rivera"); assert.equal(email.value, FACTS.email);
    assert.equal(phone.value, FACTS.phone); assert.equal(linkedin.value, FACTS.linkedin);
    assert.equal(resume.files[0]?.name, RESUME.name);
    assert.equal(cover.files.length, 0); if (parser) assert.equal(parser.files.length, 0);
    assert.equal(eligibility.value, "", "interview suggestion is not a confirmed fact");
    assert.equal(done.length, 5);
    confirmProfileValue(s.profile, "facts", "needs_sponsorship");
    await h.D.fastFill({ ...confirmedFacts(s), job_in_us: true }, RESUME, { gen: 1 });
    assert.equal(eligibility.value, "No", "explicitly confirmed answer is usable");
    assert.equal(h.events.filter(([id, event]) => id === resume.id && event === "change").length, 1, "resume is not replaced on the next step");
  });

  test(`${platform}: Take over interrupts contact prefill before later fields or file uploads`, async () => {
    const h = harness(platform), first = h.add("Email", "email"), later = h.add("Phone", "tel"), resume = h.add("Resume", "file");
    h.onChange(() => h.D.halt(8));
    await h.D.fastFill(FACTS, RESUME, { gen: 7 });
    assert.equal(first.value, FACTS.email); assert.equal(later.value, ""); assert.equal(resume.files.length, 0);
    h.D.snapshot();
    for (const [el, action, payload] of [[later, "fill", { text: FACTS.phone }], [resume, "upload", { file: RESUME }]]) {
      const result = await h.D.act(el.getAttribute("data-is-ref"), action, { ...payload, gen: 7 });
      assert.equal(result.cancelled, true); assert.equal(result.ok, false);
    }
    assert.equal(later.value, ""); assert.equal(resume.files.length, 0, "late upload did not run");
  });

  test(`${platform}: manual review navigation stays usable while final submission stays with the student`, () => {
    const { G } = harness(platform), ctx = { runFilled: true, reviewStep: true, filledFields: 4 };
    const describe = (text) => ({ text, value: "", ariaLabel: "", title: "", automationId: "", type: "button", formFilled: 0 });
    for (const text of ["Back", "Edit application", "Review application", "Continue", "Upload resume"]) assert.equal(G.allowClick(describe(text), ctx).allowed, true, text);
    for (const text of ["Submit application", "Apply now", "Confirm and send", "I agree", "Let's make it official"]) assert.equal(G.allowClick(describe(text), ctx).allowed, false, text);
    // The guard's normal synthetic-click block is temporary; the permanent rule is for agent actions.
    assert.equal(G.allowClick(describe("Submit application"), { filledFields: 0 }).allowed, false);
  });
}

test("Ashby: a contact field replaced during React rerender is recovered from its latest fingerprint", async () => {
  const h = harness("Ashby"), old = h.add("Email", "email", "email");
  h.D.snapshot();
  const ref = old.getAttribute("data-is-ref"), replacement = h.replace(old);
  const result = await h.D.act(ref, "fill", { text: FACTS.email, gen: 1 });
  assert.equal(result.ok, true); assert.equal(replacement.value, FACTS.email); assert.equal(old.value, "");
});

test("Ashby: fieldset title identifies a required radio question before its answer labels", async () => {
  const h = harness("Ashby"), radios = h.radioGroup(sponsorship), s = emptyStore();
  applyInterviewFacts(s.profile, { needs_sponsorship: "No" });
  const snap = h.D.snapshot(), question = snap.elements.find((el) => el.kind === "radio_group");
  assert.equal(question.label, sponsorship); assert.equal(question.required, true);
  assert.deepEqual(Array.from(question.options), ["Yes", "No"]);
  await h.D.fastFill({ ...confirmedFacts(s), job_in_us: true }, null);
  assert.equal(radios.some((r) => r.checked), false);
  confirmProfileValue(s.profile, "facts", "needs_sponsorship");
  await h.D.fastFill({ ...confirmedFacts(s), job_in_us: true }, null);
  assert.equal(radios[0].checked, false); assert.equal(radios[1].checked, true);
});

test("Lever: existing contact values and ambiguous resume destinations are preserved", async () => {
  const h = harness("Lever"), email = h.add("Email", "email"), resume = h.add("Resume", "file"), second = h.add("Resume/CV", "file");
  email.value = "student-edited@example.com";
  await h.D.fastFill(FACTS, RESUME);
  assert.equal(email.value, "student-edited@example.com");
  assert.equal(resume.files.length, 0); assert.equal(second.files.length, 0, "two possible resume slots need review");
});
