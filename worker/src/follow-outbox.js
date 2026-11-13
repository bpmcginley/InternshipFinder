// Dormant digest storage only. No transport or production caller imports this module.
import {
  debitFollowSendBudget,
  followBudgetStamp,
  followSendBudgetAvailable,
  observeFollowSendBudget,
  validFollowSendCap,
} from "./follow-send-budget.js";
import { normalizeFollowEmail } from "./follows.js";

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
  capabilities = null,
) {
  if (!validFollowSendCap(cap)) return "unavailable";
  try {
    const issued = capabilities === null ? null : copyCapabilities(capabilities);
    return (await beginAttempt(db, key, id, lease, clock, true, cap, issued)) || "unavailable";
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

async function beginAttempt(db, key, id, lease, clock, requirePending, cap = null, issued = null) {
  if (typeof clock !== "function") invalid();
  const email = await db
    .prepare(
      "SELECT u.email FROM follow_digest_outbox o JOIN follow_subscribers u ON u.id=o.subscriber_id WHERE o.id=?",
    )
    .bind(id)
    .first("email");
  if (!email || (issued && email !== issued.email)) return false;
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
  const issuanceGuard = issued
    ? " AND subscriber_id=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND substr(?,1,10)=date('now')"
    : "";
  const issuanceArgs = issued ? [issued.subscriberId, at, at] : [];
  const markerInsert = db
    .prepare(
      "INSERT INTO follow_digest_days (marker,expires_at) SELECT ?,? FROM follow_digest_outbox WHERE " +
        valid +
        ` AND ${consent("payload", "follow_digest_outbox.subscriber_id")} AND EXISTS ` +
        "(SELECT 1 FROM follow_subscribers WHERE id=follow_digest_outbox.subscriber_id AND email=?) AND " +
        progress +
        budgetGuard +
        issuanceGuard +
        " ON CONFLICT(marker) DO NOTHING",
    )
    .bind(marker, midnight, id, lease, at, at, email, at, ...budgetArgs, ...issuanceArgs);
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
    observeFollowSendBudget(db, at, issued !== null),
    markerInsert,
    claim,
    debitFollowSendBudget(db, at, cap, true),
    ...issueStatements(db, issued, id, lease, at),
    cancel,
    db
      .prepare(
        "SELECT o.state,o.lease_until,o.expires_at,b.attempts FROM follow_digest_outbox o " +
          "JOIN follow_send_budget b ON b.slot=1 AND b.observed_at=? " +
          "WHERE o.id=? AND o.lease_token=?",
      )
      .bind(at, id, lease),
    ...(issued ? [capabilityReceipt(db, issued, id, lease, at)] : []),
  ]);
  const checked = budgetClock(clock).toISOString();
  if (issued) return issuedReceipt(results, issued, checked, at, midnight, cap);
  if (checked < at || checked >= midnight || !results.every(({ success }) => success)) return false;
  const [original, , , claimed, debited, , current] = results;
  const row = current.results[0];
  if (!liveDeadlines(original.results[0], checked) || !liveDeadlines(row, checked)) return false;
  if (claimed.meta.changes === 1 && debited.meta.changes === 1 && row.state === "attempting")
    return "claimed";
  if (row.state === "leased" && row.attempts >= cap) return "paused";
  return false;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const validStamp = (v) => typeof v === "string" && followBudgetStamp(new Date(v)) === v;
function copyCapabilities(value) {
  const keys = [
    "subscriberId",
    "email",
    "managementHash",
    "managementGeneration",
    "unsubscribeHash",
    "unsubscribeGeneration",
  ];
  const copied = receiptFields(value, keys);
  if (
    !copied ||
    Reflect.ownKeys(value).length !== keys.length ||
    ![copied.subscriberId, copied.managementGeneration, copied.unsubscribeGeneration].every(
      (v) => typeof v === "string" && UUID.test(v),
    ) ||
    ![copied.managementHash, copied.unsubscribeHash].every(
      (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    ) ||
    copied.managementHash === copied.unsubscribeHash ||
    copied.managementGeneration === copied.unsubscribeGeneration ||
    typeof copied.email !== "string" ||
    normalizeFollowEmail(copied.email) !== copied.email
  )
    invalid();
  return Object.freeze(copied);
}

function issueStatements(db, c, id, lease, at) {
  if (!c) return [];
  const exact =
    "o.id=? AND o.state='attempting' AND o.lease_token=? AND o.attempted_at=? AND o.subscriber_id=?";
  const args = [id, lease, at, c.subscriberId];
  // Both hashes are inserted in one statement immediately after the exact debit. The
  // following deletion requires that statement's two direct changes, never old token existence.
  return [
    db
      .prepare(
        "INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at) " +
          "SELECT t.hash,o.subscriber_id,t.purpose,'',t.generation,t.expiry FROM follow_digest_outbox o CROSS JOIN " +
          "(SELECT ? AS hash,? AS generation,'manage' AS purpose,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes') AS expiry UNION ALL SELECT ?,?,'unsubscribe',NULL) t WHERE " +
          exact +
          " AND changes()=1",
      )
      .bind(
        c.managementHash,
        c.managementGeneration,
        c.unsubscribeHash,
        c.unsubscribeGeneration,
        ...args,
      ),
    db
      .prepare(
        "DELETE FROM follow_tokens WHERE purpose='manage' AND scope_key='' AND token_hash!=? AND subscriber_id=? AND changes()=2",
      )
      .bind(c.managementHash, c.subscriberId),
  ];
}

function capabilityReceipt(db, c, id, lease, at) {
  return db
    .prepare(
      "SELECT m.expires_at AS management_expires_at FROM follow_digest_outbox o JOIN follow_subscribers u ON u.id=o.subscriber_id " +
        "JOIN follow_tokens m ON m.subscriber_id=u.id AND m.token_hash=? AND m.generation=? AND m.purpose='manage' AND m.scope_key='' AND m.owner_user_hash IS NULL " +
        "JOIN follow_tokens v ON v.subscriber_id=u.id AND v.token_hash=? AND v.generation=? AND v.purpose='unsubscribe' AND v.scope_key='' AND v.owner_user_hash IS NULL AND v.expires_at IS NULL " +
        "WHERE o.id=? AND o.lease_token=? AND o.state='attempting' AND o.attempted_at=? AND o.subscriber_id=? AND u.email=? " +
        "AND m.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND m.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes') " +
        "AND NOT EXISTS(SELECT 1 FROM follow_tokens other WHERE other.subscriber_id=u.id AND other.purpose='manage' AND other.scope_key='' AND other.token_hash!=m.token_hash)",
    )
    .bind(
      c.managementHash,
      c.managementGeneration,
      c.unsubscribeHash,
      c.unsubscribeGeneration,
      id,
      lease,
      at,
      c.subscriberId,
      c.email,
    );
}

function strictReceipts(value, count) {
  if (!receiptArray(value) || value.length !== count) invalid();
  const copied = [];
  for (let i = 0; i < count; i++) {
    const r = receiptFields(receiptEntry(value, i), ["success", "results", "meta"]);
    const meta = receiptFields(r?.meta, ["changes"]);
    if (
      !r ||
      r.success !== true ||
      !meta ||
      !Number.isSafeInteger(meta.changes) ||
      meta.changes < 0 ||
      !receiptArray(r.results)
    )
      invalid();
    copied.push({ changes: meta.changes, results: r.results });
  }
  return copied;
}
function readFields(receipt, keys) {
  if (receipt.changes !== 0 || receipt.results.length > 1) invalid();
  if (!receipt.results.length) return null;
  const row = receiptEntry(receipt.results, 0),
    copied = receiptFields(row, keys);
  if (!copied || Reflect.ownKeys(row).length !== keys.length) invalid();
  return copied;
}
function issuedReceipt(results, credentials, checked, at, midnight, cap) {
  const r = strictReceipts(results, 10);
  const original = readFields(r[0], ["lease_until", "expires_at"]);
  const current = readFields(r[8], ["state", "lease_until", "expires_at", "attempts"]);
  const issued = readFields(r[9], ["management_expires_at"]);
  for (const i of [1, 2, 3, 4, 5, 6, 7]) if (r[i].results.length) invalid();
  if (
    checked < at ||
    checked >= midnight ||
    !liveDeadlines(original, checked) ||
    !liveDeadlines(current, checked) ||
    !Number.isSafeInteger(current.attempts) ||
    current.attempts < 0 ||
    ![0, 1].includes(r[1].changes)
  )
    return false;
  if (
    [2, 3, 4].every((i) => r[i].changes === 1) &&
    r[5].changes === 2 &&
    r[7].changes === 0 &&
    current.state === "attempting" &&
    issued &&
    validStamp(issued.management_expires_at) &&
    checked < issued.management_expires_at
  ) {
    return { status: "claimed", credentials, expiresAt: issued.management_expires_at };
  }
  // Only a complete no-write claim may pause. All other uncertainty stays closed.
  if (
    [2, 3, 4, 5, 6, 7].every((i) => r[i].changes === 0) &&
    !issued &&
    current.state === "leased" &&
    current.attempts >= cap
  )
    return "paused";
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

// Read only expected own data fields. Native metadata may contain additional
// fields, which are deliberately neither inspected nor invoked.
function receiptFields(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return null;
  const copy = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, "value")) return null;
    copy[key] = d.value;
  }
  return copy;
}
const receiptArray = (value) =>
  Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
function receiptEntry(value, index) {
  const d = Object.getOwnPropertyDescriptor(value, index);
  return d?.enumerable && Object.hasOwn(d, "value") ? d.value : null;
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
  if (!receiptArray(result) || result.length !== 2) return false;
  const receipts = [];
  for (const index of [0, 1]) {
    const r = receiptFields(receiptEntry(result, index), ["success", "results", "meta"]);
    const meta = receiptFields(r?.meta, ["changes"]);
    if (
      !r ||
      r.success !== true ||
      !receiptArray(r.results) ||
      !meta ||
      !Number.isSafeInteger(meta.changes) ||
      meta.changes < 0
    )
      return false;
    receipts.push({ results: r.results, changes: meta.changes });
  }
  const [subscriber, terminal] = receipts;
  if (subscriber.results.length !== 0 || subscriber.changes !== (outcome === "accepted" ? 1 : 0))
    return false;
  const rows = terminal.results;
  if (rows.length !== 1) return false;
  const row = receiptEntry(rows, 0),
    changed = receiptFields(row, ["changed"]);
  // RETURNING counts the direct update independently of watermark triggers.
  return (
    changed !== null &&
    Reflect.ownKeys(row).length === 1 &&
    changed.changed === 1 &&
    terminal.changes >= 1 &&
    terminal.changes <= MAX_TERMINAL_CHANGES
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
export async function authorizeFollowSnapshotTransport(
  db,
  id,
  lease,
  subscriberId,
  email,
  clock,
  capabilities = null,
) {
  try {
    const proof =
      capabilities === null ? null : receiptFields(capabilities, ["credentials", "expiresAt"]);
    if (capabilities !== null && !proof) return false;
    const issued = proof ? copyCapabilities(proof.credentials) : null;
    const expiry = proof ? proof.expiresAt : null;
    if (
      issued &&
      (issued.subscriberId !== subscriberId || issued.email !== email || !validStamp(expiry))
    )
      return false;
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
            `AND ${consent("payload", "follow_digest_outbox.subscriber_id")} AND ${snapshotConsent}` +
            (issued
              ? ` AND EXISTS(SELECT 1 FROM follow_tokens m WHERE m.subscriber_id=u.id AND m.token_hash=? AND m.generation=? AND m.purpose='manage' AND m.scope_key='' AND m.owner_user_hash IS NULL AND m.expires_at=? AND m.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS(SELECT 1 FROM follow_tokens other WHERE other.subscriber_id=u.id AND other.purpose='manage' AND other.scope_key='' AND other.token_hash!=m.token_hash)) AND EXISTS(SELECT 1 FROM follow_tokens v WHERE v.subscriber_id=u.id AND v.token_hash=? AND v.generation=? AND v.purpose='unsubscribe' AND v.scope_key='' AND v.owner_user_hash IS NULL AND v.expires_at IS NULL)`
              : ""),
        )
        .bind(
          id,
          lease,
          subscriberId,
          email,
          at,
          at.slice(0, 10),
          at,
          ...(issued
            ? [
                issued.managementHash,
                issued.managementGeneration,
                expiry,
                issued.unsubscribeHash,
                issued.unsubscribeGeneration,
              ]
            : []),
        ),
    ]);
    const checked = budgetClock(clock).toISOString();
    if (issued) {
      const receipts = strictReceipts(results, 1);
      const row = readFields(receipts[0], ["lease_until", "expires_at"]);
      return (
        checked >= at &&
        checked.slice(0, 10) === at.slice(0, 10) &&
        checked < expiry &&
        liveDeadlines(row, checked)
      );
    }
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
