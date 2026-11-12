// Negative-only envelope traversal. No event association, coverage advance or provider transport.
import { captureTopupCoverage, closeTopupCoverage } from "./topup-history-coverage.js";
export const HISTORY_TRAVERSAL_BOUNDS = Object.freeze({
  pages: 4,
  pageSize: 100,
  bodyBytes: 262144,
  totalBytes: 524288,
  timeoutMs: 10000,
});
const on = { enabled: true },
  DAY = 86400000;
const held = () => ({ status: "held" });
const fail = () => {
  throw new Error("History traversal unavailable");
};
function copy(value) {
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
// JSON.parse validates grammar first; this iterative pass rejects ambiguous decoded keys.
// The streamed byte cap bounds both passes, including nesting and key sets.
function uniqueJson(text) {
  const value = JSON.parse(text),
    stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") stack.push(c === "{" ? new Set() : null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, i + 1)),
          keys = stack.at(-1);
        if (!keys || keys.has(key)) fail();
        keys.add(key);
      }
    }
  }
  return value;
}
const same = (a, b) =>
  Object.keys(a).sort().join(",") === Object.keys(b).sort().join(",") &&
  Object.keys(a).every((k) => a[k] === b[k]);
const sample = (clock) => {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    void Promise.resolve(value).catch(() => {});
    fail();
  }
  return value;
};

export async function validateTopupHistoryTraversal(db, input, options = {}) {
  if (options?.enabled !== true) return { status: "disabled" };
  const cap = HISTORY_TRAVERSAL_BOUNDS;
  let expected, config, clock, readPage, timeoutMs, initial;
  try {
    config = copy(input);
    expected = copy(config.expected);
    ({ clock = Date.now, readPage, timeoutMs = cap.timeoutMs } = options);
    if (
      Object.keys(config).sort().join(",") !== "apiVersions,expected,from,livemode,schemaKey,to" ||
      typeof config.livemode !== "boolean" ||
      expected.mode !== (config.livemode ? "live" : "test") ||
      typeof config.schemaKey !== "string" ||
      expected.schema_key !== config.schemaKey ||
      typeof clock !== "function" ||
      typeof readPage !== "function" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > cap.timeoutMs ||
      !Number.isSafeInteger(config.from) ||
      !Number.isSafeInteger(config.to) ||
      config.from < 0 ||
      config.from >= config.to ||
      !Number.isSafeInteger(config.to * 1000) ||
      config.to - config.from > 30 * 86400 ||
      !Array.isArray(config.apiVersions) ||
      !config.apiVersions.length ||
      config.apiVersions.length > 4
    )
      fail();
    const versions = [];
    for (let i = 0; i < config.apiVersions.length; i++) {
      const d = Object.getOwnPropertyDescriptor(config.apiVersions, i),
        v = d?.value;
      if (typeof v !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(v) || versions.includes(v))
        fail();
      versions.push(v);
    }
    config = { ...config, apiVersions: versions };
    initial = sample(clock);
    if (
      config.from * 1000 < initial - 30 * DAY ||
      config.to * 1000 > initial ||
      config.from < Math.floor(Date.parse(expected.starts_at) / 1000)
    )
      fail();
  } catch {
    return held();
  }
  const captured = await captureTopupCoverage(db, config.livemode, on);
  if (captured.status !== "captured" || !same(captured.coverage, expected)) return held();
  // Use only the database-validated, copied tuple for any subsequent closure.
  expected = captured.coverage;
  const controller = new AbortController();
  let stopped = false,
    last = initial,
    reader = null,
    total = 0,
    timer;
  const cancel = () => {
    const current = reader;
    if (current) {
      const release = () => {
        try {
          current.releaseLock();
        } catch {
          /* pending read */
        }
      };
      try {
        void Promise.resolve(current.cancel()).then(release, release);
      } catch {
        /* closed reader */
      }
      release();
    }
  };
  const stop = () => {
    stopped = true;
    controller.abort();
    cancel();
  };
  const check = () => {
    const now = sample(clock);
    if (stopped || now < last || now - initial >= timeoutMs || config.from * 1000 < now - 30 * DAY)
      fail();
    last = now;
  };
  const discard = (response) => {
    try {
      void Promise.resolve(response?.body?.cancel()).catch(() => {});
    } catch {
      /* already closed */
    }
  };
  async function body(response) {
    if (stopped) {
      discard(response);
      fail();
    }
    if (response?.status !== 200 || response.redirected || !response.body?.getReader) {
      discard(response);
      fail();
    }
    reader = response.body.getReader();
    try {
      const length = response.headers.get("Content-Length");
      if (
        length !== null &&
        (length.length > 6 || !/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > cap.bodyBytes)
      )
        fail();
      let size = 0,
        text = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (;;) {
        check();
        const part = await reader.read();
        check();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) fail();
        size += part.value.byteLength;
        total += part.value.byteLength;
        if (size > cap.bodyBytes || total > cap.totalBytes) fail();
        text += decoder.decode(part.value, { stream: true });
      }
      if (length !== null && size !== Number(length)) fail();
      return uniqueJson(text + decoder.decode());
    } finally {
      cancel();
      reader = null;
    }
  }
  async function traverse() {
    let cursor = null,
      previous = Infinity;
    const seen = new Set();
    for (let page = 0; page < cap.pages; page++) {
      check();
      const query = Object.freeze({
        created: Object.freeze({ gte: config.from, lt: config.to }),
        limit: cap.pageSize,
        ...(cursor ? { starting_after: cursor } : {}),
      });
      const response = await readPage(query, controller.signal);
      const value = await body(response);
      check();
      if (
        value?.object !== "list" ||
        value.url !== "/v1/events" ||
        typeof value.has_more !== "boolean" ||
        !Array.isArray(value.data) ||
        value.data.length > cap.pageSize ||
        (!value.data.length && (value.has_more || page))
      )
        fail();
      for (const e of value.data) {
        if (
          e?.object !== "event" ||
          typeof e.id !== "string" ||
          !/^evt_[A-Za-z0-9_]{1,250}$/.test(e.id) ||
          seen.has(e.id) ||
          e.livemode !== config.livemode ||
          !config.apiVersions.includes(e.api_version) ||
          !Number.isSafeInteger(e.created) ||
          e.created < config.from ||
          e.created >= config.to ||
          e.created > previous ||
          typeof e.type !== "string" ||
          !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/.test(e.type) ||
          e.type.length > 128 ||
          !e.data?.object ||
          typeof e.data.object !== "object" ||
          Array.isArray(e.data.object)
        )
          fail();
        previous = e.created;
        seen.add(e.id);
      }
      if (!value.has_more) {
        const final = await captureTopupCoverage(db, config.livemode, on);
        check();
        if (final.status !== "captured" || !same(final.coverage, expected)) fail();
        return { status: "unproven" };
      }
      cursor = value.data.at(-1).id;
    }
    fail();
  }
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        stop();
        reject(new Error("History traversal unavailable"));
      }, timeoutMs);
    });
    const result = await Promise.race([traverse(), timeout]);
    check();
    return result;
  } catch {
    stop();
    const closed = await closeTopupCoverage(db, expected, on);
    return closed.status === "committed" ? { status: "closed" } : held();
  } finally {
    clearTimeout(timer);
    stop();
  }
}
