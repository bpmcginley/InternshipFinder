// Dormant digest storage only. No transport or production caller imports this module.
const DAY = 86400_000,
  LEASE = 5 * 60_000;
const encoder = new TextEncoder();
const iso = (now) => now.toISOString();
const dayOf = (now) => iso(now).slice(0, 10);
const plus = (now, duration) => new Date(+now + duration).toISOString();
const invalid = () => {
  throw new Error("Invalid digest outbox input");
};

function payloadOf(refs) {
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

export async function beginFollowDigestAttempt(db, key, id, lease, clock = () => new Date()) {
  if (typeof clock !== "function") invalid();
  const email = await db
    .prepare(
      "SELECT u.email FROM follow_digest_outbox o JOIN follow_subscribers u ON u.id=o.subscriber_id WHERE o.id=?",
    )
    .bind(id)
    .first("email");
  if (!email) return false;
  const preparedAt = clock();
  const marker = await dailyMarker(key, email, preparedAt);
  const now = clock();
  // No stale preparation can claim yesterday's budget. Caller may prepare again without sending.
  if (dayOf(now) !== dayOf(preparedAt) || +now < +preparedAt) return false;
  const at = iso(now);
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
  const valid = "id=? AND state='leased' AND lease_token=? AND lease_until>? AND expires_at>?";
  const result = await db.batch([
    db
      .prepare(
        "INSERT INTO follow_digest_days (marker,expires_at) SELECT ?,? FROM follow_digest_outbox WHERE " +
          valid +
          ` AND ${consent("payload", "follow_digest_outbox.subscriber_id")} AND EXISTS ` +
          "(SELECT 1 FROM follow_subscribers WHERE id=follow_digest_outbox.subscriber_id AND email=?) ON CONFLICT(marker) DO NOTHING",
      )
      .bind(marker, midnight, id, lease, at, at, email),
    // changes() is the preceding marker INSERT in this atomic D1 batch. Existing markers cannot
    // authorize a second attempt, even after unsubscribe/resubscribe or across enqueue days.
    db
      .prepare(
        "UPDATE follow_digest_outbox SET state='attempting',attempted_at=?,lease_until=MIN(?,expires_at,?) WHERE " +
          valid +
          " AND changes()=1",
      )
      .bind(at, plus(now, LEASE), midnight, id, lease, at, at),
    db
      .prepare(
        "UPDATE follow_digest_outbox SET state='cancelled',payload=NULL,lease_token=NULL,lease_until=NULL " +
          "WHERE id=? AND state='leased' AND lease_token=?",
      )
      .bind(id, lease),
  ]);
  return result[1].meta.changes > 0;
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
          "WHERE id=? AND state='attempting' AND lease_token=? AND lease_until>?",
      )
      .bind(outcome, outcome === "accepted" ? at : null, id, lease, at),
  ]);
  return result[1].meta.changes > 0;
}

export async function expireFollowOutbox(db, now = new Date()) {
  const at = iso(now);
  await db.batch([
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
  ]);
}
