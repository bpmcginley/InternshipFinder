import assert from "node:assert/strict";
import { topupCheckoutResponse } from "../src/topup-checkout-http.js";
import { createSession, endSession } from "../src/session.js";
import { prepareTopupStripe } from "../src/topup-stripe.js";
import { HttpError } from "../src/http.js";
import { attempt, callbacks, env, price, reply, session } from "./topup-stripe.js";
const user = "a".repeat(64),
  at = new Date("2026-11-11T12:00:00Z");
const req = (token, options = {}) =>
  new Request("https://local.invalid/unused?user=untrusted", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...options,
  });
async function expect(response, code, body) {
  assert.equal(response.status, code);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), body);
}
async function fixture(db, { onRead = async () => {}, fail = false } = {}) {
  const login = await createSession(db, { user, tier: "edu", provider: "google" }, at);
  let posts = 0,
    gets = 0,
    current;
  const adapter = await prepareTopupStripe(env, callbacks, async (url, options) => {
    if (url.includes("/prices/")) return reply(price());
    if (options.method === "POST") {
      posts++;
      if (fail) throw new Error("Synthetic private provider detail");
      current = session({
        ...attempt(),
        id: new URLSearchParams(options.body).get("metadata[attempt_id]"),
      });
    } else {
      gets++;
      await onRead(login.token);
    }
    return reply(current);
  });
  return {
    token: login.token,
    calls: () => ({ posts, gets }),
    run: (request = req(login.token), overrides = {}) =>
      topupCheckoutResponse({
        request,
        db,
        adapter,
        clock: () => new Date(at),
        ...overrides,
      }),
  };
}
export async function methodAndHeaderOnly(db) {
  const f = await fixture(db);
  const nonPost = await f.run(req(f.token, { method: "GET" }));
  assert.equal(nonPost.headers.get("Allow"), "POST");
  await expect(nonPost, 405, { status: "unavailable" });
  for (const request of [
    req(null),
    req("synthetic.oidc.token"),
    req("iss_invalid"),
    req(null, { headers: { Cookie: `session=${f.token}` } }),
    new Request(`https://local.invalid/?token=${f.token}`, { method: "POST" }),
  ])
    await expect(await f.run(request), 401, { status: "auth" });
  assert.deepEqual(f.calls(), { posts: 0, gets: 0 });
}
export async function actualSessionAndReplay(db) {
  const f = await fixture(db);
  const request = req(f.token, {
    body: JSON.stringify({
      user: "b".repeat(64),
      amount: 1,
      units: 999,
      url: "https://invalid.example",
      adapter: { enabled: true },
    }),
  });
  await expect(await f.run(request), 200, { status: "open", url: session().url });
  assert.equal(request.bodyUsed, false, "untrusted payload is neither read nor forwarded");
  await expect(await f.run(), 200, { status: "open", url: session().url });
  assert.deepEqual(f.calls(), { posts: 1, gets: 2 });
  const row = await db
    .prepare("SELECT user_hash, amount, units FROM topup_checkout_attempts")
    .first();
  assert.equal(row.user_hash, user);
  assert.equal(row.amount, attempt().amount);
  assert.equal(row.units, attempt().units);
}
export async function ambiguityAndDisabled(db) {
  const f = await fixture(db, { fail: true });
  await expect(await f.run(undefined, { adapter: {} }), 503, { status: "disabled" });
  await expect(await f.run(), 202, { status: "pending" });
  await expect(await f.run(), 202, { status: "pending" });
  assert.deepEqual(f.calls(), { posts: 1, gets: 0 });
}
export async function revokedDuringRead(db) {
  const f = await fixture(db, { onRead: (token) => endSession(db, token) });
  await expect(await f.run(), 503, { status: "unavailable" });
  await expect(await f.run(), 401, { status: "auth" });
  assert.deepEqual(f.calls(), { posts: 1, gets: 1 });
}
export async function expiredSession(db) {
  const f = await fixture(db);
  await db.prepare("UPDATE sessions SET expires=?").bind(at.toISOString()).run();
  await expect(await f.run(), 401, { status: "auth" });
  assert.deepEqual(f.calls(), { posts: 0, gets: 0 });
}
export async function outputProjection(db) {
  const f = await fixture(db);
  for (const [status, code] of [
    ["auth", 401],
    ["pending", 202],
    ["disabled", 503],
    ["unknown", 503],
  ]) {
    await expect(
      await f.run(undefined, {
        checkout: async () => ({ status, token: f.token, attempt: "private", error: "private" }),
      }),
      code,
      { status: status === "unknown" ? "unavailable" : status },
    );
  }
  for (const url of [
    "https://invalid.example/c/pay/cs_fixture",
    "https://checkout.stripe.com/wrong",
    "https://user@checkout.stripe.com/c/pay/cs_fixture",
    "https://checkout.stripe.com/c/pay/cs_fixture\\bad",
    "not a URL",
  ])
    await expect(await f.run(undefined, { checkout: async () => ({ status: "open", url }) }), 503, {
      status: "unavailable",
    });
  await expect(
    await f.run(undefined, {
      checkout: async () => ({ status: "open", url: session().url, token: f.token }),
    }),
    200,
    { status: "open", url: session().url },
  );
  assert.deepEqual(f.calls(), { posts: 0, gets: 0 });
}
export async function errorsAndClock(db) {
  const f = await fixture(db);
  for (const error of [new Error("private SQL"), new HttpError(500, "private", "private")])
    await expect(
      await f.run(undefined, {
        authenticate: async () => {
          throw error;
        },
      }),
      503,
      { status: "unavailable" },
    );
  await expect(
    await f.run(undefined, {
      authenticate: async () => {
        throw new HttpError(401, "private", "private");
      },
    }),
    401,
    { status: "auth" },
  );
  let now = +at;
  await expect(
    await f.run(undefined, {
      clock: () => new Date(now),
      authenticate: async () => {
        now++;
        return { user, expires: new Date(now).toISOString() };
      },
    }),
    401,
    { status: "auth" },
  );
  await expect(
    await f.run(undefined, {
      clock: () => new Date(now),
      authenticate: async () => {
        now--;
        return { user, expires: new Date(+at + 1000).toISOString() };
      },
    }),
    503,
    { status: "unavailable" },
  );
  await expect(await f.run(undefined, { clock: () => new Date(NaN) }), 503, {
    status: "unavailable",
  });
  assert.deepEqual(f.calls(), { posts: 0, gets: 0 });
}

export async function delayedPriorDayAuthentication(db) {
  const f = await fixture(db);
  const previous = new Date(+at - 86400000).toISOString();
  const expires = new Date(+at + 1000).toISOString();
  await db.prepare("UPDATE sessions SET last_used=?,expires=?").bind(previous, expires).run();
  let now = +at;
  const delayed = {
    batch: (statements) => db.batch(statements),
    prepare(sql) {
      const statement = db.prepare(sql);
      if (sql !== "SELECT user_hash, tier, provider, last_used, expires FROM sessions WHERE id = ?")
        return statement;
      return {
        bind: (...args) => ({
          async first() {
            const row = await statement.bind(...args).first();
            now = Date.parse(expires) + 1;
            return row;
          },
        }),
      };
    },
  };
  const response = await f.run(undefined, { db: delayed, clock: () => new Date(now) });
  assert.deepEqual(
    await db.prepare("SELECT last_used,expires FROM sessions").first(),
    { last_used: previous, expires },
    "checkout authentication must not extend the original session",
  );
  await expect(response, 401, { status: "auth" });
  assert.deepEqual(f.calls(), { posts: 0, gets: 0 });
  assert.equal((await db.prepare("SELECT count(*) n FROM topup_checkout_attempts").first()).n, 0);
}
