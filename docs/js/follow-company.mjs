// Explicit employer markup only; no auth/storage/catalog discovery or default page reference.
import { followSelection, FOLLOW_COPY, normalizeFollowEmail } from "./app/follow-form.mjs";
import { createDashboardFollowRequest } from "./app/follow.mjs";

let sequence = 0;

export function mountCompanyFollow(browser, root, { request } = {}) {
  const doc = browser.document;
  const key = root?.getAttribute("data-follow-company-key"),
    label = root?.getAttribute("data-follow-company-label");
  const valid = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value) &&
    new TextEncoder().encode(value).length <= 200;
  if (
    !root ||
    root.ownerDocument !== doc ||
    !root.isConnected ||
    !valid(key) ||
    !valid(label) ||
    root.childNodes.length
  )
    return null;
  const selection = { kind: "company", company: { key, label } },
    selected = followSelection(selection);
  let live = true,
    flight = null,
    open = false;
  const current = () =>
    live &&
    root.isConnected &&
    root.getAttribute("data-follow-company-key") === key &&
    root.getAttribute("data-follow-company-label") === label;
  const send =
    request ||
    createDashboardFollowRequest(browser, {
      enabled: true,
      selection,
      generation: 0,
      getAuth: () => ({ generation: 0, auth: null }),
      isCurrent: current,
    });
  const make = (tag, text) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  root.style.cssText = "max-width:640px;margin-block:16px";
  const toggle = make("button", selected.title),
    form = make("form"),
    emailLabel = make("label", FOLLOW_COPY.emailLabel),
    email = make("input"),
    helper = make("p", FOLLOW_COPY.helper),
    submit = make("button", FOLLOW_COPY.submitLabel),
    status = make("p");
  let id;
  do {
    id = `company-follow-${++sequence}`;
  } while (doc.getElementById(id));
  form.id = id;
  helper.id = id + "-help";
  status.id = id + "-status";
  toggle.setAttribute("aria-controls", id);
  email.setAttribute("aria-describedby", helper.id + " " + status.id);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.style.cssText =
    "min-height:44px;padding:10px 14px;white-space:normal;text-align:left;font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:6px";
  form.hidden = true;
  form.noValidate = true;
  form.setAttribute("aria-label", selected.title);
  form.style.cssText =
    "padding:16px;margin-top:12px;border:1px solid var(--rule);border-radius:8px";
  email.type = "email";
  email.autocomplete = "email";
  email.required = true;
  email.maxLength = 254;
  email.style.cssText =
    "display:block;width:100%;min-height:44px;box-sizing:border-box;padding:8px 10px;font:inherit;color:inherit;background:transparent;border:1px solid var(--rule)";
  emailLabel.append(email);
  helper.className = "more";
  submit.type = "submit";
  submit.style.cssText =
    "min-height:44px;padding:10px 14px;font:inherit;color:var(--accent-ink);background:var(--accent);border:1px solid var(--accent);border-radius:6px";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.tabIndex = -1;
  form.append(emailLabel, helper, submit, status);
  const busy = (on) => {
    toggle.disabled = email.disabled = submit.disabled = on;
    form.setAttribute("aria-busy", String(on));
  };
  const close = () => {
    if (flight) return;
    open = false;
    form.hidden = true;
    email.value = "";
    status.textContent = "";
    email.removeAttribute("aria-invalid");
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  };
  const click = () => {
    if (!current()) return destroy();
    if (open) return close();
    open = true;
    form.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    email.focus();
  };
  const input = () => {
    email.removeAttribute("aria-invalid");
    status.textContent = "";
  };
  const escape = (event) => {
    if (event.key === "Escape" && !flight) {
      event.preventDefault();
      close();
    }
  };
  const submitForm = async (event) => {
    event.preventDefault();
    if (!current()) return destroy();
    if (flight || !open) return;
    const normalized = normalizeFollowEmail(email.value);
    if (normalized === null) {
      email.setAttribute("aria-invalid", "true");
      status.textContent = FOLLOW_COPY.email;
      email.focus();
      return;
    }
    const controller = new browser.AbortController();
    flight = controller;
    busy(true);
    input();
    let accepted = false;
    try {
      accepted =
        (
          await send(
            { email: normalized, link: false, scope: structuredClone(selected.scope) },
            { signal: controller.signal },
          )
        )?.status === "accepted";
    } catch {
      /* approved generic outcome */
    }
    if (!current() || controller.signal.aborted || flight !== controller) return destroy();
    flight = null;
    busy(false);
    status.textContent = accepted ? FOLLOW_COPY.accepted : FOLLOW_COPY.unavailable;
    if (accepted) email.value = "";
    status.focus();
  };
  const observer = new browser.MutationObserver(() => {
    if (!current()) destroy();
  });
  function destroy() {
    if (!live) return;
    live = false;
    flight?.abort();
    observer.disconnect();
    browser.removeEventListener("pagehide", destroy);
    toggle.removeEventListener("click", click);
    form.removeEventListener("submit", submitForm);
    form.removeEventListener("keydown", escape);
    email.removeEventListener("input", input);
    email.value = "";
    root.replaceChildren();
  }
  toggle.addEventListener("click", click);
  form.addEventListener("submit", submitForm);
  form.addEventListener("keydown", escape);
  email.addEventListener("input", input);
  browser.addEventListener("pagehide", destroy);
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-follow-company-key", "data-follow-company-label"],
  });
  // Only expose inputs after every handler/lifecycle guard is installed; a module failure is inert.
  root.append(toggle, form);
  return { destroy };
}

if (typeof window !== "undefined") {
  for (const root of document.querySelectorAll("[data-follow-company-key]"))
    mountCompanyFollow(window, root);
}
