// Dormant raw page port. The caller authenticates account/mode; traversal owns all body limits.
const failure = () => new Error("History page unavailable");
const fail = () => {
  throw failure();
};
function record(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.isFrozen(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(",") !== keys) fail();
  const copy = Object.create(null);
  for (const [key, d] of Object.entries(descriptors)) {
    if (!d.enumerable || !Object.hasOwn(d, "value")) fail();
    copy[key] = d.value;
  }
  return copy;
}
function version(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:\.[a-z][a-z0-9-]{0,31})?$/.test(value))
    return false;
  const date = value.slice(0, 10),
    time = Date.parse(date + "T00:00:00.000Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}
function target(query) {
  const q = record(
    query,
    Object.hasOwn(query ?? {}, "starting_after") ? "created,limit,starting_after" : "created,limit",
  );
  const created = record(q.created, "gte,lt");
  if (
    q.limit !== 100 ||
    !Number.isSafeInteger(created.gte) ||
    created.gte < 0 ||
    !Number.isSafeInteger(created.lt) ||
    created.lt <= created.gte
  )
    fail();
  const params = new URLSearchParams({
    "created[gte]": String(created.gte),
    "created[lt]": String(created.lt),
    limit: "100",
  });
  if (Object.hasOwn(q, "starting_after")) {
    if (typeof q.starting_after !== "string" || !/^evt_[A-Za-z0-9_]{1,250}$/.test(q.starting_after))
      fail();
    params.set("starting_after", q.starting_after);
  }
  return "https://api.stripe.com/v1/events?" + params.toString();
}
function discard(response) {
  try {
    void Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {
    /* Unknown/closed bodies do not authorize evidence. */
  }
}
export function createTopupHistoryPageReader({ enabled = false, requestVersion, request } = {}) {
  const ready = enabled === true && version(requestVersion) && typeof request === "function";
  return (query, signal) => {
    let url;
    try {
      if (!ready || !(signal instanceof AbortSignal) || signal.aborted) fail();
      url = target(query);
    } catch {
      return Promise.reject(failure());
    }
    return new Promise((resolve, reject) => {
      let finished = false;
      const deny = () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", deny);
        reject(failure());
      };
      signal.addEventListener("abort", deny, { once: true });
      if (signal.aborted) {
        deny();
        return;
      }
      try {
        const pending = request(
          url,
          Object.freeze({
            method: "GET",
            redirect: "manual",
            signal,
            headers: Object.freeze({ "Stripe-Version": requestVersion }),
          }),
        );
        if (!pending || typeof pending.then !== "function") {
          discard(pending);
          fail();
        }
        Promise.resolve(pending).then((response) => {
          try {
            if (finished || signal.aborted) {
              discard(response);
              deny();
              return;
            }
            if (
              !(response instanceof Response) ||
              response.status !== 200 ||
              response.redirected ||
              response.url !== url
            ) {
              discard(response);
              deny();
              return;
            }
            finished = true;
            signal.removeEventListener("abort", deny);
            resolve(response); // No read, clone, buffering or parsing here.
          } catch {
            discard(response);
            deny();
          }
        }, deny);
      } catch {
        deny();
      }
    });
  };
}
