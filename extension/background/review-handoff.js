/** An isolated-world proof for one simple, native review form. Absence of proof keeps the model path. */
export async function inspectReviewDocument() {
  const capture = () => {
    const shadowRoot = chrome.dom?.openOrClosedShadowRoot;
    if (
      typeof shadowRoot !== "function" ||
      window !== window.top ||
      document.readyState !== "complete" ||
      document.visibilityState !== "visible" ||
      document.designMode !== "off" ||
      document.forms.length !== 1
    )
      return null;
    const nodes = document.querySelectorAll("*");
    if (
      nodes.length > 1500 ||
      Array.from(nodes).some(
        (element) =>
          element.localName.includes("-") ||
          element.hasAttribute("is") ||
          (element instanceof HTMLElement && shadowRoot(element)),
      )
    )
      return null;
    if (
      document.querySelector(
        "iframe, frame, fencedframe, object, embed, portal, applet, " +
          "[aria-busy='true'], [aria-invalid='true'], [role='alert'], .error, .field-error, .error-message",
      )
    )
      return null;

    const form = document.forms[0];
    const submit = form.querySelector("button[type='submit'], input[type='submit']");
    if (
      !submit ||
      submit.form !== form ||
      form.method !== "post" ||
      new URL(form.action).origin !== location.origin ||
      (form.target && form.target !== "_self") ||
      submit.matches(":disabled") ||
      !submit.getClientRects().length ||
      submit.closest("[inert], [aria-hidden='true'], [aria-disabled='true']") ||
      getComputedStyle(submit).visibility !== "visible" ||
      submit.matches("[formaction], [formmethod], [formtarget], [onclick]")
    )
      return null;

    const text = (value) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const label = text(submit instanceof HTMLInputElement ? submit.value : submit.innerText);
    if (
      label !== "submit application" ||
      [submit.getAttribute("aria-label"), submit.title].some(
        (value) => value && text(value) !== label,
      ) ||
      !Array.from(document.querySelectorAll("h1,h2")).some(
        (heading) =>
          heading.getClientRects().length &&
          getComputedStyle(heading).visibility === "visible" &&
          /^review (your )?application$/.test(text(heading.innerText)),
      )
    )
      return null;

    const controls = document.querySelectorAll(
      "button, input, select, textarea, [contenteditable], " +
        "a[href], area[href], summary, [tabindex], [role], [onclick], [onkeydown], [onkeypress], " +
        "audio[controls], video[controls]",
    );
    for (const control of controls) {
      if (control === submit || control.matches("input[type='hidden']:not([required])")) continue;
      if (
        control.matches("[role='main'], [role='heading'], [role='region']") &&
        !control.matches(
          "[tabindex], [onclick], [onkeydown], [onkeypress], [contenteditable], " +
            "button, input, select, textarea, a[href], area[href], summary, audio[controls], video[controls]",
        )
      )
        continue;
      return null;
    }

    const bodyText = document.body.innerText;
    if (
      bodyText.length > 12_000 ||
      /\b(consent|attest|acknowledg\w*|i agree|by (clicking|submitting)|accept (the|these) terms|captcha)\b/i.test(
        bodyText,
      )
    )
      return null;
    // Required-answer or error language is ambiguous unless it is a complete, affirmative status.
    const complete = [
      /^all (?:the )?required (?:answers?|fields?|questions?) (?:are complete|(?:are|have been) (?:answered|completed|provided))$/,
      /^no (?:validation )?errors? (?:found|detected|remain)$/,
      /^no (?:further |additional )?action is required$/,
      /^(?:there are )?no (?:unanswered|missing|incomplete) (?:required )?(?:answers?|fields?|questions?)$/,
    ];
    const warningText = bodyText
      .split(/[.!?;\r\n]+/)
      .map(text)
      .filter((sentence) => !complete.some((status) => status.test(sentence)))
      .join(" ");
    if (
      /\b(required|unanswered|missing|incomplete|blank|invalid|errors?|validation failed)\b/.test(
        warningText,
      ) ||
      /\b(?:answer|field|question)s? (?:is |are )?not (?:yet )?(?:answered|provided|complete|completed)\b/.test(
        warningText,
      ) ||
      /\bplease (?:answer|complete|fill in|fill out|provide|select)\b/.test(warningText)
    )
      return null;
    return JSON.stringify([location.href, form.action, bodyText]);
  };
  const captured = capture();
  if (captured === null) return null;
  // Keep application contents in the document. Only an ephemeral equality proof leaves it.
  const signature = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(captured));
  // Page scripts can update the form while the asynchronous digest is outstanding.
  if (capture() !== captured) return null;
  return Array.from(new Uint8Array(signature));
}

export async function confirmFinalReview({ execute, documentId, gen, active }) {
  try {
    const read = async (func, world, args = []) => {
      const [entry] = await execute(func, world, args);
      return entry?.documentId === documentId && entry.frameId === 0 ? entry.result : null;
    };
    const before = await read(inspectReviewDocument, "ISOLATED");
    if (!before || !(await active())) return false;
    const highlighted = await read((opts) => window.ISDom?.highlight(opts), "MAIN", [
      { runFilled: true, gen },
    ]);
    if (
      highlighted?.final !== true ||
      highlighted.missing !== 0 ||
      highlighted.stopped ||
      !(await active())
    )
      return false;
    const after = await read(inspectReviewDocument, "ISOLATED");
    return (
      !!after &&
      before.length === 32 &&
      after.length === 32 &&
      before.every((byte, i) => byte === after[i]) &&
      (await active())
    );
  } catch {
    return false;
  }
}
