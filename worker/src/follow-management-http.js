import { FOLLOW_BODY_TIMEOUT, readFollowBody } from "./follow-http-body.js";
import { listManagedFollowsPage, removeManagedFollow, deleteManagedFollows } from "./follows.js";

const TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const empty = (status, extra = {}) =>
  new Response(null, { status, headers: { ...headers, ...extra } });
const unavailable = () => empty(503, { "Retry-After": "60" });
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { ...headers, "Content-Type": "application/json" },
  });

// No route, origin, sender or capability issuance is supplied by default.
export function createFollowManagementHttp({
  db,
  enabled = false,
  originAllowed,
  now = () => new Date(),
  timers = { setTimeout, clearTimeout, monotonicNow: () => performance.now() },
} = {}) {
  let active = 0;
  const handler = (kind) => async (request) => {
    if (request.method !== "POST") return empty(405, { Allow: "POST" });
    if (enabled !== true || !db || typeof originAllowed !== "function" || typeof now !== "function")
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
        const tuple = await readFollowBody(request.body, MAX_BYTES, timers, (bytes) => {
          if (!bytes.length || (declared !== null && bytes.length !== Number(declared)))
            return null;
          const v = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
          );
          if (
            !Array.isArray(v) ||
            v.length !== (kind === "deleteAll" ? 1 : 2) ||
            typeof v[0] !== "string" ||
            !TOKEN.test(v[0])
          )
            return null;
          if (
            kind !== "deleteAll" &&
            !(kind === "list" && v[1] === null) &&
            (typeof v[1] !== "string" ||
              !v[1].length ||
              encoder.encode(v[1]).length > 4096 ||
              /[\ud800-\udfff]/u.test(v[1]))
          )
            return null;
          return v;
        });
        if (tuple === FOLLOW_BODY_TIMEOUT) return unavailable();
        if (!tuple) return empty(400);
        const at = now();
        if (!(at instanceof Date) || !Number.isFinite(+at)) return unavailable();
        if (kind === "list") {
          const page = await listManagedFollowsPage(db, tuple[0], tuple[1], at);
          return page === null ? empty(410) : json(page);
        }
        return kind === "remove"
          ? json({ removed: await removeManagedFollow(db, tuple[0], tuple[1], at, true) })
          : json({ deleted: await deleteManagedFollows(db, tuple[0], at, true) });
      } finally {
        active--;
      }
    } catch {
      return unavailable();
    }
  };
  return { list: handler("list"), remove: handler("remove"), deleteAll: handler("deleteAll") };
}
