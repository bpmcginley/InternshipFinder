import test from "node:test";
import assert from "node:assert/strict";
import { inspectReviewDocument } from "../background/review-handoff.js";

test("plain review copy falls back for explicit unmet answers and errors", async () => {
  class Element {
    constructor(localName, innerText) {
      this.localName = localName;
      this.innerText = innerText;
    }
    hasAttribute() {
      return false;
    }
    getAttribute() {
      return null;
    }
    matches() {
      return false;
    }
    closest() {
      return null;
    }
    getClientRects() {
      return [{}];
    }
  }

  const submit = new Element("button", "Submit Application");
  const heading = new Element("h1", "Review Your Application");
  const form = {
    method: "post",
    action: "https://example.test/application",
    querySelector: () => submit,
  };
  submit.form = form;
  const body = { innerText: "All required answers are complete. No errors found." };
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    designMode: "off",
    forms: [form],
    body,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "*") return [submit, heading];
      if (selector === "h1,h2") return [heading];
      return [submit];
    },
  };
  const window = {};
  window.top = window;
  const globals = {
    chrome: { dom: { openOrClosedShadowRoot: () => null } },
    window,
    document,
    location: new URL(form.action),
    HTMLElement: Element,
    HTMLInputElement: class extends Element {},
    getComputedStyle: () => ({ visibility: "visible" }),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, globals);
  try {
    assert.equal((await inspectReviewDocument()).length, 32);
    for (const warning of [
      "Required work authorization answer missing.",
      "This field is required.",
      "Complete all required fields before submitting.",
      "Your answer is not yet provided.",
      "Validation failed. Correct the errors.",
      "Your application has 1 error.",
    ]) {
      body.innerText = "Review Your Application. " + warning;
      assert.equal(await inspectReviewDocument(), null, warning);
    }
  } finally {
    Object.assign(globalThis, previous);
  }
});
