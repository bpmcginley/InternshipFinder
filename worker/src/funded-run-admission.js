// Dormant first-generation storage, NOT AI authorization. Trusted callers must separately
// enforce existing auth/task/rate gates; siblings, callbacks and purchased funding are absent.
const nonnegative = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const pending = () => ({ status: "pending" });
export async function reserveFirstFundedRun(db, input, now = new Date()) {
  const {
    userHash,
    task,
    runId,
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
    typeof task !== "string" ||
    typeof runId !== "string" ||
    !/^[a-f0-9]{64}$/.test(userHash) ||
    !/^[a-z_]{1,40}$/.test(task || "") ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(runId || "") ||
    !(allowance === null || (Number.isSafeInteger(allowance) && allowance >= 0)) ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    !nonnegative(estimate) ||
    !(accountCeiling === null || nonnegative(accountCeiling)) ||
    !nonnegative(monthBudget) ||
    typeof freeTier !== "boolean" ||
    (freeTier && !nonnegative(dayBudget)) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    return pending();
  const day = now.toISOString().slice(0, 10),
    month = day.slice(0, 7);
  const key = [userHash, month, task, runId],
    generation = crypto.randomUUID(),
    callId = crypto.randomUUID();
  const used = "COALESCE((SELECT units FROM usage WHERE user_hash=? AND month=? AND task=?),0)";
  const funded = "EXISTS(SELECT 1 FROM funded_run_calls WHERE call_id=? AND generation=?)";
  const prepare = (sql, ...values) => db.prepare(sql).bind(...values);
  const spend = (who, bucket, enabled) =>
    prepare(
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
    const results = await db.batch([
      prepare(
        "INSERT INTO runs(user_hash,month,task,run_id,calls) SELECT ?,?,?,?,1 WHERE " +
          "date('now')=? AND NOT EXISTS(SELECT 1 FROM forget WHERE user_hash=?) AND " +
          "(? IS NULL OR ?>0) AND (? IS NULL OR " +
          used +
          "<? OR EXISTS(SELECT 1 FROM bonus WHERE user_hash=? AND task=? AND used<granted)) AND " +
          "?>0 AND (?=0 OR COALESCE((SELECT cents FROM spend WHERE user_hash='*' AND month=?),0)<?) AND " +
          "(? IS NULL OR (?>0 AND COALESCE((SELECT cents FROM spend WHERE user_hash=? AND month=?),0)<?)) AND " +
          "(?=0 OR (?>0 AND COALESCE((SELECT cents FROM spend WHERE user_hash='*' AND month=?),0)<?)) " +
          "ON CONFLICT DO NOTHING",
        ...key,
        day,
        userHash,
        allowance,
        allowance,
        allowance,
        userHash,
        month,
        task,
        allowance,
        userHash,
        task,
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
      prepare(
        "INSERT INTO funded_runs(user_hash,month,task,run_id,generation,funding,first_autofill_day,first_autofill_due) " +
          "SELECT ?,?,?,?,?,CASE WHEN ? IS NULL OR " +
          used +
          "<? THEN 'monthly' ELSE 'invite' END, " +
          "CASE WHEN ?='autofill' AND " +
          used +
          "=0 THEN ? ELSE NULL END, " +
          "CASE WHEN ?='autofill' AND " +
          used +
          "=0 THEN 1 ELSE 0 END WHERE changes()=1",
        ...key,
        generation,
        allowance,
        userHash,
        month,
        task,
        allowance,
        task,
        userHash,
        month,
        task,
        day,
        task,
        userHash,
        month,
        task,
      ),
      prepare(
        "INSERT INTO funded_run_calls(call_id,generation,state,estimate,account_metered,free_day,free_month) " +
          "SELECT ?,?,'reserved',?,?,?,? WHERE changes()=1",
        callId,
        generation,
        estimate,
        Number(accountCeiling !== null),
        freeTier ? day : null,
        Number(freeTier),
      ),
      prepare(
        "UPDATE bonus SET used=used+1 WHERE user_hash=? AND task=? AND " +
          funded +
          " AND EXISTS(SELECT 1 FROM funded_runs WHERE generation=? AND funding='invite')",
        userHash,
        task,
        callId,
        generation,
        generation,
      ),
      prepare(
        "INSERT INTO usage(user_hash,month,task,units) SELECT ?,?,?,1 WHERE " +
          funded +
          " ON CONFLICT(user_hash,month,task) DO UPDATE SET units=units+1",
        userHash,
        month,
        task,
        callId,
        generation,
      ),
      spend(userHash, month, accountCeiling !== null),
      spend("*", day, freeTier),
      spend("*", month, freeTier),
      prepare(
        "INSERT INTO budget(month,spend_cents) SELECT ?,? WHERE " +
          funded +
          " ON CONFLICT(month) DO UPDATE SET spend_cents=spend_cents+excluded.spend_cents",
        month,
        estimate,
        callId,
        generation,
      ),
    ]);
    const changes = [
      1,
      1,
      1,
      null,
      1,
      Number(accountCeiling !== null),
      Number(freeTier),
      Number(freeTier),
      1,
    ];
    if (
      results.length !== 9 ||
      results.some(
        (r, i) =>
          r?.success !== true ||
          (changes[i] === null
            ? ![0, 1].includes(r.meta?.changes)
            : r.meta?.changes !== changes[i]),
      )
    )
      return pending();
    // Only this fresh server-created generation/call can authorize dependent accounting.
    // Existing or ambiguous attempts get no authorization, including legacy rows.
    return results[0].meta?.changes === 1 && results[2].meta?.changes === 1
      ? { status: "reserved", generation, callId, month }
      : pending();
  } catch {
    return pending();
  }
}
