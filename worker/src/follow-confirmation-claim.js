// Dormant. A separate dispatcher must recheck exact consent and debit the shared send budget.
import { createFollowCapability } from "./follows.js";

const JOB_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const unavailable = () => new Error("Follow confirmation claim unavailable");

export async function claimFollowConfirmation(db, jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return null;
  const claimId = crypto.randomUUID();
  const [confirm, deletion, unsubscribe] = await Promise.all([
    createFollowCapability(),
    createFollowCapability("fd_"),
    createFollowCapability(),
  ]);
  const claimed = "FROM follow_confirmation_outbox WHERE id=? AND claim_id=?";
  const statements = [
    db
      .prepare(
        `UPDATE follow_confirmation_outbox AS q SET claim_id=?
         WHERE q.id=? AND q.claim_id IS NULL AND q.queued_at<=${DB_NOW} AND q.expires_at>${DB_NOW}
           AND EXISTS (SELECT 1 FROM follow_subscriptions s
             WHERE s.subscriber_id=q.subscriber_id AND s.scope_key=q.scope_key
               AND s.confirmed_at IS NULL AND s.created<=q.queued_at
               AND q.expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',s.created,'+7 days'))
           AND NOT EXISTS (SELECT 1 FROM follow_tokens t
             WHERE t.subscriber_id=q.subscriber_id AND t.scope_key=q.scope_key
               AND t.purpose='confirm' AND t.expires_at>${DB_NOW})`,
      )
      .bind(claimId, jobId),
    db
      .prepare(
        `INSERT INTO follow_tokens (token_hash,subscriber_id,purpose,scope_key,generation,expires_at)
         SELECT ?,subscriber_id,'confirm',scope_key,?,expires_at ${claimed}`,
      )
      .bind(confirm.digest, confirm.generation, jobId, claimId),
    db
      .prepare(
        `INSERT INTO follow_request_deletions (token_hash,confirm_hash) SELECT ?,? ${claimed}`,
      )
      .bind(deletion.digest, confirm.digest, jobId, claimId),
    db
      .prepare(
        `INSERT INTO follow_tokens (token_hash,subscriber_id,purpose,scope_key,generation,expires_at)
         SELECT ?,subscriber_id,'unsubscribe','',?,NULL ${claimed}`,
      )
      .bind(unsubscribe.digest, unsubscribe.generation, jobId, claimId),
    db.prepare(`SELECT expires_at ${claimed} AND expires_at>${DB_NOW}`).bind(jobId, claimId),
  ];

  // An unacknowledged commit is spent. No retry or readback can reconstruct its raw links.
  const results = await db.batch(statements).catch(() => {
    throw unavailable();
  });
  if (
    !Array.isArray(results) ||
    results.length !== statements.length ||
    results.some((result) => result?.success !== true)
  ) {
    throw unavailable();
  }
  const [claim, confirmation, deleteRequest, addressWide, fence] = results;
  const writes = [claim, confirmation, deleteRequest, addressWide].map(
    (result) => result?.meta?.changes,
  );
  if (!Array.isArray(fence?.results) || fence.results.length > 1 || fence.meta?.changes !== 0) {
    throw unavailable();
  }
  if (writes.every((changes) => changes === 0)) {
    if (fence.results.length) throw unavailable();
    return null;
  }
  if (writes.some((changes) => changes !== 1)) throw unavailable();
  if (!fence.results.length) return null;
  const receipt = fence.results[0];
  const expiresAt = receipt?.expires_at;
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== expiresAt ||
    Object.keys(receipt).length !== 1
  ) {
    throw unavailable();
  }
  if (!(Date.now() < expiry)) return null;
  return {
    claimId,
    expiresAt,
    confirmation: confirm.raw,
    deleteRequest: deletion.raw,
    unsubscribe: unsubscribe.raw,
  };
}
