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
