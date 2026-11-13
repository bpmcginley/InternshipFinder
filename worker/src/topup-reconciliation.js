// Dormant existing-purchase storage only; no provider, grant, admission or deletion caller.
import { referenceHash } from "./topup-ledger.js";
import { decideTopup } from "./topup-decisions.js";
import {
  topupFinanciallyResolved,
  topupHistoryProven,
  financialEvidenceDigest,
  topupRetentionStatement,
  invalidateTopupRetention,
} from "./topup-retention.js";

// Capture BEFORE authoritative provider reads. A conflict requires a fresh capture AND
// provider read, never replaying an old snapshot under a new revision. No row is created here.
export async function readTopupRevision(db, paymentHash) {
  if (typeof paymentHash !== "string" || !/^[a-f0-9]{64}$/.test(paymentHash)) return null;
  const row = await db
    .prepare(
      "SELECT p.payment_hash, p.payment_id, p.checkout_id, p.user_hash, p.amount, p.currency, p.held AS held_units, " +
        "COALESCE(r.revision, 0) AS revision, COALESCE(r.loss, 0) AS loss, " +
        "COALESCE(r.full_refund, 0) AS full_refund, COALESCE(r.hold_ids, '[]') AS hold_ids, COALESCE(t.history_proven,0) AS history_proven " +
        "FROM topup_purchases p JOIN topup_claims c ON c.payment_hash=p.payment_hash " +
        "LEFT JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash " +
        "LEFT JOIN topup_retention t ON t.payment_hash=p.payment_hash WHERE p.payment_hash=? AND c.state='granted'",
    )
    .bind(paymentHash)
    .first();
  if (!row) return null;
  const heldDisputeIds = JSON.parse(row.hold_ids);
  return {
    ...row,
    previous: {
      deleted: false,
      historyProven: row.history_proven === 1,
      fullRefund: row.full_refund === 1,
      loss: row.loss === 1,
      held: heldDisputeIds.length > 0 || row.held_units > 0,
      heldDisputeIds,
    },
  };
}

export async function reconcileExistingTopup(db, paymentHash, revision, snapshot) {
  const hashing = financialEvidenceDigest(snapshot);
  try {
    snapshot = structuredClone(snapshot);
  } catch {
    // Preserve only safe association fields when a nested non-JSON fact cannot clone.
    const source = snapshot;
    snapshot = {};
    for (const key of [
      "status",
      "livemode",
      "paymentId",
      "checkoutId",
      "capturedAmount",
      "currency",
    ]) {
      const descriptor = source && Object.getOwnPropertyDescriptor(source, key);
      if (descriptor && "value" in descriptor) snapshot[key] = descriptor.value;
    }
  }
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    return { status: "stale" };
  const stored = await readTopupRevision(db, paymentHash);
  if (!stored) return { status: "unavailable" };
  if (stored.revision !== revision) return { status: "stale" };
  if (
    snapshot?.paymentId !== stored.payment_id ||
    snapshot?.checkoutId !== stored.checkout_id ||
    snapshot?.capturedAmount !== stored.amount ||
    snapshot?.currency !== stored.currency
  )
    return { status: "retry" };
  const digest = await hashing;
  // A declared provider observation must never establish resolution from coercible IDs
  // or non-JSON facts. Only the exact primitive, mode-bound association can clear old age.
  if (snapshot.status === "reversal_evidence" && !digest) {
    if (
      typeof snapshot.livemode === "boolean" &&
      typeof snapshot.paymentId === "string" &&
      typeof snapshot.checkoutId === "string" &&
      typeof snapshot.currency === "string" &&
      Number.isSafeInteger(snapshot.capturedAmount) &&
      (await referenceHash("payment", snapshot.livemode, snapshot.paymentId)) === paymentHash
    )
      await invalidateTopupRetention(db, paymentHash, revision);
    return { status: "retry" };
  }
  // Ignore any caller-supplied previous state. Governing causes remain meaningful even
  // when held units are zero; a future failed-run return must still observe the hold.
  const decision = decideTopup({ ...snapshot, previous: stored.previous });
  if (decision.disposition === "retry") {
    await invalidateTopupRetention(db, paymentHash, revision);
    return { status: "retry" };
  }
  const [state, balance, retention] = await db.batch([
    db
      .prepare(
        "INSERT INTO topup_reconciliations(payment_hash, revision, loss, full_refund, hold_ids) " +
          "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM topup_purchases p " +
          "JOIN topup_claims c ON c.payment_hash=p.payment_hash WHERE p.payment_hash=? AND c.state='granted') " +
          "AND (?=0 OR EXISTS (SELECT 1 FROM topup_reconciliations WHERE payment_hash=? AND revision=?)) " +
          "ON CONFLICT(payment_hash) DO UPDATE SET revision=excluded.revision, loss=excluded.loss, " +
          "full_refund=excluded.full_refund, hold_ids=excluded.hold_ids " +
          "WHERE topup_reconciliations.revision=? AND topup_reconciliations.loss<=excluded.loss " +
          "AND topup_reconciliations.full_refund<=excluded.full_refund",
      )
      .bind(
        paymentHash,
        revision + 1,
        Number(decision.lossSeen),
        Number(decision.fullRefundSeen),
        JSON.stringify(decision.heldDisputeIds),
        paymentHash,
        revision,
        paymentHash,
        revision,
        revision,
      ),
    // changes() belongs to the immediately preceding CAS in this same D1 transaction.
    // All RHS expressions use the current row: consumption/restoration cannot be replaced
    // with values read before the transaction. Previously revoked units never reappear.
    db
      .prepare(
        "UPDATE topup_purchases SET " +
          "available=CASE WHEN ?='available' THEN available+held ELSE 0 END, " +
          "held=CASE WHEN ?='held' THEN available+held ELSE 0 END, " +
          "revoked=revoked+CASE WHEN ?='revoked' THEN available+held ELSE 0 END " +
          "WHERE payment_hash=? AND changes()=1",
      )
      .bind(decision.disposition, decision.disposition, decision.disposition, paymentHash),
    topupRetentionStatement(
      db,
      paymentHash,
      topupFinanciallyResolved(snapshot, stored.previous),
      topupHistoryProven(snapshot, stored.previous, decision),
      digest,
    ),
  ]);
  return state.meta.changes === 1 && balance.meta.changes === 1 && retention.meta.changes === 1
    ? { status: "applied", revision: revision + 1, decision }
    : { status: "stale" };
}
