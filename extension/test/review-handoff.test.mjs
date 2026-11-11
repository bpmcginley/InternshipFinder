import test from "node:test";
import assert from "node:assert/strict";
import { inspectReviewDocument } from "../background/review-handoff.js";
import { withReviewDocument } from "./fixtures/review-document.mjs";

test("plain review copy falls back for unmet or uncertain answers and errors", async () => {
  await withReviewDocument(async (body) => {
    for (const complete of [
      "All required answers are complete. No errors found.",
      "All required questions have been answered. No further action is required.",
      "Review every answer before you submit.",
    ]) {
      body.innerText = complete;
      assert.equal((await inspectReviewDocument()).length, 32, complete);
    }
    for (const warning of [
      "Required work authorization answer missing.",
      "Required field: work authorization.",
      "You have unanswered required questions.",
      "Work authorization is required.",
      "Not all required answers are complete.",
      "This field is required.",
      "Complete all required fields before submitting.",
      "Your answer is not yet provided.",
      "Validation failed. Correct the errors.",
      "Your application has 1 error.",
    ]) {
      body.innerText = "Review Your Application. " + warning;
      assert.equal(await inspectReviewDocument(), null, warning);
    }
  });
});

test("inspection discards even valid copy changed while its digest is outstanding", async () => {
  const options = {
    bodyText: "Review every answer before you submit.",
    duringDigest: (body) => {
      body.innerText = "Review your name and start date before you submit.";
    },
  };
  assert.equal(await withReviewDocument(inspectReviewDocument, options), null);
});
