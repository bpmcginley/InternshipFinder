import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  requestFollow,
  mintFollowToken,
  listManagedFollows,
  removeManagedFollow,
  deleteManagedFollows,
} from "../src/follows.js";

it("local D1 management authorizes selective removal transactionally and expires without mutation", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date("2026-11-11T12:00:00Z"),
    catalog = { companies: new Set(["example-a", "example-b"]) };
  const a = await requestFollow(
    env.DB,
    "reader@example.test",
    { kind: "company", company: "example-a" },
    catalog,
    now,
  );
  const b = await requestFollow(
    env.DB,
    "reader@example.test",
    { kind: "company", company: "example-b" },
    catalog,
    now,
  );
  const manage = await mintFollowToken(env.DB, a.subscriberId, "manage", {}, now);
  expect(
    (
      await Promise.all([
        removeManagedFollow(env.DB, manage, a.scopeKey, now),
        removeManagedFollow(env.DB, manage, a.scopeKey, now),
      ])
    ).sort(),
  ).toEqual([false, true]);
  expect((await listManagedFollows(env.DB, manage, now)).map((s) => s.scope_key)).toEqual([
    b.scopeKey,
  ]);
  expect(await deleteManagedFollows(env.DB, manage, new Date(+now + 30 * 60_000))).toBe(false);
  expect(await deleteManagedFollows(env.DB, manage, now)).toBe(true);
  for (const table of ["follow_subscribers", "follow_subscriptions", "follow_tokens"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(0);
  }
});
