// Dormant storage API, deliberately not imported by the router or scheduled handler.
// Callers must add abuse controls, consent/UI, outbox deletion and send gates before exposure.
const DAY = 86400_000;
const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const hash = async (value) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
const stamp = (now) => now.toISOString();
const cutoff = (now) => new Date(now.getTime() - 7 * DAY).toISOString();
const invalid = () => {
  throw new Error("Invalid follow input");
};
const owner = (value) =>
  value === null || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));

export function canonicalFollow(input, catalog) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const keys = Object.keys(input).sort().join(",");
  if (input.kind === "company") {
    if (
      keys !== "company,kind" ||
      typeof input.company !== "string" ||
      encoder.encode(input.company).length > 200 ||
      !catalog.companies.has(input.company)
    )
      invalid();
    return JSON.stringify({ kind: "company", company: input.company });
  }
  if (input.kind !== "search" || keys !== "fields,kind,states") invalid();
  const clean = (items, allowed) => {
    if (
      !Array.isArray(items) ||
      items.length > 64 ||
      items.some((v) => typeof v !== "string" || !allowed.has(v))
    )
      invalid();
    return [...new Set(items)].sort();
  };
  const fields = clean(input.fields, catalog.fields),
    states = clean(input.states, catalog.states);
  if ((!fields.length && !states.length) || states.includes("REMOTE")) invalid();
  return JSON.stringify({ kind: "search", fields, states });
}

// The caller supplies a trusted public catalog, never a catalog received from a signup request.
// No token is minted here: a later outbox dispatcher mints it immediately before rendering.
export async function requestFollow(db, email, input, catalog, now = new Date()) {
  if (typeof email !== "string") invalid();
  email = email.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(email)
  )
    invalid();
  const scopeKey = canonicalFollow(input, catalog),
    id = crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        "INSERT INTO follow_subscribers (id,email,created) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING",
      )
      .bind(id, email, stamp(now)),
    db
      .prepare(
        "DELETE FROM follow_tokens WHERE purpose='confirm' AND scope_key=? AND subscriber_id IN " +
          "(SELECT s.subscriber_id FROM follow_subscriptions s JOIN follow_subscribers u ON u.id=s.subscriber_id " +
          "WHERE u.email=? AND s.scope_key=? AND s.confirmed_at IS NULL AND s.created<=?)",
      )
      .bind(scopeKey, email, scopeKey, cutoff(now)),
    db
      .prepare(
        "INSERT INTO follow_subscriptions (subscriber_id,scope_key,created) SELECT id,?,? FROM follow_subscribers WHERE email=? " +
          "ON CONFLICT(subscriber_id,scope_key) DO UPDATE SET created=excluded.created " +
          "WHERE confirmed_at IS NULL AND created<=?",
      )
      .bind(scopeKey, stamp(now), email, cutoff(now)),
    db.prepare("SELECT id FROM follow_subscribers WHERE email=?").bind(email),
  ]);
  return {
    subscriberId: result.at(-1).results[0].id,
    scopeKey,
  };
}

// Random generation + 256-bit secret; only the hash and generation enter D1.
// Confirmation/management reissues invalidate previous links in the same scope. Unsubscribe links
// remain valid until deletion, including previously delivered links after a later dispatch.
export async function mintFollowToken(
  db,
  subscriberId,
  purpose,
  { scopeKey = "", ownerUserHash = null } = {},
  now = new Date(),
) {
  if (
    !["confirm", "manage", "unsubscribe"].includes(purpose) ||
    !owner(ownerUserHash) ||
    (purpose === "confirm" ? !scopeKey : scopeKey !== "" || ownerUserHash !== null)
  )
    invalid();
  const generation = crypto.randomUUID(),
    raw = generation + "." + hex(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await hash(raw);
  let expiry =
    purpose === "unsubscribe"
      ? null
      : new Date(now.getTime() + (purpose === "manage" ? 30 * 60_000 : 7 * DAY)).toISOString();
  if (purpose === "confirm") {
    const subscription = await db
      .prepare(
        "SELECT created,confirmed_at FROM follow_subscriptions WHERE subscriber_id=? AND scope_key=?",
      )
      .bind(subscriberId, scopeKey)
      .first();
    if (!subscription) return null;
    if (!subscription.confirmed_at)
      expiry = new Date(new Date(subscription.created).getTime() + 7 * DAY).toISOString();
  }
  const eligible =
    purpose === "confirm"
      ? "SELECT subscriber_id FROM follow_subscriptions WHERE subscriber_id=? AND scope_key=? AND (confirmed_at IS NOT NULL OR created>?)"
      : "SELECT id FROM follow_subscribers WHERE id=?";
  const args = purpose === "confirm" ? [subscriberId, scopeKey, cutoff(now)] : [subscriberId];
  const statements = [];
  if (purpose !== "unsubscribe")
    statements.push(
      db
        .prepare("DELETE FROM follow_tokens WHERE subscriber_id=? AND purpose=? AND scope_key=?")
        .bind(subscriberId, purpose, scopeKey),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO follow_tokens (token_hash,subscriber_id,purpose,scope_key,generation,expires_at,owner_user_hash) " +
          `SELECT ?,id,?,?,?,?,? FROM follow_subscribers WHERE id IN (${eligible})`,
      )
      .bind(digest, purpose, scopeKey, generation, expiry, ownerUserHash, ...args),
  );
  const result = await db.batch(statements);
  return result.at(-1).meta.changes ? raw : null;
}

const liveToken =
  "SELECT subscriber_id FROM follow_tokens WHERE token_hash=? AND purpose=? AND (expires_at IS NULL OR expires_at>?)";
async function tokenHash(raw) {
  return typeof raw === "string" && /^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(raw) ? hash(raw) : "";
}

// Read-only: safe for a future confirmation GET/prefetch. Only explicit confirmation mutates.
export async function inspectFollowToken(db, raw, purpose, now = new Date()) {
  return db
    .prepare(
      "SELECT subscriber_id,scope_key,generation,owner_user_hash FROM follow_tokens WHERE token_hash=? AND purpose=? " +
        "AND (expires_at IS NULL OR expires_at>?)",
    )
    .bind(await tokenHash(raw), purpose, stamp(now))
    .first();
}

export async function confirmFollow(db, raw, now = new Date()) {
  const digest = await tokenHash(raw),
    at = stamp(now);
  const eligible =
    "SELECT t.subscriber_id FROM follow_tokens t JOIN follow_subscriptions s ON s.subscriber_id=t.subscriber_id AND s.scope_key=t.scope_key " +
    "WHERE t.token_hash=? AND t.purpose='confirm' AND t.expires_at>? " +
    "AND (s.confirmed_at IS NOT NULL OR s.created>?) AND (s.owner_user_hash IS NULL OR t.owner_user_hash IS NULL OR s.owner_user_hash=t.owner_user_hash)";
  const result = await db.batch([
    db
      .prepare(
        "UPDATE follow_subscribers SET confirmed_at=COALESCE(confirmed_at,?) WHERE id IN (" +
          eligible +
          ")",
      )
      .bind(at, digest, at, cutoff(now)),
    // Bind the first confirmed lifetime to its token generation in the same transaction.
    // Already-confirmed flows (including owner linkage) must never rotate or repair progress.
    db
      .prepare(
        "INSERT INTO follow_scope_progress (subscriber_id,scope_key,scope_generation,watermark) " +
          "SELECT t.subscriber_id,t.scope_key,t.generation,? FROM follow_tokens t " +
          "JOIN follow_subscriptions s ON s.subscriber_id=t.subscriber_id AND s.scope_key=t.scope_key " +
          "WHERE s.confirmed_at IS NULL AND t.subscriber_id IN (" +
          eligible +
          ") AND t.token_hash=?",
      )
      .bind(at, digest, at, cutoff(now), digest),
    db
      .prepare(
        "UPDATE follow_subscriptions SET confirmed_at=COALESCE(confirmed_at,?), owner_user_hash=COALESCE(owner_user_hash," +
          "(SELECT owner_user_hash FROM follow_tokens WHERE token_hash=?)) WHERE subscriber_id IN (" +
          eligible +
          ") " +
          "AND scope_key=(SELECT scope_key FROM follow_tokens WHERE token_hash=?)",
      )
      .bind(at, digest, digest, at, cutoff(now), digest),
    db.prepare("DELETE FROM follow_tokens WHERE token_hash=? AND purpose='confirm'").bind(digest),
  ]);
  return result[2].meta.changes > 0;
}

export async function unsubscribeFollows(db, raw, now = new Date()) {
  // Cascades erase all subscriptions and tokens in the same statement/transaction.
  const result = await db
    .prepare("DELETE FROM follow_subscribers WHERE id IN (" + liveToken + ")")
    .bind(await tokenHash(raw), "unsubscribe", stamp(now))
    .run();
  return result.meta.changes > 0;
}

// A management link can inspect/remove any scope for its email, but never confirms or links one.
// Read-only, including invalid/expired links: future GET/prefetch must call only inspection/listing.
export async function listManagedFollows(db, raw, now = new Date()) {
  const digest = await tokenHash(raw),
    at = stamp(now);
  const result = await db.batch([
    db.prepare(liveToken).bind(digest, "manage", at),
    db
      .prepare(
        "SELECT scope_key,created,confirmed_at FROM follow_subscriptions WHERE subscriber_id IN (" +
          liveToken +
          ") ORDER BY scope_key",
      )
      .bind(digest, "manage", at),
  ]);
  return result[0].results.length ? result[1].results : null;
}

// Explicit management action. Keep the token for further actions within its original 30-minute
// lifetime, unless the last scope is removed. Tokens for the removed scope cannot confirm it later.
export async function removeManagedFollow(db, raw, scopeKey, now = new Date()) {
  if (typeof scopeKey !== "string") invalid();
  const digest = await tokenHash(raw),
    at = stamp(now);
  const result = await db.batch([
    db
      .prepare(
        "DELETE FROM follow_tokens WHERE purpose='confirm' AND scope_key=? AND subscriber_id IN (" +
          liveToken +
          ")",
      )
      .bind(scopeKey, digest, "manage", at),
    db
      .prepare(
        "DELETE FROM follow_subscriptions WHERE scope_key=? AND subscriber_id IN (" +
          liveToken +
          ")",
      )
      .bind(scopeKey, digest, "manage", at),
    db
      .prepare(
        "DELETE FROM follow_subscribers WHERE id IN (" +
          liveToken +
          ") AND NOT EXISTS " +
          "(SELECT 1 FROM follow_subscriptions WHERE subscriber_id=follow_subscribers.id)",
      )
      .bind(digest, "manage", at),
  ]);
  return result[1].meta.changes > 0;
}

export async function deleteManagedFollows(db, raw, now = new Date()) {
  const result = await db
    .prepare("DELETE FROM follow_subscribers WHERE id IN (" + liveToken + ")")
    .bind(await tokenHash(raw), "manage", stamp(now))
    .run();
  return result.meta.changes > 0;
}

// Trusted authenticated identity only; never attach by email or by an unconfirmed request.
// This is not yet connected to DELETE /me. Future outbox rows must cascade in this transaction;
// the separately keyed daily send marker must survive deletion until UTC midnight.
export async function deleteLinkedFollows(db, ownerUserHash) {
  if (!ownerUserHash || !owner(ownerUserHash)) invalid();
  return db.batch([
    db
      .prepare(
        "DELETE FROM follow_tokens WHERE owner_user_hash=? OR (purpose='confirm' AND EXISTS " +
          "(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=follow_tokens.subscriber_id AND s.scope_key=follow_tokens.scope_key AND s.owner_user_hash=?))",
      )
      .bind(ownerUserHash, ownerUserHash),
    db.prepare("DELETE FROM follow_subscriptions WHERE owner_user_hash=?").bind(ownerUserHash),
    db.prepare(
      "DELETE FROM follow_subscribers WHERE NOT EXISTS (SELECT 1 FROM follow_subscriptions WHERE subscriber_id=follow_subscribers.id)",
    ),
  ]);
}

export async function expireFollows(db, now = new Date()) {
  await db.batch([
    db
      .prepare(
        "DELETE FROM follow_tokens WHERE expires_at<=? OR (purpose='confirm' AND EXISTS " +
          "(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=follow_tokens.subscriber_id AND s.scope_key=follow_tokens.scope_key " +
          "AND s.confirmed_at IS NULL AND s.created<=?))",
      )
      .bind(stamp(now), cutoff(now)),
    db
      .prepare("DELETE FROM follow_subscriptions WHERE confirmed_at IS NULL AND created<=?")
      .bind(cutoff(now)),
    db.prepare(
      "DELETE FROM follow_subscribers WHERE NOT EXISTS (SELECT 1 FROM follow_subscriptions WHERE subscriber_id=follow_subscribers.id)",
    ),
  ]);
}
