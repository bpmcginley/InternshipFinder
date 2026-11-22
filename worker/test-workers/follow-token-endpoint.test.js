import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { handle } from "../src/index.js";
import { mintFollowToken, requestFollow } from "../src/follows.js";
import { mintFollowRequestDeletion } from "../src/follow-request-deletion.js";

const issued = new Date("2026-11-12T12:00:00Z");
const actionTime = new Date("2026-11-12T12:01:00Z");
const catalog = { companies: new Set(["one", "two", "three"]) };
const subscribe = (email, company, at = issued) =>
  requestFollow(env.DB, email, { kind: "company", company }, catalog, at);
const confirmToken = ({ subscriberId, scopeKey }, at = issued) =>
  mintFollowToken(env.DB, subscriberId, "confirm", { scopeKey }, at);
const scope = ({ subscriberId, scopeKey }) =>
  env.DB.prepare(
    "SELECT confirmed_at FROM follow_subscriptions WHERE subscriber_id=? AND scope_key=?",
  )
    .bind(subscriberId, scopeKey)
    .first();
const call = (path, token, method = "POST", at = actionTime, clock = () => at) =>
  handle(
    new Request("https://api.example.test/follows/" + path, {
      method,
      ...(method === "POST" ? { body: token } : {}),
      headers: { Cookie: "session=unrelated", Authorization: "Bearer unrelated" },
    }),
    { DB: env.DB },
    undefined,
    {
      now: clock,
      fetch: () => {
        throw new Error("Unexpected fetch");
      },
    },
  );

it("confirmation POST consumes only its exact purpose and scope, once", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const first = await subscribe("confirm@example.test", "one");
  const second = await subscribe("confirm@example.test", "two");
  const token = await confirmToken(first);
  const other = await confirmToken(second);
  const manage = await mintFollowToken(env.DB, first.subscriberId, "manage", {}, issued);
  const requestDelete = await mintFollowRequestDeletion(env.DB, token, issued);
  for (const method of ["GET", "HEAD"]) {
    expect((await call("confirm", token, method)).status).toBe(404);
    expect((await call("delete-request", requestDelete, method)).status).toBe(404);
  }
  expect((await call("confirm", manage)).status).toBe(410);
  expect((await call("confirm", requestDelete)).status).toBe(400);
  expect((await scope(first)).confirmed_at).toBeNull();
  const responses = await Promise.all([call("confirm", token), call("confirm", token)]);
  expect(responses.map((r) => r.status).sort()).toEqual([204, 410]);
  for (const response of responses) {
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect((await scope(first)).confirmed_at).toBe(actionTime.toISOString());
  expect((await scope(second)).confirmed_at).toBeNull();
  const progress = await env.DB.prepare(
    "SELECT watermark FROM follow_scope_progress WHERE subscriber_id=? AND scope_key=?",
  )
    .bind(first.subscriberId, first.scopeKey)
    .first("watermark");
  expect(progress).toBe(actionTime.toISOString());
  expect((await call("delete-request", requestDelete)).status).toBe(204);
  expect((await scope(first)).confirmed_at).toBe(actionTime.toISOString());
  expect((await call("confirm", other)).status).toBe(204);
});

it("pending request deletion preserves other follows and cannot activate the request", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const first = await subscribe("delete@example.test", "one");
  const pending = await subscribe("delete@example.test", "two");
  const unrelated = await subscribe("unrelated@example.test", "one");
  expect((await call("confirm", await confirmToken(first))).status).toBe(204);
  const pendingConfirm = await confirmToken(pending);
  const pendingDelete = await mintFollowRequestDeletion(env.DB, pendingConfirm, issued);
  expect((await call("delete-request", pendingConfirm)).status).toBe(400);
  expect((await call("delete-request", pendingDelete)).status).toBe(204);
  expect((await call("delete-request", pendingDelete)).status).toBe(204);
  expect((await call("confirm", pendingConfirm)).status).toBe(410);
  expect((await scope(first)).confirmed_at).toBe(actionTime.toISOString());
  expect(await scope(pending)).toBeNull();
  expect((await scope(unrelated)).confirmed_at).toBeNull();
});

it("uses a fresh action time for an expiring credential after body admission", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const pending = await subscribe("expired@example.test", "three");
  const token = await confirmToken(pending);
  const expiry = new Date("2026-11-19T12:00:00Z");
  let reads = 0;
  const clock = () => (reads++ ? expiry : new Date(expiry.getTime() - 1));
  expect((await call("confirm", token, "POST", expiry, clock)).status).toBe(410);
  expect(reads).toBe(2);
  expect((await scope(pending)).confirmed_at).toBeNull();
});
