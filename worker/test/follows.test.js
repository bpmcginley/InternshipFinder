import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1 } from "./helpers.js";
import {
  canonicalFollow,
  requestFollow,
  mintFollowToken,
  inspectFollowToken,
  confirmFollow,
  unsubscribeFollows,
  deleteLinkedFollows,
  expireFollows,
} from "../src/follows.js";

const now = new Date("2026-11-10T12:00:00Z"),
  later = (ms) => new Date(+now + ms);
const catalog = {
  companies: new Set(["example-labs"]),
  fields: new Set(["engineering", "biology"]),
  states: new Set(["MA", "ON", "REMOTE"]),
};
const company = { kind: "company", company: "example-labs" };
const search = {
  kind: "search",
  fields: ["biology", "engineering", "biology"],
  states: ["ON", "MA"],
};
const address = "reader@example.test",
  account = "a".repeat(64);
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const request = (db, follow = company, email = address) =>
  requestFollow(db, email, follow, catalog, now);
const mint = (db, r, purpose = "confirm", ownerUserHash = null, time = now) =>
  mintFollowToken(
    db,
    r.subscriberId,
    purpose,
    purpose === "confirm" ? { scopeKey: r.scopeKey, ownerUserHash } : {},
    time,
  );

test("canonical public scope rejects unsupported filters, unknown keys, free text and empty searches", async () => {
  assert.equal(
    canonicalFollow(search, catalog),
    JSON.stringify({ kind: "search", fields: ["biology", "engineering"], states: ["MA", "ON"] }),
  );
  for (const bad of [
    { ...company, company: "unknown" },
    { ...company, email: address },
    { ...search, query: "personal text" },
    { ...search, states: ["REMOTE"] },
    { ...search, fields: ["unknown"] },
    { ...search, fields: [], states: [] },
    { ...search, states: [42] },
  ]) {
    assert.throws(() => canonicalFollow(bad, catalog), /Invalid follow/);
  }
  const db = fakeD1();
  for (const email of ["not-email", "bad\nheader@example.test", "Name <reader@example.test>"])
    await assert.rejects(request(db, company, email));
  assert.deepEqual(await rows(db, "follow_subscribers"), []);
});

test("pending scopes deduplicate by normalized address, stay private, and require explicit confirmation", async () => {
  const db = fakeD1(),
    a = await request(db, company, " Reader@EXAMPLE.test ");
  assert.deepEqual(await request(db), a);
  const b = await request(db, search),
    raw = await mint(db, a, "confirm", account);
  assert.equal(b.subscriberId, a.subscriberId);
  assert.equal((await rows(db, "follow_subscriptions")).length, 2);
  const tokens = await rows(db, "follow_tokens");
  assert.match(tokens[0].token_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(tokens).includes(raw));
  await inspectFollowToken(db, raw, "confirm", now); // GET/prefetch does not consent.
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, null);
  assert.ok((await rows(db, "follow_subscriptions")).every((s) => s.confirmed_at === null));
  assert.equal(await unsubscribeFollows(db, raw, now), false);
  assert.equal(await confirmFollow(db, raw, now), true);
  assert.equal(await confirmFollow(db, raw, now), false);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, account);
  assert.equal((await rows(db, "follow_subscriptions")).filter((s) => s.confirmed_at).length, 1);
});

test("reissued confirmation invalidates prior generation; concurrent confirmations consume once", async () => {
  const db = fakeD1(),
    r = await request(db),
    old = await mint(db, r),
    fresh = await mint(db, r);
  assert.notEqual(old.split(".")[0], fresh.split(".")[0]);
  assert.equal(await confirmFollow(db, old, now), false);
  assert.deepEqual(
    (await Promise.all([confirmFollow(db, fresh, now), confirmFollow(db, fresh, now)])).sort(),
    [false, true],
  );
  assert.equal((await rows(db, "follow_subscriptions"))[0].confirmed_at, now.toISOString());
});

test("linkage needs inbox confirmation and cannot replace an existing linked account", async () => {
  const db = fakeD1(),
    r = await request(db);
  await confirmFollow(db, await mint(db, r), now);
  await deleteLinkedFollows(db, account);
  assert.equal((await rows(db, "follow_subscribers")).length, 1);
  await confirmFollow(db, await mint(db, r, "confirm", account), now);
  assert.equal(await confirmFollow(db, await mint(db, r, "confirm", "b".repeat(64)), now), false);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, account);
  await deleteLinkedFollows(db, "b".repeat(64));
  assert.equal((await rows(db, "follow_subscribers")).length, 1);
  await deleteLinkedFollows(db, account);
  for (const table of ["follow_subscribers", "follow_subscriptions", "follow_tokens"])
    assert.deepEqual(await rows(db, table), []);
});

test("unsubscribe is deletion-only and old links survive reissue until deletion", async () => {
  const db = fakeD1(),
    r = await request(db),
    pendingUnsub = await mint(db, r, "unsubscribe");
  await confirmFollow(db, await mint(db, r), now);
  await mint(db, r, "unsubscribe");
  assert.equal(await inspectFollowToken(db, pendingUnsub, "confirm", now), null);
  assert.equal(await confirmFollow(db, pendingUnsub, now), false);
  assert.equal(await unsubscribeFollows(db, pendingUnsub, later(100 * 86400_000)), true);
  assert.equal(await unsubscribeFollows(db, pendingUnsub, now), false);
  for (const table of ["follow_subscribers", "follow_subscriptions", "follow_tokens"])
    assert.deepEqual(await rows(db, table), []);
});

test("pending scopes expire at seven days even after late token mint; confirmed siblings survive", async () => {
  const db = fakeD1(),
    a = await request(db),
    b = await request(db, search);
  await confirmFollow(db, await mint(db, a), now);
  const raw = await mint(db, b, "confirm", null, later(6 * 86400_000));
  await request(db, company, "pending@example.test");
  assert.equal(await inspectFollowToken(db, raw, "confirm", later(7 * 86400_000)), null);
  assert.equal(await confirmFollow(db, raw, later(7 * 86400_000)), false);
  await expireFollows(db, later(7 * 86400_000));
  assert.equal((await rows(db, "follow_subscribers")).length, 1);
  assert.deepEqual(
    (await rows(db, "follow_subscriptions")).map((s) => s.scope_key),
    [a.scopeKey],
  );
  assert.deepEqual(await rows(db, "follow_tokens"), []);
});

test("delete racing confirmation never resurrects a subscriber; new signup has a new identity", async () => {
  const db = fakeD1(),
    r = await request(db),
    confirm = await mint(db, r),
    unsub = await mint(db, r, "unsubscribe");
  await Promise.all([unsubscribeFollows(db, unsub, now), confirmFollow(db, confirm, now)]);
  assert.deepEqual(await rows(db, "follow_subscribers"), []);
  const again = await request(db);
  assert.notEqual(again.subscriberId, r.subscriberId);
  assert.equal(await confirmFollow(db, confirm, now), false);
  assert.equal(await unsubscribeFollows(db, unsub, now), false);
});

test("a failed confirmation batch rolls back linkage and token consumption", async () => {
  const db = fakeD1(),
    r = await request(db),
    raw = await mint(db, r, "confirm", account);
  await db.exec(
    "CREATE TRIGGER reject_follow_confirmation BEFORE UPDATE ON follow_subscriptions BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await assert.rejects(confirmFollow(db, raw, now), /fixture/);
  const subscriber = (await rows(db, "follow_subscribers"))[0];
  assert.equal(subscriber.confirmed_at, null);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, null);
  assert.ok(await inspectFollowToken(db, raw, "confirm", now));
  await db.exec("DROP TRIGGER reject_follow_confirmation");
  assert.equal(await confirmFollow(db, raw, now), true);
});

test("explicit renewal replaces an expired pending request without reviving tokens or confirmed scopes", async () => {
  const db = fakeD1(),
    r = await request(db),
    raw = await mint(db, r);
  const renewal = later(7 * 86400_000);
  assert.deepEqual(await requestFollow(db, address, company, catalog, renewal), r);
  assert.equal((await rows(db, "follow_subscriptions"))[0].created, renewal.toISOString());
  assert.equal(await confirmFollow(db, raw, renewal), false);
  await confirmFollow(db, await mint(db, r, "confirm", null, renewal), renewal);
  await requestFollow(db, address, company, catalog, later(20 * 86400_000));
  const scope = (await rows(db, "follow_subscriptions"))[0];
  assert.equal(scope.created, renewal.toISOString());
  assert.equal(scope.confirmed_at, renewal.toISOString());
});

test("request returns its transaction's subscriber, never a concurrent replacement", async () => {
  const db = fakeD1(),
    original = db.batch.bind(db);
  const shape = await db.batch([db.prepare("SELECT 42 AS sample")]);
  assert.deepEqual(shape[0].results, [{ sample: 42 }]);
  assert.equal(shape[0].meta.changes, 0);
  let replace = true,
    replacement;
  db.batch = async (statements) => {
    const result = await original(statements);
    if (replace) {
      replace = false;
      await db.prepare("DELETE FROM follow_subscribers").run();
      replacement = await request(db);
    }
    return result;
  };
  const requested = await request(db);
  assert.notEqual(requested.subscriberId, replacement.subscriberId);
  assert.equal(await mint(db, requested), null);
  assert.equal((await rows(db, "follow_subscribers"))[0].id, replacement.subscriberId);
});

test("scoped linkage leaves older unlinked follows intact and account deletion invalidates pending linkage", async () => {
  const db = fakeD1(),
    unlinked = await request(db),
    linked = await request(db, search);
  await confirmFollow(db, await mint(db, unlinked), now);
  await confirmFollow(db, await mint(db, linked, "confirm", account), now);
  const pendingLink = await mint(db, unlinked, "confirm", account),
    unsub = await mint(db, unlinked, "unsubscribe");
  await deleteLinkedFollows(db, account);
  assert.deepEqual(
    (await rows(db, "follow_subscriptions")).map((s) => [s.scope_key, s.owner_user_hash]),
    [[unlinked.scopeKey, null]],
  );
  assert.equal(await confirmFollow(db, pendingLink, now), false);
  assert.ok(await inspectFollowToken(db, unsub, "unsubscribe", now));
  assert.equal(await unsubscribeFollows(db, unsub, now), true);
  assert.deepEqual(await rows(db, "follow_tokens"), []);
});

test("lifecycle stays disconnected from router, cron and transport; additive SQL matches legacy path", () => {
  const source = readFileSync(new URL("../src/follows.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|sendMail|trySend|console\./);
  assert.doesNotMatch(
    readFileSync(new URL("../src/index.js", import.meta.url), "utf8"),
    /["']\.\/follows\.js["']/,
  );
  const migration = readFileSync(
    new URL("../migrations/0002_follow_lifecycle.sql", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  assert.ok(
    readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
      .replaceAll("\r\n", "\n")
      .includes(migration),
  );
});
