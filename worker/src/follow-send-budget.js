// Dormant aggregate shared by future confirmation, management and digest send attempts.
const observeSql =
  "INSERT INTO follow_send_budget(slot,observed_at,attempts) VALUES (1,?,0) " +
  "ON CONFLICT(slot) DO UPDATE SET observed_at=excluded.observed_at, attempts=CASE " +
  "WHEN substr(excluded.observed_at,1,10)=substr(follow_send_budget.observed_at,1,10) " +
  "THEN follow_send_budget.attempts ELSE 0 END " +
  "WHERE excluded.observed_at>=follow_send_budget.observed_at";

export const validFollowSendCap = (cap) => Number.isSafeInteger(cap) && cap > 0;
export const followSendBudgetAvailable =
  "EXISTS (SELECT 1 FROM follow_send_budget WHERE slot=1 AND observed_at=? AND attempts<?)";

export function observeFollowSendBudget(db, at) {
  return db.prepare(observeSql).bind(at);
}

export function debitFollowSendBudget(db, at, cap, requireClaim = false) {
  return db
    .prepare(
      "UPDATE follow_send_budget SET attempts=attempts+1 " +
        "WHERE slot=1 AND observed_at=? AND attempts<?" +
        (requireClaim ? " AND changes()=1" : ""),
    )
    .bind(at, cap);
}

export function followBudgetStamp(now) {
  if (!(now instanceof Date) || !Number.isFinite(+now)) return null;
  const value = now.toISOString();
  return value.length === 24 ? value : null;
}

// An ambiguous commit may have spent a slot. Return false and never compensate or retry here.
export async function reserveFollowSendAttempt(db, cap, now = new Date()) {
  if (!validFollowSendCap(cap)) return false;
  try {
    const at = followBudgetStamp(now);
    if (!at) return false;
    const results = await db.batch([
      observeFollowSendBudget(db, at),
      debitFollowSendBudget(db, at, cap),
    ]);
    // Even an exhausted budget records the clock high-water mark. Older observations
    // cannot claim a slot, and both writes roll back together on a storage failure.
    return (
      results.length === 2 &&
      results.every(({ success }) => success) &&
      results[1].meta.changes === 1
    );
  } catch {
    return false;
  }
}

// Replace an older UTC day in place, preserving the singleton clock fence even while off.
export async function cleanupFollowSendBudget(db, now = new Date()) {
  try {
    const at = followBudgetStamp(now);
    if (!at) return false;
    const result = await observeFollowSendBudget(db, at).run();
    return result.success === true && result.meta.changes === 1;
  } catch {
    return false;
  }
}
