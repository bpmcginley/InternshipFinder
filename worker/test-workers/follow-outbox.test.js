import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  requestFollow,
  mintFollowToken,
  confirmFollow,
  unsubscribeFollows,
} from "../src/follows.js";
import {
  queueFollowDigest,
  leaseFollowDigest,
  beginFollowDigestAttempt as beginWithClock,
  expireFollowOutbox,
} from "../src/follow-outbox.js";

const beginFollowDigestAttempt = (db, key, id, lease, now) =>
  beginWithClock(db, key, id, lease, () => now);

it("local D1 atomically claims actual-day HMAC once, retaining it after subscriber cascade", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date("2026-11-11T23:59:00Z"),
    catalog = { companies: new Set(["example"]) };
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(9),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const r = await requestFollow(
    env.DB,
    "reader@example.test",
    { kind: "company", company: "example" },
    catalog,
    now,
  );
  await confirmFollow(
    env.DB,
    await mintFollowToken(env.DB, r.subscriberId, "confirm", { scopeKey: r.scopeKey }, now),
    now,
  );
  const job = await queueFollowDigest(
    env.DB,
    r.subscriberId,
    [{ scopeKey: r.scopeKey, roles: ["1".repeat(16)] }],
    now,
  );
  const lease = await leaseFollowDigest(env.DB, job, now);
  expect(
    (
      await Promise.all([
        beginFollowDigestAttempt(env.DB, key, job, lease, now),
        beginFollowDigestAttempt(env.DB, key, job, lease, now),
      ])
    ).sort(),
  ).toEqual([false, true]);
  await unsubscribeFollows(
    env.DB,
    await mintFollowToken(env.DB, r.subscriberId, "unsubscribe", {}, now),
    now,
  );
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM follow_digest_outbox").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM follow_digest_days").first("n")).toBe(1);
  await expireFollowOutbox(env.DB, new Date("2026-11-12T00:00:00Z"));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM follow_digest_days").first("n")).toBe(0);
});
