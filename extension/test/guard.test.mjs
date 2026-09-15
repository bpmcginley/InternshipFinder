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

// ---- gates the human clears themselves ----
const page = (o = {}) => ({ headings: [], step: "", buttons: [], text: "", elements: [], ...o });
const el = (kind, label, extra = {}) => ({ kind, label, question: "", ...extra });

test("password fields always stop the agent", () => {
  // Workday's "Create Account" modal: password + verify password.
  assert.equal(G.detectGate(page({
    headings: ["Create Account"],
    elements: [el("email", "Email Address"), el("password", "Password"), el("password", "Verify New Password")],
  })).kind, "account_creation");

  // One password box and signup wording.
  assert.equal(G.detectGate(page({ headings: ["Sign up"], elements: [el("password", "Password")] })).kind, "account_creation");
  assert.equal(G.detectGate(page({ headings: ["Choose a password"], elements: [el("password", "Password")] })).kind, "account_creation");

  // One password box and sign-in wording. Still a password, still not ours to type.
  assert.equal(G.detectGate(page({ headings: ["Sign In"], elements: [el("email", "Email"), el("password", "Password")] })).kind, "sign_in");

  // Unlabelled password box on an otherwise blank page.
  assert.ok(G.detectGate(page({ elements: [el("password", "")] })));
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
