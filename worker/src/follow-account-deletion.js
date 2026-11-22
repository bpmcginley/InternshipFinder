// Build only the Follow statements for the existing account deletion transaction.
const scopesForAccount = `WITH deleting_scopes AS (
  SELECT subscriber_id,scope_key FROM follow_subscriptions
  WHERE owner_user_hash=? AND confirmed_at IS NOT NULL
  UNION ALL
  SELECT q.subscriber_id,q.scope_key FROM follow_confirmation_outbox q
  JOIN follow_subscriptions s ON s.subscriber_id=q.subscriber_id AND s.scope_key=q.scope_key
  WHERE q.owner_user_hash=? AND s.confirmed_at IS NULL
)`;
const targetPairs = "SELECT subscriber_id,scope_key FROM deleting_scopes";

export function forgetLinkedFollowStatements(db, user) {
  const scoped = (sql, ...args) =>
    db.prepare(`${scopesForAccount}\n${sql}`).bind(user, user, ...args);
  return [
    // Remove a subscriber only when this deletion removes every one of its scopes.
    scoped(
      `DELETE FROM follow_subscribers
       WHERE id IN (SELECT subscriber_id FROM deleting_scopes)
         AND NOT EXISTS (SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=follow_subscribers.id
           AND (s.subscriber_id,s.scope_key) NOT IN (${targetPairs}))`,
    ),
    // A deleting-owner token can retire its own queue row. Keep that ownership evidence
    // until the unconfirmed scope is removed, and clean up its other exact-scope tokens first.
    scoped(
      `DELETE FROM follow_tokens WHERE purpose='confirm' AND owner_user_hash IS NOT ?
         AND (subscriber_id,scope_key) IN (${targetPairs})`,
      user,
    ),
    scoped(`DELETE FROM follow_subscriptions WHERE (subscriber_id,scope_key) IN (${targetPairs})`),
    db
      .prepare("DELETE FROM follow_tokens WHERE purpose='confirm' AND owner_user_hash=?")
      .bind(user),
    db.prepare("DELETE FROM follow_confirmation_outbox WHERE owner_user_hash=?").bind(user),
  ];
}
