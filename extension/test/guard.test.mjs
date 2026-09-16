// node --test extension/test
import test from "node:test";
import assert from "node:assert/strict";
import "../agent/guard.js";

const G = globalThis.ISGuard;
const filled = { filledFields: 5 };
const empty = { filledFields: 0 };
const btn = (text, extra = {}) => ({ text, value: "", ariaLabel: "", title: "", type: "button", automationId: "", ...extra });

test("final submit variants are always refused", () => {
  for (const t of ["Submit", "Submit Application", "SUBMIT APPLICATION", "Submit my application",
    "Send application", "Send my application", "Finish application", "Complete your application",
    "Confirm and submit", "Review and Submit", "submit ›"]) {
    assert.equal(G.allowClick(btn(t), empty).allowed, false, t);
    assert.equal(G.allowClick(btn(t), filled).allowed, false, t);
  }
  assert.equal(G.allowClick(btn("", { value: "Submit", type: "submit" }), filled).allowed, false);
  assert.equal(G.allowClick(btn("", { ariaLabel: "Submit application" }), filled).allowed, false);
  assert.equal(G.allowClick(btn("Send", { automationId: "btn-submit" }), filled).allowed, false);
});

test("ambiguous final buttons: allowed on a job page, refused on a filled form", () => {
  for (const t of ["Apply", "Apply now", "Apply for this job", "Send", "Finish", "Done", "Confirm"]) {
    assert.equal(G.allowClick(btn(t), empty).allowed, true, t + " (job page)");
    assert.equal(G.allowClick(btn(t), filled).allowed, false, t + " (filled form)");
  }
  assert.equal(G.allowClick(btn("", { type: "submit" }), filled).allowed, false);
});

test("navigation and account buttons are allowed", () => {
  for (const t of ["Next", "Continue", "Save and Continue", "Back", "Add Another", "Upload",
    "Create Account", "Sign In", "Apply Manually", "Autofill with Resume", "Use My Last Application",
    "Add Work Experience", "Verify"]) {
    assert.equal(G.allowClick(btn(t), filled).allowed, true, t);
  }
  assert.equal(G.allowClick(btn("Next", { automationId: "bottom-navigation-next-button", type: "submit" }), filled).allowed, true);
});

test("final buttons that never say submit are refused", () => {
  for (const t of ["Confirm and send", "Confirm & Send", "I agree and apply", "Agree & Submit",
    "Confirm Application", "Confirm my application"]) {
    assert.equal(G.allowClick(btn(t), empty).allowed, false, t);
    assert.equal(G.allowClick(btn(t), filled).allowed, false, t);
  }
});

test("a submit-id'd button is rescued only when its label starts with a navigation word", () => {
  // A safe word somewhere in the label is not enough: this is the final button on its page.
  for (const t of ["Agree & Continue", "I have reviewed my answers, continue", "Review and continue"]) {
    assert.equal(G.allowClick(btn(t, { automationId: "submitApplication", type: "submit" }), filled).allowed, false, t);
  }
  // Real navigation and account buttons that happen to carry a submit id still work.
  for (const t of ["Create Account", "Sign In", "Next: Work Experience", "Save and Continue", "Save & Continue Later", "Continue Application"]) {
    assert.equal(G.allowClick(btn(t, { automationId: "submitButton", type: "submit" }), filled).allowed, true, t);
  }
});

// ---- gates the human clears themselves ----
const page = (o = {}) => ({ headings: [], step: "", buttons: [], text: "", elements: [], ...o });
const el = (kind, label, extra = {}) => ({ kind, label, question: "", ...extra });

// Sign-up and sign-in are the agent's job, not gates. Pinned here so that stays deliberate:
// Workday's "Verify New Password" must not read as a verification code.
test("account pages are not gates", () => {
  assert.equal(G.detectGate(page({
    headings: ["Create Account"],
    elements: [el("email", "Email Address"), el("password", "Password"), el("password", "Verify New Password")],
  })), null);

  assert.equal(G.detectGate(page({ headings: ["Sign up"], elements: [el("password", "Password")] })), null);
  assert.equal(G.detectGate(page({
    headings: ["Sign In"],
    elements: [el("email", "Email"), el("password", "Password")],
  })), null);
});

test("emailed verification codes stop the agent", () => {
  assert.equal(G.detectGate(page({
    headings: ["Verify your email"],
    text: "We emailed you a 6-digit code.",
    elements: [el("text", "Verification Code")],
  })).kind, "email_verification");

  assert.equal(G.detectGate(page({
    headings: ["Check your inbox"],
    elements: [el("text", "Code")],
  })).kind, "email_verification");

  // Oracle's interstitial: nothing to fill in yet, just a wait-for-the-email message.
  assert.equal(G.detectGate(page({ headings: ["Email verification required"] })).kind, "email_verification");
});

test("ordinary application pages are not gates", () => {
  assert.equal(G.detectGate(page({
    headings: ["My Information"],
    elements: [el("text", "First Name"), el("text", "Last Name"), el("email", "Email"), el("tel", "Phone")],
  })), null);

  // A code field that is not a verification code.
  assert.equal(G.detectGate(page({
    headings: ["Address"],
    elements: [el("text", "Postal Code"), el("select", "Country Code")],
  })), null);
  assert.equal(G.detectGate(page({ headings: ["Referral"], elements: [el("text", "Referral Code")] })), null);

  // "Verify" wording with no code field to fill: an EEO page, not a gate.
  assert.equal(G.detectGate(page({
    headings: ["Voluntary Disclosures"],
    text: "Please verify the information below is accurate.",
    elements: [el("checkbox", "I agree")],
  })), null);

  assert.equal(G.detectGate(page()), null);
  assert.equal(G.detectGate(null), null);
});
