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
    const result = await db
      .prepare(
        "DELETE FROM follow_management_outbox WHERE rowid IN (" +
          "SELECT rowid FROM follow_management_outbox INDEXED BY follow_management_outbox_expiry " +
          "WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
          "ORDER BY expires_at,rowid LIMIT ?)",
      )
      .bind(maxRows)
      .run();
    if (
      result?.success !== true ||
      !Array.isArray(result.results) ||
      result.results.length !== 0 ||
      !Number.isSafeInteger(result.meta?.changes) ||
      result.meta.changes < 0 ||
      result.meta.changes > maxRows
    )
      return unavailable();
    return { status: "maintained", removed: result.meta.changes };
  } catch {
    // The deletion may have committed. No compensating write or automatic retry.
    return unavailable();
  }
}
