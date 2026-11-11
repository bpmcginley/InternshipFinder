import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { queueFollowDigest } from "../src/follow-outbox.js";
import { deleteFollowRequest, mintFollowRequestDeletion } from "../src/follow-request-deletion.js";
import {
  confirmFollow,
  expireFollows,
  mintFollowToken,
  removeManagedFollow,
  requestFollow,
  unsubscribeFollows,
} from "../src/follows.js";

const now = new Date("2026-11-10T12:00:00Z");
const expiry = new Date(+now + 7 * 86_400_000);
const db = env.DB;
const setup = () => applyD1Migrations(db, env.TEST_MIGRATIONS);
const request = (email, company = "example") =>
  requestFollow(
    db,
    email,
    { kind: "company", company },
    {
      companies: new Set(["example", "sample"]),
    },
    now,
  );
const confirmToken = ({ subscriberId, scopeKey }, ownerUserHash = null) =>
  mintFollowToken(db, subscriberId, "confirm", { scopeKey, ownerUserHash }, now);
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");
const scope = ({ subscriberId, scopeKey }) =>
  db
    .prepare(
      "SELECT confirmed_at, owner_user_hash FROM follow_subscriptions WHERE subscriber_id=? AND scope_key=?",
    )
    .bind(subscriberId, scopeKey)
    .first();

it("scoped delete links are hashed, expire with the confirmation, and cascade on reissue or unsubscribe", async () => {
  await setup();
  const follow = await request("pending@example.test");
  const first = await confirmToken(follow);
  const stale = await mintFollowRequestDeletion(db, first, now);
  expect(stale).toMatch(/^fd_[a-f0-9-]{36}\.[a-f0-9]{64}$/);
  expect(await mintFollowRequestDeletion(db, first, now)).toBeNull();
  const stored = await db.prepare("SELECT * FROM follow_request_deletions").first();
  expect(Object.keys(stored).sort()).toEqual(["confirm_hash", "token_hash"]);
  expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(stored.confirm_hash).toMatch(/^[a-f0-9]{64}$/);

  const current = await confirmToken(follow);
  expect(await count("follow_request_deletions")).toBe(0);
  expect(await deleteFollowRequest(db, stale, now)).toBe(false);
  expect(await mintFollowRequestDeletion(db, first, now)).toBeNull();
  const live = await mintFollowRequestDeletion(db, current, now);
  expect(await mintFollowRequestDeletion(db, current, expiry)).toBeNull();
  expect(await deleteFollowRequest(db, live, expiry)).toBe(false);
  expect(await scope(follow)).not.toBeNull();
  await expireFollows(db, expiry);
  expect(await count("follow_request_deletions")).toBe(0);
  expect(await count("follow_subscribers")).toBe(0);

  const another = await request("other@example.test");
  const unsubscribe = await mintFollowToken(db, another.subscriberId, "unsubscribe", {}, now);
  expect(await mintFollowRequestDeletion(db, unsubscribe, now)).toBeNull();
  const pending = await confirmToken(another);
  const deleteLink = await mintFollowRequestDeletion(db, pending, now);
  expect(await unsubscribeFollows(db, unsubscribe, now)).toBe(true);
  expect(await count("follow_request_deletions")).toBe(0);
  expect(await deleteFollowRequest(db, deleteLink, now)).toBe(false);
});

it("confirmation and scoped deletion have exactly one winner in D1", async () => {
  await setup();
  for (const [index, order] of ["confirm", "delete", "race"].entries()) {
    const follow = await request(`pending${index}@example.test`);
    const confirmation = await confirmToken(follow);
    const deletion = await mintFollowRequestDeletion(db, confirmation, now);
    const confirm = () => confirmFollow(db, confirmation, now);
    const remove = () => deleteFollowRequest(db, deletion, now);
    let confirmed, removed;
    if (order === "confirm") [confirmed, removed] = [await confirm(), await remove()];
    else if (order === "delete") [removed, confirmed] = [await remove(), await confirm()];
    else [confirmed, removed] = await Promise.all([confirm(), remove()]);
    expect([confirmed, removed].sort()).toEqual([false, true]);
    expect(await scope(follow)).toEqual(
      confirmed ? { confirmed_at: now.toISOString(), owner_user_hash: null } : null,
    );
    const subscriber = await db
      .prepare("SELECT id FROM follow_subscribers WHERE id=?")
      .bind(follow.subscriberId)
      .first();
    expect(Boolean(subscriber)).toBe(confirmed);
    expect(await remove()).toBe(false);
    expect(await count("follow_request_deletions")).toBe(0);
  }
});

it("scoped deletion leaves a different pending confirmation for the same address usable", async () => {
  await setup();
  const email = "two-pending@example.test";
  const first = await request(email);
  const second = await request(email, "sample");
  const target = await confirmToken(first);
  const sibling = await confirmToken(second);
  const deletion = await mintFollowRequestDeletion(db, target, now);
  expect(await deleteFollowRequest(db, deletion, now)).toBe(true);
  expect(await scope(first)).toBeNull();
  expect(await confirmFollow(db, sibling, now)).toBe(true);
  expect(await scope(second)).toEqual({ confirmed_at: now.toISOString(), owner_user_hash: null });
});

it("pending sibling removal and pending linkage rollback preserve active scope and digest", async () => {
  await setup();
  const email = "active@example.test";
  const active = await request(email);
  expect(await confirmFollow(db, await confirmToken(active), now)).toBe(true);
  const job = await queueFollowDigest(
    db,
    active.subscriberId,
    [{ scopeKey: active.scopeKey, roles: ["a".repeat(16)] }],
    now,
  );
  const digest = () =>
    db.prepare("SELECT state, payload FROM follow_digest_outbox WHERE id=?").bind(job).first();
  const queued = await digest();
  expect(queued.state).toBe("queued");

  const pending = await request(email, "sample");
  const pendingConfirmation = await confirmToken(pending);
  expect(
    await deleteFollowRequest(
      db,
      await mintFollowRequestDeletion(db, pendingConfirmation, now),
      now,
    ),
  ).toBe(true);
  expect(await scope(pending)).toBeNull();
  expect(await digest()).toEqual(queued);

  const linkConfirmation = await confirmToken(active, "b".repeat(64));
  expect(
    await deleteFollowRequest(db, await mintFollowRequestDeletion(db, linkConfirmation, now), now),
  ).toBe(true);
  expect(await confirmFollow(db, linkConfirmation, now)).toBe(false);
  expect(await scope(active)).toEqual({ confirmed_at: now.toISOString(), owner_user_hash: null });
  expect(await digest()).toEqual(queued);

  // Keep a second scope so management deletion leaves the outbox row for inspection.
  await request(email, "sample");
  const manage = await mintFollowToken(db, active.subscriberId, "manage", {}, now);
  expect(await removeManagedFollow(db, manage, active.scopeKey, now)).toBe(true);
  expect(await digest()).toEqual({ state: "cancelled", payload: null });
});
