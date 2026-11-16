import assert from "node:assert/strict";
import { act, loadForm, openBrowser, snapshotFrames } from "./bench_page.mjs";

// Qualification only. The installed extension does not import this script. Workday documents
// that Next saves an application draft, but does not publish a DOM contract for the control,
// step or field selectors used by this synthetic page. The browser replay does not establish
// live ATS compatibility, end-to-end latency or production coverage.
// Run npm ci in scripts/eval, then node scripts/eval/local_next.mjs from the repository root.
function tryLocalNext(expectedUrl, prefilled, selectedFacts) {
  const snap = window.ISDom.snapshot({ runFilled: true });
  const url = new URL(snap.url);
  const normalize = (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const visible = (node) =>
    node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";
  const warning = /\b(consent|attest\w*|certif\w*|acknowledg\w*|captcha|verify|sign in|password|terms and conditions)\b/i;
  if (window !== window.top || snap.url !== expectedUrl || url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.wd[0-9]+\.myworkdayjobs\.com$/.test(url.hostname) ||
      !/\/job\/[^/]+\/[^/]+\/apply\/applyManually$/.test(url.pathname) ||
      url.port || url.search || url.hash || document.readyState !== "complete" ||
      document.visibilityState !== "visible" || snap.step !== "My Information" ||
      snap.reviewStep || snap.frozen || snap.busy || snap.captcha || snap.captchaFrame ||
      snap.errors.length || window.ISGuard.detectGate(snap) ||
      document.forms.length !== 1 || document.querySelector(
        "iframe,frame,object,embed,[contenteditable],[aria-invalid='true'],[aria-busy='true'],[role='alert'],[inert]",
      ) || [...document.querySelectorAll("*")].some(
        (node) => node.shadowRoot || node.localName.includes("-") || node.hasAttribute("is"),
      ) || warning.test(document.body.innerText)) {
    return null;
  }

  const form = document.forms[0];
  const step = [...document.querySelectorAll('[aria-current="step"]')].filter(visible);
  const next = [...document.querySelectorAll('[data-automation-id="bottom-navigation-next-button"]')];
  if (form.getAttribute("data-automation-id") !== "myInformationForm" ||
      step.length !== 1 || normalize(step[0].innerText) !== "my information" ||
      next.length !== 1 || !(next[0] instanceof HTMLButtonElement)) return null;
  const button = next[0];
  const controls = [...document.querySelectorAll("button,input,select,textarea,a[href],[role],[tabindex]")];
  const inputs = controls.filter((node) => node instanceof HTMLInputElement && node.type !== "hidden");
  // All native, plain contact fields must be freshly prefilled and read back. Human edits, even
  // to a recognized contact field, go through the baseline review. Unknown custom inputs, hidden
  // interactive controls and alternate buttons are no reason to advance the application.
  if (button.form !== form || !visible(button) || button.type !== "button" ||
      button.matches(":disabled,[aria-disabled],[aria-haspopup],[formaction],[formmethod],[onclick]") ||
      [button.innerText, button.getAttribute("aria-label"), button.title]
        .filter(Boolean).some((label) => normalize(label) !== "save and continue") ||
      !inputs.length || prefilled.length !== inputs.length || snap.elements.length !== inputs.length ||
      controls.some((node) => node !== button && !inputs.includes(node) &&
        !node.matches("input[type='hidden']:not([required])"))) return null;

  const contact = {
    "given-name": ["Given Name(s)", "first_name", "text"],
    "family-name": ["Family Name", "last_name", "text"],
    email: ["Email Address", "email", "email"],
    tel: ["Phone Number", "phone", "tel"],
  };
  const seen = new Set();
  for (const el of inputs) {
    const key = el.autocomplete;
    const known = Object.hasOwn(contact, key) && contact[key];
    if (!known || seen.has(key)) return null;
    seen.add(key);
    const [label, fact, type] = known;
    const ref = el.getAttribute("data-is-ref");
    const value = selectedFacts[fact];
    if (el.form !== form || !visible(el) || el.type !== type || el.readOnly ||
        el.matches(":disabled") || !el.validity.valid || typeof value !== "string" || !value.trim() ||
        el.value !== value || !prefilled.includes(label + " = " + value) ||
        !snap.elements.some((field) => field.ref === ref && field.label === label && field.value === value &&
          field.kind === "text" && !field.error)) return null;
  }

  const btn = snap.buttons[0];
  if (snap.buttons.length !== 1 || btn.ref !== button.getAttribute("data-is-ref") ||
      btn.text !== "Save and Continue" || btn.blocked || btn.consent) return null;
  return window.ISDom.act(btn.ref, "click", { runFilled: true });
}

const contactMarkup = [
  ['given', 'Given Name(s)', 'text', 'given-name'],
  ['family', 'Family Name', 'text', 'family-name'],
  ['email', 'Email Address', 'email', 'email'],
  ['phone', 'Phone Number', 'tel', 'tel'],
].map(([id, label, type, autocomplete]) =>
  '<label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type +
    '" autocomplete="' + autocomplete + '" required>').join("\n");

const fixture = (extra = "") => '<!doctype html><html lang="en"><meta charset="utf-8">' +
  '<meta http-equiv="Content-Security-Policy" content="form-action \'none\'">' +
  '<title>Fictional Workday candidate application</title><h1>Data Intern</h1>' +
  '<ol><li aria-current="step">My Information</li><li>My Experience</li><li>Review</li></ol>' +
  '<section id="info"><h2>My Information</h2><form data-automation-id="myInformationForm">' +
  contactMarkup + extra +
  '<button id="next" type="button" data-automation-id="bottom-navigation-next-button">' +
  'Save and Continue</button></form></section>' +
  '<template id="next-step"><section id="experience"><h2>My Experience</h2><label for="story">Why this role?</label>' +
  '<textarea id="story" required></textarea><button type="submit">Submit application</button></section></template>' +
  '<script>window.activity = { next: 0, submit: 0 };' +
  'document.addEventListener("submit", (event) => { event.preventDefault(); window.activity.submit++; });' +
  'document.querySelector("#next").addEventListener("click", () => { window.activity.next++;' +
  'document.querySelector("#info").hidden = true; document.body.append(document.querySelector("#next-step").content.cloneNode(true));' +
  'document.querySelector("[aria-current]").removeAttribute("aria-current");' +
  'document.querySelector("li:nth-child(2)").setAttribute("aria-current", "step"); });</script></html>';

const url = "https://internscout-fixture.wd1.myworkdayjobs.com/en-US/careers/job/Remote/Data-Intern_FICTIONAL/apply/applyManually";
const facts = { first_name: "Jordan", last_name: "Rivera", email: "jordan@example.com", phone: "555-010-0100" };

const { browser, close } = await openBrowser();
try {
  const run = async (fn, { pageUrl = url, html = fixture(), profile = facts } = {}) => {
    const { page, pre } = await loadForm(browser, pageUrl, html, profile, null);
    try {
      return await fn(page, pre);
    } finally {
      await page.close();
    }
  };
  const after = async (page) => ({
    page: (await snapshotFrames(page))[0].step,
    browser: await page.evaluate(() => ({
      contact: ["given", "family", "email", "phone"].map((id) => document.querySelector("#" + id).value),
      story: document.querySelector("#story").value,
      ...window.activity,
    })),
  });
  const baseline = await run(async (page) => {
    const [{ buttons }] = await snapshotFrames(page);
    const button = buttons.find(({ text }) => text === "Save and Continue");
    assert.equal((await act(page, button.ref, "click", { runFilled: true })).ok, true);
    return after(page);
  });
  const local = await run(async (page, pre) => {
    assert.equal((await page.evaluate(tryLocalNext, url, pre, facts))?.ok, true);
    return after(page);
  });
  assert.deepEqual(local, baseline);
  assert.deepEqual(local, {
    page: "My Experience",
    browser: { contact: [facts.first_name, facts.last_name, facts.email, facts.phone], story: "", next: 1, submit: 0 },
  });

  const fallbackCases = [
    ["blank supported contact", { profile: { ...facts, phone: "" } }],
    ["unknown optional prose", { html: fixture('<label for="extra">Additional information</label><textarea id="extra"></textarea>') }],
    ["unchecked consent", { html: fixture('<label><input type="checkbox">I agree</label>') }],
    ["upload not accounted for", { html: fixture('<label for="resume">Resume</label><input type="file" id="resume">') }],
    ["multiple navigation controls", { html: fixture('<button type="button">Other Next</button>') }],
    ["frame", { html: fixture("<iframe hidden></iframe>") }],
    ["busy", { html: fixture('<span aria-busy="true">Loading</span>') }],
    ["server rejection", { html: fixture('<span role="alert">Your email is invalid.</span>') }],
    ["native validation fails", { html: fixture().replace('id="phone"', 'id="phone" pattern="[0-9]{10}"') }],
    ["same label without the Workday control identity", { html: fixture().replace("bottom-navigation-next-button", "generic-next") }],
    ["conflicting accessibility label", { html: fixture().replace('id="next"', 'id="next" aria-label="Submit application"') }],
    ["final-style button", { html: fixture().replace('id="next" type="button"', 'id="next" type="submit"') }],
    ["review step", { html: fixture().replace('<li aria-current="step">My Information</li>', '<li aria-current="step">Review</li>') }],
    ["wrong origin", { pageUrl: url.replace("internscout-fixture.wd1.myworkdayjobs.com", "example.invalid") }],
    ["different URL since the snapshot", {}, undefined, url.replace("/Remote/", "/Boston/")],
    ["contact changed after prefill", {}, (page) => page.evaluate(() => { document.querySelector("#email").value = "changed@example.com"; })],
    ["prefill absent", {}, undefined, url, []],
  ];
  for (const [name, config, mutate, expected = config.pageUrl ?? url, prefilled] of fallbackCases) {
    await run(async (page, pre) => {
      await mutate?.(page);
      assert.equal(await page.evaluate(tryLocalNext, expected, prefilled ?? pre, facts), null, name);
      assert.deepEqual(await page.evaluate(() => window.activity), { next: 0, submit: 0 }, name);
    }, config);
  }

  const ambiguous = {
    html: fixture('<label for="extra">Additional information</label><textarea id="extra"></textarea>'),
  };
  const replayModel = async (page) => {
    const [{ buttons, elements }] = await snapshotFrames(page);
    const field = elements.find(({ label }) => label === "Additional information");
    const button = buttons.find(({ text }) => text === "Save and Continue");
    assert.equal((await act(page, field.ref, "fill", { text: "I worked on a fictional data project." })).ok, true);
    assert.equal((await act(page, button.ref, "click", { runFilled: true })).ok, true);
    return {
      ...await after(page),
      optionalAnswer: await page.evaluate(() => document.querySelector("#extra").value),
    };
  };
  const modelOnly = await run(replayModel, ambiguous);
  const modelAfterDecline = await run(async (page, pre) => {
    assert.equal(await page.evaluate(tryLocalNext, url, pre, facts), null);
    assert.deepEqual(await page.evaluate(() => window.activity), { next: 0, submit: 0 });
    return replayModel(page);
  }, ambiguous);
  assert.deepEqual(modelAfterDecline, modelOnly);
  assert.equal(modelAfterDecline.optionalAnswer, "I worked on a fictional data project.");
  assert.equal(modelAfterDecline.browser.submit, 0);
  console.log("Local Next browser replay: a declined page keeps the scripted model's optional answer and navigation.");
  console.log("Local Next browser replay: baseline and candidate match on one synthetic page.");
  console.log("Local Next browser replay: " + fallbackCases.length + " ambiguous pages defer without clicking.");
  console.log("Calls on the matching step: 1 scripted baseline decision, 0 candidate decisions. No provider calls.");
} finally {
  await close();
}
