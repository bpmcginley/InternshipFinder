// Dormant new-call admission into a previously funded generation. No unit debit or
// provider authorization: trusted callers preserve current auth/task/rate gates.
const nonnegative = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
export async function reserveFundedSibling(db, input, now = new Date()) {
  const pending = () => ({ status: "pending" });
  const {
    userHash,
    month,
    task,
    runId,
    generation,
    allowance,
    maxCalls,
    estimate,
    accountCeiling,
    monthBudget,
    dayBudget,
    freeTier,
  } = input || {};
  if (
    typeof userHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(userHash) ||
    typeof task !== "string" ||
    !/^[a-z_]{1,40}$/.test(task) ||
    typeof runId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(runId) ||
    typeof generation !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(generation) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    month !== now.toISOString().slice(0, 7) ||
    !(allowance === null || (Number.isSafeInteger(allowance) && allowance > 0)) ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    !nonnegative(estimate) ||
    !(accountCeiling === null || nonnegative(accountCeiling)) ||
    !nonnegative(monthBudget) ||
    typeof freeTier !== "boolean" ||
    (freeTier && !nonnegative(dayBudget))
  )
    return pending();
  const day = now.toISOString().slice(0, 10),
    callId = crypto.randomUUID();
  const q = (sql, ...values) => db.prepare(sql).bind(...values);
  const funded = "EXISTS(SELECT 1 FROM funded_run_calls WHERE call_id=? AND generation=?)";
  const spend = (who, bucket, enabled) =>
    q(
      "INSERT INTO spend(user_hash,month,cents) SELECT ?,?,? WHERE ? AND " +
        funded +
        " ON CONFLICT(user_hash,month) DO UPDATE SET cents=cents+excluded.cents",
      who,
      bucket,
      estimate,
      Number(enabled),
      callId,
      generation,
    );
  try {
    const result = await db.batch([
      q(
        "UPDATE runs SET calls=calls+1 WHERE user_hash=? AND month=? AND task=? AND run_id=? AND calls>0 AND calls<? " +
          "AND date('now')=? AND NOT EXISTS(SELECT 1 FROM forget WHERE user_hash=?) " +
          "AND EXISTS(SELECT 1 FROM funded_runs f WHERE f.user_hash=runs.user_hash AND f.month=runs.month AND f.task=runs.task AND f.run_id=runs.run_id AND f.generation=? AND f.funding IN ('monthly','invite')) " +
          "AND ?>0 AND (?=0 OR COALESCE((SELECT cents FROM spend WHERE user_hash='*' AND month=?),0)<?) " +
          "AND (? IS NULL OR (?>0 AND COALESCE((SELECT cents FROM spend WHERE user_hash=? AND month=?),0)<?)) " +
          "AND (?=0 OR (?>0 AND COALESCE((SELECT cents FROM spend WHERE user_hash='*' AND month=?),0)<?))",
        userHash,
        month,
        task,
        runId,
        maxCalls,
        day,
        userHash,
        generation,
        monthBudget,
        Number(freeTier),
        month,
        monthBudget,
        accountCeiling,
        accountCeiling,
        userHash,
        month,
        accountCeiling,
        Number(freeTier),
        dayBudget ?? 0,
        day,
        dayBudget ?? 0,
      ),
      q(
        "INSERT INTO funded_run_calls(call_id,generation,state,estimate,account_metered,free_day,free_month) " +
          "SELECT ?,?,'reserved',?,?,?,? WHERE changes()=1",
        callId,
        generation,
        estimate,
        Number(accountCeiling !== null),
        freeTier ? day : null,
        Number(freeTier),
      ),
      spend(userHash, month, accountCeiling !== null),
      spend("*", day, freeTier),
      spend("*", month, freeTier),
      q(
        "INSERT INTO budget(month,spend_cents) SELECT ?,? WHERE " +
          funded +
          " ON CONFLICT(month) DO UPDATE SET spend_cents=spend_cents+excluded.spend_cents",
        month,
        estimate,
        callId,
        generation,
      ),
    ]);
    const changes = [1, 1, Number(accountCeiling !== null), Number(freeTier), Number(freeTier), 1];
    if (
      result.length !== changes.length ||
      result.some((r, i) => r?.success !== true || r.meta?.changes !== changes[i])
    )
      return pending();
    return { status: "reserved", generation, callId, month };
  } catch {
    return pending();
  }
}
