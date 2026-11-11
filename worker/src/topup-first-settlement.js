// Dormant trusted-storage boundary: no provider, route, expiry or deletion integration.
import { referenceHash, validTopupCheckoutId, validTopupOfferVersion } from "./topup-ledger.js";
import { decideTopup } from "./topup-decisions.js";
import {
  topupFinanciallyResolved,
  topupRetentionStatement,
  topupHistoryProven,
  financialEvidenceDigest,
} from "./topup-retention.js";
const active = "a.state IN ('creating','open')";
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const revision = (n) => Number.isSafeInteger(n) && n > 0;

// Call BEFORE both authoritative reads. A later capture invalidates earlier evidence even
// if that later reader fails. Never reuse evidence after capturing a different revision.
export async function captureTopupSettlement(db, attemptId) {
  if (!uuid(attemptId)) return null;
  const [, selected] = await db.batch([
    db
      .prepare(
        "INSERT INTO topup_attempt_revisions(attempt_id,revision) " +
          `SELECT id,1 FROM topup_checkout_attempts a WHERE id=? AND ${active} ` +
          "ON CONFLICT(attempt_id) DO UPDATE SET revision=topup_attempt_revisions.revision+1 " +
          "WHERE topup_attempt_revisions.revision<9007199254740991",
      )
      .bind(attemptId),
    db
      .prepare(
        "SELECT a.*,r.revision FROM topup_checkout_attempts a " +
          "JOIN topup_attempt_revisions r ON r.attempt_id=a.id WHERE a.id=? AND changes()=1",
      )
      .bind(attemptId),
  ]);
  return selected.results[0] || null;
}

// Inputs must come from the authenticated payment/reversal readers, never HTTP claims or
// redirects. Decision prior state is initial ONLY because the guarded insert must win a
// new durable claim. Existing/deleted/retired claims cannot enter this path.
export async function settleFirstTopup(db, capture, payment, reversals, now = new Date()) {
  let a, p, r;
  try {
    [a, p, r] = structuredClone([capture, payment, reversals]);
  } catch {
    return { status: "retry" };
  }
  if (
    !uuid(a?.id) ||
    !revision(a.revision) ||
    !["creating", "open"].includes(a.state) ||
    typeof a.user_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(a.user_hash) ||
    !validTopupOfferVersion(a.offer_version) ||
    a.amount !== 300 ||
    a.currency !== "usd" ||
    a.units !== 25 ||
    typeof a.created !== "string" ||
    !(a.checkout_id === null || validTopupCheckoutId(a.checkout_id)) ||
    p?.status !== "paid_evidence" ||
    r?.status !== "reversal_evidence" ||
    p.attemptId !== a.id ||
    p.userHash !== a.user_hash ||
    p.offerVersion !== a.offer_version ||
    p.offerAmount !== a.amount ||
    p.units !== a.units ||
    p.currency !== a.currency ||
    typeof p.livemode !== "boolean" ||
    !validTopupCheckoutId(p.checkoutId) ||
    (a.checkout_id !== null && a.checkout_id !== p.checkoutId) ||
    typeof p.paymentId !== "string" ||
    !/^pi_[A-Za-z0-9_]{1,250}$/.test(p.paymentId) ||
    typeof p.chargeId !== "string" ||
    !/^ch_[A-Za-z0-9_]{1,250}$/.test(p.chargeId) ||
    !Number.isSafeInteger(p.capturedAmount) ||
    p.capturedAmount < a.amount ||
    r.paymentId !== p.paymentId ||
    r.checkoutId !== p.checkoutId ||
    r.chargeId !== p.chargeId ||
    r.livemode !== p.livemode ||
    r.currency !== p.currency ||
    r.capturedAmount !== p.capturedAmount ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    return { status: "retry" };
  const decision = decideTopup({
    ...r,
    previous: {
      deleted: false,
      fullRefund: false,
      loss: false,
      held: false,
      heldDisputeIds: [],
    },
  });
  if (decision.disposition === "retry") return { status: "retry" };
  const created = now.toISOString();
  const [paymentHash, checkoutHash] = await Promise.all([
    referenceHash("payment", p.livemode, p.paymentId),
    referenceHash("checkout", p.livemode, p.checkoutId),
  ]);
  // Every state/identity/generation guard is on the FIRST mutation. The subsequent writes
  // are deterministic, chained through changes(), with no interleaving inside this batch.
  // Any constraint failure aborts the entire batch, including the initial replay claim.
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO topup_claims(payment_hash,checkout_hash,state) " +
          "SELECT ?,?,'granted' WHERE EXISTS (SELECT 1 FROM topup_checkout_attempts a " +
          "JOIN topup_attempt_revisions r ON r.attempt_id=a.id WHERE a.id=? AND r.revision=? " +
          `AND ${active} AND a.state=? AND a.checkout_id IS ? AND a.user_hash=? ` +
          "AND a.offer_version=? AND a.amount=? AND a.currency=? AND a.units=? AND a.created=?) " +
          "ON CONFLICT DO NOTHING",
      )
      .bind(
        paymentHash,
        checkoutHash,
        a.id,
        a.revision,
        a.state,
        a.checkout_id,
        a.user_hash,
        a.offer_version,
        a.amount,
        a.currency,
        a.units,
        a.created,
      ),
    db
      .prepare(
        "INSERT INTO topup_purchases(payment_hash,payment_id,checkout_id,user_hash,offer_version," +
          "amount,currency,granted,available,held,revoked,created) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1",
      )
      .bind(
        paymentHash,
        p.paymentId,
        p.checkoutId,
        a.user_hash,
        a.offer_version,
        p.capturedAmount,
        p.currency,
        a.units,
        decision.disposition === "available" ? a.units : 0,
        decision.disposition === "held" ? a.units : 0,
        decision.disposition === "revoked" ? a.units : 0,
        created,
      ),
    db
      .prepare(
        "INSERT INTO topup_reconciliations(payment_hash,revision,loss,full_refund,hold_ids) " +
          "SELECT ?,1,?,?,? WHERE changes()=1",
      )
      .bind(
        paymentHash,
        Number(decision.lossSeen),
        Number(decision.fullRefundSeen),
        JSON.stringify(decision.heldDisputeIds),
      ),
    db
      .prepare(
        "UPDATE topup_checkout_attempts SET checkout_id=?,state='settled' WHERE id=? AND changes()=1",
      )
      .bind(p.checkoutId, a.id),
    topupRetentionStatement(
      db,
      paymentHash,
      topupFinanciallyResolved(r, { loss: false }),
      topupHistoryProven(r, { loss: false, historyProven: true }, decision),
      await financialEvidenceDigest(r),
    ),
    // Terminal state consumes this capture; no second increment can overflow.
    db.prepare("DELETE FROM topup_attempt_revisions WHERE attempt_id=? AND changes()=1").bind(a.id),
  ]);
  if (results.every((value) => value.meta.changes === 0)) return { status: "stale" };
  if (!results.every((value) => value.meta.changes === 1))
    throw new Error("Invalid top-up settlement transaction");
  return { status: "settled", paymentHash, disposition: decision.disposition };
}
