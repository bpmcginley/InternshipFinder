import assert from "node:assert/strict";
import { getSessionTopupCheckout } from "../src/topup-checkout-service.js";
import { createSession, endSession } from "../src/session.js";
import { prepareTopupStripe } from "../src/topup-stripe.js";
import { attempt, callbacks, env, price, reply, session } from "./topup-stripe.js";
const user = "a".repeat(64);
const at = new Date("2026-11-11T12:00:00Z");

async function fixture(db, { onRead = async () => {}, createFails = false } = {}) {
  const login = await createSession(db, { user, tier: "edu", provider: "google" }, at);
  let current,
    posts = 0,
    gets = 0,
    now = +at;
  const adapter = await prepareTopupStripe(env, callbacks, async (url, options) => {
    if (url.includes("/prices/")) return reply(price());
    if (options.method === "POST") {
      posts++;
      if (createFails) throw new Error("Synthetic provider detail must stay private");
      const id = new URLSearchParams(options.body).get("metadata[attempt_id]");
      current = session({ ...attempt(), id });
    } else {
      gets++;
      await onRead({
        token: login.token,
        id: current.metadata.attempt_id,
        setNow: (value) => (now = value),
      });
    }
    return reply(current);
  });
  return {
    adapter,
    token: login.token,
    calls: () => ({ posts, gets }),
    run: (capability = adapter, identity = user, token = login.token) =>
      getSessionTopupCheckout(db, identity, token, capability, () => new Date(now)),
  };
}

export async function defaultOff(db) {
  assert.deepEqual(await getSessionTopupCheckout(db), { status: "disabled" });
  assert.equal((await db.prepare("SELECT count(*) n FROM topup_checkout_attempts").first()).n, 0);
}
export async function onePostReplay(db) {
  const f = await fixture(db);
  const expected = { status: "open", url: session().url };
  assert.deepEqual(await f.run(), expected);
  assert.deepEqual(await f.run(), expected);
  assert.deepEqual(f.calls(), { posts: 1, gets: 2 });
  const stored = JSON.stringify(
    (await db.prepare("SELECT * FROM topup_checkout_attempts").all()).results,
  );
  assert.ok(!stored.includes("ephemeral-fixture"));
  assert.ok(!stored.includes(f.token));
}
export async function ambiguityCannotPostAgain(db) {
  const f = await fixture(db, { createFails: true });
  assert.deepEqual(await f.run(), { status: "pending" });
  assert.deepEqual(await f.run(), { status: "pending" });
  assert.deepEqual(f.calls(), { posts: 1, gets: 0 });
}
export async function wrongIdentityNoProvider(db) {
  const f = await fixture(db);
  assert.deepEqual(await f.run(f.adapter, "b".repeat(64)), { status: "auth" });
  assert.deepEqual(await f.run(f.adapter, user, "invalid"), { status: "auth" });
  assert.deepEqual(f.calls(), { posts: 0, gets: 0 });
}
export async function revokedDuringRead(db) {
  const f = await fixture(db, { onRead: ({ token }) => endSession(db, token) });
  assert.deepEqual(await f.run(), { status: "unavailable" });
  assert.deepEqual(await f.run(), { status: "auth" });
  assert.deepEqual(f.calls(), { posts: 1, gets: 1 });
}
export async function expiresDuringRead(db) {
  const f = await fixture(db, {
    onRead: async ({ setNow }) => {
      await db
        .prepare("UPDATE sessions SET expires=?")
        .bind(new Date(+at + 1000).toISOString())
        .run();
      setNow(+at + 1000);
    },
  });
  assert.deepEqual(await f.run(), { status: "unavailable" });
}
export async function staleDatabaseAttempt(db) {
  const f = await fixture(db, {
    onRead: async ({ id }) => {
      await db
        .prepare("UPDATE topup_checkout_attempts SET state='expired' WHERE id=?")
        .bind(id)
        .run();
      await db
        .prepare(
          "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state,checkout_id) VALUES(?,?,?,300,'usd',25,?,'open',?)",
        )
        .bind(crypto.randomUUID(), user, "topup-v1", at.toISOString(), "cs_other")
        .run();
    },
  });
  assert.deepEqual(await f.run(), { status: "unavailable" });
  assert.deepEqual(f.calls(), { posts: 1, gets: 1 });
}
export async function staleRevision(db) {
  const f = await fixture(db, {
    onRead: ({ id }) =>
      db
        .prepare("INSERT INTO topup_attempt_revisions(attempt_id,revision) VALUES(?,1)")
        .bind(id)
        .run(),
  });
  assert.deepEqual(await f.run(), { status: "unavailable" });
}
export async function associationMismatch(db) {
  const f = await fixture(db);
  for (const key of [
    "attemptId",
    "userHash",
    "checkoutId",
    "offerVersion",
    "amount",
    "currency",
    "units",
    "url",
  ]) {
    const adapter = {
      ...f.adapter,
      async readOpen(a) {
        return {
          ...(await f.adapter.readOpen(a)),
          [key]: key === "amount" || key === "units" ? 1 : "different",
        };
      },
    };
    assert.deepEqual(await f.run(adapter), { status: "unavailable" });
  }
  assert.equal(f.calls().posts, 1);
}
export async function clockAndStorageFailure(db) {
  const f = await fixture(db, { onRead: ({ setNow }) => setNow(+at - 1) });
  assert.deepEqual(await f.run(), { status: "unavailable" });
  const broken = {
    prepare() {
      throw new Error("private database details");
    },
  };
  assert.deepEqual(await getSessionTopupCheckout(broken, user, f.token, f.adapter), {
    status: "unavailable",
  });
}
export async function readFailureAndDisable(db) {
  const f = await fixture(db);
  const broken = {
    ...f.adapter,
    readOpen() {
      throw new Error("private provider details");
    },
  };
  assert.deepEqual(await f.run(broken), { status: "unavailable" });
  const disabled = {
    ...f.adapter,
    async readOpen(a) {
      const result = await f.adapter.readOpen(a);
      disabled.enabled = false;
      return result;
    },
  };
  assert.deepEqual(await f.run(disabled), { status: "disabled" });
  assert.equal(f.calls().posts, 1);
}
