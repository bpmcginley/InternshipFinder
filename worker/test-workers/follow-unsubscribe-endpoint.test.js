import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { handle } from "../src/index.js";
import { confirmFollow, mintFollowToken, requestFollow } from "../src/follows.js";
import { mintFollowRequestDeletion } from "../src/follow-request-deletion.js";
import {
  beginFollowDigestAttempt,
  leaseFollowDigest,
  queueFollowDigest,
} from "../src/follow-outbox.js";

it("actual anonymous HTTP route cascades only the bearer subscriber and preserves send-day markers", async () => {
  const db = env.DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const now = new Date("2026-11-11T12:00:00Z");
  const deps = {
    now: () => now,
    fetch: async () => {
      throw new Error("No provider calls");
    },
  };
  const subscribe = (email, company = "example") =>
    requestFollow(
      db,
      email,
      { kind: "company", company },
      { companies: new Set(["example", "pending"]) },
      now,
    );
  const target = await subscribe("target@example.test");
  const confirm = await mintFollowToken(
    db,
    target.subscriberId,
    "confirm",
    { scopeKey: target.scopeKey },
    now,
  );
  await confirmFollow(db, confirm, now);
  const sibling = await subscribe("other@example.test");
  const pending = await subscribe("target@example.test", "pending");
  const wrong = await mintFollowToken(
    db,
    target.subscriberId,
    "confirm",
    { scopeKey: pending.scopeKey },
    now,
  );
  const requestOnly = await mintFollowRequestDeletion(db, wrong, now);
  const manage = await mintFollowToken(db, target.subscriberId, "manage", {}, now);
  const token = await mintFollowToken(db, target.subscriberId, "unsubscribe", {}, now);
  const id = await queueFollowDigest(
    db,
    target.subscriberId,
    [{ scopeKey: target.scopeKey, roles: ["1".repeat(16)] }],
    now,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(9),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const lease = await leaseFollowDigest(db, id, now);
  expect(await beginFollowDigestAttempt(db, key, id, lease, () => now)).toBe(true);
  const counts = () =>
    Promise.all(
      [
        "follow_subscribers",
        "follow_subscriptions",
        "follow_tokens",
        "follow_request_deletions",
        "follow_digest_outbox",
        "follow_digest_days",
      ].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")),
    );
  const before = await counts();
  expect(before).toEqual([2, 3, 3, 1, 1, 1]);
  const call = (value, method = "POST", multipart = false) => {
    const body = multipart ? new FormData() : new URLSearchParams();
    body.set("List-Unsubscribe", "One-Click");
    return handle(
      new Request(`https://api.example.test/follows/unsubscribe?token=${value}`, {
        method,
        ...(method === "POST" ? { body } : {}),
        headers: {
          Cookie: "session=unrelated",
          Authorization: "Bearer invalid",
          Origin: "https://mail.example.test",
        },
      }),
      { DB: db },
      undefined,
      deps,
    );
  };
  for (const method of ["GET", "HEAD"]) expect((await call(token, method)).status).toBe(404);
  for (const value of [wrong, manage]) expect((await call(value)).status).toBe(204);
  expect((await call(requestOnly)).status).toBe(400);
  expect(await counts()).toEqual(before);
  const response = await call(token, "POST", true);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await counts()).toEqual([1, 1, 0, 0, 0, 1]);
  expect(
    await db
      .prepare("SELECT id FROM follow_subscribers WHERE id=?")
      .bind(sibling.subscriberId)
      .first("id"),
  ).toBe(sibling.subscriberId);
  const resubscribed = await subscribe("target@example.test");
  expect(resubscribed.subscriberId).not.toBe(target.subscriberId);
  expect((await call(token)).status).toBe(204);
  expect(await counts()).toEqual([2, 2, 0, 0, 0, 1]);
});
