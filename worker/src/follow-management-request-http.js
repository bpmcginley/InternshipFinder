import { FOLLOW_BODY_TIMEOUT, readFollowBody } from "./follow-http-body.js";
import { normalizeFollowEmail } from "./follows.js";
import { enqueueFollowManagementRequest } from "./follow-management-request.js";

const MAX_BYTES = 16 * 1024;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const empty = (status, extra = {}) =>
  new Response(null, { status, headers: { ...headers, ...extra } });
const unavailable = () => empty(503, { "Retry-After": "60" });

// Create once per isolate. No default route, origin, request policy or sender.
export function createFollowManagementRequestHttp({
  db: defaultDb,
  enabled = false,
  originAllowed: defaultOriginAllowed,
  ttlMs: defaultTtlMs,
  dailyLimit: defaultDailyLimit,
  timers = { setTimeout, clearTimeout, monotonicNow: () => performance.now() },
} = {}) {
  let active = 0;
  return async (request, context = {}) => {
    const {
      db = defaultDb,
      originAllowed = defaultOriginAllowed,
      ttlMs = defaultTtlMs,
      dailyLimit = defaultDailyLimit,
    } = context;
    if (request.method !== "POST") return empty(405, { Allow: "POST" });
    if (
      enabled !== true ||
      !db ||
      typeof originAllowed !== "function" ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 604800000 ||
      !Number.isSafeInteger(dailyLimit) ||
      dailyLimit < 1
    )
      return unavailable();
    try {
      const origin = request.headers.get("Origin");
      if (!origin || origin === "null") return empty(403);
      const allowed = originAllowed(request);
      if (allowed !== true) {
        void Promise.prototype.then.call(Promise.resolve(allowed), undefined, () => {});
        return empty(403);
      }
      if (request.url.includes("?") || request.url.includes("#")) return empty(400);
      if (!JSON_TYPE.test(request.headers.get("Content-Type")?.trim() ?? "")) return empty(415);
      const declared = request.headers.get("Content-Length");
      if (
        !request.body ||
        (declared !== null &&
          (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > MAX_BYTES))
      )
        return empty(400);
      if (active >= 4) return unavailable();
      active++;
      try {
        const input = await readFollowBody(request.body, MAX_BYTES, timers, (bytes) => {
          if (!bytes.length || (declared !== null && bytes.length !== Number(declared)))
            return null;
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          const value = JSON.parse(text);
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).join(",") !== "email" ||
            typeof value.email !== "string"
          )
            return null;
          // An exact one-string-member object has two JSON string tokens. Count after
          // parsing grammar, so escaped duplicate keys cannot disappear in JSON.parse.
          if ([...text.matchAll(/"(?:[^"\\]|\\.)*"/g)].length !== 2) return null;
          return { email: normalizeFollowEmail(value.email) };
        });
        if (input === FOLLOW_BODY_TIMEOUT) return unavailable();
        if (!input) return empty(400);
        const outcome = await enqueueFollowManagementRequest(db, input, {
          enabled: true,
          ttlMs,
          dailyLimit,
        });
        return outcome.status === "accepted" ? empty(202) : unavailable();
      } finally {
        active--;
      }
    } catch {
      return unavailable();
    }
  };
}
