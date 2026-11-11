// Evidence prerequisite only. No retirement, provider read, clock injection or scheduler.
import { decideTopup } from "./topup-decisions.js";
const initial = { deleted: false, fullRefund: false, loss: false, held: false, heldDisputeIds: [] };

// Validate complete lists even when the committed credit decision short-circuits a prior
// refund/loss. Credit disposition alone says nothing about financial resolution.
export function topupFinanciallyResolved(snapshot, previous) {
  if (typeof previous?.loss !== "boolean" || previous.loss) return false; // Governing lost identity was not retained by older writers.
  const heldIds = previous.heldDisputeIds ?? [];
  if (!Array.isArray(heldIds)) return false;
  const validated = decideTopup({ ...snapshot, previous: initial });
  return (
    validated.disposition !== "retry" &&
    snapshot.refunds.every(({ status }) => ["succeeded", "failed", "canceled"].includes(status)) &&
    heldIds.every((id) =>
      snapshot.disputes.some(
        (d) => d.id === id && ["won", "warning_closed", "prevented", "lost"].includes(d.status),
      ),
    ) &&
    snapshot.disputes.every(({ status }) =>
      ["won", "warning_closed", "prevented", "lost"].includes(status),
    )
  );
}

// Append after a successful guarded settlement/balance write in the SAME D1 batch.
// Failed CAS means changes()=0 and cannot alter the anchor. A successful refresh preserves
// continuous resolution/zero time; unresolved evidence clears both. Database UTC owns time.
export function topupRetentionStatement(db, paymentHash, resolved) {
  return db
    .prepare(
      "INSERT INTO topup_retention(payment_hash,resolved_at,resolved_zero_since) " +
        "SELECT payment_hash,CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END," +
        "CASE WHEN ? AND available+held=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END " +
        "FROM topup_purchases WHERE payment_hash=? AND changes()=1 " +
        "ON CONFLICT(payment_hash) DO UPDATE SET " +
        "resolved_at=CASE WHEN excluded.resolved_at IS NOT NULL THEN COALESCE(topup_retention.resolved_at,excluded.resolved_at) END," +
        "resolved_zero_since=CASE WHEN excluded.resolved_zero_since IS NOT NULL " +
        "THEN COALESCE(topup_retention.resolved_zero_since,excluded.resolved_zero_since) END",
    )
    .bind(Number(resolved), Number(resolved), paymentHash);
}

// An associated but untrustworthy current snapshot cannot preserve an old cleanup anchor.
// Do not invalidate a newer successful reconciliation; financial state/revision stay intact.
export function invalidateTopupRetention(db, paymentHash, revision) {
  return db
    .prepare(
      "UPDATE topup_retention SET resolved_at=NULL,resolved_zero_since=NULL WHERE payment_hash=? " +
        "AND EXISTS(SELECT 1 FROM topup_purchases p JOIN topup_claims c ON c.payment_hash=p.payment_hash " +
        "LEFT JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash " +
        "WHERE p.payment_hash=topup_retention.payment_hash AND c.state='granted' AND COALESCE(r.revision,0)=?)",
    )
    .bind(paymentHash, revision)
    .run();
}

// Append immediately after a guarded balance mutation. Explicit statements preserve D1's
// exact existing change counts (trigger writes are included in D1 meta.changes).
export function topupRetentionBalanceSql(purchaseSelect) {
  return (
    "UPDATE topup_retention SET resolved_zero_since=CASE " +
    "WHEN resolved_at IS NULL OR (SELECT available+held FROM topup_purchases p " +
    "WHERE p.payment_hash=topup_retention.payment_hash)>0 THEN NULL " +
    "ELSE COALESCE(resolved_zero_since,strftime('%Y-%m-%dT%H:%M:%fZ','now')) END " +
    "WHERE payment_hash=(" +
    purchaseSelect +
    ") AND changes()=1"
  );
}
