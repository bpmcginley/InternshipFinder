import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  requestFollow,
  mintFollowToken,
  confirmFollow,
  unsubscribeFollows,
  expireFollows,
} from "../src/follows.js";

it("local D1 commits confirmation once and cascades all follow data on unsubscribe", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date("2026-11-10T12:00:00Z");
  const catalog = { companies: new Set(["example-labs"]) };
  const r = await requestFollow(
    env.DB,
    "reader@example.test",
    { kind: "company", company: "example-labs" },
    catalog,
    now,
  );
  const token = await mintFollowToken(
    env.DB,
    r.subscriberId,
    "confirm",
    { scopeKey: r.scopeKey, ownerUserHash: "a".repeat(64) },
    now,
  );
  expect(
    (
      await Promise.all([confirmFollow(env.DB, token, now), confirmFollow(env.DB, token, now)])
    ).sort(),
  ).toEqual([false, true]);
  expect(
    await env.DB.prepare("SELECT owner_user_hash FROM follow_subscribers WHERE id=?")
      .bind(r.subscriberId)
      .first("owner_user_hash"),
  ).toBe("a".repeat(64));
  const unsub = await mintFollowToken(env.DB, r.subscriberId, "unsubscribe", {}, now);
  expect(await unsubscribeFollows(env.DB, unsub, now)).toBe(true);
  for (const table of ["follow_subscribers", "follow_subscriptions", "follow_tokens"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(0);
  }
  await requestFollow(
    env.DB,
    "pending@example.test",
    { kind: "company", company: "example-labs" },
    catalog,
    now,
  );
  await expireFollows(env.DB, new Date(+now + 7 * 86400_000));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM follow_subscribers").first("n")).toBe(0);
});
