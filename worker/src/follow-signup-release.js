import { loadFollowCatalog, prepareFollowCatalogRelease } from "./follow-catalog-loader.js";

const ORIGIN = "https://internscout.org";
const empty = () => ({ companies: new Set(), fields: new Set(), states: new Set() });
const unavailable = () => ({ status: "unavailable" });
const fail = () => {
  throw new Error("Follow release unavailable");
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys;

// JSON grammar is checked first. Compare decoded names, including escaped aliases.
export function uniqueFollowDeploymentMembers(text) {
  const stack = [];
  let previous;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}:]/g)) {
    if (token === "{") stack.push(new Set());
    if (token === "}") stack.pop();
    if (token === ":") {
      const name = JSON.parse(previous),
        names = stack.at(-1);
      if (names.has(name)) fail();
      names.add(name);
    }
    previous = token;
  }
}

// Pure deployment policy shared with the dormant archive adapter. No read or clock starts here.
export function prepareFollowCatalogDeployment(input) {
  if (
    !exact(input, "deadlineMs,maxBytes,maxKeys,origin,predecessor,release,version") ||
    input.version !== 1 ||
    input.origin !== ORIGIN ||
    input.maxBytes > 1000000 ||
    input.maxKeys > 10000
  )
    fail();
  const policy = prepareFollowCatalogRelease({ ...input, previousValid: empty() });
  if (!Number.isFinite(+new Date(policy.release.expiresAt))) fail();
  let predecessor = null;
  if (!(exact(input.predecessor, "genesis") && input.predecessor.genesis === true)) {
    if (!exact(input.predecessor, "catalogSha256,sourceSha256,url")) fail();
    predecessor = prepareFollowCatalogRelease({
      ...policy,
      // Current release authority qualifies historical bytes, not predecessor admission.
      release: { ...policy.release, ...input.predecessor },
    });
    if (predecessor.release.url === policy.release.url) fail();
  }
  return { policy, predecessor };
}

// Deployment input only. No request values, cached authority, settings or default pins.
// maxBytes is PER catalog (at most two); maxKeys is the existing per-array bound.
export function prepareFollowSignupDeployment(
  raw,
  { fetch, now, initialTime, monotonicNow = () => performance.now() } = {},
) {
  if (typeof raw !== "string" || raw.length > 4096 || new TextEncoder().encode(raw).length > 4096)
    fail();
  const input = JSON.parse(raw);
  uniqueFollowDeploymentMembers(raw);
  if (
    !exact(input, "dailyLimit,deadlineMs,maxBytes,maxKeys,origin,predecessor,release,version") ||
    input.version !== 1 ||
    input.origin !== ORIGIN ||
    !Number.isSafeInteger(input.dailyLimit) ||
    input.dailyLimit <= 0 ||
    input.maxBytes > 1000000 ||
    input.maxKeys > 10000 ||
    (initialTime !== undefined && !Number.isSafeInteger(initialTime)) ||
    typeof fetch !== "function" ||
    typeof now !== "function" ||
    typeof monotonicNow !== "function"
  )
    fail();
  const { dailyLimit, ...catalogInput } = input;
  const { policy, predecessor } = prepareFollowCatalogDeployment(catalogInput);
  let latest = initialTime ?? -Infinity;
  const clock = () => {
    const sample = now();
    if (!(sample instanceof Date)) {
      void Promise.resolve(sample).catch(() => {});
      fail();
    }
    const at = +sample;
    if (
      !Number.isSafeInteger(at) ||
      at < latest ||
      at < policy.release.notBefore ||
      at >= policy.release.expiresAt
    )
      fail();
    latest = at;
    return new Date(at);
  };
  const monotonicClock = () => {
    const at = monotonicNow();
    if (!Number.isFinite(at) || at < 0) {
      void Promise.resolve(at).catch(() => {});
      fail();
    }
    return at;
  };
  clock();
  return {
    dailyLimit,
    clock,
    loadCatalog: async () => {
      try {
        const started = +clock(),
          monotonicStart = monotonicClock();
        let lastMonotonic = monotonicStart;
        const remaining = () => {
          const monotonic = monotonicClock();
          if (monotonic < lastMonotonic) fail();
          lastMonotonic = monotonic;
          const elapsed = Math.max(+clock() - started, monotonic - monotonicStart);
          const left = policy.deadlineMs - elapsed;
          if (left <= 0) fail();
          // Loader takes integer milliseconds; the outer elapsed check remains exact.
          return Math.ceil(left);
        };
        const read = (selected) =>
          loadFollowCatalog({
            ...selected,
            enabled: true,
            fetch,
            deadlineMs: remaining(),
            now: () => {
              remaining();
              return latest;
            },
          });
        let previousValid = empty();
        if (predecessor) {
          // The independently pinned predecessor is a continuity root, not an admission catalog.
          const prior = await read(predecessor);
          remaining();
          if (prior.status !== "available") return unavailable();
          previousValid = prior.catalog.valid;
        }
        const result = await read({ ...policy, previousValid });
        remaining();
        return result.status === "available"
          ? { ...result, expiresAt: policy.release.expiresAt }
          : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
