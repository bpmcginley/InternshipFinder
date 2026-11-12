// Dormant explicit scoped consent. Account deletion must join this lifecycle before exposure.
import { canonicalFollow, normalizeFollowEmail } from "./follows.js";

const HASH = /^[a-f0-9]{64}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export async function requestLinkedFollowConfirmation(db, email, input, catalog, session) {
  const { id, user } = session ?? {};
  if (![id, user].every((v) => typeof v === "string" && HASH.test(v))) return null;
  email = normalizeFollowEmail(email);
  const scope = canonicalFollow(input, catalog);
  // Every write rechecks the current session and consent in the same transaction. No session
  // reference enters a Follow row. A conflicting live request is never silently replaced.
  const guard = `EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_hash=?
      AND julianday(expires)>julianday('now'))
    AND NOT EXISTS(SELECT 1 FROM follow_subscriptions s JOIN follow_subscribers u ON u.id=s.subscriber_id
      WHERE u.email=? AND s.scope_key=? AND s.owner_user_hash IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM follow_confirmation_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
      WHERE u.email=? AND q.scope_key=? AND q.expires_at>${NOW} AND q.owner_user_hash IS NOT ?)
    AND NOT EXISTS(SELECT 1 FROM follow_tokens t JOIN follow_subscribers u ON u.id=t.subscriber_id
      WHERE u.email=? AND t.scope_key=? AND t.purpose='confirm' AND t.expires_at>${NOW}
        AND t.owner_user_hash IS NOT ?)`;
  const args = [id, user, email, scope, email, scope, user, email, scope, user];
  const q = (sql, ...values) => db.prepare(sql).bind(...values, ...args);
  const result = await db.batch([
    q(
      `INSERT INTO follow_subscribers(id,email,created) SELECT ?,?,${NOW} WHERE ${guard}
       ON CONFLICT(email) DO NOTHING`,
      crypto.randomUUID(),
      email,
    ),
    q(
      `DELETE FROM follow_tokens WHERE purpose='confirm' AND scope_key=? AND expires_at<=${NOW}
       AND subscriber_id IN(SELECT id FROM follow_subscribers WHERE email=?) AND ${guard}`,
      scope,
      email,
    ),
    q(
      `DELETE FROM follow_confirmation_outbox WHERE scope_key=? AND expires_at<=${NOW}
       AND subscriber_id IN(SELECT id FROM follow_subscribers WHERE email=?) AND ${guard}`,
      scope,
      email,
    ),
    q(
      `INSERT INTO follow_subscriptions(subscriber_id,scope_key,created)
       SELECT id,?,${NOW} FROM follow_subscribers WHERE email=? AND ${guard}
       ON CONFLICT(subscriber_id,scope_key) DO UPDATE SET created=excluded.created
       WHERE confirmed_at IS NULL AND created<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')`,
      scope,
      email,
    ),
    q(
      `INSERT INTO follow_confirmation_outbox(id,subscriber_id,scope_key,queued_at,expires_at,owner_user_hash)
       SELECT ?,s.subscriber_id,s.scope_key,${NOW},
         CASE WHEN s.confirmed_at IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ',s.created,'+7 days')
           ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days') END,?
       FROM follow_subscriptions s JOIN follow_subscribers u ON u.id=s.subscriber_id
       WHERE u.email=? AND s.scope_key=? AND ${guard}
       ON CONFLICT(subscriber_id,scope_key) DO NOTHING`,
      crypto.randomUUID(),
      user,
      email,
      scope,
    ),
    q(
      `SELECT q.id AS confirmationJobId,q.subscriber_id AS subscriberId,q.scope_key AS scopeKey
       FROM follow_confirmation_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
       WHERE u.email=? AND q.scope_key=? AND q.owner_user_hash=? AND q.expires_at>${NOW} AND ${guard}`,
      email,
      scope,
      user,
    ),
  ]);
  if (!Array.isArray(result) || result.length !== 6 || result.some((r) => r?.success !== true))
    throw new Error("Follow linkage unavailable");
  const receipt = result.at(-1);
  if (receipt.meta?.changes !== 0 || !Array.isArray(receipt.results) || receipt.results.length > 1)
    throw new Error("Follow linkage unavailable");
  const row = receipt.results[0];
  if (!row) return null;
  const uuid = (v) =>
    typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
  if (
    Object.keys(row).sort().join(",") !== "confirmationJobId,scopeKey,subscriberId" ||
    !uuid(row.confirmationJobId) ||
    !uuid(row.subscriberId) ||
    row.scopeKey !== scope
  )
    throw new Error("Follow linkage unavailable");
  return {
    confirmationJobId: row.confirmationJobId,
    subscriberId: row.subscriberId,
    scopeKey: scope,
  };
}
