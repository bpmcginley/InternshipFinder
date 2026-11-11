import {
  confirmFollow,
  deleteLinkedFollows,
  expireFollows,
  mintFollowToken,
  removeManagedFollow,
  requestFollow,
  unsubscribeFollows,
} from "../src/follows.js";
import { readFollowProgress } from "../src/follow-progress.js";

export const now = new Date("2026-11-10T12:00:00.000Z");
export const catalog = {
  companies: new Set(["alpha", "beta"]),
  fields: new Set(["biology"]),
  states: new Set(["MA"]),
};
export const options = { upperBound: now.toISOString(), maxScopes: 4, maxBytes: 4096 };
export const read = (db, id, overrides = {}) =>
  readFollowProgress(db, id, catalog, { ...options, ...overrides });
const request = (db, company = "alpha", email = "fixture@example.test") =>
  requestFollow(db, email, { kind: "company", company }, catalog, now);
const token = (db, follow, ownerUserHash = null) =>
  mintFollowToken(
    db,
    follow.subscriberId,
    "confirm",
    { scopeKey: follow.scopeKey, ownerUserHash },
    now,
  );
const progress = (db) => db.prepare("SELECT * FROM follow_scope_progress ORDER BY scope_key").all();

export async function scopeLifetime(db, equal) {
  const first = await request(db);
  const sibling = await request(db, "beta");
  equal((await progress(db)).results, []);
  equal(await read(db, first.subscriberId), []);
  const original = await token(db, first);
  const outcomes = await Promise.all([
    confirmFollow(db, original, now),
    confirmFollow(db, original, now),
  ]);
  equal(outcomes.sort(), [false, true]);
  const expected = [
    {
      scope_key: first.scopeKey,
      confirmed_at: now.toISOString(),
      scope_generation: original.split(".")[0],
      watermark: now.toISOString(),
    },
  ];
  equal(await read(db, first.subscriberId), expected);
  // A later matcher will advance progress. Reconfirmation must preserve even an advanced value.
  const advanced = new Date(+now + 1).toISOString();
  await db.prepare("UPDATE follow_scope_progress SET watermark=?").bind(advanced).run();
  const repeated = await token(db, first, "a".repeat(64));
  equal(await confirmFollow(db, repeated, now), true);
  expected[0].watermark = advanced;
  equal(await read(db, first.subscriberId, { upperBound: advanced }), expected);
  equal(await confirmFollow(db, repeated, now), false);
  const manage = await mintFollowToken(db, first.subscriberId, "manage", {}, now);
  equal(await removeManagedFollow(db, manage, first.scopeKey, now), true);
  equal((await progress(db)).results, []);
  // Keep a sibling so the subscriber ID is unchanged, and reuse the identical millisecond.
  const recreated = await request(db);
  equal(recreated.subscriberId, sibling.subscriberId);
  const next = await token(db, recreated);
  equal(await confirmFollow(db, next, now), true);
  const current = await read(db, first.subscriberId);
  equal(current[0].scope_generation === expected[0].scope_generation, false);
  equal(current[0].scope_generation, next.split(".")[0]);
  equal(current[0].confirmed_at, expected[0].confirmed_at);
  equal(current[0].watermark, now.toISOString());
}

export async function cleanupProgress(db, equal) {
  const linked = await request(db);
  await confirmFollow(db, await token(db, linked, "b".repeat(64)), now);
  await request(db, "beta");
  await expireFollows(db, new Date(+now + 7 * 86400_000));
  equal((await progress(db)).results.length, 1);
  await deleteLinkedFollows(db, "b".repeat(64));
  equal((await progress(db)).results, []);
  equal(await read(db, linked.subscriberId), []);
  const fresh = await request(db);
  equal(fresh.subscriberId === linked.subscriberId, false);
  await confirmFollow(db, await token(db, fresh), now);
  const unsubscribe = await mintFollowToken(db, fresh.subscriberId, "unsubscribe", {}, now);
  equal(await unsubscribeFollows(db, unsubscribe, now), true);
  equal((await progress(db)).results, []);
}

export async function rollbackProgress(db, equal, rejects) {
  const first = await request(db);
  const raw = await token(db, first);
  // Deliberately corrupt a pending row to force INSERT failure, proving whole-batch rollback.
  await db
    .prepare("INSERT INTO follow_scope_progress VALUES (?,?,?,?)")
    .bind(first.subscriberId, first.scopeKey, crypto.randomUUID(), now.toISOString())
    .run();
  await rejects(() => confirmFollow(db, raw, now));
  equal(
    await db.prepare("SELECT confirmed_at FROM follow_subscribers").first("confirmed_at"),
    null,
  );
  equal(
    await db.prepare("SELECT confirmed_at FROM follow_subscriptions").first("confirmed_at"),
    null,
  );
  equal(await db.prepare("SELECT COUNT(*) AS n FROM follow_tokens").first("n"), 1);
}

export async function invalidProgress(db, equal, rejects) {
  const first = await request(db);
  await confirmFollow(db, await token(db, first), now);
  const original = await read(db, first.subscriberId);
  const serialized = new TextEncoder().encode(JSON.stringify(original)).length;
  equal(await read(db, first.subscriberId, { maxBytes: serialized }), original);
  await rejects(() => read(db, first.subscriberId, { maxBytes: serialized - 1 }));
  const second = await request(db, "beta");
  await confirmFollow(db, await token(db, second), now);
  await rejects(() => read(db, first.subscriberId, { maxScopes: 1 }));
  equal((await read(db, first.subscriberId, { maxScopes: 2 })).length, 2);
  for (const value of [
    null,
    "garbage",
    "2026-02-30T00:00:00.000Z",
    "2026-11-10T12:00:00Z",
    "2026-11-10T11:59:59.999Z",
    "2026-11-10T12:00:00.001Z",
  ]) {
    if (value === null) {
      await db
        .prepare("DELETE FROM follow_scope_progress WHERE scope_key=?")
        .bind(first.scopeKey)
        .run();
      await rejects(() => read(db, first.subscriberId));
      await db
        .prepare("INSERT INTO follow_scope_progress VALUES (?,?,?,?)")
        .bind(first.subscriberId, first.scopeKey, original[0].scope_generation, now.toISOString())
        .run();
    } else {
      await db
        .prepare("UPDATE follow_scope_progress SET watermark=? WHERE scope_key=?")
        .bind(value, first.scopeKey)
        .run();
      await rejects(() => read(db, first.subscriberId));
    }
  }
  await db
    .prepare(
      "UPDATE follow_scope_progress SET watermark=?,scope_generation='invalid' WHERE scope_key=?",
    )
    .bind(now.toISOString(), first.scopeKey)
    .run();
  await rejects(() => read(db, first.subscriberId));
  await db
    .prepare("UPDATE follow_scope_progress SET scope_generation=? WHERE scope_key=?")
    .bind(original[0].scope_generation, first.scopeKey)
    .run();
  await db
    .prepare("UPDATE follow_subscriptions SET confirmed_at='invalid' WHERE scope_key=?")
    .bind(first.scopeKey)
    .run();
  await rejects(() => read(db, first.subscriberId));
}
