// Server-owned manual-review discovery. No route, write or erasure capability.
import { TOPUP_SETTLEMENT_TERMS } from "./topup-first-settlement.js";

const HASH = /^[a-f0-9]{64}$/;
const PAGE_LIMIT = 64;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MATURE = "strftime('%Y-%m-%dT%H:%M:%fZ',t.resolved_zero_since,'+400 days')";
const AGE = ["pending", "not_due", "mature"];
const EVIDENCE = ["payment_pending", "history_gap", "under_observation", "verify_history"];
const result = (status) => ({ status });
const own = (value, key) =>
  value == null ? undefined : Object.getOwnPropertyDescriptor(value, key)?.value;

// Limit the index walk before filtering or joining so an empty candidate page still makes progress.
const SQL = `
WITH page AS MATERIALIZED (
  SELECT payment_hash, checkout_id, user_hash, offer_version, currency, amount, granted, available, held
  FROM topup_purchases WHERE payment_hash>?
  ORDER BY payment_hash LIMIT ?
), review AS (
  SELECT p.payment_hash, coalesce(r.revision,0) AS revision,
    CASE WHEN c.state='granted' AND p.available=0 AND p.held=0 THEN 1 ELSE 0 END AS reviewable,
    CASE WHEN r.revision IS NOT NULL AND r.loss=0 AND r.hold_ids='[]' AND a.id IS NOT NULL
      AND t.evidence_digest IS NOT NULL AND t.resolved_at IS NOT NULL AND t.resolved_zero_since IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',a.created,'+0 days') IS a.created AND a.created<=t.resolved_at
      AND strftime('%Y-%m-%dT%H:%M:%fZ',t.resolved_at,'+0 days') IS t.resolved_at
      AND strftime('%Y-%m-%dT%H:%M:%fZ',t.resolved_zero_since,'+0 days') IS t.resolved_zero_since
      AND t.resolved_at<=t.resolved_zero_since AND t.resolved_zero_since<=${NOW}
      AND ${MATURE} IS NOT NULL THEN 1 ELSE 0 END AS payment_evidence,
    CASE WHEN ${MATURE}<=${NOW} THEN 1 ELSE 0 END AS mature,
    CASE WHEN t.history_proven=1 AND EXISTS(
      SELECT 1 FROM topup_history_coverage h WHERE h.epoch=t.coverage_epoch AND h.health='qualified'
      AND h.starts_at<=a.created AND h.covered_through<=${NOW}
      AND h.covered_through>=CASE WHEN ${MATURE}<=${NOW} THEN ${MATURE} ELSE t.resolved_zero_since END
    ) THEN 1 ELSE 0 END AS recorded_history
  FROM page p
  LEFT JOIN topup_claims c ON c.payment_hash=p.payment_hash
  LEFT JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash
  LEFT JOIN topup_retention t ON t.payment_hash=p.payment_hash
  LEFT JOIN topup_checkout_attempts a ON a.checkout_id=p.checkout_id AND a.user_hash=p.user_hash
    AND a.offer_version=p.offer_version AND a.units=p.granted AND a.currency=p.currency AND a.state='settled'
    AND a.amount=? AND a.currency=? AND a.units=? AND p.amount>=a.amount
)
SELECT payment_hash, revision, reviewable,
  CASE WHEN payment_evidence=0 THEN 'pending' WHEN mature=0 THEN 'not_due' ELSE 'mature' END AS age,
  CASE WHEN payment_evidence=0 THEN 'payment_pending'
    WHEN recorded_history=0 THEN 'history_gap' WHEN mature=0 THEN 'under_observation'
    ELSE 'verify_history' END AS evidence
FROM review ORDER BY payment_hash`;

export async function listTopupManualReview(db, options = {}) {
  try {
    if (own(options, "enabled") !== true) return result("disabled");
    const limit = own(options, "limit");
    const after = own(options, "after");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PAGE_LIMIT ||
      !(after === null || (typeof after === "string" && HASH.test(after)))
    )
      return result("unavailable");
    const { amount, currency, units } = TOPUP_SETTLEMENT_TERMS;
    const reply = await db
      .prepare(SQL)
      .bind(after ?? "", limit + 1, amount, currency, units)
      .all();
    const rows = own(reply, "results");
    if (
      own(reply, "success") !== true ||
      !Array.isArray(rows) ||
      rows.length > limit + 1 ||
      own(own(reply, "meta"), "changes") !== 0
    )
      return result("unavailable");

    const candidates = [];
    let last = after ?? "";
    for (let index = 0; index < rows.length; index++) {
      const row = own(rows, index);
      const paymentHash = own(row, "payment_hash");
      const revision = own(row, "revision");
      const reviewable = own(row, "reviewable");
      const age = own(row, "age");
      const evidence = own(row, "evidence");
      if (
        typeof paymentHash !== "string" ||
        !HASH.test(paymentHash) ||
        paymentHash <= last ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        ![0, 1].includes(reviewable) ||
        !AGE.includes(age) ||
        !EVIDENCE.includes(evidence) ||
        (age === "pending") !== (evidence === "payment_pending") ||
        (age !== "mature" && evidence === "verify_history") ||
        (age !== "not_due" && evidence === "under_observation")
      )
        return result("unavailable");
      if (index === limit) return { status: "listed", candidates, next: last };
      if (reviewable === 1) candidates.push({ paymentHash, revision, age, evidence });
      last = paymentHash;
    }
    return { status: "listed", candidates, next: null };
  } catch {
    return result("unavailable");
  }
}
