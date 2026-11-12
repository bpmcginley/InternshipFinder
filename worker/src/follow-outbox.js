// Dormant digest storage only. No transport or production caller imports this module.
import {
  debitFollowSendBudget,
  followBudgetStamp,
  followSendBudgetAvailable,
  observeFollowSendBudget,
  validFollowSendCap,
} from "./follow-send-budget.js";

const DAY = 86400_000,
  LEASE = 5 * 60_000;
// Migrations 0010/0012 bound pending JSON to 32768 bytes and unique advances.
// Each advance occupies at least one byte. Add one outbox update and one pending
// deletion for a conservative aggregate bound without reading retained scopes.
const MAX_TERMINAL_CHANGES = 32768 + 2;
const encoder = new TextEncoder();
const iso = (now) => now.toISOString();
const dayOf = (now) => iso(now).slice(0, 10);
const plus = (now, duration) => new Date(+now + duration).toISOString();
const invalid = () => {
  throw new Error("Invalid digest outbox input");
};

export function payloadOf(refs) {
  if (!Array.isArray(refs) || !refs.length) invalid();
  const seen = new Set();
  for (const ref of refs) {
    if (
      !ref ||
      Object.keys(ref).sort().join(",") !== "roles,scopeKey" ||
      typeof ref.scopeKey !== "string" ||
      seen.has(ref.scopeKey) ||
      !Array.isArray(ref.roles) ||
      !ref.roles.length ||
      ref.roles.some((id) => typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id))
    )
      invalid();
    seen.add(ref.scopeKey);
  }
  const text = JSON.stringify(
    refs
      .map((r) => ({ scopeKey: r.scopeKey, roles: [...new Set(r.roles)].sort() }))
      .sort((a, b) => a.scopeKey.localeCompare(b.scopeKey)),
  );
  // Defensive storage bound, not a send-volume quota: reject oversize snapshots, never truncate.
  if (encoder.encode(text).length > 32768) invalid();
  return text;
}

// Evaluate against current confirmation for every referenced scope, inside the write transaction.
const consent = (payload, subscriber) =>
  `NOT EXISTS (SELECT 1 FROM json_each(${payload}) r WHERE NOT EXISTS ` +
  `(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=${subscriber} AND s.scope_key=json_extract(r.value,'$.scopeKey') AND s.confirmed_at IS NOT NULL))`;

export async function queueFollowDigest(db, subscriberId, refs, now = new Date()) {
  const payload = payloadOf(refs),
    id = crypto.randomUUID(),
    day = dayOf(now);
  const result = await db.batch([
    db
      .prepare(
        "INSERT INTO follow_digest_outbox (id,subscriber_id,day,payload,created,expires_at,state) " +
          `SELECT ?,id,?,?,?,?,'queued' FROM follow_subscribers WHERE id=? AND ${consent("?", "follow_subscribers.id")} ON CONFLICT(subscriber_id,day) DO NOTHING`,
      )
      .bind(id, day, payload, iso(now), plus(now, 2 * DAY), subscriberId, payload),
    db
      .prepare(
        `SELECT id FROM follow_digest_outbox WHERE subscriber_id=? AND day=? AND payload=? AND state IN ('queued','leased','attempting') AND ${consent("?", "follow_digest_outbox.subscriber_id")}`,
      )
      .bind(subscriberId, day, payload, payload),
  ]);
  return result[1].results[0]?.id ?? null;
}

// Only a pre-attempt lease can be reclaimed. An unresolved attempt blocks other leases until
// explicitly finished or expired to uncertain; an attempted job can never return to queued.
export async function leaseFollowDigest(db, id, now = new Date()) {
  const lease = crypto.randomUUID(),
    at = iso(now);
  const result = await db
    .prepare(
      "UPDATE follow_digest_outbox SET state='leased',lease_token=?,lease_until=MIN(?,expires_at) " +
        "WHERE id=? AND expires_at>? AND (state='queued' OR (state='leased' AND lease_until<=?)) " +
        "AND NOT EXISTS (SELECT 1 FROM follow_digest_outbox busy WHERE busy.id!=? AND " +
        "(busy.state='attempting' OR (busy.state='leased' AND busy.lease_until>?)))",
    )
    .bind(lease, plus(now, LEASE), id, at, at, id, at)
    .run();
  return result.meta.changes ? lease : null;
}

async function dailyMarker(key, email, now) {
  if (
    !key ||
    key.type !== "secret" ||
    key.algorithm?.name !== "HMAC" ||
    key.algorithm?.hash?.name !== "SHA-256" ||
    key.algorithm?.length < 256 ||
    !key.usages.includes("sign")
  )
    invalid();
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode("follow-digest:v1\n" + dayOf(now) + "\n" + email.trim().toLowerCase()),
  );
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

// Snapshot jobs require valid immutable metadata and an exact current progress set. The
// anti-join stops at the first extra confirmed scope; at most captured-count+1 are visited.
const snapshotConsent =
  "EXISTS (SELECT 1 FROM follow_valid_pending v WHERE v.job_id=follow_digest_outbox.id AND v.snapshot_at<=? " +
  "AND NOT EXISTS (SELECT 1 FROM json_each(v.advances) a WHERE NOT EXISTS (" +
  "SELECT 1 FROM follow_subscriptions s JOIN follow_scope_progress p " +
  "ON p.subscriber_id=s.subscriber_id AND p.scope_key=s.scope_key " +
  "WHERE s.subscriber_id=follow_digest_outbox.subscriber_id AND s.scope_key=json_extract(a.value,'$.scopeKey') " +
  "AND s.confirmed_at=json_extract(a.value,'$.confirmedAt') " +
  "AND p.scope_generation=json_extract(a.value,'$.generation') AND p.watermark=json_extract(a.value,'$.from')) " +
  ") AND NOT EXISTS (SELECT 1 FROM follow_subscriptions s " +
  "WHERE s.subscriber_id=follow_digest_outbox.subscriber_id AND s.confirmed_at IS NOT NULL " +
  "AND s.scope_key NOT IN (SELECT json_extract(a.value,'$.scopeKey') FROM json_each(v.advances) a)))";

// Compatibility for standalone dormant jobs. A present pending row still requires validation.
export function beginFollowDigestAttempt(db, key, id, lease, clock = () => new Date()) {
  return beginAttempt(db, key, id, lease, clock, false);
}

// Strict snapshot claim for existing callers. Missing pending metadata cannot use legacy fallback.
export function beginFollowSnapshotAttempt(db, key, id, lease, clock = () => new Date()) {
  return beginAttempt(db, key, id, lease, clock, true);
}

// A future snapshot sender must use this budgeted boundary. A paused result leaves the
// pre-attempt lease reclaimable and should stop that scheduler pass without immediate retries.
export async function beginBudgetedFollowSnapshotAttempt(
  db,
  key,
  id,
  lease,
  cap,
  clock = () => new Date(),
) {
  if (!validFollowSendCap(cap)) return "unavailable";
  try {
    return (await beginAttempt(db, key, id, lease, clock, true, cap)) || "unavailable";
  } catch {
    // A lost batch response may have committed. Never authorize transport or retry here.
    return "unavailable";
  }
}

function budgetClock(clock) {
  const stamp = followBudgetStamp(clock());
  if (!stamp) invalid();
  return new Date(stamp);
}

async function beginAttempt(db, key, id, lease, clock, requirePending, cap = null) {
  if (typeof clock !== "function") invalid();
  const email = await db
    .prepare(
      "SELECT u.email FROM follow_digest_outbox o JOIN follow_subscribers u ON u.id=o.subscriber_id WHERE o.id=?",
    )
    .bind(id)
    .first("email");
  if (!email) return false;
  const preparedAt = cap === null ? clock() : budgetClock(clock);
  const marker = await dailyMarker(key, email, preparedAt);
  const now = cap === null ? clock() : budgetClock(clock);
  // No stale preparation can claim yesterday's budget. Caller may prepare again without sending.
  if (dayOf(now) !== dayOf(preparedAt) || +now < +preparedAt) return false;
  const at = iso(now);
  const midnight =
    cap === null
      ? new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
        ).toISOString()
      : plus(new Date(at.slice(0, 10) + "T00:00:00.000Z"), DAY);
  if (cap !== null && midnight.length !== 24) return false;
  const valid = "id=? AND state='leased' AND lease_token=? AND lease_until>? AND expires_at>?";
  const progress = requirePending
    ? snapshotConsent
    : "(NOT EXISTS (SELECT 1 FROM follow_pending_progress WHERE job_id=follow_digest_outbox.id) OR " +
      snapshotConsent +
      ")";
  const budgetGuard = cap === null ? "" : " AND " + followSendBudgetAvailable;
  const budgetArgs = cap === null ? [] : [at, cap];
  const markerInsert = db
    .prepare(
      "INSERT INTO follow_digest_days (marker,expires_at) SELECT ?,? FROM follow_digest_outbox WHERE " +
        valid +
        ` AND ${consent("payload", "follow_digest_outbox.subscriber_id")} AND EXISTS ` +
        "(SELECT 1 FROM follow_subscribers WHERE id=follow_digest_outbox.subscriber_id AND email=?) AND " +
        progress +
        budgetGuard +
        " ON CONFLICT(marker) DO NOTHING",
    )
    .bind(marker, midnight, id, lease, at, at, email, at, ...budgetArgs);
  // changes() is the preceding marker INSERT in this atomic D1 batch. Existing markers cannot
  // authorize a second attempt, even after unsubscribe/resubscribe or across enqueue days.
  const claim = db
    .prepare(
      "UPDATE follow_digest_outbox SET state='attempting',attempted_at=?,lease_until=MIN(?,expires_at,?) WHERE " +
        valid +
        " AND changes()=1",
    )
    .bind(at, plus(now, LEASE), midnight, id, lease, at, at);
  const cancel = db
    .prepare(
      "UPDATE follow_digest_outbox SET state='cancelled',payload=NULL,lease_token=NULL,lease_until=NULL " +
        "WHERE id=? AND state='leased' AND lease_token=?" +
        budgetGuard,
    )
    .bind(id, lease, ...budgetArgs);
  if (cap === null) return (await db.batch([markerInsert, claim, cancel]))[1].meta.changes > 0;

  const results = await db.batch([
    // The attempt may extend lease_until. Keep the exact pre-claim deadlines from this
    // same transaction so a delayed response cannot authorize work under an expired lease.
    db
      .prepare("SELECT lease_until,expires_at FROM follow_digest_outbox WHERE " + valid)
      .bind(id, lease, at, at),
    observeFollowSendBudget(db, at),
    markerInsert,
    claim,
    debitFollowSendBudget(db, at, cap, true),
    cancel,
    db
      .prepare(
        "SELECT o.state,o.lease_until,o.expires_at,b.attempts FROM follow_digest_outbox o " +
          "JOIN follow_send_budget b ON b.slot=1 AND b.observed_at=? " +
          "WHERE o.id=? AND o.lease_token=?",
      )
      .bind(at, id, lease),
  ]);
  const checked = budgetClock(clock).toISOString();
  if (checked < at || checked >= midnight || !results.every(({ success }) => success)) return false;
  const [original, , , claimed, debited, , current] = results;
  const row = current.results[0];
  if (!liveDeadlines(original.results[0], checked) || !liveDeadlines(row, checked)) return false;
  if (claimed.meta.changes === 1 && debited.meta.changes === 1 && row.state === "attempting")
    return "claimed";
  if (row.state === "leased" && row.attempts >= cap) return "paused";
  return false;
}

function liveDeadlines(row, checked) {
  return (
    row &&
    [row.lease_until, row.expires_at].every(
      (value) =>
        typeof value === "string" &&
        followBudgetStamp(new Date(value)) === value &&
        checked < value,
    )
  );
}

// Caller reports a known acceptance or uncertainty; there is deliberately no retry transition.
// After lease expiry/cleanup or deletion, late completion is inert. No provider is called here.
export async function finishFollowDigestAttempt(db, id, lease, outcome, now = new Date()) {
  if (!["accepted", "uncertain"].includes(outcome)) invalid();
  const at = iso(now);
  const result = await db.batch([
    db
      .prepare(
        "UPDATE follow_subscribers SET last_sent_at=? WHERE ?='accepted' AND id IN " +
          "(SELECT subscriber_id FROM follow_digest_outbox WHERE id=? AND state='attempting' AND lease_token=? AND lease_until>?)",
      )
      .bind(at, outcome, id, lease, at),
    db
      .prepare(
        "UPDATE follow_digest_outbox SET state=?,accepted_at=?,payload=NULL,lease_token=NULL,lease_until=NULL " +
          "WHERE id=? AND state='attempting' AND lease_token=? AND lease_until>? RETURNING 1 AS changed",
      )
      .bind(outcome, outcome === "accepted" ? at : null, id, lease, at),
  ]);
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    !Object.hasOwn(result, 0) ||
    !Object.hasOwn(result, 1) ||
    result.some(
      (r) =>
        r?.success !== true ||
        !Array.isArray(r.results) ||
        !Number.isSafeInteger(r.meta?.changes) ||
        r.meta.changes < 0,
    )
  )
    return false;
  const [subscriber, terminal] = result;
  if (
    subscriber.results.length !== 0 ||
    subscriber.meta.changes > 1 ||
    (outcome === "uncertain" && subscriber.meta.changes !== 0)
  )
    return false;
  const rows = terminal.results;
  const entry = Object.getOwnPropertyDescriptor(rows, 0);
  const row = entry && Object.hasOwn(entry, "value") ? entry.value : null;
  if (
    rows.length !== 1 ||
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
    Reflect.ownKeys(row).length !== 1
  )
    return false;
  const changed = Object.getOwnPropertyDescriptor(row, "changed");
  // RETURNING counts the direct outbox update, independently of watermark triggers.
  // Only an own data property can certify the acknowledgement; never invoke a getter.
  return (
    changed?.enumerable === true &&
    Object.hasOwn(changed, "value") &&
    changed.value === 1 &&
    terminal.meta.changes >= 1 &&
    terminal.meta.changes <= MAX_TERMINAL_CHANGES &&
    subscriber.meta.changes === (outcome === "accepted" ? 1 : 0)
  );
}

export function followOutboxExpiryStatements(db, now) {
  const at = iso(now);
  return [
    db
      .prepare(
        "UPDATE follow_digest_outbox SET state='uncertain',payload=NULL,lease_token=NULL,lease_until=NULL " +
          "WHERE state='attempting' AND lease_until<=?",
      )
      .bind(at),
    db
      .prepare(
        "UPDATE follow_digest_outbox SET state='cancelled',payload=NULL,lease_token=NULL,lease_until=NULL " +
          "WHERE state IN ('queued','leased') AND expires_at<=?",
      )
      .bind(at),
    db.prepare("DELETE FROM follow_digest_outbox WHERE created<=?").bind(plus(now, -7 * DAY)),
    db.prepare("DELETE FROM follow_digest_days WHERE expires_at<=?").bind(at),
  ];
}

export async function expireFollowOutbox(db, now = new Date()) {
  await db.batch(followOutboxExpiryStatements(db, now));
}

// Dormant final transport fence. No caller may await other work after true before handoff.
// Snapshot consent is the same exact generation/progress check used by the budgeted claim.
export async function authorizeFollowSnapshotTransport(db, id, lease, subscriberId, email, clock) {
  try {
    const at = budgetClock(clock).toISOString();
    const results = await db.batch([
      db
        .prepare(
          "SELECT follow_digest_outbox.lease_until,follow_digest_outbox.expires_at FROM follow_digest_outbox " +
            "JOIN follow_subscribers u ON u.id=follow_digest_outbox.subscriber_id " +
            "WHERE follow_digest_outbox.id=? AND state='attempting' AND lease_token=? " +
            "AND subscriber_id=? AND u.email=? AND attempted_at<=? AND substr(attempted_at,1,10)=? " +
            "AND attempted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
            "AND substr(attempted_at,1,10)=date('now') " +
            "AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
            "AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
            `AND ${consent("payload", "follow_digest_outbox.subscriber_id")} AND ${snapshotConsent}`,
        )
        .bind(id, lease, subscriberId, email, at, at.slice(0, 10), at),
    ]);
    const checked = budgetClock(clock).toISOString();
    return (
      checked >= at &&
      checked.slice(0, 10) === at.slice(0, 10) &&
      results.length === 1 &&
      results[0].success === true &&
      results[0].results.length === 1 &&
      liveDeadlines(results[0].results[0], checked)
    );
  } catch {
    return false;
  }
}
