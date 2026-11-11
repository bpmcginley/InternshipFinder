// Dormant purchased-unit storage. The future admission caller must first exhaust monthly
// and invite units and enforce every service/task limit. Receipts are not AI authorization.
const identity = (run) =>
  run &&
  typeof run.userHash === "string" &&
  typeof run.month === "string" &&
  /^[a-f0-9]{64}$/.test(run.userHash) &&
  /^\d{4}-(0[1-9]|1[0-2])$/.test(run.month) &&
  run.task === "autofill" &&
  typeof run.runId === "string" &&
  /^[A-Za-z0-9_-]{1,64}$/.test(run.runId)
    ? [run.userHash, run.month, run.task, run.runId]
    : null;
const key = "user_hash=? AND month=? AND task=? AND run_id=?";
const receipt = (db, values) =>
  db.prepare(`SELECT payment_hash,state FROM topup_allocations WHERE ${key}`).bind(...values);
const outcome = (changed, selected) => ({
  changed: changed.meta.changes === 1,
  allocation: selected.results[0] || null,
});

export async function allocatePurchasedRun(db, run) {
  const values = identity(run);
  if (!values) return { changed: false, allocation: null };
  const [inserted, , selected] = await db.batch([
    db
      .prepare(
        "INSERT INTO topup_allocations(user_hash,month,task,run_id,payment_hash,state) " +
          "SELECT ?,?,?,?,p.payment_hash,'allocated' FROM topup_purchases p " +
          "JOIN topup_claims c ON c.payment_hash=p.payment_hash " +
          "LEFT JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash " +
          "WHERE p.user_hash=? AND p.available>0 AND p.held=0 AND c.state='granted' " +
          "AND COALESCE(r.loss,0)=0 AND COALESCE(r.full_refund,0)=0 " +
          "AND json_array_length(COALESCE(r.hold_ids,'[]'))=0 " +
          `AND EXISTS(SELECT 1 FROM runs WHERE ${key}) ` +
          "ORDER BY p.created,p.payment_hash LIMIT 1 ON CONFLICT DO NOTHING",
      )
      .bind(...values, values[0], ...values),
    db
      .prepare(
        "UPDATE topup_purchases SET available=available-1,consumed=consumed+1 " +
          `WHERE payment_hash=(SELECT payment_hash FROM topup_allocations WHERE ${key}) AND changes()=1`,
      )
      .bind(...values),
    receipt(db, values),
  ]);
  return outcome(inserted, selected);
}

// Current committed state, not a saved allowance or the state when the run started.
const destination =
  "CASE WHEN c.state!='granted' OR COALESCE(r.loss,0)=1 OR COALESCE(r.full_refund,0)=1 " +
  "THEN 'revoked' WHEN p.held>0 OR json_array_length(COALESCE(r.hold_ids,'[]'))>0 THEN 'held' ELSE 'available' END";
const financial =
  "FROM topup_purchases p JOIN topup_claims c ON c.payment_hash=p.payment_hash " +
  "LEFT JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash ";

export async function restorePurchasedRun(db, run) {
  const values = identity(run);
  if (!values) return { changed: false, allocation: null };
  const [restored, , selected] = await db.batch([
    db
      .prepare(
        "UPDATE topup_allocations SET state=CASE WHEN (SELECT " +
          destination +
          " " +
          financial +
          "WHERE p.payment_hash=topup_allocations.payment_hash)='revoked' THEN 'revoked' ELSE 'restored' END " +
          `WHERE ${key} AND state='allocated' AND EXISTS(SELECT 1 FROM topup_purchases p ` +
          "WHERE p.payment_hash=topup_allocations.payment_hash AND p.consumed>0)",
      )
      .bind(...values),
    db
      .prepare(
        "WITH target AS (SELECT p.payment_hash," +
          destination +
          " AS destination " +
          financial +
          "JOIN topup_allocations a ON a.payment_hash=p.payment_hash " +
          "WHERE a.user_hash=? AND a.month=? AND a.task=? AND a.run_id=?) " +
          "UPDATE topup_purchases SET consumed=consumed-1, " +
          "available=available+((SELECT destination FROM target)='available'), " +
          "held=held+((SELECT destination FROM target)='held'), " +
          "revoked=revoked+((SELECT destination FROM target)='revoked') " +
          "WHERE payment_hash=(SELECT payment_hash FROM target) AND changes()=1",
      )
      .bind(...values),
    receipt(db, values),
  ]);
  return outcome(restored, selected);
}
