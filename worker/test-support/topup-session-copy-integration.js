import assert from "node:assert/strict";
import { deleteUser } from "../src/limits.js";
import { copySession, createSession, endSession } from "../src/session.js";
import { reserveSessionTopupCheckout } from "../src/topup-checkout.js";
import { prepareTopupStripe } from "../src/topup-stripe.js";
import { attempt, callbacks, env, price, reply, session } from "./topup-stripe.js";

const user = "a".repeat(64);
const now = new Date("2026-11-11T12:00:00Z");
const sessionClock = { now: +now };
const checkoutClock = () => new Date(now);
const auth = { status: "auth", attempt: null };
const start = (db) => createSession(db, { user, tier: "edu", provider: "google" }, now);

async function paymentFixture(beforeCreate = () => {}) {
  let created;
  const calls = [];
  const adapter = await prepareTopupStripe(env, callbacks, async (url, options) => {
    if (url.includes("/prices/")) return reply(price());
    calls.push(options.method);
    if (options.method === "POST") {
      const id = new URLSearchParams(options.body).get("metadata[attempt_id]");
      assert.equal(options.headers["Idempotency-Key"], "topup-checkout:" + id);
      created = session({ ...attempt(), id });
      await beforeCreate();
    }
    return reply(created);
  });
  assert.equal(adapter.enabled, true);
  return { adapter, calls };
}

export async function copiedSessionCanCheckoutAfterSourceSignout(db) {
  const source = await start(db);
  const copy = await copySession(db, source.token, sessionClock);
  await endSession(db, source.token);

  const { adapter, calls } = await paymentFixture();
  assert.deepEqual(
    await reserveSessionTopupCheckout(db, user, source.token, adapter, checkoutClock),
    auth,
  );
  const result = await reserveSessionTopupCheckout(db, user, copy.session, adapter, checkoutClock);
  assert.equal(result.status, "open");
  assert.equal(result.attempt.checkout_id, "cs_fixture");
  assert.equal((await adapter.readOpen(result.attempt)).url, session().url);
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.ok(!JSON.stringify(result.attempt).includes(copy.session));
  assert.ok(!JSON.stringify(result.attempt).includes("ephemeral-fixture"));
}

export async function deletedSourceCannotCopyOrReserveCheckout(db) {
  const source = await start(db);
  let reachedCopyWrite = false;
  const deleteBeforeCopy = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      reachedCopyWrite = true;
      await deleteUser(db, user, now);
      return db.batch(statements);
    },
  };
  await assert.rejects(
    () => copySession(deleteBeforeCopy, source.token, sessionClock),
    (err) => err.status === 401 && err.code === "auth",
  );
  assert.equal(reachedCopyWrite, true);
  const { adapter, calls } = await paymentFixture();
  assert.deepEqual(
    await reserveSessionTopupCheckout(db, user, source.token, adapter, checkoutClock),
    auth,
  );
  assert.deepEqual(calls, []);
  for (const table of ["sessions", "session_copies", "topup_checkout_attempts"]) {
    assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n, 0);
  }
}

export async function revokedCopyCannotReadItsVerifiedCheckout(db) {
  const source = await start(db);
  const copy = await copySession(db, source.token, sessionClock);
  const { adapter, calls } = await paymentFixture(() => endSession(db, copy.session));

  assert.deepEqual(
    await reserveSessionTopupCheckout(db, user, copy.session, adapter, checkoutClock),
    auth,
  );
  const recovered = await reserveSessionTopupCheckout(
    db,
    user,
    source.token,
    adapter,
    checkoutClock,
  );
  assert.equal(recovered.status, "open");
  assert.equal(recovered.attempt.checkout_id, "cs_fixture");
  assert.deepEqual(calls, ["POST"]);
  assert.ok(!JSON.stringify(recovered.attempt).includes("ephemeral-fixture"));
}
