// Dormant, internal read contract. No email, tokens, queue writes or watermark advancement.
import { canonicalFollow } from "./follows.js";

const encoder = new TextEncoder();
const generation = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const instant = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const invalid = () => {
  throw new Error("Invalid follow progress");
};

// Trusted caller supplies catalog, scan upper bound and explicit resource limits. This is a
// snapshot for a later CAS, not an authorization to queue: deletion or changes can follow it.
// A deleted/unknown subscriber yields []; malformed or over-budget state never yields a prefix.
export async function readFollowProgress(
  db,
  subscriberId,
  catalog,
  { upperBound, maxScopes, maxBytes },
) {
  if (
    typeof subscriberId !== "string" ||
    !generation.test(subscriberId) ||
    !instant(upperBound) ||
    !Number.isSafeInteger(maxScopes) ||
    maxScopes < 1 ||
    maxScopes >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    invalid();
  const { results } = await db
    .prepare(
      // Do not materialize oversized legacy strings in JS. A NULL sentinel fails validation.
      "SELECT CASE WHEN length(CAST(s.scope_key AS BLOB))<=? THEN s.scope_key END AS scope_key, " +
        "CASE WHEN length(s.confirmed_at)=24 THEN s.confirmed_at END AS confirmed_at, " +
        "CASE WHEN length(p.scope_generation)=36 THEN p.scope_generation END AS scope_generation, " +
        "CASE WHEN length(p.watermark)=24 THEN p.watermark END AS watermark " +
        "FROM follow_subscriptions s LEFT JOIN follow_scope_progress p " +
        "ON p.subscriber_id=s.subscriber_id AND p.scope_key=s.scope_key " +
        "WHERE s.subscriber_id=? AND s.confirmed_at IS NOT NULL ORDER BY s.scope_key LIMIT ?",
    )
    .bind(maxBytes, subscriberId, maxScopes + 1)
    .all();
  if (results.length > maxScopes || encoder.encode(JSON.stringify(results)).length > maxBytes)
    invalid();
  for (const row of results) {
    if (
      typeof row.scope_key !== "string" ||
      !generation.test(row.scope_generation) ||
      !instant(row.confirmed_at) ||
      !instant(row.watermark) ||
      row.watermark < row.confirmed_at ||
      row.watermark > upperBound
    )
      invalid();
    try {
      if (canonicalFollow(JSON.parse(row.scope_key), catalog) !== row.scope_key) invalid();
    } catch {
      invalid();
    }
  }
  return results;
}
