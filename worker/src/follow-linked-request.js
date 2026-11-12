// Dormant explicit scoped consent. Account deletion must join this lifecycle before exposure.
import { canonicalFollow, normalizeFollowEmail } from "./follows.js";

const HASH = /^[a-f0-9]{64}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export async function requestLinkedFollowConfirmation(db, email, input, catalog, session) {
  const { id, user } = session ?? {};
  if (![id, user].every((v) => typeof v === "string" && HASH.test(v))) return null;
  email = normalizeFollowEmail(email);
  const scope = canonicalFollow(input, catalog);
  // The non-persisting view executes the entire admission at one authoritative SQL instant.
  // The later receipt remains session-gated, even if expiry follows the atomic request.
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO follow_link_requests(subscriber_id,email,scope_key,job_id,session_id,owner_user_hash)
      VALUES(?,?,?,?,?,?)`,
      )
      .bind(crypto.randomUUID(), email, scope, crypto.randomUUID(), id, user),
    db
      .prepare(
        `SELECT q.id AS confirmationJobId,q.subscriber_id AS subscriberId,q.scope_key AS scopeKey
      FROM follow_confirmation_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
      WHERE u.email=? AND q.scope_key=? AND q.owner_user_hash=? AND q.expires_at>${NOW}
      AND EXISTS(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=q.subscriber_id
        AND s.scope_key=q.scope_key AND s.owner_user_hash IS NULL)
      AND NOT EXISTS(SELECT 1 FROM follow_tokens t WHERE t.subscriber_id=q.subscriber_id
        AND t.scope_key=q.scope_key AND t.purpose='confirm' AND t.expires_at>${NOW}
        AND t.owner_user_hash IS NOT q.owner_user_hash)
      AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_hash=? AND julianday(expires)>julianday('now'))`,
      )
      .bind(email, scope, user, id, user),
  ]);
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    result[0]?.success !== true ||
    result[1]?.success !== true
  )
    throw new Error("Follow linkage unavailable");
  const receipt = result[1];
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
