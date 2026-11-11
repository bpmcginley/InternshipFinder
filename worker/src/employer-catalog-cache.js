// Dormant cache: no URL, fetch, canonical-key rules, DB or limiter is owned here.
const TTL = 300_000;
const RETRY = 5_000;

// load(signal) returns a Response; parse(text) reuses the single catalog validator and
// returns its private synchronous boolean membership predicate, or null. No stale data
// escapes this object. The eventual reviewed wire format must provide maxBytes explicitly.
export function createEmployerCatalogCache({
  load,
  parse,
  maxBytes,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  loadTimeoutMs = TTL,
}) {
  if (
    typeof load !== "function" ||
    typeof parse !== "function" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(loadTimeoutMs) ||
    loadTimeoutMs < 1 ||
    loadTimeoutMs > TTL
  )
    throw new TypeError("Invalid catalog cache options");
  let cached = null,
    pending = null,
    last = 0,
    retryAt = 0;
  const time = () => {
    try {
      const value = now();
      if (
        !Number.isSafeInteger(value) ||
        value < last ||
        value > Number.MAX_SAFE_INTEGER - TTL - RETRY
      )
        return null;
      last = value;
      return value;
    } catch {
      return null;
    }
  };
  const drop = () => {
    cached = null;
    if (pending) pending.finish(null);
    else retryAt = (time() ?? last) + RETRY;
  };

  function start(at) {
    const expires = at + TTL,
      deadline = at + loadTimeoutMs,
      controller = new AbortController();
    let resolve, timer, reader, response;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const discard = () => {
      try {
        void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel?.()).catch(() => {});
      } catch {
        /* A malformed loader result must still fail closed. */
      }
    };
    const work = {
      promise,
      finish(entry) {
        if (pending !== work) return;
        try {
          cancel(timer);
        } catch {
          /* Late timer callbacks cannot replace this generation. */
        }
        pending = null;
        cached = entry;
        if (!entry) {
          retryAt = (time() ?? last) + RETRY;
          controller.abort();
          discard();
        }
        resolve(entry);
      },
    };
    pending = work;
    const live = () => {
      const current = time();
      return pending === work && current !== null && current < deadline;
    };
    try {
      timer = schedule(() => work.finish(null), loadTimeoutMs);
      timer?.unref?.();
    } catch {
      work.finish(null);
      return promise;
    }
    void (async () => {
      try {
        response = await load(controller.signal);
        if (!live() || response?.ok !== true) throw new Error("Catalog unavailable");
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) ||
            !Number.isSafeInteger(Number(length)) ||
            Number(length) > maxBytes)
        ) {
          throw new Error("Catalog too large");
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0,
          text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (!live()) throw new Error("Catalog expired");
          if (done) break;
          if (
            !(value instanceof Uint8Array) ||
            !value.byteLength ||
            value.byteLength > maxBytes - bytes
          )
            throw new Error("Invalid catalog body");
          bytes += value.byteLength;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        const known = await parse(text);
        if (!live() || typeof known !== "function") throw new Error("Invalid catalog");
        work.finish({ known, expires });
      } catch {
        work.finish(null);
      } finally {
        discard();
        try {
          reader?.releaseLock();
        } catch {
          /* No reusable reader escapes. */
        }
      }
    })();
    return promise;
  }

  async function match(key) {
    const at = time();
    if (at === null) {
      drop();
      return null;
    }
    if (cached && at >= cached.expires) cached = null;
    if (!cached && at < retryAt) return null;
    const entry = cached || (await (pending?.promise || start(at)));
    const current = time();
    if (current === null) {
      drop();
      return null;
    }
    if (!entry || entry !== cached || current >= entry.expires) {
      if (entry === cached) cached = null;
      return null;
    }
    try {
      const accepted = entry.known(key);
      if (typeof accepted !== "boolean") throw new Error("Invalid membership predicate");
      const finished = time();
      if (finished === null) {
        drop();
        return null;
      }
      if (entry !== cached || finished >= entry.expires) {
        cached = null;
        return null;
      }
      if (!accepted) return null;
      // Recheck this exact snapshot when the caller resumes and admits the click.
      return (checked) =>
        Number.isSafeInteger(checked) &&
        checked >= last &&
        checked < entry.expires &&
        entry === cached;
    } catch {
      drop();
      return null;
    }
  }

  return Object.freeze({
    match,
    async has(key) {
      const isCurrent = await match(key);
      if (!isCurrent) return false;
      const checked = time();
      if (checked !== null) return isCurrent(checked);
      drop();
      return false;
    },
  });
}
