import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { createSession } from "../src/session.js";
import { recordVerifiedTopup } from "../src/topup-ledger.js";

const at = new Date("2026-11-11T12:00:00Z");
const owner = "a".repeat(64);
const other = "b".repeat(64);
const ready = {
  FUNDED_RUNS_MODE: "create",
  FUNDED_PURCHASES: "1",
  FUNDED_RESPONSE_MAX_BYTES: "16384",
  FUNDED_RESPONSE_EVENT_BYTES: "8192",
  FUNDED_RESPONSE_DEADLINE_MS: "5000",
};
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

async function grant(db, user) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const { purchase } = await recordVerifiedTopup(
    db,
    {
      paymentId: "pi_" + suffix,
      checkoutId: "cs_" + suffix,
      userHash: user,
      offerVersion: "fixture",
      amount: 327,
      currency: "usd",
      units: 25,
      livemode: false,
    },
    at,
  );
  return purchase.payment_hash;
}

async function me(db, token, settings = ready, expectedStatus = 200) {
  const background = [];
  const response = await handle(
    new Request("https://local.invalid/me", {
      headers: token ? { Authorization: "Bearer " + token } : {},
    }),
    { ...settings, DB: db },
    { waitUntil: (promise) => background.push(promise) },
    {
      now: () => new Date(at),
      fetch: () => assert.fail("The balance projection must not call a provider"),
    },
  );
  await Promise.all(background);
  assert.equal(response.status, expectedStatus);
  if (expectedStatus === 200) assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.json();
}

export async function purchasedAllowanceProjection(db) {
  const { token } = await createSession(db, { user: owner, tier: "edu", provider: "google" }, at);
  const { token: otherToken } = await createSession(
    db,
    { user: other, tier: "edu", provider: "google" },
    at,
  );
  const empty = (await me(db, token)).allowance;
  const included = empty.autofill.limit;
  assert.ok(Number.isSafeInteger(included) && included > 0);
  assert.deepEqual(empty.autofill, { used: 0, limit: included });

  const first = await grant(db, owner);
  await run(db, "UPDATE topup_purchases SET available=20,consumed=5 WHERE payment_hash=?", first);
  await grant(db, owner);
  const held = await grant(db, owner);
  await run(db, "UPDATE topup_purchases SET held=5,available=20 WHERE payment_hash=?", held);
  const disputed = await grant(db, owner);
  const reconcile = `INSERT INTO topup_reconciliations
    (payment_hash,revision,loss,full_refund,hold_ids) VALUES(?,1,?,?,?)`;
  await run(db, reconcile, disputed, 0, 0, '["hold_fixture"]');
  const lost = await grant(db, owner);
  await run(db, reconcile, lost, 1, 0, "[]");
  const refunded = await grant(db, owner);
  await run(db, reconcile, refunded, 0, 1, "[]");
  await grant(db, other);
  await run(db, "INSERT INTO bonus (user_hash,task,granted,used) VALUES(?,'autofill',6,2)", owner);
  await run(db, "INSERT INTO usage (user_hash,month,task,units) VALUES(?,'2026-11','autofill',?)", owner, included + 3);

  const paid = (await me(db, token)).allowance;
  assert.deepEqual(paid.autofill, { used: included + 3, limit: included + 52, bonus: 4, purchased: 45 });
  assert.deepEqual(paid.resume_tailor, empty.resume_tailor);
  const forOther = (await me(db, otherToken)).allowance;
  assert.deepEqual(forOther.autofill, { used: 0, limit: included + 25, purchased: 25 });

  for (const settings of [
    {},
    { ...ready, FUNDED_RUNS_MODE: "drain" },
    { ...ready, FUNDED_PURCHASES: "0" },
    { ...ready, FUNDED_RESPONSE_EVENT_BYTES: "99999" },
  ]) {
    const unready = (await me(db, token, settings)).allowance;
    assert.deepEqual(unready.autofill, { used: included + 3, limit: included + 7, bonus: 4, purchased: 45 });
  }
  const unsigned = await me(db, undefined, ready, 401);
  assert.equal(unsigned.allowance, undefined);
  const unchanged = await db
    .prepare("SELECT available,consumed FROM topup_purchases WHERE payment_hash=?")
    .bind(first)
    .first();
  assert.deepEqual(unchanged, { available: 20, consumed: 5 });
}
