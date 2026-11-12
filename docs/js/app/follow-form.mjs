// Dormant UI. The mounting layer supplies catalog labels, session generation and a request port.
export const FOLLOW_COPY = Object.freeze({
  search: "Email me new roles like these",
  emailLabel: "Email",
  submitLabel: "Email me new internships",
  helper:
    "Confirm your email first. Then get one email a day when there are new matches. No account needed. Unsubscribe any time.",
  link: "Link these follows to my account so Delete my data removes them too.",
  accepted: "If this address can receive email, a confirmation link is on its way.",
  email: "Enter a valid email address.",
  scope: "Choose a company or at least one field or state.",
  unavailable: "Email follows are unavailable. Please try again later.",
});
const COPY = FOLLOW_COPY;
export function normalizeFollowEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 &&
    /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(normalized)
    ? normalized
    : null;
}
// Values and labels come from the same trusted catalog selection, never arbitrary search text.
export function followSelection(selection) {
  const item = (v) =>
    v &&
    typeof v.key === "string" &&
    v.key.length > 0 &&
    v.key.length <= 200 &&
    typeof v.label === "string" &&
    v.label.trim().length > 0;
  if (selection?.kind === "company" && item(selection.company))
    return {
      scope: { kind: "company", company: selection.company.key },
      title: `Email me when ${selection.company.label} posts an internship`,
      summary: "",
    };
  if (selection?.kind !== "search") return null;
  const { fields, states } = selection;
  if (
    ![fields, states].every(
      (a) => Array.isArray(a) && a.length <= 64 && Array.from(a).every(item),
    ) ||
    (!fields.length && !states.length)
  )
    return null;
  return {
    scope: { kind: "search", fields: fields.map((v) => v.key), states: states.map((v) => v.key) },
    title: COPY.search,
    summary: `Following: ${fields.map((v) => v.label).join(", ") || "All fields"}; ${states.map((v) => v.label).join(", ") || "Anywhere"}. Other search filters are not included.`,
  };
}

export function createFollowForm({ h, useState, useRef, useEffect, useId }) {
  function Form({ selected, signedIn, request }) {
    const [open, setOpen] = useState(false),
      [email, setEmail] = useState(""),
      [link, setLink] = useState(false);
    const [busy, setBusy] = useState(false),
      [message, setMessage] = useState(""),
      [invalid, setInvalid] = useState(false);
    const control = useRef(),
      input = useRef(),
      status = useRef(),
      flight = useRef(null),
      live = useRef(true),
      id = useId();
    useEffect(() => {
      live.current = true;
      return () => {
        live.current = false;
        flight.current?.abort();
      };
    }, []);
    useEffect(() => {
      if (open) input.current?.focus();
    }, [open]);
    const close = () => {
      if (!flight.current) {
        setEmail("");
        setLink(false);
        setInvalid(false);
        setMessage("");
        setOpen(false);
        control.current?.focus();
      }
    };
    const submit = async (event) => {
      event.preventDefault();
      if (flight.current) return;
      const normalized = normalizeFollowEmail(email);
      if (normalized === null) {
        setInvalid(true);
        setMessage(COPY.email);
        input.current?.focus();
        return;
      }
      if (!selected) {
        setMessage(COPY.scope);
        return;
      }
      if (typeof request !== "function") {
        setMessage(COPY.unavailable);
        return;
      }
      const controller = new AbortController();
      flight.current = controller;
      setBusy(true);
      setInvalid(false);
      setMessage("");
      let accepted = false;
      try {
        const result = await request(
          { email: normalized, link: signedIn && link, scope: structuredClone(selected.scope) },
          { signal: controller.signal },
        );
        accepted = result?.status === "accepted";
      } catch {
        /* Only the approved generic outcome is exposed. */
      }
      if (!live.current || controller.signal.aborted) return;
      flight.current = null;
      setBusy(false);
      setMessage(accepted ? COPY.accepted : COPY.unavailable);
      if (accepted) {
        setEmail("");
        setLink(false);
      }
      // The live status exists before the asynchronous result, so focus never depends on a new node.
      status.current?.focus();
    };
    const title = selected?.title || COPY.search;
    return h(
      "section",
      { style: { maxWidth: "640px", marginBlock: "16px" } },
      h(
        "button",
        {
          type: "button",
          className: "btn",
          ref: control,
          "aria-expanded": open,
          "aria-controls": id,
          disabled: busy,
          style: {
            whiteSpace: "normal",
            height: "auto",
            minHeight: "44px",
            paddingBlock: "10px",
            textAlign: "left",
          },
          onClick: () => (open ? close() : setOpen(true)),
        },
        title,
      ),
      open &&
        h(
          "form",
          {
            id,
            noValidate: true,
            onSubmit: submit,
            "aria-label": title,
            "aria-busy": busy,
            onKeyDown: (e) => {
              if (e.key === "Escape" && !flight.current) {
                e.preventDefault();
                close();
              }
            },
            style: {
              padding: "16px",
              marginTop: "12px",
              border: "1px solid var(--rule)",
              borderRadius: "var(--r)",
              background: "var(--panel)",
            },
          },
          selected?.summary && h("p", { className: "meta" }, selected.summary),
          h("label", { className: "lbl", htmlFor: id + "-email" }, COPY.emailLabel),
          h("input", {
            id: id + "-email",
            ref: input,
            type: "email",
            autoComplete: "email",
            required: true,
            maxLength: 254,
            value: email,
            disabled: busy,
            "aria-invalid": invalid,
            "aria-describedby": id + "-help " + id + "-status",
            style: {
              width: "100%",
              minHeight: "44px",
              padding: "8px 10px",
              boxSizing: "border-box",
              border: "1px solid var(--field-border)",
              borderRadius: "var(--r)",
              background: "var(--panel)",
              color: "var(--ink)",
              font: "inherit",
            },
            onChange: (e) => {
              setEmail(e.target.value);
              setInvalid(false);
              setMessage("");
            },
          }),
          h("p", { className: "meta", id: id + "-help" }, COPY.helper),
          signedIn &&
            h(
              "label",
              {
                className: "check",
                style: { minHeight: "44px", alignItems: "flex-start", paddingBlock: "8px" },
              },
              h("input", {
                type: "checkbox",
                checked: link,
                disabled: busy,
                onChange: (e) => setLink(e.target.checked),
              }),
              COPY.link,
            ),
          h(
            "div",
            { className: "setup-foot" },
            h(
              "button",
              {
                type: "submit",
                className: "btn primary",
                disabled: busy || !selected,
                style: { minHeight: "44px" },
              },
              COPY.submitLabel,
            ),
          ),
          h(
            "p",
            {
              id: id + "-status",
              ref: status,
              className: "meta",
              role: "status",
              "aria-live": "polite",
              tabIndex: -1,
            },
            selected ? message : COPY.scope,
          ),
        ),
    );
  }
  return function FollowForm({
    enabled = false,
    selection,
    signedIn = false,
    sessionGeneration = 0,
    request,
  }) {
    if (enabled !== true) return null;
    const selected = followSelection(selection);
    // A scope/account change unmounts the old request UI, aborts its signal and resets explicit consent.
    return h(Form, {
      key: JSON.stringify([selected, signedIn === true, sessionGeneration]),
      selected,
      signedIn: signedIn === true,
      request,
    });
  };
}
