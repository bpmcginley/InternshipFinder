// Dormant confirmation credentials and the atomic, optionally budgeted claim.
import { createFollowCapability } from "./follows.js";
import {
  debitFollowSendBudget,
  followSendBudgetAvailable,
  observeFollowSendBudget,
} from "./follow-send-budget.js";

const JOB_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const unavailable = () => new Error("Follow confirmation claim unavailable");
const pending = `q.queued_at<=${DB_NOW} AND q.expires_at>${DB_NOW}
  AND EXISTS (SELECT 1 FROM follow_subscriptions s
    WHERE s.subscriber_id=q.subscriber_id AND s.scope_key=q.scope_key
      AND s.created<=q.queued_at AND (s.owner_user_hash IS NULL OR q.owner_user_hash IS NULL)
      AND ((s.confirmed_at IS NULL AND q.expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',s.created,'+7 days'))
        OR (s.confirmed_at IS NOT NULL AND q.owner_user_hash IS NOT NULL
          AND q.expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',q.queued_at,'+7 days'))))`;
const unclaimed = `q.claim_id IS NULL AND ${pending}
  AND NOT EXISTS (SELECT 1 FROM follow_tokens t
    WHERE t.subscriber_id=q.subscriber_id AND t.scope_key=q.scope_key
      AND t.purpose='confirm' AND t.expires_at>${DB_NOW})`;
const exactJob = `q.subscriber_id=? AND q.scope_key=? AND q.queued_at=? AND q.expires_at=? AND q.owner_user_hash IS ?
  AND EXISTS (SELECT 1 FROM follow_subscribers u WHERE u.id=q.subscriber_id AND u.email=?)`;
const sameDay = `?<=${DB_NOW} AND substr(?,1,10)=date('now')`;
const jobValues = (job) => [
  job.subscriber_id,
  job.scope_key,
  job.queued_at,
  job.expires_at,
  job.owner_user_hash ?? null,
  job.email,
];

export async function readUnclaimedFollowConfirmation(db, jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return null;
  const result = await db
    .prepare(
      `SELECT q.subscriber_id,q.scope_key,q.queued_at,q.expires_at,q.owner_user_hash,u.email
       FROM follow_confirmation_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
       WHERE q.id=? AND ${unclaimed}`,
    )
    .bind(jobId)
    .all();
  return readReceipt(result);
}

export async function readFollowConfirmationClock(db) {
  const receipt = readReceipt(await db.prepare(`SELECT ${DB_NOW} AS at`).all());
  const at = receipt?.at;
  const time = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== at) throw unavailable();
  return at;
}

export async function prepareFollowConfirmationClaim() {
  const [confirm, deletion, unsubscribe] = await Promise.all([
    createFollowCapability(),
    createFollowCapability("fd_"),
    createFollowCapability(),
  ]);
  return { claimId: crypto.randomUUID(), confirm, deletion, unsubscribe };
}

function readReceipt(result) {
  if (
    result?.success !== true ||
    !Array.isArray(result.results) ||
    result.results.length > 1 ||
    result.meta?.changes !== 0
  )
    throw unavailable();
  if (!result.results.length) return null;
  const row = result.results[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) throw unavailable();
  return row;
}

// An unacknowledged commit is spent. No retry or readback can reconstruct its raw links.
export async function commitFollowConfirmationClaim(db, jobId, prepared, attempt = null) {
  const { claimId, confirm, deletion, unsubscribe } = prepared;
  const claimed = "FROM follow_confirmation_outbox WHERE id=? AND claim_id=?";
  const guard = attempt ? ` AND ${exactJob} AND ${sameDay}` : "";
  const exact = attempt ? [...jobValues(attempt.job), attempt.at, attempt.at] : [];
  const claim = db
    .prepare(
      `UPDATE follow_confirmation_outbox AS q SET claim_id=? WHERE q.id=? AND ${unclaimed}${guard}` +
        (attempt ? ` AND ${followSendBudgetAvailable}` : ""),
    )
    .bind(claimId, jobId, ...exact, ...(attempt ? [attempt.at, attempt.cap] : []));
  const credentials = [
    db
      .prepare(
        `INSERT INTO follow_tokens (token_hash,subscriber_id,purpose,scope_key,generation,expires_at,owner_user_hash)
         SELECT ?,subscriber_id,'confirm',scope_key,?,expires_at,owner_user_hash ${claimed}`,
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
  ];
  const fence = db
    .prepare(`SELECT expires_at ${claimed} AND expires_at>${DB_NOW}`)
    .bind(jobId, claimId);
  const statements = attempt
    ? [
        observeFollowSendBudget(db, attempt.at, true),
        claim,
        // The guarded claim is immediately before the debit in the same D1 transaction.
        debitFollowSendBudget(db, attempt.at, attempt.cap, true),
        ...credentials,
        fence,
        db
          .prepare(
            `SELECT 1 AS paused FROM follow_confirmation_outbox q
             WHERE q.id=? AND ${unclaimed}${guard}
               AND EXISTS (SELECT 1 FROM follow_send_budget WHERE slot=1 AND observed_at>=?
                 AND substr(observed_at,1,10)=substr(?,1,10) AND attempts>=?)`,
          )
          .bind(jobId, ...exact, attempt.at, attempt.at, attempt.cap),
      ]
    : [claim, ...credentials, fence];
  const results = await db.batch(statements).catch(() => {
    throw unavailable();
  });
  if (
    !Array.isArray(results) ||
    results.length !== statements.length ||
    results.some((result) => result?.success !== true)
  )
    throw unavailable();
  const [receiptResult, pauseResult] = results.slice(attempt ? 6 : 4);
  const receipt = readReceipt(receiptResult);
  const paused = attempt && readReceipt(pauseResult);
  if (paused && (paused.paused !== 1 || Object.keys(paused).length !== 1)) throw unavailable();
  const writes = results.slice(attempt ? 1 : 0, attempt ? 6 : 4).map((r) => r.meta?.changes);
  if (writes.every((changes) => changes === 0)) {
    if (receipt) throw unavailable();
    return { status: paused ? "paused" : "unavailable" };
  }
  if (writes.some((changes) => changes !== 1) || paused) throw unavailable();
  if (!receipt) return { status: "unavailable" };
  const expiresAt = receipt.expires_at;
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== expiresAt ||
    Object.keys(receipt).length !== 1 ||
    (attempt && attempt.job.expires_at !== expiresAt)
  )
    throw unavailable();
  return { status: "claimed", expiresAt };
}

export async function readFollowConfirmationTransportFence(db, jobId, job, prepared, at) {
  const { claimId, confirm, deletion, unsubscribe } = prepared;
  const result = await db
    .prepare(
      `SELECT q.expires_at FROM follow_confirmation_outbox q
       WHERE q.id=? AND q.claim_id=? AND ${pending} AND ${exactJob} AND ${sameDay}
         AND EXISTS (SELECT 1 FROM follow_tokens t JOIN follow_request_deletions d ON d.confirm_hash=t.token_hash
           WHERE t.token_hash=? AND t.generation=? AND t.purpose='confirm' AND t.subscriber_id=q.subscriber_id
             AND t.scope_key=q.scope_key AND t.expires_at=q.expires_at AND t.owner_user_hash IS q.owner_user_hash AND d.token_hash=?)
         AND EXISTS (SELECT 1 FROM follow_tokens t WHERE t.token_hash=? AND t.generation=?
           AND t.purpose='unsubscribe' AND t.subscriber_id=q.subscriber_id AND t.scope_key='' AND t.expires_at IS NULL)`,
    )
    .bind(
      jobId,
      claimId,
      ...jobValues(job),
      at,
      at,
      confirm.digest,
      confirm.generation,
      deletion.digest,
      unsubscribe.digest,
      unsubscribe.generation,
    )
    .all();
  const receipt = readReceipt(result);
  return receipt?.expires_at === job.expires_at && Object.keys(receipt).length === 1;
}

export async function claimFollowConfirmation(db, jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return null;
  const prepared = await prepareFollowConfirmationClaim();
  const { status, expiresAt } = await commitFollowConfirmationClaim(db, jobId, prepared);
  if (status !== "claimed" || !(Date.now() < Date.parse(expiresAt))) return null;
  return {
    claimId: prepared.claimId,
    expiresAt,
    confirmation: prepared.confirm.raw,
    deleteRequest: prepared.deletion.raw,
    unsubscribe: prepared.unsubscribe.raw,
  };
}
