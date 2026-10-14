// PR #94 review, P2 "Auto-Apply safety" (2026-10-14): what the agent may press on the review step, and
// consent buttons in the middle of an application. Neither may weaken the rule that the student always
// presses the final Submit.
import test from "node:test";
import assert from "node:assert/strict";
import "../agent/guard.js";

const G = globalThis.ISGuard;
const btn = (text, extra = {}) => ({ text, value: "", ariaLabel: "", title: "", type: "button", automationId: "", formFilled: 0, ...extra });
const REVIEW = { filledFields: 0, runFilled: true, reviewStep: true };

test("on the review step an unfamiliar button is refused whatever its type", () => {
  // <button type=button>Let's make it official</button> and <div role=button>Go</div> (describe gives type "")
  for (const d of [btn("Let's make it official"), btn("Go", { type: "" }), btn("Make it official", { type: "" }),
    btn("Let's go", { type: "button" }), btn("I agree"), btn("Accept"), btn("OK"), btn("Proceed"), btn("Accept and continue"), btn("")]) {
    const v = G.allowClick(d, REVIEW);
    assert.equal(v.allowed, false, JSON.stringify(d.text));
    // the same button with no review heading and nothing filled is still usable
  }
  assert.equal(G.allowClick(btn("Let's make it official"), { filledFields: 0, runFilled: true, reviewStep: false }).allowed, true);
  assert.equal(G.allowClick(btn("Go", { type: "" }), { filledFields: 2 }).allowed, true);
});

test("on the review step the ways back, forward and the account buttons still work", () => {
  for (const t of ["Back", "Previous", "Next", "Continue", "Save and Continue", "Edit", "Edit section", "Review application",
    "Save", "Cancel", "Sign in", "Create Account", "Upload", "Go back"]) {
    assert.equal(G.allowClick(btn(t), REVIEW).allowed, true, t);
    assert.equal(G.allowClick(btn(t, { type: "" }), REVIEW).allowed, true, t + " (div role=button)");
  }
});

test("send-like buttons stay refused on the review step, and the refusal there is not the weak kind", () => {
  for (const t of ["Submit", "Apply", "Finish", "Confirm", "Send application"]) {
    const v = G.allowClick(btn(t), REVIEW);
    assert.equal(v.allowed, false, t);
    assert.notEqual(v.review, true, t + " is outlined as the send button");
  }
  assert.equal(G.allowClick(btn("Print"), REVIEW).review, true, "an unfamiliar button is the weak kind");
});

test("Accept and I agree move a consent page on once the run has filled earlier pages", () => {
  const mid = { filledFields: 1, runFilled: true, reviewStep: false };
  for (const t of ["Accept", "I Agree", "I accept", "Agree", "I acknowledge", "I agree to the terms", "Accept terms and conditions", "I consent"]) {
    assert.equal(G.allowClick(btn(t, { type: "submit", formFilled: 0 }), mid).allowed, true, t + " (submit, form empty)");
    assert.equal(G.allowClick(btn(t, { type: "submit", formFilled: 1 }), mid).allowed, true, t + " (submit, the consent box ticked)");
    assert.equal(G.allowClick(btn(t), mid).allowed, true, t + " (plain button)");
    assert.equal(G.isConsent(btn(t)), true, t);
  }
});

test("consent buttons never become a way round the final Submit", () => {
  const mid = { filledFields: 1, runFilled: true, reviewStep: false };
  // Labels that send the application are final whatever word they start with.
  for (const t of ["I agree and apply", "Agree & Submit", "Accept and submit", "I agree and submit my application"]) {
    assert.equal(G.allowClick(btn(t, { type: "submit" }), mid).allowed, false, t);
    assert.equal(G.allowClick(btn(t), mid).allowed, false, t + " (plain button)");
  }
  // On the review step, refused.
  for (const t of ["Accept", "I Agree"]) {
    assert.equal(G.allowClick(btn(t, { type: "submit" }), REVIEW).allowed, false, t + " on the review step");
    assert.equal(G.allowClick(btn(t), REVIEW).allowed, false, t + " (plain) on the review step");
  }
  // In a form that holds a whole application, "I agree" may be the send button.
  const full = { filledFields: 9, runFilled: true, reviewStep: false };
  assert.equal(G.allowClick(btn("I agree", { type: "submit", formFilled: 9 }), full).allowed, false);
  assert.equal(G.allowClick(btn("Accept", { type: "submit", formFilled: 0 }), full).allowed, false, "a full page, even with the button outside the form");
  // A Workday-style id that says submit still wins.
  assert.equal(G.allowClick(btn("I Agree", { automationId: "submitApplication" }), mid).allowed, false);
  // A consent word in front of something else is not a bare consent button.
  assert.equal(G.isConsent(btn("Accept offer and send")), false);
});
