// Dormant operator-only bulk maintenance. No route, schedule or delivery.
import { followExpiryStatements } from "./follows.js";
import { followOutboxExpiryStatements } from "./follow-outbox.js";
import { followBudgetStamp, observeFollowSendBudget } from "./follow-send-budget.js";

const unavailable = () => ({ status: "unavailable" });

export async function maintainFollowRetention(db) {
  try {
    const sample = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").all();
    if (sample?.success !== true || !Array.isArray(sample.results) || sample.results.length !== 1)
      return unavailable();
    const at = sample.results[0]?.at;
    if (typeof at !== "string") return unavailable();
    const now = new Date(at);
    if (followBudgetStamp(now) !== at) return unavailable();

    const statements = [
      ...followExpiryStatements(db, now),
      ...followOutboxExpiryStatements(db, now),
      observeFollowSendBudget(db, at),
    ];
    const results = await db.batch(statements);
    if (
      !Array.isArray(results) ||
      results.length !== statements.length ||
      results.some(
        (result) =>
          result?.success !== true ||
          !Number.isSafeInteger(result.meta?.changes) ||
          result.meta.changes < 0,
      ) ||
      results.at(-1).meta.changes > 1
    )
      return unavailable();

    // A concurrent newer budget observation may legitimately fence out this sample.
    return { status: "maintained", budgetObserved: results.at(-1).meta.changes === 1 };
  } catch {
    // An ambiguous response does not establish commit state. Never retry automatically.
    return unavailable();
  }
}

// Separate opt-in operation; the caller owns scheduling and an explicit per-call bound.
export async function expireFollowManagementRequests(db, options = {}) {
  if (options?.enabled !== true) return { status: "disabled" };
  const { maxRows } = options;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) return unavailable();
  try {
    const rows = await db.batch([
      db
        .prepare(
          "DELETE FROM follow_management_outbox WHERE rowid IN (" +
            "SELECT rowid FROM follow_management_outbox INDEXED BY follow_management_outbox_expiry " +
            "WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
            "ORDER BY expires_at,rowid LIMIT ?)",
        )
        .bind(maxRows),
      db.prepare("SELECT changes() AS removed"),
    ]);
    // D1 meta.changes includes trigger writes. changes() is this DELETE's direct count.
    if (
      !Array.isArray(rows) ||
      rows.length !== 2 ||
      rows[0]?.success !== true ||
      !Array.isArray(rows[0].results) ||
      rows[0].results.length !== 0 ||
      !Number.isSafeInteger(rows[0].meta?.changes) ||
      rows[0].meta.changes < 0 ||
      rows[1]?.success !== true ||
      rows[1].meta?.changes !== 0 ||
      !Array.isArray(rows[1].results) ||
      rows[1].results.length !== 1
    )
      return unavailable();
    const receipt = rows[1].results[0];
    if (
      !receipt ||
      Array.isArray(receipt) ||
      Object.keys(receipt).join(",") !== "removed" ||
      !Number.isSafeInteger(receipt.removed) ||
      receipt.removed < 0 ||
      receipt.removed > maxRows ||
      rows[0].meta.changes < receipt.removed
    )
      return unavailable();
    return { status: "maintained", removed: receipt.removed };
  } catch {
    // The deletion may have committed. No compensating write or automatic retry.
    return unavailable();
  }
}
