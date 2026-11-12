// Dormant bounded replay. Valid pagination is not proof of continuous history coverage.
import {
  createTopupHistoryPageReader,
  validTopupHistoryRequestVersion,
} from "./topup-history-page.js";
import {
  validateTopupHistoryTraversal,
  HISTORY_TRAVERSAL_BOUNDS,
} from "./topup-history-traversal.js";
import { captureTopupCoverage, closeTopupCoverage } from "./topup-history-coverage.js";
import { observeVerifiedTopupEvent } from "./topup-history-events.js";
const on = { enabled: true },
  held = () => ({ status: "held" });
const fail = () => {
  throw new Error("History replay unavailable");
};
function record(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const result = Object.create(null);
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!d.enumerable || !Object.hasOwn(d, "value")) fail();
    result[key] = d.value;
  }
  return result;
}
const same = (a, b) =>
  Object.keys(a).sort().join(",") === Object.keys(b).sort().join(",") &&
  Object.keys(a).every((k) => a[k] === b[k]);
const discard = (response) => {
  try {
    void Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {}
};
export async function replayTopupHistoryTarget(db, env, input, options = {}) {
  return replay(db, env, input, options, false);
}
export async function replayTopupHistoryWindow(db, env, input, options = {}) {
  return replay(db, env, input, options, true);
}
async function replay(db, env, input, options, wholeWindow) {
  if (options.enabled !== true) return { status: "disabled" };
  let config,
    provider,
    targetEventId,
    requestVersion,
    fetchImpl,
    resolveOffer,
    clock,
    timeoutMs,
    initial;
  try {
    ({
      targetEventId,
      requestVersion,
      fetchImpl,
      resolveOffer,
      clock = Date.now,
      timeoutMs,
    } = options);
    config = record(input);
    config.expected = record(config.expected);
    if (
      !Array.isArray(config.apiVersions) ||
      !config.apiVersions.length ||
      config.apiVersions.length > 4
    )
      fail();
    const versions = [];
    for (let i = 0; i < config.apiVersions.length; i++) {
      const d = Object.getOwnPropertyDescriptor(config.apiVersions, i);
      if (!d?.enumerable || !Object.hasOwn(d, "value") || typeof d.value !== "string") fail();
      versions.push(d.value);
    }
    config.apiVersions = versions;
    provider = Object.freeze({
      STRIPE_SECRET_KEY: env?.STRIPE_SECRET_KEY,
      STRIPE_PRICE_TOPUP: env?.STRIPE_PRICE_TOPUP,
    });
    if (
      typeof provider.STRIPE_SECRET_KEY !== "string" ||
      !provider.STRIPE_SECRET_KEY ||
      (provider.STRIPE_PRICE_TOPUP !== undefined &&
        typeof provider.STRIPE_PRICE_TOPUP !== "string") ||
      !validTopupHistoryRequestVersion(requestVersion) ||
      (wholeWindow
        ? targetEventId !== undefined
        : typeof targetEventId !== "string" || !/^evt_[A-Za-z0-9_]{1,250}$/.test(targetEventId)) ||
      typeof fetchImpl !== "function" ||
      typeof resolveOffer !== "function" ||
      typeof clock !== "function" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > HISTORY_TRAVERSAL_BOUNDS.timeoutMs
    )
      fail();
    initial = clock();
    if (!Number.isSafeInteger(initial) || initial < 0) {
      void Promise.resolve(initial).catch(() => {});
      fail();
    }
  } catch {
    return held();
  }
  const started = performance.now(),
    controller = new AbortController();
  let last = initial,
    timer,
    authorized,
    closure,
    closureResult;
  const remaining = () => {
    const now = clock();
    if (!Number.isSafeInteger(now)) {
      void Promise.resolve(now).catch(() => {});
      fail();
    }
    if (controller.signal.aborted || now < last) fail();
    last = now;
    const left = Math.floor(timeoutMs - Math.max(performance.now() - started, now - initial));
    if (left < 1) fail();
    return left;
  };
  const request = async (url, init) => {
    remaining();
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.any([controller.signal, init.signal]),
    });
    try {
      remaining();
      return response;
    } catch {
      discard(response);
      fail();
    }
  };
  const readPage = createTopupHistoryPageReader({
    enabled: true,
    requestVersion,
    request: (url, init) =>
      request(url, {
        ...init,
        headers: { ...init.headers, Authorization: "Bearer " + provider.STRIPE_SECRET_KEY },
      }),
  });
  const closeOnce = () => {
    if (!authorized) return Promise.resolve({ status: "unavailable" });
    return (closure ??= closeTopupCoverage(db, authorized, on).then(
      (result) => (closureResult = result),
    ));
  };
  const current = async () => {
    remaining();
    const captured = await captureTopupCoverage(db, config.livemode, on);
    remaining();
    return captured.status === "captured" && authorized && same(captured.coverage, authorized);
  };
  async function run() {
    const traversed = await validateTopupHistoryTraversal(db, config, {
      enabled: true,
      readPage,
      clock,
      timeoutMs: remaining(),
      ...(wholeWindow ? { collectEvents: true } : { targetEventId }),
      onCaptured: (expected) => {
        remaining();
        authorized = Object.freeze({ ...expected });
        return true;
      },
      closeCoverage: closeOnce,
    });
    if (traversed.status !== "unproven") return traversed;
    remaining();
    const events = wholeWindow ? traversed.events : traversed.event ? [traversed.event] : null;
    if (!events || !(await current())) fail();
    const counts = { observed: 0, duplicate: 0, inactive: 0 };
    let result;
    for (const [index, event] of events.entries()) {
      if (index && !(await current())) fail();
      result = await observeVerifiedTopupEvent(db, provider, event, {
        enabled: true,
        livemode: config.livemode,
        apiVersions: config.apiVersions,
        fetchImpl: request,
        resolveOffer,
        timeoutMs: remaining(),
        beforeObserve: current,
      });
      remaining();
      if (!["observed", "duplicate", "inactive"].includes(result.status)) fail();
      if (!(await current())) fail();
      counts[result.status]++;
    }
    return wholeWindow ? { status: "handled_unproven", ...counts } : result;
  }

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("History replay unavailable"));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([run(), timeout]);
    if (["closed", "held"].includes(result.status)) return result;
    remaining();
    return result;
  } catch {
    let live = false;
    try {
      remaining();
      live = true;
    } catch {}
    controller.abort();
    const pending = closeOnce();
    // A closure already admitted may commit after timeout; never issue another attempt.
    if (!live) return closureResult?.status === "committed" ? { status: "closed" } : held();
    const closed = await Promise.race([pending, timeout.catch(() => null)]);
    return closed?.status === "committed" ? { status: "closed" } : held();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
