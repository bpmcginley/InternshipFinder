const COPY = {
  unavailable: "Email follows are unavailable. Please try again later.",
  invalid: "This management link is no longer valid. Enter your email to request a new one.",
  empty: "You have no follows to manage.",
  receipt: "If this address can receive email, a management link is on its way.",
};
const LINK_INVALID = Symbol("invalid management link");
const REQUEST_ACCEPTED = Symbol("management request accepted");
const encoder = new TextEncoder();
const boundedKey = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  encoder.encode(value).length <= 4096 &&
  !/[\ud800-\udfff]/u.test(value);

// Retained scopes need no current signup catalog. Display facts as text only;
// send the original scope key and cursor unchanged to the capability handlers.
export function scopeFacts(key) {
  if (!boundedKey(key)) throw new Error("scope");
  const scope = JSON.parse(key);
  if (scope?.kind === "company" && typeof scope.company === "string" && scope.company)
    return scope.company;
  if (
    scope?.kind === "search" &&
    Array.isArray(scope.fields) &&
    Array.isArray(scope.states) &&
    scope.fields.concat(scope.states).every((value) => typeof value === "string" && value)
  )
    return `Following: ${scope.fields.join(", ") || "All fields"}; ${scope.states.join(", ") || "Anywhere"}. Other search filters are not included.`;
  throw new Error("scope");
}

async function replyBody(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  const stop = () => {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {}
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const part = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (part.done) return text + decoder.decode();
      size += part.value.byteLength;
      if (size > 262144) throw new Error("response");
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

// Trusted static opt-in only. No URL, identity or policy comes from the link.
export function createManagementTransport({
  enabled = false,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (enabled !== true || typeof fetchImpl !== "function") return null;
  return (operation, body, { signal }) => {
    if (!["list", "remove", "deleteAll", "request"].includes(operation))
      throw new Error("operation");
    return fetchImpl(
      operation === "list"
        ? "https://internscout-api.bpmcginley.workers.dev/follows/manage/list"
        : operation === "remove"
          ? "https://internscout-api.bpmcginley.workers.dev/follows/manage/remove"
          : operation === "deleteAll"
            ? "https://internscout-api.bpmcginley.workers.dev/follows/manage/delete"
            : "https://internscout-api.bpmcginley.workers.dev/follows/manage/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        mode: "cors",
        referrerPolicy: "no-referrer",
        signal,
      },
    );
  };
}

export function mountManagementPage({
  document,
  lifecycle,
  transport = null,
  timers = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  timeoutMs = 12000,
}) {
  const el = (id) => document.getElementById(id);
  const list = el("scopes"),
    status = el("status"),
    load = el("load"),
    more = el("more");
  const removeAll = el("delete"),
    email = el("email"),
    requestButton = el("request-button");
  let busy = false,
    controller,
    cursor = null,
    rows = new Map(),
    loaded = false,
    serial = 0;
  const tell = (text) => {
    status.textContent = text;
  };
  function controls() {
    const state = lifecycle.read();
    for (const button of document.querySelectorAll("button"))
      button.disabled = busy || !state.active;
    load.disabled ||= !state.token;
    more.disabled ||= !state.token || !cursor;
    removeAll.disabled ||= !state.token || !loaded;
    email.disabled = busy || !state.active;
    list.setAttribute("aria-busy", String(busy));
  }
  function reset() {
    controller?.abort();
    busy = false;
    cursor = null;
    loaded = false;
    rows = new Map();
    list.replaceChildren();
    email.value = "";
    more.hidden = true;
    removeAll.hidden = true;
    requestButton.textContent = lifecycle.read().token
      ? "Email me a management link"
      : "Email me a new management link";
    tell(lifecycle.read().token ? "" : COPY.invalid);
    controls();
  }
  lifecycle.subscribe(reset);
  reset();
  async function act(kind, body, apply) {
    if (!lifecycle.read().active || lifecycle.receive() || busy) return;
    const version = lifecycle.read().version;
    const current = () => lifecycle.read().active && lifecycle.read().version === version;
    busy = true;
    controls();
    tell("");
    const abort = new AbortController();
    controller = abort;
    let timeout, focusAfter;
    try {
      const operation = (async () => {
        if (typeof transport !== "function") throw new Error("unavailable");
        const response = await transport(kind, body, { signal: abort.signal });
        if (!current() || lifecycle.receive() || abort.signal.aborted) return;
        if (kind === "request") {
          if (response.status !== 202) throw new Error("unavailable");
          return REQUEST_ACCEPTED;
        }
        if (response.status === 410 && kind === "list") return LINK_INVALID;
        if (response.status !== 200) throw new Error("unavailable");
        const raw = await replyBody(response, abort.signal);
        return JSON.parse(raw);
      })();
      const result = await Promise.race([
        operation,
        new Promise((_, reject) => {
          timeout = timers.setTimeout(() => {
            abort.abort();
            reject(new Error("timeout"));
          }, timeoutMs);
        }),
      ]);
      if (!current() || lifecycle.receive() || abort.signal.aborted) return;
      if (result === LINK_INVALID) {
        lifecycle.forget();
        status.focus();
        return;
      }
      focusAfter = apply(result);
    } catch {
      if (current() && !lifecycle.receive()) {
        tell(COPY.unavailable);
        status.focus();
      }
    } finally {
      timers.clearTimeout(timeout);
      if (current()) {
        busy = false;
        controls();
        focusAfter?.focus();
      }
    }
  }
  function showPage(page, append) {
    if (
      !page ||
      !Array.isArray(page.scopes) ||
      page.scopes.length > 50 ||
      !(page.next === null || boundedKey(page.next))
    )
      throw new Error("page");
    const incoming = new Map();
    for (const scope of page.scopes) {
      if (
        !scope ||
        !boundedKey(scope.scope_key) ||
        incoming.has(scope.scope_key) ||
        (append && rows.has(scope.scope_key)) ||
        typeof scope.created !== "string" ||
        !(scope.confirmed_at === null || typeof scope.confirmed_at === "string")
      )
        throw new Error("row");
      incoming.set(scope.scope_key, {
        facts: scopeFacts(scope.scope_key),
        confirmed: scope.confirmed_at !== null,
      });
    }
    if (
      page.next !== null &&
      (!page.scopes.length ||
        page.next !== page.scopes.at(-1).scope_key ||
        (append && page.next === cursor))
    )
      throw new Error("cursor");
    if (!append) {
      rows = new Map();
      list.replaceChildren();
    }
    let first;
    for (const [key, value] of incoming) {
      const item = document.createElement("li"),
        facts = document.createElement("p");
      facts.id = `follow-scope-${++serial}`;
      facts.className = "scope";
      facts.textContent = value.facts;
      facts.tabIndex = -1;
      const confirmation = document.createElement("p");
      confirmation.className = "confirmation";
      confirmation.textContent = value.confirmed ? "Confirmed" : "Pending confirmation";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Remove this follow";
      button.setAttribute("aria-describedby", facts.id);
      button.addEventListener("click", () => {
        const token = lifecycle.read().token;
        if (!token) return;
        void act("remove", [token, key], (result) => {
          if (result?.removed !== true) throw new Error("unavailable");
          const next = item.nextElementSibling?.querySelector("button") || load;
          item.remove();
          rows.delete(key);
          tell("Follow removed.");
          return next;
        });
      });
      item.append(facts, confirmation, button);
      list.append(item);
      rows.set(key, item);
      first ||= facts;
    }
    loaded = true;
    cursor = page.next;
    more.hidden = cursor === null;
    removeAll.hidden = false;
    tell(rows.size ? "" : COPY.empty);
    (first || status).focus();
  }
  function getPage(append) {
    const token = lifecycle.read().token;
    if (token) void act("list", [token, append ? cursor : null], (page) => showPage(page, append));
  }
  load.addEventListener("click", () => getPage(false));
  more.addEventListener("click", () => getPage(true));
  removeAll.addEventListener("click", () => {
    const token = lifecycle.read().token;
    if (token)
      void act("deleteAll", [token], (result) => {
        if (result?.deleted !== true) throw new Error("unavailable");
        lifecycle.forget();
        tell("All your follows and queued emails have been deleted.");
        status.focus();
      });
  });
  el("request").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!lifecycle.read().active || lifecycle.receive() || busy) return;
    const value = email.value.trim();
    if (!value || !email.checkValidity()) {
      tell("Enter a valid email address.");
      email.focus();
      return;
    }
    void act("request", { email: value }, (result) => {
      if (result !== REQUEST_ACCEPTED) throw new Error("unavailable");
      email.value = "";
      tell(COPY.receipt);
      status.focus();
    });
  });
}
