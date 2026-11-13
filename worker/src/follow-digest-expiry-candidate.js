import { expiryReceipts } from "./follow-expiry-page.js";

const { record, rowid, dense, receipt } = expiryReceipts;
const unavailable = () => ({ status: "unavailable" });
const DAY = 86400000;
const encoder = new TextEncoder();
const table = "follow_digest_outbox";

// Do not take the first two in lease order unless the third-row probe proves
// the set is complete. Once complete, choose the minimum signed integer rowid.
const selection = `WITH
  attempts AS MATERIALIZED (
    SELECT rowid,id FROM ${table} INDEXED BY follow_digest_outbox_due
    WHERE state='attempting' AND lease_until<=?1 ORDER BY lease_until,rowid LIMIT 3
  ), attempt_set AS MATERIALIZED (
    SELECT count(*) AS due,CAST(min(rowid) AS TEXT) AS first,CAST(max(rowid) AS TEXT) AS last,
      (SELECT id FROM attempts ORDER BY rowid LIMIT 1) AS first_id,
      (SELECT id FROM attempts ORDER BY rowid DESC LIMIT 1) AS last_id
    FROM attempts
  ), queued AS MATERIALIZED (
    SELECT rowid FROM ${table} INDEXED BY follow_digest_outbox_expiry
    WHERE state='queued' AND expires_at<=?1 ORDER BY expires_at,rowid LIMIT 1
  ), leased AS MATERIALIZED (
    SELECT rowid FROM ${table} INDEXED BY follow_digest_outbox_expiry
    WHERE state='leased' AND expires_at<=?1 ORDER BY expires_at,rowid LIMIT 1
  ), old AS MATERIALIZED (
    SELECT rowid FROM ${table} INDEXED BY follow_digest_outbox_created
    WHERE created<=?2 ORDER BY created,rowid LIMIT 1
  ), candidate AS MATERIALIZED (
    SELECT min(rowid) AS rid FROM (
      SELECT rowid FROM attempts UNION ALL SELECT rowid FROM queued
      UNION ALL SELECT rowid FROM leased UNION ALL SELECT rowid FROM old
    ) WHERE (SELECT due FROM attempt_set)<3
  ), plan AS (
    SELECT attempt_set.*, CAST(q.rowid AS TEXT) AS selected,
      CASE WHEN q.rowid IS NOT NULL THEN json_array(CAST(q.rowid AS TEXT),q.id,q.state,
        q.subscriber_id,q.day,q.created,q.expires_at,q.lease_token,q.lease_until,q.attempted_at,
        CASE WHEN q.state='attempting' AND q.lease_until<=?1 THEN 'uncertain'
          WHEN q.state IN ('queued','leased') AND q.expires_at<=?1 THEN 'cancelled' END,
        CASE WHEN q.created<=?2 THEN 1 ELSE 0 END) END AS target
    FROM attempt_set CROSS JOIN candidate LEFT JOIN ${table} q ON q.rowid=candidate.rid
  ), proof AS (
    SELECT plan.*, p.snapshot_digest AS digest,p.snapshot_at,p.advances
    FROM plan LEFT JOIN follow_pending_progress p
      ON json_extract(plan.target,'$[10]')='uncertain'
        AND p.job_id=json_extract(plan.target,'$[1]')
  ) `;

const selectPlan = `${selection} SELECT due,first,first_id,last,last_id,selected,target,digest,snapshot_at,advances FROM proof`;
const revalidate = `(${selection}
  SELECT target IS ?3 AND due=?4 AND first IS ?5 AND last IS ?6
    AND first_id IS ?7 AND last_id IS ?8
    AND digest IS ?9 AND snapshot_at IS ?10 AND advances IS ?11 FROM proof)`;
const returning = "RETURNING CAST(rowid AS TEXT) AS rowid,id";

function fail() {
  throw new Error("Follow digest expiry unavailable");
}

function onlyRow(value, keys) {
  const r = receipt(value);
  if (r.changes !== 0 || r.rows.length !== 1) fail();
  const row = record(r.rows[0]);
  if (Object.keys(row).sort().join(",") !== keys) fail();
  return row;
}

function checkedPlan(value) {
  const plan = onlyRow(
    value,
    "advances,digest,due,first,first_id,last,last_id,selected,snapshot_at,target",
  );
  const { due, first, first_id, last, last_id, selected, target } = plan;
  if (due === 0) {
    if ([first, last, first_id, last_id].some((v) => v !== null)) fail();
  } else if (
    ![1, 2, 3].includes(due) ||
    [first_id, last_id].some((id) => typeof id !== "string" || !id) ||
    (due === 1
      ? rowid(first) !== rowid(last) || first_id !== last_id
      : rowid(first) >= rowid(last) || first_id === last_id)
  ) {
    fail();
  }
  const pending = [plan.digest, plan.snapshot_at, plan.advances];
  const absent = pending.every((v) => v === null);
  if (target === null) {
    if (selected !== null || !absent || (due !== 0 && due !== 3)) fail();
    return plan;
  }
  if (due === 3 || typeof target !== "string") fail();
  const fields = dense(JSON.parse(target), 12);
  const [key, id, , , , , , , , , transition, remove] = fields;
  if (
    fields.length !== 12 ||
    key !== selected ||
    (due > 0 && rowid(key) > rowid(first)) ||
    typeof id !== "string" ||
    !id ||
    ![null, "uncertain", "cancelled"].includes(transition) ||
    ![0, 1].includes(remove) ||
    (transition === null && !remove)
  )
    fail();
  rowid(key);
  // The deployed schema permits a noncanonical 24-character snapshot time. Pin
  // its exact value and let the existing finalizer reject invalid chronology.
  if (
    !absent &&
    (transition !== "uncertain" ||
      typeof plan.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(plan.digest) ||
      typeof plan.snapshot_at !== "string" ||
      [...plan.snapshot_at].length !== 24 ||
      typeof plan.advances !== "string" ||
      plan.advances.length > 32768 ||
      encoder.encode(plan.advances).length > 32768)
  )
    fail();
  return { ...plan, id, transition, remove };
}

function checkWrite(result, { selected, id }, maximumChanges) {
  const write = receipt(result);
  if (write.rows.length !== 1 || write.changes < 1 || write.changes > maximumChanges) fail();
  const removed = record(write.rows[0]);
  if (
    Object.keys(removed).sort().join(",") !== "id,rowid" ||
    removed.id !== id ||
    removed.rowid !== selected
  )
    fail();
}

// Dormant one-job operation. No sender, owner, cursor or production caller.
export async function expireFollowDigestCandidate(db, options = {}) {
  try {
    const policy = record(options);
    if (policy.enabled !== true) return { status: "disabled" };
    if (Object.keys(policy).join() !== "enabled") fail();
    const clock = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at");
    const { at } = onlyRow(await clock.all(), "at");
    if (typeof at !== "string" || !/^\d{4}-/.test(at) || new Date(at).toISOString() !== at) fail();
    const cutoff = new Date(Date.parse(at) - 7 * DAY).toISOString();
    const plan = checkedPlan(await db.prepare(selectPlan).bind(at, cutoff).all());
    if (plan.due === 3) return unavailable();
    if (plan.target === null) return { status: "maintained", complete: true };

    const args = [
      at,
      cutoff,
      plan.target,
      plan.due,
      plan.first,
      plan.last,
      plan.first_id,
      plan.last_id,
      plan.digest,
      plan.snapshot_at,
      plan.advances,
      plan.selected,
      plan.id,
    ];
    const same = "rowid=CAST(?12 AS INTEGER) AND id=?13";
    const mutation = [];
    if (plan.transition) {
      mutation.push(
        db
          .prepare(
            `UPDATE ${table} NOT INDEXED SET state=?14,
        payload=NULL,lease_token=NULL,lease_until=NULL
        WHERE ${same} AND ${revalidate} ${returning}`,
          )
          .bind(...args, plan.transition),
      );
    }
    if (plan.remove) {
      // The first update can change eligibility/order. Delete its exact row only
      // if the immediately preceding direct write succeeded in the same batch.
      const guard = plan.transition ? "changes()=1" : revalidate;
      mutation.push(
        db
          .prepare(
            `DELETE FROM ${table} NOT INDEXED
        WHERE ${same} AND created<=?2 AND ${guard} ${returning}`,
          )
          .bind(...args),
      );
    }
    const results = dense(await db.batch(mutation), 2);
    if (results.length !== mutation.length) fail();
    if (plan.transition) checkWrite(results[0], plan, plan.transition === "uncertain" ? 32770 : 2);
    if (plan.remove) checkWrite(results.at(-1), plan, 2);
    return {
      status: "maintained",
      complete: false,
      uncertain: Number(plan.transition === "uncertain"),
      cancelled: Number(plan.transition === "cancelled"),
      removed: plan.remove,
    };
  } catch {
    // A failed acknowledgement can follow a commit. No retry or progress claim.
    return unavailable();
  }
}
