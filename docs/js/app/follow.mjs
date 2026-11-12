// Optional dashboard mount. The shipped document has no release attribute.
import { createFollowForm, followSelection } from "./follow-form.mjs";

export function dashboardFollowSelection(filters, IS) {
  const dimension = (values, pattern, label) => {
    if (
      !Array.isArray(values) ||
      values.length > 80 ||
      !Array.from(values).every((value) => typeof value === "string" && pattern.test(value))
    )
      return null;
    const keys = [...new Set(values)].sort();
    return keys.length <= 64 ? keys.map((key) => ({ key, label: label(key) })) : null;
  };
  const fields = dimension(filters?.fields, /^[a-z_]{2,32}$/, IS.fieldLabel);
  const picked = filters?.states;
  if (
    !Array.isArray(picked) ||
    picked.length > 80 ||
    !Array.from(picked).every((value) => typeof value === "string")
  )
    return null;
  // Mixed URL-derived Everywhere/state chips are ambiguous for a saved follow.
  if (picked.includes(IS.ALL_KEY) && picked.some((key) => key !== IS.ALL_KEY)) return null;
  const states = dimension(picked.includes(IS.ALL_KEY) ? [] : picked, /^[A-Z]{2}$/, IS.keyLabel);
  const selection = { kind: "search", fields, states };
  return fields && states && followSelection(selection) ? selection : null;
}

export function dashboardFollowSession(auth, IS) {
  const who = auth?.who;
  return !!(
    who?.session === true &&
    who.token === auth.token &&
    /^iss_[A-Za-z0-9_-]{43}$/.test(auth.token) &&
    IS.authOk(who)
  );
}

export function createDashboardFollowRequest(
  browser,
  { enabled = false, selection, generation, getAuth, renderedToken },
) {
  const scope = followSelection(selection)?.scope;
  return async (input, { signal } = {}) => {
    const unavailable = { status: "unavailable" };
    if (
      enabled !== true ||
      !scope ||
      signal?.aborted ||
      typeof input?.link !== "boolean" ||
      JSON.stringify(input.scope) !== JSON.stringify(scope)
    )
      return unavailable;
    const initial = getAuth();
    if (
      initial.generation !== generation ||
      (input.link &&
        (initial.auth?.token !== renderedToken ||
          !dashboardFollowSession(initial.auth, browser.IS)))
    )
      return unavailable;
    const controller = new browser.AbortController();
    let timer, response, reader;
    const originalExpiry = initial.auth?.who?.exp;
    const start = browser.performance.now();
    const now = () => browser.performance.now();
    const current = () => {
      const latest = getAuth();
      const elapsed = now() - start;
      return (
        !controller.signal.aborted &&
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed < 12000 &&
        latest.generation === generation &&
        (!input.link ||
          (latest.auth?.token === renderedToken &&
            browser.Date.now() < originalExpiry &&
            dashboardFollowSession(latest.auth, browser.IS)))
      );
    };
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const stopped = new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(null), { once: true });
        timer = browser.setTimeout(abort, 12000);
      });
      if (signal?.aborted || !current()) return unavailable;
      // No account refresh, fallback, persisted credentials or retry. The server owns membership.
      const headers = { "Content-Type": "application/json" };
      if (input.link) headers.Authorization = `Bearer ${initial.auth.token}`;
      response = await Promise.race([
        browser.fetch("https://internscout-api.bpmcginley.workers.dev/follows/signup", {
          method: "POST",
          headers,
          body: JSON.stringify({ email: input.email, link: input.link, scope }),
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          mode: "cors",
          referrerPolicy: "no-referrer",
        }),
        stopped,
      ]);
      if (!current() || response?.status !== 202) return unavailable;
      if (response.body) {
        reader = response.body.getReader();
        const end = await Promise.race([reader.read(), stopped]);
        if (!current() || end?.done !== true) return unavailable;
      }
      return current() ? { status: "accepted" } : unavailable;
    } catch {
      return unavailable;
    } finally {
      browser.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else void response?.body?.cancel().catch(() => {});
    }
  };
}

export function createDashboardFollow(browser) {
  const h = browser.React.createElement;
  const Form = createFollowForm({ ...browser.React, h });
  const enabled =
    browser.document?.documentElement?.getAttribute?.("data-follow-signup-enabled") === "1";
  return function DashboardFollow({ filters, auth, generation, getAuth }) {
    if (!enabled) return null;
    const selection = dashboardFollowSelection(filters, browser.IS);
    if (!selection) return null;
    return h(Form, {
      enabled: true,
      selection,
      signedIn: dashboardFollowSession(auth, browser.IS),
      sessionGeneration: generation,
      request: createDashboardFollowRequest(browser, {
        enabled,
        selection,
        generation,
        getAuth,
        renderedToken: auth?.token,
      }),
    });
  };
}
