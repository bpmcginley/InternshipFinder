// Private cursor and latest-check state. Never supplies payment or retirement evidence.
import { referenceHash } from "./topup-ledger.js";

const NOW = "(unixepoch('now')*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
const ACTIVE = `mode=? AND lease=? AND lease_until_ms>${NOW}`;
const hash = /^[a-f0-9]{64}$/;
const invalid = () => {
  throw Error("Unavailable top-up reconciliation storage");
};
const modeOf = (livemode) => {
  if (typeof livemode !== "boolean") invalid();
  return livemode ? "live" : "test";
};

function cursorAfter(value) {
  if (typeof value !== "string" || (value !== "" && !hash.test(value))) invalid();
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

export function createTopupReconciliationStorage(db, leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000) invalid();
  const lease = crypto.randomUUID().replaceAll("-", "");
  let ownerMode,
    readStarted = false;
  const ownership = (livemode) => {
    if (!ownerMode || modeOf(livemode) !== ownerMode) invalid();
    return [ownerMode, lease];
  };

  return Object.freeze({
    leaseMs,
    async read(livemode) {
      if (readStarted) invalid();
      readStarted = true;
      const mode = modeOf(livemode);
      const current = await db
        .prepare(
          `INSERT INTO topup_reconciliation_cursor(mode,lease,lease_until_ms) VALUES(?,?,${NOW}+?)
         ON CONFLICT(mode) DO UPDATE SET lease=excluded.lease,lease_until_ms=excluded.lease_until_ms
         WHERE topup_reconciliation_cursor.lease IS NULL OR topup_reconciliation_cursor.lease_until_ms<=${NOW}
         RETURNING after_hash AS after,revision`,
        )
        .bind(mode, lease, leaseMs)
        .first();
      if (current) ownerMode = mode;
      return current;
    },
    async advance(livemode, expected, next) {
      const [mode, token] = ownership(livemode);
      const after = cursorAfter(next.after),
        nextRevision = revision(next.revision);
      if (nextRevision !== revision(expected.revision) + 1) invalid();
      const current = cursorAfter(expected.after);
      if (after !== "" && after <= current) invalid();
      // The probe cannot lend a test-mode marker to a live purchase even if D1 was mixed.
      const linked =
        after &&
        (await db
          .prepare(
            "SELECT p.payment_id,p.checkout_id,c.checkout_hash FROM topup_purchases p " +
              "JOIN topup_claims c ON c.payment_hash=p.payment_hash AND c.state='granted' " +
              "WHERE p.payment_hash=?",
          )
          .bind(after)
          .first());
      const [payment, checkout] = linked
        ? await Promise.all([
            referenceHash("payment", livemode, linked.payment_id),
            referenceHash("checkout", livemode, linked.checkout_id),
          ])
        : [null, null];
      const reserve = db
        .prepare(
          `UPDATE topup_reconciliation_cursor SET after_hash=?,revision=?
         WHERE ${ACTIVE} AND after_hash=? AND revision=? RETURNING after_hash AS after,revision`,
        )
        .bind(after, nextRevision, mode, token, current, expected.revision);
      if (payment !== after || checkout === null || checkout !== linked.checkout_hash)
        return reserve.first();
      // Cursor and pending marker succeed together. Deletion or a crossed identity after
      // the read can advance rotation but must not create an orphan or mismatched marker.
      const marker = db
        .prepare(
          `INSERT INTO topup_reconciliation_observations(payment_hash,mode,reservation_revision,reserved_at_ms,outcome)
         SELECT p.payment_hash,?,?,${NOW},'pending' FROM topup_purchases p
         JOIN topup_claims c ON c.payment_hash=p.payment_hash AND c.state='granted'
         WHERE p.payment_hash=? AND p.payment_id=? AND p.checkout_id=? AND c.checkout_hash=? AND changes()=1
         ON CONFLICT(payment_hash) DO UPDATE SET
           reservation_revision=excluded.reservation_revision,reserved_at_ms=excluded.reserved_at_ms,
           last_gap_at_ms=CASE WHEN topup_reconciliation_observations.outcome='pending'
             THEN MAX(COALESCE(topup_reconciliation_observations.last_gap_at_ms,0),${NOW})
             ELSE topup_reconciliation_observations.last_gap_at_ms END,outcome='pending'
         WHERE topup_reconciliation_observations.mode=excluded.mode
           AND topup_reconciliation_observations.reservation_revision<excluded.reservation_revision`,
        )
        .bind(mode, nextRevision, after, linked.payment_id, linked.checkout_id, checkout);
      const [change, observation] = await db.batch([reserve, marker]);
      if (
        change?.success !== true ||
        observation?.success !== true ||
        !Array.isArray(change.results) ||
        change.results.length > 1 ||
        ![0, 1].includes(change.meta?.changes) ||
        ![0, 1].includes(observation.meta?.changes) ||
        change.results.length !== change.meta.changes ||
        observation.meta.changes > change.meta.changes
      )
        invalid();
      return change.results[0] ?? null;
    },
    async guard(livemode) {
      return (
        (await db
          .prepare(`SELECT 1 AS owned FROM topup_reconciliation_cursor WHERE ${ACTIVE}`)
          .bind(...ownership(livemode))
          .first("owned")) === 1
      );
    },
    async write(livemode, statements) {
      // A failed CHECK rolls back the batch. Lease time can change between statements,
      // so verify ownership on both sides of the purchase revision CAS.
      const assertion = db
        .prepare(
          `INSERT INTO topup_reconciliation_cursor(mode,revision)
         SELECT ?, -1 WHERE NOT EXISTS (SELECT 1 FROM topup_reconciliation_cursor WHERE ${ACTIVE})`,
        )
        .bind(modeOf(livemode), ...ownership(livemode));
      const receipts = await db.batch([assertion, ...statements, assertion]);
      if (!Array.isArray(receipts) || receipts.length !== statements.length + 2) invalid();
      const acknowledged = (receipt) => receipt?.success === true && receipt.meta?.changes === 0;
      if (!acknowledged(receipts[0]) || !acknowledged(receipts.at(-1))) invalid();
      return receipts.slice(1, -1);
    },
    async finish(livemode, reservation, appliedRevision) {
      const [mode, token] = ownership(livemode);
      const paymentHash = cursorAfter(reservation.after),
        reservationRevision = revision(reservation.revision);
      if (!paymentHash || !reservationRevision) invalid();
      if (appliedRevision !== null) revision(appliedRevision);
      // Completion is informational. An unknown acknowledgement or concurrent webhook
      // is a gap, even if the previously submitted financial batch actually committed.
      return (
        (await db
          .prepare(
            `WITH observation(completed) AS (
           SELECT EXISTS(SELECT 1 FROM topup_reconciliations WHERE payment_hash=? AND revision=?)
         )
         UPDATE topup_reconciliation_observations
         SET outcome=CASE WHEN (SELECT completed FROM observation) THEN 'completed' ELSE 'missed' END,
           last_completed_at_ms=CASE WHEN (SELECT completed FROM observation)
             THEN MAX(COALESCE(last_completed_at_ms,0),${NOW}) ELSE last_completed_at_ms END,
           last_gap_at_ms=CASE WHEN (SELECT completed FROM observation)
             THEN last_gap_at_ms ELSE MAX(COALESCE(last_gap_at_ms,0),${NOW}) END
         WHERE payment_hash=? AND mode=? AND reservation_revision=? AND outcome='pending'
          AND EXISTS(SELECT 1 FROM topup_reconciliation_cursor WHERE ${ACTIVE} AND revision=? AND after_hash=?)
         RETURNING outcome`,
          )
          .bind(
            paymentHash,
            appliedRevision,
            paymentHash,
            mode,
            reservationRevision,
            mode,
            token,
            reservationRevision,
            paymentHash,
          )
          .first("outcome")) ?? null
      );
    },
    async close(livemode) {
      const released = await db
        .prepare(
          `UPDATE topup_reconciliation_cursor SET lease=NULL,lease_until_ms=NULL
         WHERE ${ACTIVE} RETURNING 1 AS released`,
        )
        .bind(...ownership(livemode))
        .first("released");
      ownerMode = undefined;
      return released === 1;
    },
  });
}
