// Deployment-only dormant entry. No env/request supplier, scheduler, pins or policy defaults.
import {
  prepareFollowCatalogDeployment,
  uniqueFollowDeploymentMembers,
} from "./follow-signup-release.js";
import { loadFollowCatalog } from "./follow-catalog-loader.js";
import { createFollowArchiveReader } from "./follow-archive-reader.js";
import { runFollowArchiveRelease } from "./follow-archive-release.js";

const positive = (n) => Number.isSafeInteger(n) && n > 0;
const exact = (x, keys) =>
  x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join(",") === keys;
const fail = () => {
  throw Error("Unavailable archive deployment");
};
function sample(clock) {
  const value = clock();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    void Promise.resolve(value).catch(() => {});
    fail();
  }
  return value;
}

export async function runFollowArchiveDeployment(options = {}) {
  if (options?.enabled !== true) return { status: "disabled" };
  let fetchCalls = 0;
  try {
    const {
      descriptor,
      db,
      fetch: get,
      now = Date.now,
      monotonicNow = () => performance.now(),
    } = options;
    if ([get, now, monotonicNow].some((v) => typeof v !== "function")) fail();
    const prepare = db?.prepare,
      batch = db?.batch;
    if (typeof prepare !== "function" || typeof batch !== "function") fail();
    const database = { prepare: prepare.bind(db), batch: batch.bind(db) };
    // Start before descriptor parsing and before predecessor I/O, never restart authority.
    const started = sample(now),
      mono = sample(monotonicNow);
    let wall = started,
      monotonic = mono;
    if (
      !Number.isSafeInteger(started) ||
      started < 0 ||
      mono < 0 ||
      typeof descriptor !== "string" ||
      descriptor.length > 8192 ||
      new TextEncoder().encode(descriptor).length > 8192
    )
      fail();
    const input = JSON.parse(descriptor);
    uniqueFollowDeploymentMembers(descriptor);
    if (
      !exact(input, "archive,budget,catalog,limits,maxPendingBytes,maxProgressBytes,version") ||
      input.version !== 1
    )
      fail();
    const { policy, predecessor } = prepareFollowCatalogDeployment(input.catalog);
    const { budget, archive, limits, maxProgressBytes, maxPendingBytes } = input;
    if (
      !exact(
        budget,
        "deadlineMs,maxD1Calls,maxFetches,maxPages,maxStatements,maxSubscribers,pageSize",
      ) ||
      !Object.values(budget).every(positive) ||
      budget.maxPages > 128 ||
      budget.pageSize > 128 ||
      budget.maxSubscribers > 128 ||
      budget.maxD1Calls > 48 ||
      budget.maxStatements > 100 ||
      budget.maxFetches > 257 ||
      budget.deadlineMs > 2147483647 ||
      budget.maxFetches < (predecessor ? 4 : 3) ||
      budget.maxD1Calls < 4 ||
      budget.maxStatements < 7 ||
      !positive(maxProgressBytes) ||
      !positive(maxPendingBytes) ||
      maxPendingBytes > 32768 ||
      !exact(archive, "bounds,indexSha256,indexUrl") ||
      archive.indexUrl !== "https://internscout.org/data/follows/index.json" ||
      typeof archive.indexSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(archive.indexSha256) ||
      !exact(
        archive.bounds,
        "deadlineMs,maxArchiveBytes,maxEnqueueAgeMs,maxEntries,maxManifestBytes,publishMarginMs",
      ) ||
      !exact(
        limits,
        "maxBytes,maxFollows,maxMatches,maxResultBytes,maxRoles,maxTextBytes,maxWindowMs",
      )
    )
      fail();
    createFollowArchiveReader({
      ...archive,
      catalog: policy.previousValid,
      limits,
      fetch: get,
      clock: () => new Date(started),
    });
    const check = () => {
      const next = sample(now),
        nextMono = sample(monotonicNow);
      if (
        !Number.isSafeInteger(next) ||
        next < wall ||
        nextMono < monotonic ||
        next < policy.release.notBefore ||
        next >= policy.release.expiresAt ||
        Math.max(next - started, nextMono - mono) >= budget.deadlineMs
      )
        fail();
      wall = next;
      monotonic = nextMono;
      return wall;
    };
    const remaining = () => {
      check();
      return Math.ceil(
        Math.min(
          budget.deadlineMs - Math.max(wall - started, monotonic - mono),
          policy.release.expiresAt - wall,
        ),
      );
    };
    const fetch = (...args) => {
      check();
      if (fetchCalls >= budget.maxFetches) fail();
      fetchCalls++;
      return get(...args);
    };
    let previousValid = policy.previousValid;
    if (predecessor) {
      const prior = await loadFollowCatalog({
        ...predecessor,
        enabled: true,
        fetch,
        now: check,
        deadlineMs: Math.min(policy.deadlineMs, remaining()),
      });
      check();
      if (prior.status !== "available") fail();
      previousValid = prior.catalog.valid;
    }
    // Runner owns the sole current-catalog GET and existing atomic enqueue logic. The
    // outer clocks/fetch budget remain authoritative even after late inner acknowledgements.
    const result = await runFollowArchiveRelease({
      enabled: true,
      db: database,
      fetch,
      now: check,
      monotonicNow: () => {
        check();
        return monotonic;
      },
      catalog: { ...policy, previousValid },
      archive,
      limits,
      maxProgressBytes,
      maxPendingBytes,
      budget: { ...budget, maxFetches: budget.maxFetches - fetchCalls, deadlineMs: remaining() },
    });
    check();
    return { ...result, fetchCalls };
  } catch {
    // An admitted D1 transaction may have committed. Never retry or assert rollback here.
    return { status: "unavailable", fetchCalls };
  }
}
