// Dormant. A trusted dispatcher mints this capability for a fresh confirmation message.
// A future handler may call deletion only after an explicit POST, never on preview.
const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const hash = async (value) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
const CONFIRM = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;
const PREFIX = "fd_";

export async function mintFollowRequestDeletion(db, confirmation, now = new Date()) {
  if (typeof confirmation !== "string" || !CONFIRM.test(confirmation)) return null;
  const at = now.toISOString();
  const raw = `${PREFIX}${crypto.randomUUID()}.${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const result = await db
    .prepare(
      `INSERT INTO follow_request_deletions (token_hash, confirm_hash)
       SELECT ?, t.token_hash FROM follow_tokens t JOIN follow_subscriptions s
         ON s.subscriber_id=t.subscriber_id AND s.scope_key=t.scope_key
       WHERE t.token_hash=? AND t.purpose='confirm' AND t.expires_at>?
       ON CONFLICT(confirm_hash) DO NOTHING`,
    )
    .bind(await hash(raw), await hash(confirmation), at)
    .run();
  return result.meta.changes === 1 ? raw : null;
}

const live = `FROM follow_request_deletions d JOIN follow_tokens t ON t.token_hash=d.confirm_hash
  WHERE d.token_hash=? AND t.purpose='confirm' AND t.expires_at>?`;

export async function deleteFollowRequest(db, token, now = new Date()) {
  if (
    typeof token !== "string" ||
    !token.startsWith(PREFIX) ||
    !CONFIRM.test(token.slice(PREFIX.length))
  )
    return false;
  const args = [await hash(token), now.toISOString()];
  // D1 serializes these statements with confirmation and reissue. Keep the credential
  // until the last step so it authorizes each statement, including orphan cleanup.
  const result = await db.batch([
    db
      .prepare(
        `DELETE FROM follow_subscriptions WHERE confirmed_at IS NULL
        AND (subscriber_id, scope_key) IN (SELECT t.subscriber_id, t.scope_key ${live})`,
      )
      .bind(...args),
    db
      .prepare(
        `DELETE FROM follow_subscribers WHERE id IN (SELECT t.subscriber_id ${live})
        AND NOT EXISTS (SELECT 1 FROM follow_subscriptions WHERE subscriber_id=follow_subscribers.id)`,
      )
      .bind(...args),
    db
      .prepare(`DELETE FROM follow_tokens WHERE token_hash IN (SELECT t.token_hash ${live})`)
      .bind(...args),
  ]);
  return result.some(({ meta }) => meta.changes > 0);
}
