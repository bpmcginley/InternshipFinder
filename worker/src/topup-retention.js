// Trusted retention evidence only. No provider read, clock injection or scheduler.
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

// Hash all available verified lifecycle facts, including any timestamps supplied by a
// future reader. Object keys and refund/dispute ordering do not manufacture a new age.
export async function financialEvidenceDigest(snapshot) {
  try {
    const canonical = (v) => {
      if (v === null || typeof v === "string" || typeof v === "boolean") return v;
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v !== "object") throw new Error("Invalid financial fact");
      const array = Array.isArray(v),
        proto = Object.getPrototypeOf(v);
      if (
        (!array && proto !== Object.prototype && proto !== null) ||
        (array && proto !== Array.prototype) ||
        Object.getOwnPropertySymbols(v).length
      )
        throw new Error("Expected plain financial JSON");
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (array) {
        if (Object.keys(descriptors).length !== v.length + 1)
          throw new Error("Invalid financial array");
        return Array.from({ length: v.length }, (_, i) => {
          const d = descriptors[i];
          if (!d || !d.enumerable || !("value" in d)) throw new Error("Invalid financial array");
          return canonical(d.value);
        });
      }
      return Object.fromEntries(
        Object.keys(descriptors)
          .sort()
          .map((k) => {
            const d = descriptors[k];
            if (!d.enumerable || !("value" in d)) throw new Error("Invalid financial property");
            return [k, canonical(d.value)];
          }),
      );
    };
    const value = canonical(snapshot);
    if (
      value?.status !== "reversal_evidence" ||
      typeof value.livemode !== "boolean" ||
      ![value.paymentId, value.checkoutId, value.chargeId].every((id) => typeof id === "string") ||
      !/^pi_[A-Za-z0-9_]{1,250}$/.test(value.paymentId || "") ||
      !/^cs_[A-Za-z0-9_]{1,250}$/.test(value.checkoutId || "") ||
      !/^ch_[A-Za-z0-9_]{1,250}$/.test(value.chargeId || "") ||
      decideTopup({ ...value, previous: initial }).disposition === "retry"
    )
      return null;
    delete value.previous;
    const order = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    value.refunds.sort(order);
    value.disputes.sort(order);
    const bytes = new TextEncoder().encode(
      "internscout:financial-resolution:v1:" + JSON.stringify(value),
    );
    if (bytes.length > 262144) return null;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// Unknown history cannot be repaired by an apparently clean current observation. Every
// nonterminal governing cause must remain stored, or future cleanup could forget it.
export function topupHistoryProven(snapshot, previous, decision) {
  const current = decideTopup({ ...snapshot, previous: initial });
  const terminal = (d) => ["won", "warning_closed", "prevented"].includes(d.status);
  return (
    current.disposition !== "retry" &&
    (!previous.fullRefund || current.fullRefundSeen) &&
    previous.historyProven === true &&
    !previous.loss &&
    !decision.lossSeen &&
    decision.disposition !== "retry" &&
    (previous.heldDisputeIds || []).every((id) =>
      snapshot.disputes.some(
        (d) => d.id === id && (terminal(d) || decision.heldDisputeIds.includes(id)),
      ),
    ) &&
    snapshot.disputes.every((d) => terminal(d) || decision.heldDisputeIds.includes(d.id))
  );
}

// Append after a successful guarded settlement/balance write in the SAME D1 batch.
// Failed CAS means changes()=0 and cannot alter the anchor. A successful refresh preserves
// continuous resolution/zero time; unresolved evidence clears both. Database UTC owns time.
export function topupRetentionStatement(
  db,
  paymentHash,
  resolved,
  historyProven = false,
  digest = null,
) {
  return db
    .prepare(
      "INSERT INTO topup_retention(payment_hash,resolved_at,resolved_zero_since,history_proven,evidence_digest) " +
        "SELECT payment_hash,CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END," +
        "CASE WHEN ? AND available+held=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END " +
        ",?,? FROM topup_purchases WHERE payment_hash=? AND changes()=1 " +
        "ON CONFLICT(payment_hash) DO UPDATE SET " +
        "history_proven=topup_retention.history_proven AND excluded.history_proven, " +
        "resolved_at=CASE WHEN excluded.resolved_at IS NOT NULL THEN CASE WHEN topup_retention.evidence_digest IS excluded.evidence_digest THEN COALESCE(topup_retention.resolved_at,excluded.resolved_at) ELSE excluded.resolved_at END END," +
        "resolved_zero_since=CASE WHEN excluded.resolved_zero_since IS NOT NULL " +
        "THEN CASE WHEN topup_retention.evidence_digest IS excluded.evidence_digest THEN COALESCE(topup_retention.resolved_zero_since,excluded.resolved_zero_since) ELSE excluded.resolved_zero_since END END, evidence_digest=excluded.evidence_digest",
    )
    .bind(
      Number(resolved),
      Number(resolved),
      Number(historyProven && digest !== null),
      digest,
      paymentHash,
    );
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
