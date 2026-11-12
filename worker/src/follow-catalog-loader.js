// Dormant one-shot reader: trusted release metadata only; no default fetch/URL or cache.
import { parseFollowCatalog } from "./follow-catalog.js";

const positive = (n) => Number.isSafeInteger(n) && n > 0;
const digest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const unavailable = () => ({ status: "unavailable" });
const fail = () => {
  throw new Error("Follow catalog unavailable");
};

export async function loadFollowCatalog(options = {}) {
  if (options?.enabled !== true) return { status: "disabled" };
  let controller,
    reader,
    response,
    timer,
    stopped = false;
  const { fetch: get, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = options;
  const discard = () => {
    stopped = true;
    controller?.abort();
    try {
      void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {});
    } catch {
      /* Discard a malformed or already closed body without exposing details. */
    }
  };
  try {
    const { origin, maxBytes, maxKeys, deadlineMs } = options;
    const release = { ...options.release };
    const allowed = new URL(origin),
      target = new URL(release.url);
    if (
      typeof origin !== "string" ||
      allowed.protocol !== "https:" ||
      allowed.origin !== origin ||
      typeof release.url !== "string" ||
      target.href !== release.url ||
      target.origin !== origin ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      Object.keys(release).sort().join(",") !==
        "catalogSha256,expiresAt,notBefore,sourceSha256,url" ||
      !digest(release.sourceSha256) ||
      !digest(release.catalogSha256) ||
      !Number.isSafeInteger(release.notBefore) ||
      release.notBefore < 0 ||
      !positive(release.expiresAt) ||
      release.notBefore >= release.expiresAt ||
      ![maxBytes, maxKeys, deadlineMs].every(positive) ||
      deadlineMs > 2147483647 ||
      [get, now, schedule, cancel].some((value) => typeof value !== "function")
    )
      fail();
    const previousValid = {};
    if (
      Object.keys(options.previousValid || {})
        .sort()
        .join(",") !== "companies,fields,states"
    )
      fail();
    for (const kind of ["companies", "fields", "states"]) {
      const set = options.previousValid[kind];
      if (!(set instanceof Set) || set.size > maxKeys) fail();
      previousValid[kind] = new Set(set);
    }
    let last = -Infinity;
    const clock = () => {
      const at = now();
      if (
        !Number.isSafeInteger(at) ||
        at < last ||
        at < release.notBefore ||
        at >= release.expiresAt
      )
        fail();
      last = at;
      return at;
    };
    const started = clock();
    const check = () => {
      if (stopped || clock() - started >= deadlineMs) fail();
    };
    controller = new AbortController();
    const timeout = new Promise((_, reject) => {
      timer = schedule(() => {
        discard();
        reject(new Error("Follow catalog unavailable"));
      }, deadlineMs);
    });
    const operation = async () => {
      check();
      response = await get(target.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      check();
      if (
        !(response instanceof Response) ||
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== target.href) ||
        !response.body
      )
        fail();
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) || !positive(Number(declared)) || Number(declared) > maxBytes)
      )
        fail();
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        check();
        if (done) break;
        if (!(value instanceof Uint8Array) || !value.length || value.length > maxBytes - size)
          fail();
        chunks.push(new Uint8Array(value));
        size += value.length;
      }
      reader.releaseLock();
      reader = null;
      if (!size || (declared !== null && Number(declared) !== size)) fail();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const catalog = await parseFollowCatalog(bytes, {
        maxBytes,
        maxKeys,
        previousValid,
        sourceSha256: release.sourceSha256,
        catalogSha256: release.catalogSha256,
      });
      check();
      return { status: "available", catalog };
    };
    // Rejected/late work is always observed; it cannot escape after the one deadline.
    return await Promise.race([
      operation().catch(() => {
        discard();
        return unavailable();
      }),
      timeout,
    ]);
  } catch {
    return unavailable();
  } finally {
    try {
      if (timer !== undefined) cancel(timer);
    } catch {
      /* Still discard on timer failure. */
    }
    discard();
  }
}
