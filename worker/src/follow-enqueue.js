// Dormant transaction composition. No sender, producer, route, cron or progress finalization.
import { followInstant, followSnapshotDigest, matchFollowSnapshot } from "./follow-matching.js";
import { readFollowProgress } from "./follow-progress.js";
import { payloadOf } from "./follow-outbox.js";

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value).length;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const invalid = (reason) => ({ status: "invalid", reason });

// Every captured confirmed scope must still exist with the identical lifetime/from timestamp,
// and there must be no additional confirmed scope. Pending scopes cannot receive matching mail.
const currentScopes = (count) =>
  "(SELECT COUNT(*) FROM (SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=u.id " +
  `AND s.confirmed_at IS NOT NULL LIMIT ${count + 1}))=json_array_length(c.advances) ` +
  "AND NOT EXISTS (SELECT 1 FROM json_each(c.advances) a WHERE NOT EXISTS (" +
  "SELECT 1 FROM follow_subscriptions s JOIN follow_scope_progress p " +
  "ON p.subscriber_id=s.subscriber_id AND p.scope_key=s.scope_key " +
  "WHERE s.subscriber_id=u.id AND s.scope_key=json_extract(a.value,'$.scopeKey') " +
  "AND s.confirmed_at=json_extract(a.value,'$.confirmedAt') " +
  "AND p.scope_generation=json_extract(a.value,'$.generation') " +
  "AND p.watermark=json_extract(a.value,'$.from')))";

const noLiveJob =
  "NOT EXISTS (SELECT 1 FROM follow_digest_outbox busy WHERE busy.subscriber_id=u.id " +
  "AND busy.state IN ('queued','leased','attempting') AND busy.expires_at>?)";

// SQLite evaluates UTC at the mutating statement. The day fence prevents a
// delayed statement from inheriting yesterday's admission and daily key.
const databaseNow = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const archiveTimeGuard = ` AND ${databaseNow}>=? AND ${databaseNow}<? AND substr(${databaseNow},1,10)=?`;
const archiveTimeParameters = (admission, upperBound, at) =>
  admission ? [upperBound, admission.enqueueUntil, at.slice(0, 10)] : [];

async function advanceEmptyWindow(db, subscriberId, advances, current, at, upperBound, admission) {
  // Evaluate the full-set check once, before any of its captured watermarks are updated.
  const [result] = await db.batch([
    db
      .prepare(
        "WITH captured(advances) AS (SELECT ?), ready(id) AS MATERIALIZED (" +
          "SELECT u.id FROM follow_subscribers u CROSS JOIN captured c WHERE u.id=? AND " +
          current +
          " AND " +
          noLiveJob +
          " AND NOT EXISTS (SELECT 1 FROM follow_digest_outbox busy " +
          "WHERE busy.state='attempting' AND busy.subscriber_id=u.id)" +
          (admission ? archiveTimeGuard : "") +
          ") " +
          "UPDATE follow_scope_progress SET watermark=? WHERE subscriber_id=(SELECT id FROM ready) " +
          "AND watermark<? AND scope_key IN (SELECT json_extract(a.value,'$.scopeKey') " +
          "FROM captured c,json_each(c.advances) a)",
      )
      .bind(
        advances,
        subscriberId,
        at,
        ...archiveTimeParameters(admission, upperBound, at),
        upperBound,
        upperBound,
      ),
  ]);
  return { status: result.meta.changes ? "advanced" : "conflict" };
}

// Trusted caller supplies already bounded public bytes, authoritative date/catalog and limits.
// Return does not authorize transport. Callers must retain/retrieve the identical public digest
// later. Only a complete, empty window without a competing job advances immediately.
export async function enqueueFollowSnapshot(
  db,
  subscriberId,
  input,
  { catalog, limits, upperBound, maxProgressBytes, maxPendingBytes, archiveAdmission },
  now = new Date(),
) {
  let nowMs = now instanceof Date ? +now : NaN;
  if (
    !(input instanceof Uint8Array) ||
    !positive(limits?.maxBytes) ||
    input.byteLength > limits.maxBytes ||
    !positive(maxPendingBytes) ||
    maxPendingBytes > 32768 ||
    !Number.isFinite(nowMs)
  )
    return invalid("configuration");
  // Own the bytes across asynchronous reads/hash computation; callers cannot swap the snapshot.
  const snapshot = new Uint8Array(input);
  let at = new Date(nowMs).toISOString();
  const admission = archiveAdmission && { ...archiveAdmission };
  const deadline = followInstant(admission?.enqueueUntil);
  const generated = followInstant(upperBound);
  if (
    admission &&
    (deadline === null || generated === null || typeof admission.clock !== "function")
  )
    return invalid("archive_admission");
  function refreshAdmission() {
    if (!admission) return true;
    const current = admission.clock();
    if (
      !(current instanceof Date) ||
      !Number.isFinite(+current) ||
      +current < nowMs ||
      +current >= deadline ||
      +current < generated
    )
      return false;
    nowMs = +current;
    at = current.toISOString();
    return true;
  }
  if (!refreshAdmission()) return invalid("archive_admission");
  let scopes;
  try {
    scopes = await readFollowProgress(db, subscriberId, catalog, {
      upperBound,
      maxScopes: limits.maxFollows,
      maxBytes: maxProgressBytes,
    });
  } catch (error) {
    if (error.message === "Invalid follow progress") return invalid("progress");
    throw error;
  }
  if (!refreshAdmission()) return invalid("archive_admission");
  if (upperBound > at) return invalid("future_snapshot");
  const matched = matchFollowSnapshot(
    snapshot,
    scopes.map(({ scope_key, confirmed_at, watermark }) => ({
      scope_key,
      confirmed_at,
      watermark,
    })),
    { catalog, limits, upperBound },
  );
  if (matched.status !== "matched") return matched;
  if (!matched.refs.length && !scopes.some(({ watermark }) => watermark < upperBound))
    return { status: "empty" };
  const advances = JSON.stringify(
    scopes.map((scope) => ({
      scopeKey: scope.scope_key,
      generation: scope.scope_generation,
      confirmedAt: scope.confirmed_at,
      from: scope.watermark,
      to: upperBound,
    })),
  );
  if (bytes(advances) > maxPendingBytes) return invalid("pending_bound");
  const current = currentScopes(scopes.length);
  if (!matched.refs.length) {
    if (!refreshAdmission()) return invalid("archive_admission");
    return advanceEmptyWindow(db, subscriberId, advances, current, at, upperBound, admission);
  }
  // Reuse the existing outbox's canonical references and 32-KiB validation.
  let payload;
  try {
    payload = payloadOf(matched.refs);
  } catch {
    return invalid("pending_bound");
  }
  const digest = await followSnapshotDigest(snapshot);
  if (!refreshAdmission()) return invalid("archive_admission");
  const id = crypto.randomUUID(),
    day = at.slice(0, 10);
  const result = await db.batch([
    db
      .prepare(
        "WITH captured(advances) AS (SELECT ?) " +
          "INSERT INTO follow_digest_outbox (id,subscriber_id,day,payload,created,expires_at,state) " +
          "SELECT ?,u.id,?,?,?,?,'queued' FROM follow_subscribers u CROSS JOIN captured c " +
          "WHERE u.id=? AND " +
          current +
          " AND " +
          noLiveJob +
          (admission ? archiveTimeGuard : "") +
          " ON CONFLICT(subscriber_id,day) DO NOTHING",
      )
      .bind(
        advances,
        id,
        day,
        payload,
        at,
        new Date(nowMs + 2 * 86400_000).toISOString(),
        subscriberId,
        at,
        ...archiveTimeParameters(admission, upperBound, at),
      ),
    db
      .prepare(
        "INSERT INTO follow_pending_progress (job_id,snapshot_digest,snapshot_at,advances) " +
          "SELECT id,?,?,? FROM follow_digest_outbox WHERE id=? AND state='queued'",
      )
      .bind(digest, upperBound, advances, id),
    db
      .prepare(
        "SELECT o.id FROM follow_digest_outbox o " +
          "JOIN follow_subscribers u ON u.id=o.subscriber_id " +
          "JOIN follow_pending_progress p ON p.job_id=o.id CROSS JOIN (SELECT ? AS advances) c " +
          "WHERE u.id=? AND o.day=? AND o.payload=? AND o.expires_at>? " +
          "AND o.state IN ('queued','leased','attempting') " +
          "AND p.snapshot_digest=? AND p.snapshot_at=? AND p.advances=c.advances AND " +
          current,
      )
      .bind(advances, subscriberId, day, payload, at, digest, upperBound),
  ]);
  const queued = result[2].results[0]?.id;
  return queued ? { status: "queued", id: queued } : { status: "conflict" };
}
