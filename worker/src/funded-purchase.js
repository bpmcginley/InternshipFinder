// SQL fragments used only inside the funded-run transaction, never a second allocation call.
export const purchaseFrom =
  "FROM topup_purchases p JOIN topup_claims c ON c.payment_hash=p.payment_hash LEFT JOIN topup_reconciliations r ON r.payment_hash=p.payment_hash";
export const purchaseClear =
  "c.state='granted' AND p.held=0 AND COALESCE(r.loss,0)=0 AND COALESCE(r.full_refund,0)=0 AND json_array_length(COALESCE(r.hold_ids,'[]'))=0";
export const purchaseSpendable = "p.available>0 AND " + purchaseClear;
export function allocateGeneration(db, generation, callId) {
  return [
    db
      .prepare(
        "INSERT INTO topup_generation_allocations(generation,user_hash,month,task,run_id,payment_hash,state) " +
          "SELECT f.generation,f.user_hash,f.month,f.task,f.run_id,p.payment_hash,'allocated' " +
          purchaseFrom +
          " JOIN funded_runs f ON f.user_hash=p.user_hash WHERE f.generation=? AND f.funding='purchase' AND " +
          purchaseSpendable +
          " AND EXISTS(SELECT 1 FROM funded_run_calls WHERE call_id=? AND generation=f.generation) ORDER BY p.created,p.payment_hash LIMIT 1",
      )
      .bind(generation, callId),
    db
      .prepare(
        "UPDATE topup_purchases SET available=available-1,consumed=consumed+1 WHERE payment_hash=(SELECT payment_hash FROM topup_generation_allocations WHERE generation=?) AND changes()=1",
      )
      .bind(generation),
  ];
}
const destination =
  "CASE WHEN c.state!='granted' OR COALESCE(r.loss,0)=1 OR COALESCE(r.full_refund,0)=1 THEN 'revoked' WHEN p.held>0 OR json_array_length(COALESCE(r.hold_ids,'[]'))>0 THEN 'held' ELSE 'available' END";
export function restoreGeneration(q) {
  const selected =
    purchaseFrom +
    " JOIN topup_generation_allocations a ON a.payment_hash=p.payment_hash WHERE a.generation=(SELECT generation FROM target WHERE calls=1 AND accepted=0 AND funding='purchase')";
  return [
    q(
      "UPDATE topup_generation_allocations SET state=CASE WHEN (SELECT " +
        destination +
        " " +
        selected +
        ")='revoked' THEN 'revoked' ELSE 'restored' END " +
        "WHERE generation=(SELECT generation FROM target WHERE calls=1 AND accepted=0 AND funding='purchase') AND state='allocated' AND EXISTS(SELECT 1 " +
        selected +
        " AND p.consumed>0)",
    ),
    q(
      "UPDATE topup_purchases SET consumed=consumed-1,available=available+((SELECT " +
        destination +
        " " +
        selected +
        ")='available'),held=held+((SELECT " +
        destination +
        " " +
        selected +
        ")='held'),revoked=revoked+((SELECT " +
        destination +
        " " +
        selected +
        ")='revoked') " +
        "WHERE payment_hash=(SELECT p.payment_hash " +
        selected +
        ") AND changes()=1",
    ),
  ];
}
export const purchaseContinuation =
  "EXISTS(SELECT 1 " +
  purchaseFrom +
  " JOIN topup_generation_allocations a ON a.payment_hash=p.payment_hash WHERE a.generation=f.generation AND a.user_hash=f.user_hash AND a.month=f.month AND a.task=f.task AND a.run_id=f.run_id AND a.state='allocated' AND p.user_hash=f.user_hash AND c.state='granted' AND (f.accepted=1 OR (" +
  purchaseClear +
  ")))";
