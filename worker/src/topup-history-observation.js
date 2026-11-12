// Dormant trusted-normalized observation, not webhook authentication or coverage authority.
import { referenceHash, validTopupCheckoutId } from "./topup-ledger.js";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const result = (status) => ({ status });
function normalized(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getOwnPropertySymbols(input).length
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(descriptors).sort().join(",") !== "checkoutId,eventId,livemode,paymentId,revision"
  )
    throw new Error();
  const value = {};
  for (const [key, d] of Object.entries(descriptors)) {
    if (!d.enumerable || !Object.hasOwn(d, "value")) throw new Error();
    value[key] = d.value;
  }
  if (
    typeof value.eventId !== "string" ||
    !/^evt_[A-Za-z0-9_]{1,250}$/.test(value.eventId) ||
    typeof value.paymentId !== "string" ||
    !/^pi_[A-Za-z0-9_]{1,250}$/.test(value.paymentId) ||
    !validTopupCheckoutId(value.checkoutId) ||
    typeof value.livemode !== "boolean" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new Error();
  return value;
}
function checked(rows, size) {
  if (!Array.isArray(rows) || rows.length !== size) throw new Error();
  for (let i = 0; i < size; i++)
    if (
      !Object.hasOwn(rows, i) ||
      rows[i]?.success !== true ||
      !Number.isSafeInteger(rows[i].meta?.changes) ||
      rows[i].meta.changes < 0 ||
      !Array.isArray(rows[i].results)
    )
      throw new Error();
  return rows;
}
// Caller captures revision BEFORE verifying the authoritative event-to-payment association.
// Unknown schema/history or incomplete association cannot call this operation or gain coverage.
export async function observeTopupHistory(db, input, options = {}) {
  if (options?.enabled !== true) return result("disabled");
  try {
    const value = normalized(input);
    const [event, payment, checkout] = await Promise.all([
      referenceHash("history-event", value.livemode, value.eventId),
      referenceHash("payment", value.livemode, value.paymentId),
      referenceHash("checkout", value.livemode, value.checkoutId),
    ]);
    const rows = checked(
      await db.batch([
        db
          .prepare(
            `INSERT INTO topup_history_receipts(event_digest,observed_at)
        SELECT ?,${NOW} FROM topup_purchases p
        JOIN topup_claims c ON c.payment_hash=p.payment_hash
        JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash
        JOIN topup_retention t ON t.payment_hash=p.payment_hash
        JOIN topup_checkout_attempts a ON a.checkout_id=p.checkout_id AND a.state='settled'
          AND a.user_hash=p.user_hash AND a.offer_version=p.offer_version
          AND a.units=p.granted AND a.currency=p.currency
        WHERE p.payment_hash=? AND p.payment_id=? AND p.checkout_id=?
          AND c.checkout_hash=? AND c.state='granted' AND r.revision=?
        ON CONFLICT(event_digest) DO NOTHING`,
          )
          .bind(event, payment, value.paymentId, value.checkoutId, checkout, value.revision),
        db
          .prepare(
            "UPDATE topup_reconciliations SET revision=revision+1 WHERE payment_hash=? AND changes()=1",
          )
          .bind(payment),
        db
          .prepare(
            "UPDATE topup_retention SET resolved_at=NULL,resolved_zero_since=NULL,evidence_digest=NULL WHERE payment_hash=? AND changes()=1",
          )
          .bind(payment),
        db
          .prepare("SELECT observed_at FROM topup_history_receipts WHERE event_digest=?")
          .bind(event),
      ]),
      4,
    );
    if (
      rows.slice(0, 3).some((r) => r.results.length || ![0, 1].includes(r.meta.changes)) ||
      rows[3].meta.changes !== 0 ||
      rows[3].results.length > 1
    )
      throw new Error();
    if (rows[3].results.length && !Object.hasOwn(rows[3].results, 0)) throw new Error();
    const row = rows[3].results[0];
    if (
      rows[3].results.length &&
      (!row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).join(",") !== "observed_at" ||
        typeof row.observed_at !== "string" ||
        row.observed_at.length !== 24 ||
        !Number.isFinite(Date.parse(row.observed_at)) ||
        new Date(row.observed_at).toISOString() !== row.observed_at)
    )
      throw new Error();
    if (rows[0].meta.changes === 1) {
      if (rows[1].meta.changes !== 1 || rows[2].meta.changes !== 1 || !row) throw new Error();
      return { status: "observed", revision: value.revision + 1 };
    }
    if (rows[1].meta.changes || rows[2].meta.changes) throw new Error();
    return result(row ? "duplicate" : "pending");
  } catch {
    return result("unavailable");
  }
}
// First successful daily maintenance must repeatedly drain due pages. No schedule is mounted.
export async function cleanupTopupHistoryReceipts(db, options = {}) {
  if (options?.enabled !== true) return result("disabled");
  const { limit } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) return result("unavailable");
  try {
    const [row] = checked(
      await db.batch([
        db
          .prepare(
            "DELETE FROM topup_history_receipts WHERE event_digest IN (SELECT event_digest FROM topup_history_receipts INDEXED BY topup_history_receipts_expiry WHERE observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') ORDER BY observed_at,event_digest LIMIT ?)",
          )
          .bind(limit),
      ]),
      1,
    );
    if (row.results.length || row.meta.changes > limit) throw new Error();
    return { status: "cleaned", removed: row.meta.changes };
  } catch {
    return result("unavailable");
  }
}
