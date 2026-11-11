import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.js";
import {
  requestFollow,
  mintFollowToken,
  confirmFollow,
  unsubscribeFollows,
  deleteLinkedFollows,
  listManagedFollows,
  removeManagedFollow,
  deleteManagedFollows,
  expireFollows,
} from "../src/follows.js";

const now = new Date("2026-11-11T12:00:00Z"),
  at = (minutes) => new Date(+now + minutes * 60_000);
const catalog = { companies: new Set(["example-a", "example-b"]) },
  account = "a".repeat(64);
const request = (db, company = "example-a", email = "reader@example.test") =>
  requestFollow(db, email, { kind: "company", company }, catalog, now);
const mint = (db, r, purpose = "manage", options = {}) =>
  mintFollowToken(db, r.subscriberId, purpose, options, now);
const confirm = async (db, r, ownerUserHash = null) =>
  confirmFollow(db, await mint(db, r, "confirm", { scopeKey: r.scopeKey, ownerUserHash }), now);
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;

test("management listing does not activate pending follows or expose address, token, or account hash", async () => {
  const db = fakeD1(),
    a = await request(db),
    b = await request(db, "example-b");
  await confirm(db, a, account);
  const raw = await mint(db, a),
    before = await rows(db, "follow_subscriptions");
  const listed = await listManagedFollows(db, raw, now);
  assert.deepEqual(
    listed.map((s) => s.scope_key),
    [a.scopeKey, b.scopeKey],
  );
  assert.deepEqual(Object.keys(listed[0]).sort(), ["confirmed_at", "created", "scope_key"]);
  assert.deepEqual(await rows(db, "follow_subscriptions"), before);
  assert.equal(await confirmFollow(db, raw, now), false);
  assert.equal(await unsubscribeFollows(db, raw, now), false);
  assert.ok(!JSON.stringify(await rows(db, "follow_tokens")).includes(raw));
});

test("management expires exactly at 30 minutes and reissue revokes the previous generation", async () => {
  const db = fakeD1(),
    r = await request(db),
    old = await mint(db, r),
    current = await mint(db, r);
  assert.equal(await listManagedFollows(db, old, now), null);
  assert.equal(await deleteManagedFollows(db, old, now), false);
  assert.ok(await listManagedFollows(db, current, at(29.999)));
  assert.equal(await listManagedFollows(db, current, at(30)), null);
  assert.equal(await removeManagedFollow(db, current, r.scopeKey, at(30)), false);
  assert.equal(await deleteManagedFollows(db, current, at(30)), false);
  await expireFollows(db, at(30));
  assert.deepEqual(await rows(db, "follow_tokens"), []);
  assert.equal((await rows(db, "follow_subscriptions")).length, 1);
  await assert.rejects(mint(db, r, "manage", { scopeKey: r.scopeKey }));
  await assert.rejects(mint(db, r, "manage", { ownerUserHash: account }));
  assert.equal(await mintFollowToken(db, "missing-subscriber", "manage", {}, now), null);
});

test("confirmation/unsubscribe tokens and another inbox's management token cannot remove scopes", async () => {
  const db = fakeD1(),
    a = await request(db),
    other = await request(db, "example-b", "other@example.test");
  for (const token of [
    await mint(db, a, "confirm", { scopeKey: a.scopeKey }),
    await mint(db, a, "unsubscribe"),
    "invalid",
  ]) {
    assert.equal(await listManagedFollows(db, token, now), null);
    assert.equal(await removeManagedFollow(db, token, a.scopeKey, now), false);
    assert.equal(await deleteManagedFollows(db, token, now), false);
  }
  assert.equal(await removeManagedFollow(db, await mint(db, other), a.scopeKey, now), false);
  assert.equal((await rows(db, "follow_subscriptions")).length, 2);
  assert.equal(await deleteManagedFollows(db, await mint(db, other), now), true);
  assert.equal((await rows(db, "follow_subscriptions"))[0].subscriber_id, a.subscriberId);
});

test("selective removal preserves sibling linkage and revokes scope tokens; last removal erases all", async () => {
  const db = fakeD1(),
    a = await request(db),
    b = await request(db, "example-b");
  await confirm(db, b, account);
  const pending = await mint(db, a, "confirm", { scopeKey: a.scopeKey, ownerUserHash: account });
  const manage = await mint(db, a),
    unsub = await mint(db, a, "unsubscribe");
  assert.equal(await removeManagedFollow(db, manage, a.scopeKey, now), true);
  assert.equal(await removeManagedFollow(db, manage, a.scopeKey, now), false);
  assert.equal(await confirmFollow(db, pending, now), false);
  assert.deepEqual(
    (await rows(db, "follow_subscriptions")).map((s) => [s.scope_key, s.owner_user_hash]),
    [[b.scopeKey, account]],
  );
  assert.equal((await listManagedFollows(db, manage, now)).length, 1);
  assert.equal(await removeManagedFollow(db, manage, b.scopeKey, now), true);
  for (const table of ["follow_subscribers", "follow_subscriptions", "follow_tokens"])
    assert.deepEqual(await rows(db, table), []);
  assert.equal(await unsubscribeFollows(db, unsub, now), false);
  assert.equal(await deleteManagedFollows(db, manage, now), false);
});

test("deleting linked scopes leaves inbox management authorized only for surviving unlinked scopes", async () => {
  const db = fakeD1(),
    a = await request(db),
    b = await request(db, "example-b");
  await confirm(db, a, account);
  const manage = await mint(db, a);
  await deleteLinkedFollows(db, account);
  assert.deepEqual(
    (await listManagedFollows(db, manage, now)).map((s) => s.scope_key),
    [b.scopeKey],
  );
  assert.equal(await deleteManagedFollows(db, manage, now), true);
  assert.equal(await listManagedFollows(db, manage, now), null);
});

test("explicit delete-all and confirmation race cannot resurrect records or affect a later signup", async () => {
  const db = fakeD1(),
    r = await request(db),
    manage = await mint(db, r);
  const confirmation = await mint(db, r, "confirm", { scopeKey: r.scopeKey });
  await Promise.all([deleteManagedFollows(db, manage, now), confirmFollow(db, confirmation, now)]);
  assert.deepEqual(await rows(db, "follow_subscribers"), []);
  const replacement = await request(db);
  assert.notEqual(replacement.subscriberId, r.subscriberId);
  assert.equal(await deleteManagedFollows(db, manage, now), false);
  assert.equal(await removeManagedFollow(db, manage, replacement.scopeKey, now), false);
  assert.equal(await confirmFollow(db, confirmation, now), false);
});

test("selective deletion rollback preserves the scope and its pending confirmation token", async () => {
  const db = fakeD1(),
    r = await request(db),
    manage = await mint(db, r);
  const confirmation = await mint(db, r, "confirm", { scopeKey: r.scopeKey });
  await db.exec(
    "CREATE TRIGGER reject_follow_removal BEFORE DELETE ON follow_subscriptions BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await assert.rejects(removeManagedFollow(db, manage, r.scopeKey, now), /fixture/);
  assert.equal((await listManagedFollows(db, manage, now)).length, 1);
  assert.equal(await confirmFollow(db, confirmation, now), true);
});

test("concurrent selective removals commit once and leave unrelated scope unchanged", async () => {
  const db = fakeD1(),
    a = await request(db),
    b = await request(db, "example-b"),
    manage = await mint(db, a);
  assert.deepEqual(
    (
      await Promise.all([
        removeManagedFollow(db, manage, a.scopeKey, now),
        removeManagedFollow(db, manage, a.scopeKey, now),
      ])
    ).sort(),
    [false, true],
  );
  assert.deepEqual(
    (await listManagedFollows(db, manage, now)).map((s) => s.scope_key),
    [b.scopeKey],
  );
});
