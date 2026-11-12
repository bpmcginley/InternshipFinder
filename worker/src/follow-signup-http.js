import { FOLLOW_BODY_TIMEOUT, readFollowBody } from "./follow-http-body.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_IN_FLIGHT = 4;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const empty = (status, extra = {}) =>
  new Response(null, { status, headers: { ...headers, ...extra } });
const unavailable = () => empty(503, { "Retry-After": "60" });

// The future route supplies a trusted origin policy and admission function.
// There is no default route, sender, session parser, catalog source or configuration.
export function createFollowSignupHttp({
  enabled = false,
  originAllowed,
  admit,
  timers = { setTimeout, clearTimeout, monotonicNow: () => performance.now() },
} = {}) {
  let active = 0;
  return async (request) => {
    if (request.method !== "POST") return empty(405, { Allow: "POST" });
    if (enabled !== true || typeof originAllowed !== "function" || typeof admit !== "function")
      return unavailable();
    try {
      const origin = request.headers.get("Origin");
      if (!origin || origin === "null" || originAllowed(request) !== true) return empty(403);
      if (new URL(request.url).search) return empty(400);
      const contentType = request.headers.get("Content-Type")?.trim();
      if (!contentType || !JSON_TYPE.test(contentType)) return empty(415);
      const declared = request.headers.get("Content-Length");
      if (
        !request.body ||
        (declared !== null &&
          (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > MAX_BODY_BYTES))
      )
        return empty(400);
      if (active >= MAX_IN_FLIGHT) return unavailable();
      active += 1;
      try {
        const input = await readFollowBody(request.body, MAX_BODY_BYTES, timers, (bytes) => {
          if (!bytes.length || (declared !== null && bytes.length !== Number(declared)))
            return null;
          const value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
          );
          return value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).sort().join(",") === "email,link,scope" &&
            typeof value.link === "boolean"
            ? value
            : null;
        });
        if (input === FOLLOW_BODY_TIMEOUT) return unavailable();
        if (!input) return empty(400);
        const outcome = await admit(input, request);
        if (outcome?.status === "accepted") return empty(202);
        return outcome?.status === "invalid" ? empty(400) : unavailable();
      } finally {
        active -= 1;
      }
    } catch {
      return unavailable();
    }
  };
}
