import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { handleFollowUnsubscribe } from "../src/follow-unsubscribe.js";
import { confirmFollow, mintFollowToken, requestFollow } from "../src/follows.js";
import {
  beginFollowDigestAttempt,
  leaseFollowDigest,
  queueFollowDigest,
} from "../src/follow-outbox.js";

const URL = "https://site.example.test/unsubscribe";
const NOW = new Date("2026-11-11T12:00:00Z");
const form = (multipart) => {
  const body = multipart ? new FormData() : new URLSearchParams();
  body.append("List-Unsubscribe", "One-Click");
  return new Request(URL, { method: "POST", body });
};

it("anonymous one-click POST cascades in D1 while retaining an earlier digest-day marker", async () => {
  const db = env.DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const email = "reader@example.test";
  const subscribe = (company = "example") =>
    requestFollow(
      db,
      email,
      { kind: "company", company },
      {
        companies: new Set(["example", "sample"]),
      },
      NOW,
    );
  const { subscriberId, scopeKey } = await subscribe();
  const confirmation = await mintFollowToken(db, subscriberId, "confirm", { scopeKey }, NOW);
  await confirmFollow(db, confirmation, NOW);
  const pending = await subscribe("sample");
  const wrongPurpose = await mintFollowToken(
    db,
    subscriberId,
    "confirm",
    {
      scopeKey: pending.scopeKey,
    },
    NOW,
  );
  const token = await mintFollowToken(db, subscriberId, "unsubscribe", {}, NOW);

  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(9),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const refs = [{ scopeKey, roles: ["1".repeat(16)] }];
  const attempted = await queueFollowDigest(db, subscriberId, refs, NOW);
  const nextDay = new Date("2026-11-12T12:00:00Z");
  // Yesterday's queued job takes today's still-active marker before today's job queues.
  const lease = await leaseFollowDigest(db, attempted, nextDay);
  expect(await beginFollowDigestAttempt(db, key, attempted, lease, () => nextDay)).toBe(true);
  const queued = await queueFollowDigest(db, subscriberId, refs, nextDay);
  expect(queued).toBeTruthy();

  const counts = async () =>
    Promise.all(
      [
        "follow_subscribers",
        "follow_subscriptions",
        "follow_tokens",
        "follow_digest_outbox",
        "follow_digest_days",
      ].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")),
    );
  const before = await counts();
  expect(before).toEqual([1, 2, 2, 2, 1]);
  for (const method of ["GET", "HEAD"]) {
    expect(
      (await handleFollowUnsubscribe(new Request(URL, { method }), db, token, nextDay)).status,
    ).toBe(405);
  }
  const file = new FormData();
  file.append("List-Unsubscribe", new Blob(["One-Click"]), "part.txt");
  expect(
    (
      await handleFollowUnsubscribe(
        new Request(URL, { method: "POST", body: file }),
        db,
        token,
        nextDay,
      )
    ).status,
  ).toBe(400);
  const wrong = await handleFollowUnsubscribe(form(false), db, wrongPurpose, nextDay);
  expect(await counts()).toEqual(before);
  const result = await handleFollowUnsubscribe(form(true), db, token, nextDay);
  expect(await counts()).toEqual([0, 0, 0, 0, 1]);
  const resubscribed = await subscribe();
  const replay = await handleFollowUnsubscribe(form(false), db, token, nextDay);
  expect(await counts()).toEqual([1, 1, 0, 0, 1]);
  const fresh = await mintFollowToken(db, resubscribed.subscriberId, "unsubscribe", {}, nextDay);
  const urlEncoded = await handleFollowUnsubscribe(form(false), db, fresh, nextDay);
  expect(await counts()).toEqual([0, 0, 0, 0, 1]);
  for (const response of [wrong, result, replay, urlEncoded]) {
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(Object.fromEntries(response.headers)).toEqual({ "cache-control": "no-store" });
  }
});
