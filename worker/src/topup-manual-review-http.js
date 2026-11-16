import { FOLLOW_BODY_TIMEOUT, readFollowBody } from "./follow-http-body.js";
import { HttpError, json } from "./http.js";
import { requireAdmin } from "./placements.js";
import { listTopupManualReview } from "./topup-manual-review.js";

const PATH = "/admin/topup-review";
const PAGE_SIZE = 64;
const BODY_BYTES = 128;
const CURSOR = /^[a-f0-9]{64}$/;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const timers = { setTimeout, clearTimeout, monotonicNow: () => performance.now() };
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const empty = (status, extra) => new Response(null, { status, headers: { ...headers, ...extra } });

function decodeCursor(bytes, declared) {
  if (declared !== null && bytes.length !== declared) return null;
  const tuple = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 1 ||
    !(tuple[0] === null || (typeof tuple[0] === "string" && CURSOR.test(tuple[0])))
  )
    return null;
  return tuple;
}

// Held for a separate route-table change. The admin terminal supplies [null] or [cursor].
export async function topupManualReviewHttp({ request, env }) {
  try {
    if (env.TOPUP_MANUAL_REVIEW_ENABLED !== "1" || new URL(request.url).pathname !== PATH)
      return empty(404);
    await requireAdmin(request, env);
    if (request.headers.has("Origin")) return empty(403);
    if (!/^Bearer\s+\S+$/i.test(request.headers.get("Authorization") ?? "")) return empty(401);
    if (request.method !== "POST") return empty(405, { Allow: "POST" });
    if (request.url.includes("?") || request.url.includes("#")) return empty(400);
    if (!JSON_TYPE.test(request.headers.get("Content-Type") ?? "")) return empty(415);
    const length = request.headers.get("Content-Length");
    if (
      !request.body ||
      (length !== null && (!/^[1-9]\d{0,2}$/.test(length) || Number(length) > BODY_BYTES))
    )
      return empty(400);
    const declared = length === null ? null : Number(length);
    const input = await readFollowBody(request.body, BODY_BYTES, timers, (bytes) =>
      decodeCursor(bytes, declared),
    );
    if (input === FOLLOW_BODY_TIMEOUT) return empty(503);
    if (!input) return empty(400);
    const page = await listTopupManualReview(env.DB, {
      enabled: true,
      limit: PAGE_SIZE,
      after: input[0],
    });
    if (page.status !== "listed") return empty(503);
    return json({ candidates: page.candidates, next: page.next }, 200, headers);
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 404].includes(error.status))
      return empty(error.status);
    return empty(503);
  }
}
