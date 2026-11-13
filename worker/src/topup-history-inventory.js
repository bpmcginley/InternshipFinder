import { uniqueJson, HISTORY_TRAVERSAL_BOUNDS } from "./topup-history-traversal.js";
import { topupReversalObject } from "./topup-reversal-types.js";

const unavailable = () => ({ status: "unavailable" });
const fail = () => {
  throw new Error("History inventory unavailable");
};
const own = (value) => {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const result = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    result[key] = descriptor.value;
  }
  return result;
};
const exact = (value, keys) => {
  const result = own(value);
  if (Object.keys(result).sort().join(",") !== keys.split(",").sort().join(",")) fail();
  return result;
};
const discard = (response) => {
  try {
    void Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {}
};

// No DB, URL, credential, coverage transition or provider-specific transport.
// The injected reader must honor the explicit copied request policy.
export async function inventoryTopupHistory(input, options = {}) {
  let config, readPage, clock, policy, cap, initial;
  try {
    const o = own(options);
    if (o.enabled !== true) return { status: "disabled" };
    if (
      Object.keys(o).some(
        (k) => !["enabled", "readPage", "clock", "requestPolicy", "limits"].includes(k),
      )
    )
      fail();
    config = exact(input, "from,to,livemode,apiVersions");
    policy = exact(o.requestPolicy, "method,redirect,credentials,cache");
    if (
      policy.method !== "GET" ||
      policy.redirect !== "manual" ||
      policy.credentials !== "omit" ||
      policy.cache !== "no-store"
    )
      fail();
    policy = Object.freeze(policy);
    readPage = o.readPage;
    clock = o.clock ?? Date.now;
    if (typeof readPage !== "function" || typeof clock !== "function") fail();
    cap = { ...HISTORY_TRAVERSAL_BOUNDS };
    if (o.limits !== undefined) {
      for (const [key, value] of Object.entries(own(o.limits))) {
        if (
          !["pages", "bodyBytes", "totalBytes", "timeoutMs"].includes(key) ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > cap[key]
        )
          fail();
        cap[key] = value;
      }
    }
    initial = clock();
    if (
      !Number.isSafeInteger(initial) ||
      initial < 0 ||
      typeof config.livemode !== "boolean" ||
      !Number.isSafeInteger(config.from) ||
      !Number.isSafeInteger(config.to) ||
      config.from < 0 ||
      config.from >= config.to ||
      config.to - config.from > 3600 ||
      !Number.isSafeInteger(config.to * 1000) ||
      config.to * 1000 > initial ||
      config.from * 1000 < initial - 30 * 86400000
    )
      fail();
    const versions = config.apiVersions;
    if (!Array.isArray(versions) || versions.length < 1 || versions.length > 4) fail();
    config.apiVersions = [];
    for (let i = 0; i < versions.length; i++) {
      const d = Object.getOwnPropertyDescriptor(versions, i);
      if (
        !d?.enumerable ||
        !Object.hasOwn(d, "value") ||
        typeof d.value !== "string" ||
        !/^[A-Za-z0-9_.-]{1,64}$/.test(d.value) ||
        config.apiVersions.includes(d.value)
      )
        fail();
      config.apiVersions.push(d.value);
    }
  } catch {
    return unavailable();
  }
  const controller = new AbortController(),
    started = performance.now();
  let reader,
    timer,
    stopped = false,
    last = initial,
    total = 0;
  const check = () => {
    const now = clock();
    if (
      stopped ||
      !Number.isSafeInteger(now) ||
      now < last ||
      Math.max(now - initial, performance.now() - started) >= cap.timeoutMs
    )
      fail();
    last = now;
  };
  const release = () => {
    const current = reader;
    reader = null;
    if (!current) return;
    try {
      void Promise.resolve(current.cancel()).catch(() => {});
    } catch {}
    try {
      current.releaseLock();
    } catch {}
  };
  const stop = () => {
    stopped = true;
    controller.abort();
    release();
  };
  async function body(response) {
    if (stopped) {
      discard(response);
      fail();
    }
    if (
      !(response instanceof Response) ||
      response.status !== 200 ||
      response.redirected ||
      !response.body?.getReader
    ) {
      discard(response);
      fail();
    }
    reader = response.body.getReader();
    try {
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^(?:0|[1-9][0-9]{0,5})$/.test(declared) || Number(declared) > cap.bodyBytes)
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
      if (declared !== null && Number(declared) !== size) fail();
      const value = uniqueJson(text + decoder.decode());
      check();
      return value;
    } finally {
      release();
    }
  }
  async function run() {
    const result = {
      status: "observed_inventory",
      pages: 0,
      events: 0,
      families: { refund: 0, dispute: 0, charge: 0, other: 0 },
      schemas: config.apiVersions.map(() => 0),
      unknownSchema: 0,
    };
    const seen = new Set();
    let cursor,
      previous = Infinity;
    for (let page = 0; page < cap.pages; page++) {
      check();
      const query = Object.freeze({
        created: Object.freeze({ gte: config.from, lt: config.to }),
        limit: cap.pageSize,
        ...(cursor ? { starting_after: cursor } : {}),
      });
      const response = await readPage(query, controller.signal, policy);
      try {
        check();
      } catch {
        discard(response);
        fail();
      }
      const value = await body(response);
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
        const family = topupReversalObject(e?.type);
        if (
          e?.object !== "event" ||
          typeof e.id !== "string" ||
          !/^evt_[A-Za-z0-9_]{1,250}$/.test(e.id) ||
          seen.has(e.id) ||
          e.livemode !== config.livemode ||
          e.account != null ||
          e.context != null ||
          !Number.isSafeInteger(e.created) ||
          e.created < config.from ||
          e.created >= config.to ||
          e.created > previous ||
          typeof e.type !== "string" ||
          e.type.length > 128 ||
          !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/.test(e.type) ||
          !(
            e.api_version === null ||
            (typeof e.api_version === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.api_version))
          ) ||
          !e.data?.object ||
          typeof e.data.object !== "object" ||
          Array.isArray(e.data.object) ||
          (family && e.data.object.object !== family)
        )
          fail();
        seen.add(e.id);
        previous = e.created;
        result.events++;
        result.families[family ?? "other"]++;
        const slot = config.apiVersions.indexOf(e.api_version);
        if (slot < 0) result.unknownSchema++;
        else result.schemas[slot]++;
      }
      result.pages++;
      check();
      if (!value.has_more) return result;
      cursor = value.data.at(-1).id;
    }
    fail();
  }
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        stop();
        reject(new Error("History inventory unavailable"));
      }, cap.timeoutMs);
    });
    const result = await Promise.race([run(), timeout]);
    check();
    return result;
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    stop();
  }
}
