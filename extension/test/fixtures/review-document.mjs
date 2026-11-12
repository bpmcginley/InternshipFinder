// Minimal isolated-world document for the real review inspector.
export async function withReviewDocument(run, { bodyText, duringDigest } = {}) {
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
  const body = { innerText: bodyText };
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
    chrome: { ...globalThis.chrome, dom: { openOrClosedShadowRoot: () => null } },
    window,
    document,
    location: new URL(form.action),
    HTMLElement: Element,
    HTMLInputElement: class extends Element {},
    getComputedStyle: () => ({ visibility: "visible" }),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, globals);
  const { subtle } = globalThis.crypto;
  const originalDigest = Object.getOwnPropertyDescriptor(subtle, "digest");
  if (duringDigest) {
    const digest = subtle.digest.bind(subtle);
    Object.defineProperty(subtle, "digest", {
      configurable: true,
      async value(...args) {
        const result = await digest(...args);
        duringDigest(body);
        return result;
      },
    });
  }
  try {
    return await run(body);
  } finally {
    if (duringDigest && originalDigest) Object.defineProperty(subtle, "digest", originalDigest);
    else if (duringDigest) delete subtle.digest;
    Object.assign(globalThis, previous);
  }
}
