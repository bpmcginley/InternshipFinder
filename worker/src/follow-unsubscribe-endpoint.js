import { handleFollowUnsubscribe } from "./follow-unsubscribe.js";

const unavailable = () =>
  new Response(null, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "60" },
  });

// Four anonymous in-flight operations per isolate, not a deployment-wide quota.
// No key, IP, address or bearer is retained in the guard. A restart resets it.
export function createFollowUnsubscribeEndpoint(timers) {
  let active = 0;
  return async (request, db, now) => {
    if (active >= 4) return unavailable();
    active += 1;
    try {
      const url = new URL(request.url);
      // The only URL credential is the existing deletion-only bearer. Cookies,
      // Authorization and Origin neither grant nor restrict this capability.
      const fields = url.search.length <= 256 ? [...url.searchParams] : [];
      const token = fields.length === 1 && fields[0][0] === "token" ? fields[0][1] : null;
      return await handleFollowUnsubscribe(request, db, token, now, timers);
    } catch {
      // Missing schema/binding and transient storage failures must be retryable.
      // Never pass the request target or provider error to the router's logger.
      return unavailable();
    } finally {
      active -= 1;
    }
  };
}

export const followUnsubscribeEndpoint = createFollowUnsubscribeEndpoint();
