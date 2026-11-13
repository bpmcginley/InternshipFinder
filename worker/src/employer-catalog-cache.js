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
  const observeTime = (value) => {
    if (
      !Number.isSafeInteger(value) ||
      value < last ||
      value > Number.MAX_SAFE_INTEGER - TTL - RETRY
    )
      return null;
    last = value;
    return value;
  };
  const time = () => {
    try {
      return observeTime(now());
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
      return (checked) => {
        if (entry !== cached) return false;
        if (observeTime(checked) === null) {
          drop();
          return false;
        }
        if (checked < entry.expires) return true;
        cached = null;
        return false;
      };
    } catch {
      drop();
      return null;
    }
  }

  return Object.freeze({
    match,
    async has(key) {
      const isCurrent = await match(key);
      return isCurrent ? isCurrent(time()) : false;
    },
  });
}

// Isolate-shared mode: load belongs to the calling request, never to this cache.
// Only parsed membership, timestamps and a plain generation token survive a call.
// A competing request fails closed instead of awaiting or cancelling another's I/O.
export function createRequestSafeEmployerCatalogCache({
  parse,
  maxBytes,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  loadTimeoutMs = 5_000,
}) {
  if (
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
  const time = (value) => {
    try {
      const at = value === undefined ? now() : value;
      if (!Number.isSafeInteger(at) || at < last || at > Number.MAX_SAFE_INTEGER - TTL - RETRY)
        return null;
      last = at;
      return at;
    } catch {
      return null;
    }
  };
  const drop = () => {
    cached = null;
    pending = null; // Never calls the owner's abort, reader or timer.
    retryAt = last + RETRY;
  };
  async function match(key, load) {
    const at = time();
    if (at === null) {
      drop();
      return null;
    }
    if (cached && at >= cached.expires) cached = null;
    if (pending) {
      if (at >= pending.deadline) drop();
      return null;
    }
    if (!cached) {
      if (at < retryAt || typeof load !== "function") return null;
      const token = { deadline: at + loadTimeoutMs, expires: at + TTL };
      pending = token;
      let known;
      // The existing bounded reader/timeout stays entirely within its owner request.
      const owner = createEmployerCatalogCache({
        load,
        maxBytes,
        now,
        schedule,
        cancel,
        loadTimeoutMs,
        parse: async (text) => {
          known = await parse(text);
          return typeof known === "function" ? () => true : null;
        },
      });
      const lease = await owner.match(key);
      const finished = time();
      if (pending !== token) return null; // A late owner cannot replace a newer generation.
      if (finished === null || finished >= token.deadline || !lease || !lease(finished)) {
        drop();
        return null;
      }
      pending = null;
      cached = { known, expires: token.expires };
    }
    const entry = cached;
    try {
      const accepted = entry.known(key),
        checked = time();
      if (typeof accepted !== "boolean" || checked === null) {
        drop();
        return null;
      }
      if (checked >= entry.expires) {
        cached = null;
        return null;
      }
      if (!accepted) return null;
      return (value) => {
        if (cached !== entry) return false;
        const checked = time(value);
        if (checked === null) {
          drop();
          return false;
        }
        if (checked >= entry.expires) {
          cached = null;
          return false;
        }
        return true;
      };
    } catch {
      drop();
      return null;
    }
  }
  return Object.freeze({
    match,
    async has(key, load) {
      const lease = await match(key, load);
      return lease ? lease(time()) : false;
    },
  });
}
