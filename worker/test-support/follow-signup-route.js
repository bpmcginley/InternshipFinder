import assert from "node:assert/strict";
import { createFollowSignupRoute } from "../src/follow-signup-route.js";
import { createSession, sessionTokenHash } from "../src/session.js";

const origin = "https://example.test";
const catalog = {
  signup: {
    companies: new Set(["fixture"]),
    fields: new Set(["biology"]),
    states: new Set(["MA"]),
  },
  valid: { companies: new Set(["retired"]) },
};
const input = (link = false) => ({
  email: "reader@example.test",
  scope: { kind: "company", company: "fixture" },
  link,
});
const post = (body = input(), headers = {}) =>
  new Request("https://api.example.test/follows/request", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const options = (more = {}) => ({
  enabled: true,
  dailyLimit: 10,
  originAllowed: (r) => r.headers.get("Origin") === origin,
  loadCatalog: async () => ({ status: "available", catalog }),
  ...more,
});
const count = async (db, table) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
async function response(value, status) {
  assert.equal(value.status, status);
  assert.equal(value.headers.get("Cache-Control"), "no-store");
  assert.equal(value.headers.has("Set-Cookie"), false);
  assert.equal(await value.text(), "");
}
async function session(db) {
  const user = "c".repeat(64),
    now = new Date();
  const { token } = await createSession(db, { user, tier: "general", provider: "google" }, now);
  const id = await sessionTokenHash(token);
  return { token, id, user, now, headers: { Authorization: `Bearer ${token}` } };
}

export async function rejectedInputsNeverReachCatalogOrStorage() {
  const never = () => assert.fail("Unexpected I/O"),
    db = { prepare: never, batch: never };
  const handle = createFollowSignupRoute(options({ loadCatalog: never }));
  await response(
    await createFollowSignupRoute(options({ enabled: false, loadCatalog: never }))(post(), { db }),
    503,
  );
  await response(
    await handle(post(input(), { Origin: "https://other.example.test" }), { db }),
    403,
  );
  for (const body of [
    "{",
    { ...input(), proof: {} },
    { ...input(), email: "bad" },
    { ...input(), scope: { kind: "search", fields: [], states: [] } },
  ])
    await response(await handle(post(body), { db }), 400);
  for (const headers of [
    {},
    { Authorization: "Bearer not-a-session" },
    { Cookie: "session=ignored" },
  ])
    await response(await handle(post(input(true), headers), { db }), 503);
}

export async function anonymousUsesOnlyCurrentTrustedCatalog(db) {
  const seen = [],
    wrapper = {
      prepare(sql) {
        seen.push(sql);
        return db.prepare(sql);
      },
      batch: (s) => db.batch(s),
    };
  const handle = createFollowSignupRoute(options());
  await response(
    await handle(post(input(), { Authorization: "Bearer ignored" }), { db: wrapper }),
    202,
  );
  const before = await db.prepare("SELECT * FROM follow_confirmation_outbox").first();
  await response(await handle(post(), { db: wrapper }), 202);
  assert.deepEqual(await db.prepare("SELECT * FROM follow_confirmation_outbox").first(), before);
  assert.equal(
    seen.some((sql) => /sessions/.test(sql)),
    false,
  );
  assert.equal(await count(db, "follow_subscribers"), 1);
  await response(
    await handle(post({ ...input(), scope: { kind: "company", company: "retired" } }), { db }),
    400,
  );
  assert.equal((await db.prepare("SELECT calls FROM rate").first()).calls, 2);
  await response(
    await createFollowSignupRoute(
      options({ loadCatalog: async () => ({ status: "unavailable" }) }),
    )(post(), { db }),
    503,
  );
}

export async function linkedDerivesProofWithoutRefreshing(db) {
  const s = await session(db);
  await db
    .prepare("UPDATE sessions SET last_used=? WHERE id=?")
    .bind("2020-01-01T00:00:00.000Z", s.id)
    .run();
  const before = await db.prepare("SELECT * FROM sessions WHERE id=?").bind(s.id).first();
  await response(
    await createFollowSignupRoute(options())(post(input(true), s.headers), { db }),
    202,
  );
  assert.deepEqual(
    await db.prepare("SELECT * FROM sessions WHERE id=?").bind(s.id).first(),
    before,
  );
  assert.equal(
    (await db.prepare("SELECT owner_user_hash FROM follow_confirmation_outbox").first())
      .owner_user_hash,
    s.user,
  );
  assert.equal(
    (await db.prepare("SELECT owner_user_hash FROM follow_subscriptions").first()).owner_user_hash,
    null,
  );
}

export async function staleLookupAndCatalogNeverExtendSession(db) {
  for (const stage of ["lookup", "catalog"]) {
    const s = await session(db),
      expiry = new Date(+s.now + 10000).toISOString();
    await db
      .prepare("UPDATE sessions SET expires=?,last_used=? WHERE id=?")
      .bind(expiry, "2020-01-01T00:00:00.000Z", s.id)
      .run();
    let clock = s.now,
      loads = 0;
    const wrapped = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("SELECT user_hash")) return statement;
        return {
          bind: (...args) => ({
            first: async () => {
              const row = await statement.bind(...args).first();
              if (stage === "lookup") clock = new Date(expiry);
              return row;
            },
          }),
        };
      },
      batch: (ss) => db.batch(ss),
    };
    const handle = createFollowSignupRoute(
      options({
        clock: () => clock,
        loadCatalog: async () => {
          loads++;
          clock = new Date(expiry);
          return { status: "available", catalog };
        },
      }),
    );
    await response(await handle(post(input(true), s.headers), { db: wrapped }), 503);
    assert.equal(loads, stage === "lookup" ? 0 : 1);
    assert.equal(
      (await db.prepare("SELECT expires FROM sessions WHERE id=?").bind(s.id).first()).expires,
      expiry,
    );
  }
  assert.equal(await count(db, "rate"), 0);
  assert.equal(await count(db, "follow_subscribers"), 0);
}

export async function expiryDuringRateWriteKeepsCapButDoesNotQueue(db) {
  const s = await session(db),
    expiry = new Date(+s.now + 10000).toISOString();
  await db.prepare("UPDATE sessions SET expires=? WHERE id=?").bind(expiry, s.id).run();
  let clock = s.now;
  const wrapper = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith("INSERT INTO rate")) return statement;
      return {
        bind: (...args) => ({
          run: async () => {
            const result = await statement.bind(...args).run();
            clock = new Date(expiry);
            return result;
          },
        }),
      };
    },
    batch: (ss) => db.batch(ss),
  };
  await response(
    await createFollowSignupRoute(options({ clock: () => clock }))(post(input(true), s.headers), {
      db: wrapper,
    }),
    503,
  );
  assert.equal((await db.prepare("SELECT calls FROM rate").first()).calls, 1);
  assert.equal(await count(db, "follow_subscribers"), 0);
}

export async function sqlFencesRevocationAndDatabaseExpiry(db) {
  for (const mode of ["revoked", "expired"]) {
    const s = await session(db);
    const handle = createFollowSignupRoute(
      options({
        loadCatalog: async () => {
          if (mode === "revoked")
            await db.prepare("DELETE FROM sessions WHERE id=?").bind(s.id).run();
          else
            await db
              .prepare("UPDATE sessions SET expires=? WHERE id=?")
              .bind("2020-01-01T00:00:00.000Z", s.id)
              .run();
          return { status: "available", catalog };
        },
      }),
    );
    // Generic receipt does not disclose that the exact SQL session fence declined the write.
    await response(await handle(post(input(true), s.headers), { db }), 202);
    assert.equal(await count(db, "follow_subscribers"), 0);
    assert.equal(await count(db, "follow_confirmation_outbox"), 0);
  }
}

export async function oneFactorySharesCapacityAcrossRequestContexts(db) {
  const gates = [],
    releases = [];
  const handle = createFollowSignupRoute(
    options({
      loadCatalog: () =>
        new Promise((resolve) => {
          gates.push(true);
          releases.push(() => resolve({ status: "available", catalog }));
        }),
    }),
  );
  const pending = Array.from({ length: 4 }, () => handle(post(), { db }));
  for (let n = 0; n < 100 && gates.length < 4; n++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(gates.length, 4);
  await response(
    await handle(post(), { db: { prepare: () => assert.fail("fifth request I/O") } }),
    503,
  );
  releases.forEach((release) => release());
  for (const value of await Promise.all(pending)) await response(value, 202);
  assert.equal(await count(db, "follow_confirmation_outbox"), 1);
}
