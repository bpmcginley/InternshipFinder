// Dormant preparation only. A sender must still claim an attempt under fresh consent.
import {
  followInstant,
  followSnapshotDigest,
  matchFollowSnapshot,
  matchFollowSnapshotWithRelated,
} from "./follow-matching.js";
import { payloadOf } from "./follow-outbox.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const unavailable = () => ({ status: "unavailable" });
function stamp(clock) {
  const time = clock();
  if (!(time instanceof Date) || !Number.isFinite(+time)) return null;
  const iso = time.toISOString();
  return iso.length === 24 ? iso : null;
}

function stillLeased(row, at, previous) {
  return (
    row &&
    at &&
    at >= previous &&
    followInstant(row.lease_until) !== null &&
    followInstant(row.expires_at) !== null &&
    at < row.lease_until &&
    at < row.expires_at
  );
}

function leasedSnapshot(db, jobId, lease, at) {
  return db
    .prepare(
      "SELECT o.subscriber_id,o.payload,o.lease_until,o.expires_at,v.snapshot_at,v.advances,p.snapshot_digest " +
        "FROM follow_digest_outbox o JOIN follow_valid_pending v ON v.job_id=o.id " +
        "JOIN follow_pending_progress p ON p.job_id=o.id " +
        "WHERE o.id=? AND o.state='leased' AND o.lease_token=? AND o.lease_until>? " +
        "AND o.expires_at>? AND v.snapshot_at<=? AND length(CAST(o.payload AS BLOB))<=32768",
    )
    .bind(jobId, lease, at, at, at)
    .first();
}

// loadSnapshot is a trusted bounded byte reader. It receives only a public snapshot pin,
// not the job, email address, or recipient links. This function makes no network request.
export async function prepareLeasedFollowDigest(
  db,
  jobId,
  lease,
  { catalog, limits, loadSnapshot, clock = () => new Date(), relatedLimits } = {},
) {
  const bounds = { ...limits };
  const related = relatedLimits === undefined ? undefined : { ...relatedLimits };
  if (
    typeof jobId !== "string" ||
    !uuid.test(jobId) ||
    typeof lease !== "string" ||
    !uuid.test(lease) ||
    typeof loadSnapshot !== "function" ||
    typeof clock !== "function" ||
    !Number.isSafeInteger(bounds.maxBytes) ||
    bounds.maxBytes < 1
  )
    return unavailable();
  const at = stamp(clock);
  if (!at) return unavailable();
  const pinned = await leasedSnapshot(db, jobId, lease, at);
  const loadingAt = stamp(clock);
  if (!stillLeased(pinned, loadingAt, at)) return unavailable();

  let matched;
  try {
    const loaded = await loadSnapshot({
      at: pinned.snapshot_at,
      digest: pinned.snapshot_digest,
      maxBytes: bounds.maxBytes,
    });
    if (!(loaded instanceof Uint8Array) || loaded.byteLength > bounds.maxBytes)
      return unavailable();
    const bytes = new Uint8Array(loaded);
    if ((await followSnapshotDigest(bytes)) !== pinned.snapshot_digest) return unavailable();
    const scopes = JSON.parse(pinned.advances).map(({ scopeKey, confirmedAt, from }) => ({
      scope_key: scopeKey,
      confirmed_at: confirmedAt,
      watermark: from,
    }));
    const options = {
      catalog,
      limits: bounds,
      upperBound: pinned.snapshot_at,
    };
    matched =
      related === undefined
        ? matchFollowSnapshot(bytes, scopes, options)
        : matchFollowSnapshotWithRelated(bytes, scopes, options, related);
    if (
      matched.status !== "matched" ||
      !matched.refs.length ||
      payloadOf(matched.refs) !== pinned.payload
    )
      return unavailable();
  } catch {
    return unavailable();
  }

  const checked = stamp(clock);
  if (!stillLeased(pinned, checked, loadingAt)) return unavailable();
  const current = await leasedSnapshot(db, jobId, lease, checked);
  if (
    !stillLeased(current, stamp(clock), checked) ||
    Object.keys(pinned).some((key) => current[key] !== pinned[key])
  )
    return unavailable();
  const result = { status: "ready", subscriberId: pinned.subscriber_id, roles: matched.roles };
  return related === undefined ? result : { ...result, similar: matched.similar };
}
