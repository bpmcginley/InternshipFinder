// Dormant one-shot reader: trusted release metadata only; no default fetch/URL or cache.
import { copyFollowCatalogPrevious, parseFollowCatalog } from "./follow-catalog.js";

const positive = (n) => Number.isSafeInteger(n) && n > 0;
const digest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength").get;
const arrayType = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag).get;
const unavailable = () => ({ status: "unavailable" });
const fail = () => {
  throw new Error("Follow catalog unavailable");
};

// Copy the same release authority before an HTTP caller admits the request body.
export function prepareFollowPublicRead(options) {
  const { origin, maxBytes, deadlineMs } = options;
  const release = { ...options.release };
  const allowed = new URL(origin),
    target = new URL(release.url);
  if (
    typeof origin !== "string" ||
    allowed.protocol !== "https:" ||
    allowed.origin !== origin ||
    typeof release.url !== "string" ||
    release.url.includes("?") ||
    release.url.includes("#") ||
    target.href !== release.url ||
    target.origin !== origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !Number.isSafeInteger(release.notBefore) ||
    release.notBefore < 0 ||
    !positive(release.expiresAt) ||
    release.notBefore >= release.expiresAt ||
    ![maxBytes, deadlineMs].every(positive) ||
    deadlineMs > 2147483647
  )
    fail();
  return { origin, release, maxBytes, deadlineMs };
}

export function prepareFollowCatalogRelease(options) {
  const prepared = prepareFollowPublicRead(options);
  const { release } = prepared,
    { maxKeys } = options;
  if (
    Object.keys(release).sort().join(",") !==
      "catalogSha256,expiresAt,notBefore,sourceSha256,url" ||
    !digest(release.sourceSha256) ||
    !digest(release.catalogSha256) ||
    !positive(maxKeys)
  )
    fail();
  const previousValid = copyFollowCatalogPrevious(options.previousValid, maxKeys);
  return { ...prepared, maxKeys, previousValid };
}

export const loadFollowCatalog = (options = {}) => readFollowPublic(options, true);
// Raw bytes for the consumed link-release composition; integrity is checked before ownership.
export const loadFollowPublicBytes = (options = {}) => readFollowPublic(options, false);

async function readFollowPublic(options, catalogRead) {
  if (options?.enabled !== true) return { status: "disabled" };
  let controller,
    reader,
    response,
    timer,
    stopped = false;
  const { fetch: get, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = options;
  const releaseReader = () => {
    try {
      reader?.releaseLock();
      reader = null;
    } catch {
      /* Pending cancellation retries release when it settles. */
    }
  };
  const discard = () => {
    stopped = true;
    controller?.abort();
    try {
      void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel())
        .catch(() => {})
        .finally(releaseReader);
    } catch {
      /* Discard a malformed or already closed body without exposing details. */
    }
    releaseReader();
  };
  try {
    const { release, maxBytes, maxKeys, deadlineMs, previousValid } = catalogRead
      ? prepareFollowCatalogRelease(options)
      : prepareFollowPublicRead(options);
    if ([get, now, schedule, cancel].some((value) => typeof value !== "function")) fail();
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
      response = await get(release.url, {
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
        response.url !== release.url ||
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
        if (arrayType.call(value) !== "Uint8Array") fail();
        const length = byteLength.call(value);
        if (!length || length > maxBytes - size) fail();
        chunks.push(new Uint8Array(value));
        size += length;
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
      if (!catalogRead) {
        check();
        return { status: "available", bytes };
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
    const result = await Promise.race([
      operation().catch(() => {
        discard();
        return unavailable();
      }),
      timeout,
    ]);
    if (result.status === "available") check();
    return result;
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
