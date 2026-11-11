// Dormant callbacks. Stored call facts, never saved client flags, control accounting.
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const pending = () => ({ status: "pending" });
function statements(db, identity, state) {
  const { userHash, month, task, runId, generation, callId } = identity || {};
  if (
    typeof userHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(userHash) ||
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    typeof task !== "string" ||
    !/^[a-z_]{1,40}$/.test(task) ||
    typeof runId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(runId) ||
    !uuid(generation) ||
    !uuid(callId)
  )
    return null;
  const target =
    "WITH target AS (SELECT f.*,c.call_id,c.state,c.estimate,c.account_metered,c.free_day,c.free_month,r.calls " +
    "FROM funded_run_calls c JOIN funded_runs f ON f.generation=c.generation " +
    "JOIN runs r USING(user_hash,month,task,run_id) " +
    "WHERE f.user_hash=? AND f.month=? AND f.task=? AND f.run_id=? AND f.generation=? AND c.call_id=? AND c.state=? " +
    "AND r.calls>0 AND f.funding IN ('monthly','invite') AND NOT EXISTS(SELECT 1 FROM forget WHERE user_hash=f.user_hash)) ";
  return (sql, ...args) =>
    db.prepare(target + sql).bind(userHash, month, task, runId, generation, callId, state, ...args);
}
async function commit(db, list, changed, status, cascadeIndex = -1) {
  try {
    const result = await db.batch(list);
    if (
      result.length !== list.length ||
      result.some(
        (r, i) =>
          r?.success !== true ||
          !(i === cascadeIndex ? [0, 1, 3] : [0, 1]).includes(r.meta?.changes),
      )
    )
      return pending();
    return { status: changed.some((i) => result[i].meta.changes > 0) ? status : "inactive" };
  } catch {
    return pending();
  }
}

// Commit usable-response acceptance before exposing the response. Unknown acceptance
// must be retried as acceptance, never treated as a definitive failure to refund.
export async function acceptFundedCall(db, identity) {
  const q = statements(db, identity, "reserved");
  if (!q) return pending();
  return commit(
    db,
    [
      q(
        "INSERT INTO event_counts(day,event,page,n) SELECT first_autofill_day,'first_autofill','worker',1 FROM target WHERE first_autofill_due=1 " +
          "ON CONFLICT(day,event,page) DO UPDATE SET n=n+1",
      ),
      q(
        "UPDATE funded_runs SET accepted=1,first_autofill_due=0 WHERE generation=(SELECT generation FROM target)",
      ),
      q("UPDATE funded_run_calls SET state='accepted' WHERE call_id=(SELECT call_id FROM target)"),
    ],
    [2],
    "accepted",
  );
}

// Definitive upstream failure only. All predicates remain reserved until the terminal
// delete; serialized D1 batches cannot refund twice or cross into a replacement generation.
export async function releaseFundedCall(db, identity) {
  const q = statements(db, identity, "reserved");
  if (!q) return pending();
  const estimate = "(SELECT estimate FROM target)";
  const account = (who, bucket, enabled) =>
    q(
      "UPDATE spend SET cents=MAX(0,cents-" +
        estimate +
        ") " +
        "WHERE user_hash=" +
        who +
        " AND month=" +
        bucket +
        " AND EXISTS(SELECT 1 FROM target WHERE " +
        enabled +
        ")",
    );
  return commit(
    db,
    [
      q(
        "UPDATE budget SET spend_cents=MAX(0,spend_cents-" +
          estimate +
          ") WHERE month=(SELECT month FROM target)",
      ),
      account("(SELECT user_hash FROM target)", "(SELECT month FROM target)", "account_metered=1"),
      account("'*'", "(SELECT free_day FROM target)", "free_day IS NOT NULL"),
      account("'*'", "(SELECT month FROM target)", "free_month=1"),
      q(
        "UPDATE usage SET units=MAX(0,units-1) WHERE (user_hash,month,task) IN " +
          "(SELECT user_hash,month,task FROM target WHERE calls=1 AND accepted=0)",
      ),
      q(
        "UPDATE bonus SET used=MAX(0,used-1) WHERE (user_hash,task) IN " +
          "(SELECT user_hash,task FROM target WHERE calls=1 AND accepted=0 AND funding='invite')",
      ),
      q(
        "DELETE FROM runs WHERE (user_hash,month,task,run_id) IN " +
          "(SELECT user_hash,month,task,run_id FROM target WHERE calls=1 AND accepted=0)",
      ),
      q(
        "UPDATE runs SET calls=calls-1 WHERE (user_hash,month,task,run_id) IN (SELECT user_hash,month,task,run_id FROM target)",
      ),
      q("DELETE FROM funded_run_calls WHERE call_id=(SELECT call_id FROM target)"),
    ],
    [6, 7],
    "released",
    6, // Actual D1 counts the run, metadata and last-call cascade; Node counts only the run.
  );
}

// Authoritative accounting only. Interruption or unknown cost leaves the accepted
// call and its estimate intact; the captured month remains valid until its run sweep.
export async function meterFundedCall(db, identity, { cents, usage = null, model = null } = {}) {
  const q = statements(db, identity, "accepted");
  if (
    !q ||
    typeof cents !== "number" ||
    !Number.isFinite(cents) ||
    cents < 0 ||
    (usage !== null && (typeof usage !== "object" || Array.isArray(usage))) ||
    (model !== null && (typeof model !== "string" || !/^[A-Za-z0-9._:/-]{1,100}$/.test(model)))
  )
    return pending();
  const values =
    usage &&
    [
      "promptTokenCount",
      "cachedContentTokenCount",
      "candidatesTokenCount",
      "thoughtsTokenCount",
    ].map((k) => usage[k] ?? 0);
  if (
    values &&
    (values.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      !Number.isSafeInteger(values[2] + values[3]))
  )
    return pending();
  const delta = "(?-estimate)",
    list = [
      q(
        "INSERT INTO budget(month,spend_cents) SELECT month,MAX(0," +
          delta +
          ") FROM target WHERE 1 " +
          "ON CONFLICT(month) DO UPDATE SET spend_cents=MAX(0,spend_cents+?-(SELECT estimate FROM target))",
        cents,
        cents,
      ),
      q(
        "UPDATE spend SET cents=MAX(0,cents+?-(SELECT estimate FROM target)) WHERE (user_hash,month) IN " +
          "(SELECT user_hash,month FROM target WHERE account_metered=1)",
        cents,
      ),
    ];
  for (const [bucket, flag] of [
    ["free_day", "free_day IS NOT NULL"],
    ["month", "free_month=1"],
  ])
    list.push(
      q(
        "INSERT INTO spend(user_hash,month,cents) SELECT '*'," +
          bucket +
          ",MAX(0," +
          delta +
          ") FROM target WHERE " +
          flag +
          " ON CONFLICT(user_hash,month) DO UPDATE SET cents=MAX(0,cents+?-(SELECT estimate FROM target))",
        cents,
        cents,
      ),
    );
  if (values) {
    const [prompt, cached, output, thoughts] = values;
    list.push(
      q(
        "INSERT INTO tokens(month,calls,prompt,cached,output) SELECT month,1,?,?,? FROM target WHERE 1 " +
          "ON CONFLICT(month) DO UPDATE SET calls=calls+1,prompt=prompt+excluded.prompt,cached=cached+excluded.cached,output=output+excluded.output",
        prompt,
        cached,
        output + thoughts,
      ),
    );
    if (model !== null)
      list.push(
        q(
          "INSERT INTO task_tokens(month,task,model,calls,prompt,cached,output,cents) SELECT month,task,?,1,?,?,?,? FROM target WHERE 1 " +
            "ON CONFLICT(month,task,model) DO UPDATE SET calls=calls+1,prompt=prompt+excluded.prompt,cached=cached+excluded.cached,output=output+excluded.output,cents=cents+excluded.cents",
          model,
          prompt,
          cached,
          output + thoughts,
          cents,
        ),
      );
  }
  list.push(q("DELETE FROM funded_run_calls WHERE call_id=(SELECT call_id FROM target)"));
  return commit(db, list, [list.length - 1], "metered");
}
