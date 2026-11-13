// Dormant: no default URL, fetch, catalog, policy, scheduler or retained response.
import { followInstant, followSnapshotDigest, matchFollowSnapshot } from "./follow-matching.js";

const digestPattern = /^[a-f0-9]{64}$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const keys = (x, expected) =>
  x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join(",") === expected;
const fail = () => {
  throw new Error("Unavailable follow archive");
};
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const unavailable = () => ({ status: "unavailable" });

export function createFollowArchiveReader({
  indexUrl,
  indexSha256,
  fetch: get,
  clock,
  bounds,
  catalog,
  limits,
} = {}) {
  const b = { ...bounds },
    l = { ...limits };
  const c =
    catalog &&
    Object.fromEntries(
      ["companies", "fields", "states"].map((k) => [
        k,
        catalog[k] instanceof Set ? new Set(catalog[k]) : null,
      ]),
    );
  let url;
  try {
    url = new URL(indexUrl);
  } catch {
    fail();
  }
  if (
    (indexSha256 !== undefined &&
      (typeof indexSha256 !== "string" || !digestPattern.test(indexSha256))) ||
    url.href !== indexUrl ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/data/follows/index.json" ||
    typeof get !== "function" ||
    typeof clock !== "function" ||
    ![
      "maxManifestBytes",
      "maxEntries",
      "maxArchiveBytes",
      "maxEnqueueAgeMs",
      "publishMarginMs",
      "deadlineMs",
    ].every((k) => positive(b[k])) ||
    b.deadlineMs > 2147483647 ||
    ![
      "maxBytes",
      "maxRoles",
      "maxFollows",
      "maxMatches",
      "maxResultBytes",
      "maxTextBytes",
      "maxWindowMs",
    ].every((k) => positive(l[k])) ||
    !c ||
    Object.values(c).some((x) => !(x instanceof Set))
  )
    fail();
  let lastClock = -Infinity;
  const now = () => {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(+value)) fail();
    const at = value.toISOString(),
      n = followInstant(at);
    if (n === null || n < lastClock) fail();
    lastClock = n;
    return n;
  };

  // Each operation owns its controller, reader and timer. No promise crosses invocations.
  async function run(action) {
    const controller = new AbortController();
    let reader, timer;
    const cancel = () => {
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
    };
    try {
      const started = now();
      const check = () => {
        if (controller.signal.aborted || now() - started >= b.deadlineMs) fail();
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancel();
          reject(new Error("Archive deadline"));
        }, b.deadlineMs);
      });
      async function read(target, cap) {
        check();
        if (controller.signal.aborted) fail();
        const response = await get(target, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
        try {
          check();
        } catch (error) {
          response?.body?.cancel().catch(() => {});
          throw error;
        }
        if (controller.signal.aborted) {
          response?.body?.cancel().catch(() => {});
          fail();
        }
        if (!(response instanceof Response)) fail();
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== target) ||
          !response.body
        ) {
          response.body?.cancel().catch(() => {});
          fail();
        }
        reader = response.body.getReader();
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) || !positive(Number(length)) || Number(length) > cap)
        )
          fail();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          check();
          if (controller.signal.aborted) fail();
          if (done) break;
          if (!(value instanceof Uint8Array) || !value.length || value.length > cap - size) fail();
          size += value.length;
          chunks.push(value);
        }
        reader.releaseLock();
        reader = null;
        if (!size || (length !== null && size !== Number(length))) fail();
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        check();
        return bytes;
      }
      const operation = async () => {
        const result = await action(read, check);
        check();
        return result;
      };
      return await Promise.race([operation(), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      cancel();
    }
  }

  async function manifest(read, check) {
    const raw = await read(indexUrl, b.maxManifestBytes);
    if (indexSha256 !== undefined) {
      const digest = await followSnapshotDigest(raw);
      check();
      if (digest !== indexSha256) fail();
    }
    const text = decode(raw),
      m = JSON.parse(text);
    if (
      !keys(m, "checked_at,entries,high_water,latest,version") ||
      m.version !== 1 ||
      !Array.isArray(m.entries) ||
      m.entries.length > b.maxEntries
    )
      fail();
    const high = followInstant(m.high_water),
      checked = followInstant(m.checked_at);
    if (high === null || checked === null || high > checked || checked > now()) fail();
    let prior = "",
      total = raw.length;
    const entries = [],
      digests = new Set();
    for (const e of m.entries) {
      if (
        !keys(e, "bytes,enqueue_until,generated_at,retain_until,sha256") ||
        typeof e.sha256 !== "string" ||
        !digestPattern.test(e.sha256) ||
        digests.has(e.sha256) ||
        !positive(e.bytes) ||
        e.bytes > l.maxBytes
      )
        fail();
      const at = followInstant(e.generated_at),
        enqueue = followInstant(e.enqueue_until),
        retain = followInstant(e.retain_until);
      if (
        at === null ||
        enqueue === null ||
        retain === null ||
        enqueue - at !== b.maxEnqueueAgeMs ||
        retain - enqueue !== 48 * 3600000 + b.publishMarginMs ||
        e.generated_at.slice(0, 10) <= prior ||
        e.generated_at > m.high_water ||
        e.bytes > b.maxArchiveBytes - total
      )
        fail();
      total += e.bytes;
      prior = e.generated_at.slice(0, 10);
      digests.add(e.sha256);
      entries.push({
        bytes: e.bytes,
        enqueue_until: e.enqueue_until,
        generated_at: e.generated_at,
        retain_until: e.retain_until,
        sha256: e.sha256,
      });
    }
    if (
      total > b.maxArchiveBytes ||
      m.latest !== (entries.at(-1)?.sha256 ?? null) ||
      (entries.length && entries.at(-1).generated_at !== m.high_water)
    )
      fail();
    // Exact Python sort_keys/separators representation rejects duplicate keys and aliases.
    if (
      JSON.stringify({
        checked_at: m.checked_at,
        entries,
        high_water: m.high_water,
        latest: m.latest,
        version: 1,
      }) !== text
    )
      fail();
    return entries;
  }

  async function blob(read, entry, maximum) {
    if (entry.bytes > maximum || now() >= followInstant(entry.retain_until)) fail();
    const target = new URL(`${entry.sha256}.json`, url).href;
    const bytes = await read(target, Math.min(maximum, l.maxBytes));
    if (bytes.length !== entry.bytes || (await followSnapshotDigest(bytes)) !== entry.sha256)
      fail();
    const text = decode(bytes),
      snapshot = JSON.parse(text);
    // The producer emits compact JSON. Round-trip rejects duplicate keys before matching.
    if (
      JSON.stringify(snapshot) !== text ||
      matchFollowSnapshot(bytes, [], {
        catalog: c,
        limits: l,
        upperBound: entry.generated_at,
      }).status !== "matched" ||
      now() >= followInstant(entry.retain_until)
    )
      fail();
    return { bytes, snapshot };
  }

  async function latest(effectiveLower) {
    return (
      (await run(async (read, check) => {
        const entry = (await manifest(read, check)).at(-1);
        if (
          !entry ||
          now() < followInstant(entry.generated_at) ||
          now() >= followInstant(entry.enqueue_until)
        )
          fail();
        const { bytes, snapshot } = await blob(read, entry, l.maxBytes);
        if (now() >= followInstant(entry.enqueue_until)) fail();
        if (effectiveLower !== undefined) {
          if (effectiveLower > entry.generated_at) return unavailable();
          if (effectiveLower < snapshot.covers_after) return { status: "gap" };
        }
        return {
          status: "ready",
          at: entry.generated_at,
          enqueueUntil: entry.enqueue_until,
          digest: entry.sha256,
          bytes,
        };
      })) ?? unavailable()
    );
  }

  return Object.freeze({
    // Compatible with #298 loadSnapshot({at,digest,maxBytes}); independent of latest.
    async loadSnapshot({ at, digest, maxBytes } = {}) {
      if (
        followInstant(at) === null ||
        typeof digest !== "string" ||
        !digestPattern.test(digest) ||
        !positive(maxBytes)
      )
        return null;
      return run(async (read, check) => {
        const entry = (await manifest(read, check)).find(
          (e) => e.sha256 === digest && e.generated_at === at,
        );
        if (!entry) fail();
        return (await blob(read, entry, maxBytes)).bytes;
      });
    },
    async latest({ effectiveLower } = {}) {
      if (followInstant(effectiveLower) === null) return unavailable();
      return latest(effectiveLower);
    },
    // A batch checks subscriber-specific coverage in the existing matcher and CAS.
    latestSnapshot() {
      return latest();
    },
  });
}
