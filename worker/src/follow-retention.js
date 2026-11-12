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
