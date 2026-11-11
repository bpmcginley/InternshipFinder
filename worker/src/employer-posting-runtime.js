import {
  createRequestSafeEmployerPostingCatalog,
  createRetentionCheckedEmployerPostingCounter,
  employerPostingCountsEnabled,
} from "./employer-posting-counts.js";
import { employerMetricsResponse } from "./employer-metrics-response.js";
import { json } from "./http.js";

const CATALOG = "https://internscout.org/data/employer-posting-keys.json";
const MAX_BYTES = 256 * 1024;
const DEADLINE = 5_000;
// Operator-reviewed public release identity only. No descriptor is configured by this package.
export function employerCatalogDescriptor(env) {
  if (!employerPostingCountsEnabled(env)) return null;
  try {
    const raw = env.EMPLOYER_POSTING_CATALOG;
    if (typeof raw !== "string" || raw.length > 512) return null;
    const value = JSON.parse(raw);
    if (
      !value ||
      Object.keys(value).sort().join(",") !== "sha256,url,version" ||
      value.url !== CATALOG ||
      typeof value.version !== "string" ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{40}$/.test(value.version) ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

// Runs under the existing cache's request-owned abort/deadline. Pin raw bounded bytes before
// the one canonical parser sees them. Late/noncooperative I/O cannot return usable membership.
async function pinnedCatalog(descriptor, fetcher, signal, clock) {
  const start = clock(),
    url = `${descriptor.url}?v=${descriptor.version}`;
  let response,
    reader,
    previous = start;
  const live = () => {
    const at = clock();
    if (
      signal.aborted ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(at) ||
      at < previous ||
      at - start >= DEADLINE
    )
      throw new Error("Catalog unavailable");
    previous = at;
  };
  const discard = () => {
    try {
      void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {});
    } catch {
      /* Cleanup must not expose transport details. */
    }
  };
  signal.addEventListener("abort", discard, { once: true });
  try {
    live();
    response = await fetcher(url, { signal, redirect: "error", credentials: "omit" });
    live();
    if (response?.status !== 200 || response.redirected || response.url !== url)
      throw new Error("Catalog unavailable");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
      throw new Error("Catalog unavailable");
    reader = response.body.getReader();
    const buffer = new Uint8Array(MAX_BYTES);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      live();
      if (done) break;
      if (!(value instanceof Uint8Array) || !value.length || value.length > MAX_BYTES - size)
        throw new Error("Catalog unavailable");
      buffer.set(value, size);
      size += value.length;
    }
    const bytes = buffer.subarray(0, size);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
    live();
    if (hash !== descriptor.sha256) throw new Error("Catalog unavailable");
    return new Response(bytes);
  } finally {
    discard();
    signal.removeEventListener("abort", discard);
    try {
      reader?.releaseLock();
    } catch {
      /* A pending read still belongs to this request. */
    }
  }
}

// One bounded parsed cache per isolate. No request, DB, loader or address survives a call.
// Reconfiguration invalidates the previous generation without touching its request-owned I/O.
export function createEmployerPostingRuntime({ clock = Date.now } = {}) {
  let current = null;
  return {
    service(env, db, fetcher, now = () => new Date()) {
      const descriptor = employerCatalogDescriptor(env);
      if (!descriptor) {
        current = null;
        return null;
      }
      const identity = `${descriptor.url}|${descriptor.version}|${descriptor.sha256}`;
      if (current?.identity !== identity)
        current = {
          identity,
          cache: createRequestSafeEmployerPostingCatalog({ maxBytes: MAX_BYTES, now: clock }),
        };
      const generation = current;
      const cache = {
        async match(key, load) {
          if (generation !== current) return null;
          const lease = await generation.cache.match(key, load);
          return lease && ((at) => generation === current && lease(at));
        },
      };
      const counter = createRetentionCheckedEmployerPostingCounter({
        db,
        cache,
        now,
        load: (signal) => pinnedCatalog(descriptor, fetcher, signal, clock),
      });
      return (receipt) => counter.countAdmitted(receipt);
    },
  };
}

// Owner-only diagnostic: current DB invariant, not scheduler history or fetched-catalog health.
export async function employerPostingReport(context) {
  const enabled = employerPostingCountsEnabled(context.env);
  const configured = employerCatalogDescriptor(context.env) !== null;
  const response = await employerMetricsResponse({
    ...context,
    env: { EMPLOYER_POSTING_COUNTS_ENABLED: configured ? "1" : undefined },
  });
  if (!enabled) return response;
  let retention = "not_checked";
  if (configured) {
    try {
      const day = context.now.toISOString().slice(0, 10);
      const row = await context.db
        .prepare(
          `SELECT ?=date('now')
        AND EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day=?)
        AND NOT EXISTS(SELECT 1 FROM employer_posting_counts WHERE day<date(?,'-90 days'))
        AND NOT EXISTS(SELECT 1 FROM employer_posting_counts WHERE day>?)
        AND NOT EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day!=?) AS ready`,
        )
        .bind(day, day, day, day, day)
        .first();
      retention = row?.ready === 1 ? "ready" : "blocked";
    } catch {
      retention = "unavailable";
    }
  }
  return json(
    {
      ...(await response.json()),
      organic_posting_readiness: {
        catalog_configured: configured,
        retention,
      },
    },
    200,
    { "Cache-Control": "no-store" },
  );
}
