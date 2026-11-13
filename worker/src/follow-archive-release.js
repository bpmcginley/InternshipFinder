// Dormant finite pass. No scheduler, persistent cursor, delivery or release defaults.
import { enqueueFollowArchiveBatch } from "./follow-archive-enqueue.js";
import { loadFollowCatalog, prepareFollowCatalogRelease } from "./follow-catalog-loader.js";
import { createFollowArchiveReader } from "./follow-archive-reader.js";

const fail = () => {
  throw new Error("Unavailable archive release");
};
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const outcomes = new Set(["queued", "advanced", "empty", "conflict", "gap", "invalid"]);
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !d?.enumerable || !Object.hasOwn(d, "value")) fail();
    result[key] = d.value;
  }
  return result;
}
function sample(read) {
  const value = read();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    // Clock ports are synchronous; observe accidental async rejection without waiting.
    void Promise.resolve(value).catch(() => {});
    fail();
  }
  return value;
}
function receipt(value) {
  const r = record(value),
    meta = record(r.meta);
  if (
    r.success !== true ||
    !Number.isSafeInteger(meta.changes) ||
    meta.changes < 0 ||
    !Array.isArray(r.results)
  )
    fail();
  const results = [];
  for (let i = 0; i < r.results.length; i++) {
    const d = Object.getOwnPropertyDescriptor(r.results, String(i));
    if (!d || !Object.hasOwn(d, "value")) fail();
    results.push(record(d.value));
  }
  return { success: true, meta: { changes: meta.changes }, results };
}

export async function runFollowArchiveRelease(options = {}) {
  if (options?.enabled !== true) return { status: "disabled" };
  let pages = 0,
    subscribers = 0,
    d1Calls = 0,
    statements = 0,
    fetchCalls = 0;
  const counts = {};
  const result = (status) => ({
    status,
    pages,
    subscribers,
    d1Calls,
    statements,
    fetchCalls,
    counts: { ...counts },
  });
  try {
    const o = record(options),
      db = o.db,
      get = o.fetch;
    const prepareMethod = db?.prepare,
      batchMethod = db?.batch;
    const now = o.now ?? Date.now,
      monotonicNow = o.monotonicNow ?? (() => performance.now());
    const budget = record(o.budget),
      limits = record(o.limits),
      archive = record(o.archive);
    const bounds = record(archive.bounds);
    const catalogOptions = record(o.catalog);
    catalogOptions.release = record(catalogOptions.release);
    const catalog = prepareFollowCatalogRelease(catalogOptions);
    if (
      typeof get !== "function" ||
      typeof now !== "function" ||
      typeof monotonicNow !== "function" ||
      !db ||
      typeof prepareMethod !== "function" ||
      typeof batchMethod !== "function" ||
      ![
        budget.maxPages,
        budget.pageSize,
        budget.maxSubscribers,
        budget.maxD1Calls,
        budget.maxStatements,
        budget.maxFetches,
        budget.deadlineMs,
        o.maxProgressBytes,
        o.maxPendingBytes,
      ].every(positive) ||
      budget.maxPages > 128 ||
      budget.pageSize > 128 ||
      budget.maxSubscribers > 128 ||
      budget.maxD1Calls > 48 ||
      budget.maxStatements > 100 ||
      budget.maxFetches > 257 ||
      budget.deadlineMs > 2147483647 ||
      o.maxPendingBytes > 32768 ||
      catalog.origin !== "https://internscout.org" ||
      archive.indexUrl !== `${catalog.origin}/data/follows/index.json` ||
      typeof archive.indexSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(archive.indexSha256)
    )
      fail();
    const prepare = prepareMethod.bind(db),
      batch = batchMethod.bind(db);
    createFollowArchiveReader({
      ...archive,
      bounds,
      limits,
      catalog: catalog.previousValid,
      fetch: get,
      clock: () => new Date(0),
    });
    const start = sample(now),
      mono = sample(monotonicNow);
    let latest = start,
      latestMono = mono;
    const check = () => {
      const at = sample(now),
        m = sample(monotonicNow);
      if (
        !Number.isSafeInteger(at) ||
        at < latest ||
        m < latestMono ||
        at < catalog.release.notBefore ||
        at >= catalog.release.expiresAt ||
        Math.max(at - start, m - mono) >= budget.deadlineMs
      )
        fail();
      latest = at;
      latestMono = m;
      return at;
    };
    const remaining = () => {
      check();
      return Math.max(
        1,
        Math.ceil(
          Math.min(
            budget.deadlineMs - Math.max(latest - start, latestMono - mono),
            catalog.release.expiresAt - latest,
          ),
        ),
      );
    };
    const charge = (n) => {
      check();
      if (d1Calls >= budget.maxD1Calls || n > budget.maxStatements - statements) fail();
      d1Calls++;
      statements += n;
    };
    const fetch = (...args) => {
      check();
      if (fetchCalls >= budget.maxFetches) fail();
      fetchCalls++;
      return get(...args);
    };
    const originals = new WeakMap();
    function statement(raw) {
      const wrapped = {
        bind(...args) {
          return statement(raw.bind(...args));
        },
        async all() {
          charge(1);
          const value = await raw.all();
          check();
          return receipt(value);
        },
        async first(column) {
          charge(1);
          const value = await raw.first(column);
          check();
          return value;
        },
      };
      originals.set(wrapped, raw);
      return wrapped;
    }
    const database = {
      prepare(sql) {
        check();
        return statement(prepare(sql));
      },
      async batch(list) {
        const raw = list.map((item) => originals.get(item) ?? fail());
        // Existing 0025 empty view admits this whole atomic batch at DB UTC.
        // It retains no release data; an already-admitted transaction completes atomically.
        const cutoff = Math.floor(
          Math.min(catalog.release.expiresAt, start + budget.deadlineMs, check() + remaining()),
        );
        charge(raw.length + 1);
        const guard = prepare(
          "INSERT INTO follow_catalog_admissions(expires_at_ms) VALUES(?)",
        ).bind(cutoff);
        const value = await batch([guard, ...raw]);
        check();
        if (!Array.isArray(value) || value.length !== raw.length + 1) fail();
        const copied = [];
        for (let i = 0; i < value.length; i++) {
          const d = Object.getOwnPropertyDescriptor(value, String(i));
          if (!d || !Object.hasOwn(d, "value")) fail();
          copied.push(receipt(d.value));
        }
        if (copied[0].meta.changes !== 0 || copied[0].results.length !== 0) fail();
        return copied.slice(1);
      },
    };
    const loaded = await loadFollowCatalog({
      ...catalog,
      enabled: true,
      fetch,
      now: check,
      deadlineMs: Math.min(catalog.deadlineMs, remaining()),
    });
    check();
    if (loaded.status !== "available") fail();
    let after = null;
    while (pages < budget.maxPages && subscribers < budget.maxSubscribers) {
      check();
      // Reserve a whole worst-case page: enumeration + final DB UTC, then each
      // progress read and one guarded four-statement enqueue batch. Never split it.
      const size = Math.min(
        budget.pageSize,
        budget.maxSubscribers - subscribers,
        Math.floor((budget.maxD1Calls - d1Calls - 2) / 2),
        Math.floor((budget.maxStatements - statements - 2) / 5),
      );
      if (size < 1 || budget.maxFetches - fetchCalls < 2) return result("partial");
      // Each page independently verifies exactly the same pinned manifest and selected blob.
      const page = await enqueueFollowArchiveBatch(database, {
        after,
        maxSubscribers: size,
        archive: {
          indexUrl: archive.indexUrl,
          indexSha256: archive.indexSha256,
          fetch,
          clock: () => new Date(check()),
          bounds: { ...bounds, deadlineMs: Math.min(bounds.deadlineMs, remaining()) },
        },
        catalog: loaded.catalog.valid,
        limits,
        maxProgressBytes: o.maxProgressBytes,
        maxPendingBytes: o.maxPendingBytes,
      });
      check();
      if (page.status !== "processed") fail();
      let examined = 0;
      for (const [key, count] of Object.entries(page.counts)) {
        if (!outcomes.has(key) || !positive(count)) fail();
        examined += count;
        counts[key] = (counts[key] ?? 0) + count;
      }
      pages++;
      subscribers += examined;
      if (page.nextAfter === null)
        return result(
          counts.gap || counts.invalid || counts.conflict ? "partial" : "pass-complete",
        );
      if (
        typeof page.nextAfter !== "string" ||
        (after !== null && page.nextAfter <= after) ||
        examined < 1
      )
        fail();
      after = page.nextAfter;
    }
    return result("partial");
  } catch {
    // No retry, external cursor, or assertion that an admitted D1 write did not commit.
    return result("unavailable");
  }
}
