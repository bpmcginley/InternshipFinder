// Dormant trusted object composition; no settings, schedule, key encoding or policy defaults.
import { prepareFollowCatalogDeployment } from "./follow-signup-release.js";
import { loadFollowCatalog } from "./follow-catalog-loader.js";
import { createFollowArchiveReader } from "./follow-archive-reader.js";
import { createOwnedFollowDigestRuntime } from "./follow-owned-digest-runtime.js";
import { captureFollowDigestRelatedLimits } from "./follow-digest-prepare.js";

const fail = () => {
  throw Error("Unavailable digest release");
};
const positive = (n) => Number.isSafeInteger(n) && n > 0;
function record(value, keys) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).sort().join(",") !== keys
  )
    fail();
  const result = {};
  for (const key of keys.split(",")) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, "value")) fail();
    result[key] = d.value;
  }
  return result;
}
async function signingKey(key) {
  if (!(key instanceof CryptoKey)) fail();
  // Workerd exposes displayed metadata as own data, Node as intrinsic accessors.
  // Import provenance/nonextractability/length remain the trusted caller's precondition.
  const read = (name) => {
    const own = Object.getOwnPropertyDescriptor(key, name);
    if (own) {
      if (!Object.hasOwn(own, "value")) fail();
      return own.value;
    }
    return Object.getOwnPropertyDescriptor(CryptoKey.prototype, name).get.call(key);
  };
  const algorithm = read("algorithm");
  if (
    read("type") !== "secret" ||
    read("extractable") !== false ||
    algorithm.name !== "HMAC" ||
    algorithm.hash?.name !== "SHA-256" ||
    !positive(algorithm.length) ||
    algorithm.length < 256 ||
    !read("usages").includes("sign")
  )
    fail();
  // Native brand/hash proof only; never sign user, credential or private input here.
  const proof = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("InternScout Follow digest key preflight v1"),
  );
  if (proof.byteLength !== 32) fail();
  return key;
}
function sample(clock) {
  const value = clock();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    void Promise.resolve(value).catch(() => {});
    fail();
  }
  return value;
}
function targetPath(url) {
  let path = new URL(url).pathname;
  while (true) {
    const decoded = decodeURIComponent(path);
    if (decoded === path) return new URL(path, "https://internscout.org").pathname;
    path = decoded;
  }
}

export async function runFollowDigestRelease(options = {}) {
  try {
    const enabled =
      options == null ? undefined : Object.getOwnPropertyDescriptor(options, "enabled");
    if (enabled && !Object.hasOwn(enabled, "value")) fail();
    if (enabled?.value !== true) return { status: "disabled" };
    const {
      db,
      email,
      policy,
      fetch: get,
      now,
      monotonicNow,
      deadlineMs,
      transportTimeoutMs,
    } = options;
    if (
      [policy, get, now, monotonicNow].some((f) => typeof f !== "function") ||
      !positive(deadlineMs) ||
      deadlineMs > 2147483647 ||
      !positive(transportTimeoutMs) ||
      transportTimeoutMs > 10000
    )
      fail();
    const started = sample(now),
      mono = sample(monotonicNow);
    if (!Number.isSafeInteger(started)) fail();
    const key = options.key;
    const prepare = db?.prepare,
      batch = db?.batch,
      send = email?.send;
    if ([prepare, batch, send].some((f) => typeof f !== "function")) fail();
    const database = { prepare: prepare.bind(db), batch: batch.bind(db) };
    const boundSend = send.bind(email);
    const input = record(
      options.catalog,
      "deadlineMs,maxBytes,maxKeys,origin,predecessor,release,version",
    );
    input.release = record(input.release, "catalogSha256,expiresAt,notBefore,sourceSha256,url");
    input.predecessor = Object.hasOwn(input.predecessor ?? {}, "genesis")
      ? record(input.predecessor, "genesis")
      : record(input.predecessor, "catalogSha256,sourceSha256,url");
    const { policy: catalog, predecessor } = prepareFollowCatalogDeployment(input);
    const archive = record(options.archive, "bounds,indexSha256,indexUrl");
    archive.bounds = record(
      archive.bounds,
      "deadlineMs,maxArchiveBytes,maxEnqueueAgeMs,maxEntries,maxManifestBytes,publishMarginMs",
    );
    const limits = record(
      options.limits,
      "maxBytes,maxFollows,maxMatches,maxResultBytes,maxRoles,maxTextBytes,maxWindowMs",
    );
    const relatedLimits = captureFollowDigestRelatedLimits(options.relatedLimits);
    if (
      archive.indexUrl !== "https://internscout.org/data/follows/index.json" ||
      typeof archive.indexSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(archive.indexSha256)
    )
      fail();
    const urls = [
      archive.indexUrl,
      catalog.release.url,
      ...(predecessor ? [predecessor.release.url] : []),
    ];
    if (urls.some((url) => url.length > 2048) || new Set(urls.map(targetPath)).size !== urls.length)
      fail();
    // Validate the reader's explicit bounds before any fetch or owner activity.
    createFollowArchiveReader({
      ...archive,
      catalog: catalog.previousValid,
      limits,
      fetch: get,
      clock: () => new Date(started),
    });
    // All release records and callable ports are captured before the first await.
    await signingKey(key);
    let wall = started,
      monotonic = mono,
      fetches = 0;
    const check = () => {
      const next = sample(now),
        nextMono = sample(monotonicNow);
      if (
        !Number.isSafeInteger(next) ||
        next < wall ||
        nextMono < monotonic ||
        next < catalog.release.notBefore ||
        next >= catalog.release.expiresAt ||
        Math.max(next - started, nextMono - mono) >= deadlineMs
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
          deadlineMs - Math.max(wall - started, monotonic - mono),
          catalog.release.expiresAt - wall,
        ),
      );
    };
    const fetch = (...args) => {
      check();
      // One queued candidate: current/prior catalog, manifest, exact retained blob.
      if (++fetches > (predecessor ? 4 : 3)) fail();
      return get(...args);
    };
    const read = (selected) =>
      loadFollowCatalog({
        ...selected,
        enabled: true,
        fetch,
        now: check,
        deadlineMs: Math.min(selected.deadlineMs, remaining()),
      });
    let previousValid = catalog.previousValid;
    if (predecessor) {
      const prior = await read(predecessor);
      check();
      if (prior.status !== "available") fail();
      previousValid = prior.catalog.valid;
    }
    const current = await read({ ...catalog, previousValid });
    check();
    if (current.status !== "available") fail();
    const loadSnapshot = async (pin) => {
      const reader = createFollowArchiveReader({
        ...archive,
        catalog: current.catalog.valid,
        limits,
        bounds: { ...archive.bounds, deadlineMs: Math.min(archive.bounds.deadlineMs, remaining()) },
        fetch,
        clock: () => new Date(check()),
      });
      const bytes = await reader.loadSnapshot(pin);
      check();
      return bytes;
    };
    const result = await createOwnedFollowDigestRuntime({
      enabled: true,
      db: database,
      email: {
        send: (message) => {
          // After the final policy sample and adapter validation, immediately hand off.
          check();
          return boundSend(message);
        },
      },
      beforeAcquire: () => {
        check();
        return true;
      },
      policy,
      key,
      catalog: current.catalog.valid,
      limits,
      relatedLimits,
      loadSnapshot,
      clock: () => new Date(check()),
      transportTimeoutMs,
    })();
    check();
    return result;
  } catch {
    // Existing owner/settlement retains uncertainty. Never race or retry database work.
    return { status: "unavailable" };
  }
}
