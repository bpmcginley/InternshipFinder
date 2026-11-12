import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  confirmFollow,
  expireFollows,
  mintFollowToken,
  requestFollow,
  requestFollowConfirmation,
  unsubscribeFollows,
} from "../src/follows.js";
import { deleteFollowRequest, mintFollowRequestDeletion } from "../src/follow-request-deletion.js";

const DAY = 86400_000;
const start = new Date("2026-11-12T12:00:00.123Z");
const later = (ms) => new Date(+start + ms);
const catalog = { companies: new Set(["one", "two", "three"]) };
const scope = (company) => ({ kind: "company", company });
const address = "request@example.test";
const queue = (company, now = start, email = address) =>
  requestFollowConfirmation(env.DB, email, scope(company), catalog, now);
const job = (id) =>
  env.DB.prepare("SELECT * FROM follow_confirmation_outbox WHERE id=?").bind(id).first();
const mint = ({ subscriberId, scopeKey }, now = start) =>
  mintFollowToken(env.DB, subscriberId, "confirm", { scopeKey }, now);
const count = (table) => env.DB.prepare("SELECT COUNT(*) AS n FROM " + table).first("n");

it("0021 adds an empty queue to populated local D1 and preserves original scope lifetime", async () => {
  const migrations = env.TEST_MIGRATIONS;
  await applyD1Migrations(
    env.DB,
    migrations.filter(({ name }) => name < "0021_follow_confirmation_outbox.sql"),
  );
  const legacy = await requestFollow(env.DB, address, scope("one"), catalog, start);
  expect(Object.keys(legacy).sort()).toEqual(["scopeKey", "subscriberId"]);
  const existing = await mint(legacy);

  await applyD1Migrations(env.DB, migrations);
  expect(await count("follow_confirmation_outbox")).toBe(0);
  expect(await count("follow_subscriptions")).toBe(1);
  expect(await count("follow_tokens")).toBe(1);

  const acceptedAt = later(60_000);
  const [a, b] = await Promise.all([
    queue("one", acceptedAt, " REQUEST@example.test "),
    queue("one", acceptedAt),
  ]);
  expect(a).toEqual(b);
  expect(a).toMatchObject(legacy);
  expect(a.confirmationJobId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await count("follow_confirmation_outbox")).toBe(1);
  expect(await count("follow_tokens")).toBe(1);
  expect(await job(a.confirmationJobId)).toEqual({
    id: a.confirmationJobId,
    subscriber_id: legacy.subscriberId,
    scope_key: legacy.scopeKey,
    queued_at: acceptedAt.toISOString(),
    expires_at: later(7 * DAY).toISOString(),
    claim_id: null,
  });

  // Older in-flight request timestamps cannot present newer queued work as their own.
  expect((await queue("one", later(59_999))).confirmationJobId).toBeNull();
  expect(await confirmFollow(env.DB, existing, acceptedAt)).toBe(true);
  expect(await job(a.confirmationJobId)).toBeNull();
  expect((await queue("one", later(61_000))).confirmationJobId).toBeNull();
});

it("renewal at the seven-day cutoff retires the old job and expires the replacement on time", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const email = "renewal@example.test";
  const first = await queue("one", start, email);
  expect(first.confirmationJobId).toMatch(/^[a-f0-9-]{36}$/);
  const oldToken = await mint(first);
  expect((await queue("one", later(7 * DAY - 1), email)).confirmationJobId).toBe(
    first.confirmationJobId,
  );
  const next = await queue("one", later(7 * DAY), email);
  expect(next.subscriberId).toBe(first.subscriberId);
  expect(next.confirmationJobId).not.toBe(first.confirmationJobId);
  expect(await job(first.confirmationJobId)).toBeNull();
  expect(await confirmFollow(env.DB, oldToken, later(7 * DAY))).toBe(false);
  expect((await job(next.confirmationJobId)).expires_at).toBe(later(14 * DAY).toISOString());

  await expireFollows(env.DB, later(14 * DAY));
  expect(await job(next.confirmationJobId)).toBeNull();
  expect(
    await env.DB.prepare("SELECT id FROM follow_subscribers WHERE id=?")
      .bind(next.subscriberId)
      .first(),
  ).toBeNull();
});

it("scope deletion fences same-millisecond recreation and unsubscribe removes surviving jobs", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const email = "deletion@example.test";
  const first = await queue("one", start, email);
  const pending = await queue("two", start, email);
  const unrelated = await queue("one", start, "other@example.test");
  expect(first.subscriberId).toBe(pending.subscriberId);
  expect(await confirmFollow(env.DB, await mint(first), start)).toBe(true);
  expect(await job(first.confirmationJobId)).toBeNull();
  expect(await job(pending.confirmationJobId)).not.toBeNull();

  const pendingToken = await mint(pending);
  const pendingDeletion = await mintFollowRequestDeletion(env.DB, pendingToken, start);
  expect(await deleteFollowRequest(env.DB, pendingDeletion, start)).toBe(true);
  expect(await job(pending.confirmationJobId)).toBeNull();
  const replacement = await queue("two", start, email);
  expect(replacement.subscriberId).toBe(pending.subscriberId);
  expect(replacement.confirmationJobId).not.toBe(pending.confirmationJobId);
  expect(await deleteFollowRequest(env.DB, pendingDeletion, start)).toBe(false);
  expect(await job(replacement.confirmationJobId)).not.toBeNull();

  const unsubscribe = await mintFollowToken(env.DB, first.subscriberId, "unsubscribe", {}, start);
  expect(await unsubscribeFollows(env.DB, unsubscribe, start)).toBe(true);
  expect(await job(replacement.confirmationJobId)).toBeNull();
  expect(await job(unrelated.confirmationJobId)).not.toBeNull();
});

it("a queue insert fault rolls back subscriber and scope creation in the same batch", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "CREATE TRIGGER fail_confirmation_queue BEFORE INSERT ON follow_confirmation_outbox " +
      "BEGIN SELECT RAISE(ABORT,'fixture confirmation queue failure'); END",
  ).run();
  const tables = [
    "follow_subscribers",
    "follow_subscriptions",
    "follow_confirmation_outbox",
    "follow_tokens",
  ];
  const before = await Promise.all(tables.map(count));
  await expect(queue("one", start, "failure@example.test")).rejects.toThrow(
    /fixture confirmation queue failure/,
  );
  expect(await Promise.all(tables.map(count))).toEqual(before);
});
