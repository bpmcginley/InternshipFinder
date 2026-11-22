import { deleteFollowRequest } from "./follow-request-deletion.js";
import { confirmFollow } from "./follows.js";
import { FOLLOW_BODY_TIMEOUT, readFollowBody } from "./follow-http-body.js";

const TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;
const TOKEN_BYTES = 101;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const empty = (status) => new Response(null, { status, headers });
const unavailable = () =>
  new Response(null, { status: 503, headers: { ...headers, "Retry-After": "60" } });

async function readToken(request, prefix, timers) {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  const limit = TOKEN_BYTES + prefix.length;
  if (
    mediaType !== "text/plain" ||
    !request.body ||
    Number(request.headers.get("Content-Length")) > limit
  ) {
    return null;
  }
  return readFollowBody(request.body, limit, timers, (bytes) => {
    if (bytes.length !== limit) return null;
    const token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return token.startsWith(prefix) && TOKEN.test(token.slice(prefix.length)) ? token : null;
  });
}

export function createFollowTokenEndpoints(
  timers = { setTimeout, clearTimeout, monotonicNow: () => performance.now() },
) {
  // One shared anonymous bound per isolate. Keep the slot through the actual D1 action.
  let active = 0;
  const endpoint = (prefix, mutate, missedStatus) => async (request, db, now) => {
    if (request.method !== "POST") return empty(405);
    if (new URL(request.url).search) return empty(400);
    if (active >= 4) return unavailable();
    active += 1;
    try {
      const token = await readToken(request, prefix, timers);
      if (token === FOLLOW_BODY_TIMEOUT) return unavailable();
      if (!token) return empty(400);
      return empty((await mutate(db, token, now())) ? 204 : missedStatus);
    } catch {
      // Keep request bodies and storage errors out of the router's logging path.
      return unavailable();
    } finally {
      active -= 1;
    }
  };
  return {
    confirm: endpoint("", confirmFollow, 410),
    deleteRequest: endpoint("fd_", deleteFollowRequest, 204),
  };
}

export const followTokenEndpoints = createFollowTokenEndpoints();
