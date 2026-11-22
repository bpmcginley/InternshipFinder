// Dormant issuance only. No rendering, transport or retry of an uncertain committed claim.
import { createFollowCapability, normalizeFollowEmail } from "./follows.js";
import {
  observeFollowSendBudget,
  debitFollowSendBudget,
  followSendBudgetAvailable,
  validFollowSendCap,
} from "./follow-send-budget.js";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const unavailable = () => ({ status: "unavailable" });
const live = `q.queued_at<=${NOW} AND q.expires_at>${NOW}
 AND EXISTS(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=q.subscriber_id)`;
const stamp = (v) =>
  typeof v === "string" &&
  v.length === 24 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function batch(rows, count) {
  if (!Array.isArray(rows) || rows.length !== count) throw new Error();
  for (let i = 0; i < count; i++)
    if (
      !Object.hasOwn(rows, i) ||
      rows[i]?.success !== true ||
      !Number.isSafeInteger(rows[i].meta?.changes) ||
      rows[i].meta.changes < 0 ||
      !Array.isArray(rows[i].results)
    )
      throw new Error();
  return rows;
}
function read(r) {
  if (r.meta.changes !== 0 || r.results.length > 1) throw new Error();
  if (!r.results.length) return null;
  const row = r.results[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
  return row;
}

export async function claimFollowManagementRequest(db, jobId, options = {}) {
  if (options?.enabled !== true) return { status: "disabled" };
  const { cap } = options;
  if (typeof jobId !== "string" || !UUID.test(jobId) || !validFollowSendCap(cap))
    return unavailable();
  try {
    const job = read(
      batch(
        await db.batch([
          db
            .prepare(
              `SELECT q.subscriber_id,q.queued_at,q.expires_at,u.email
      FROM follow_management_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
      WHERE q.id=? AND q.claim_id IS NULL AND ${live}`,
            )
            .bind(jobId),
        ]),
        1,
      )[0],
    );
    if (
      !job ||
      Object.keys(job).sort().join(",") !== "email,expires_at,queued_at,subscriber_id" ||
      typeof job.subscriber_id !== "string" ||
      !job.subscriber_id ||
      normalizeFollowEmail(job.email) !== job.email ||
      !stamp(job.queued_at) ||
      !stamp(job.expires_at) ||
      job.queued_at >= job.expires_at
    )
      return unavailable();
    const [manage, unsubscribe] = await Promise.all([
      createFollowCapability(),
      createFollowCapability(),
    ]);
    // Fresh IDs are private to this call. A spent receipt is never supplied back to this API.
    const claimId = crypto.randomUUID();
    const clock = read(batch(await db.batch([db.prepare(`SELECT ${NOW} AS at`)]), 1)[0]);
    if (!clock || Object.keys(clock).join(",") !== "at" || !stamp(clock.at)) return unavailable();
    const at = clock.at;
    const claimed = "FROM follow_management_outbox q WHERE q.id=? AND q.claim_id=?";
    const statements = [
      observeFollowSendBudget(db, at, true),
      db
        .prepare(
          `UPDATE follow_management_outbox AS q SET claim_id=?
        WHERE q.id=? AND q.claim_id IS NULL AND ${live}
          AND q.subscriber_id=? AND q.queued_at=? AND q.expires_at=?
          AND EXISTS(SELECT 1 FROM follow_subscribers u WHERE u.id=q.subscriber_id AND u.email=?)
          AND ?<=${NOW} AND substr(?,1,10)=date('now') AND ${followSendBudgetAvailable}`,
        )
        .bind(
          claimId,
          jobId,
          job.subscriber_id,
          job.queued_at,
          job.expires_at,
          job.email,
          at,
          at,
          at,
          cap,
        ),
      debitFollowSendBudget(db, at, cap, true),
      db
        .prepare(
          `DELETE FROM follow_tokens WHERE purpose='manage' AND scope_key=''
        AND subscriber_id IN(SELECT q.subscriber_id ${claimed})`,
        )
        .bind(jobId, claimId),
      db
        .prepare(
          `INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at)
        SELECT ?,q.subscriber_id,'manage','',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes') ${claimed}`,
        )
        .bind(manage.digest, manage.generation, jobId, claimId),
      db
        .prepare(
          `INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at)
        SELECT ?,q.subscriber_id,'unsubscribe','',?,NULL ${claimed}`,
        )
        .bind(unsubscribe.digest, unsubscribe.generation, jobId, claimId),
      db
        .prepare(
          `SELECT t.expires_at FROM follow_management_outbox q
        JOIN follow_subscribers u ON u.id=q.subscriber_id
        JOIN follow_tokens t ON t.subscriber_id=q.subscriber_id AND t.token_hash=? AND t.generation=?
          AND t.purpose='manage' AND t.scope_key='' AND t.owner_user_hash IS NULL
        WHERE q.id=? AND q.claim_id=? AND q.subscriber_id=? AND u.email=? AND ${live}
          AND ?<=${NOW} AND substr(?,1,10)=date('now')
          AND t.expires_at>${NOW} AND t.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes')
          AND EXISTS(SELECT 1 FROM follow_tokens v WHERE v.subscriber_id=q.subscriber_id
            AND v.token_hash=? AND v.generation=? AND v.purpose='unsubscribe' AND v.scope_key=''
            AND v.owner_user_hash IS NULL AND v.expires_at IS NULL)`,
        )
        .bind(
          manage.digest,
          manage.generation,
          jobId,
          claimId,
          job.subscriber_id,
          job.email,
          at,
          at,
          unsubscribe.digest,
          unsubscribe.generation,
        ),
    ];
    const receipts = batch(await db.batch(statements), 7);
    for (const r of receipts.slice(0, 6)) if (r.results.length) throw new Error();
    const changes = receipts.slice(0, 6).map((r) => r.meta.changes),
      receipt = read(receipts[6]);
    if (
      ![0, 1].includes(changes[0]) ||
      [1, 2, 4, 5].some((i) => changes[i] !== 1) ||
      !receipt ||
      Object.keys(receipt).join(",") !== "expires_at" ||
      !stamp(receipt.expires_at)
    )
      return unavailable();
    return {
      status: "claimed",
      claimId,
      jobId,
      email: job.email,
      expiresAt: receipt.expires_at,
      management: manage.raw,
      unsubscribe: unsubscribe.raw,
    };
  } catch {
    // Raw capabilities are never returned after uncertain writes, including a genuine lost commit acknowledgement.
    return unavailable();
  }
}
