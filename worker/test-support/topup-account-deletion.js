// Synthetic account deletion through the real helper, shared by SQLite and local D1.
import assert from "node:assert/strict";
import { deleteUser, cleanup } from "../src/limits.js";
import { createSession } from "../src/session.js";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
import { reserveSessionTopupCheckout } from "../src/topup-checkout.js";
const user = "a".repeat(64),
  other = "b".repeat(64);
const now = new Date("2026-11-10T12:00:00Z");
const run = (db, sql, ...args) =>
  db
    .prepare(sql)
    .bind(...args)
    .run();
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const session = (db) => createSession(db, { user, tier: "edu", provider: "google" }, now);
async function attempt(db, state, owner = user) {
  const id = crypto.randomUUID();
  await run(
    db,
    "INSERT INTO topup_checkout_attempts VALUES(?,?,'fixture',300,'usd',25,?,?,?)",
    id,
    owner,
    now.toISOString(),
    "cs_" + id.replaceAll("-", ""),
    state,
  );
  await run(db, "INSERT INTO topup_attempt_revisions VALUES(?,1)", id);
  return id;
}
async function purchase(db, owner = user) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const input = {
    paymentId: "pi_" + suffix,
    checkoutId: "cs_" + suffix,
    userHash: owner,
    offerVersion: "fixture",
    amount: 327,
    currency: "usd",
    units: 25,
    livemode: false,
  };
  const { purchase: stored } = await recordVerifiedTopup(db, input, now);
  const hash = stored.payment_hash;
  await run(db, "UPDATE topup_purchases SET available=24,consumed=1 WHERE payment_hash=?", hash);
  await run(db, "INSERT INTO topup_reconciliations VALUES(?,1,0,0,'[]')", hash);
  await run(
    db,
    "INSERT INTO topup_allocations VALUES(?,'2026-11','autofill',?,?,'allocated')",
    owner,
    suffix,
    hash,
  );
  return { input, hash };
}
async function reset(db) {
  await db.batch(
    [
      "DROP TRIGGER IF EXISTS fixture_delete_abort",
      ...[
        "topup_allocations",
        "topup_reconciliations",
        "topup_purchases",
        "topup_claims",
        "topup_attempt_revisions",
        "topup_checkout_attempts",
        "sessions",
        "session_copies",
        "forget",
        "demand",
        "usage",
      ].map((t) => `DELETE FROM ${t}`),
    ].map((sql) => db.prepare(sql)),
  );
}

export async function deletionBlocksUnresolved(db) {
  for (const existing of [false, true])
    for (const state of ["creating", "open"]) {
      await reset(db);
      if (existing) await run(db, "INSERT INTO forget VALUES(?,'2026-10')", user);
      await attempt(db, state);
      await purchase(db);
      await session(db);
      await run(db, "INSERT INTO demand VALUES(?,'[]','fixture','fixture')", user);
      await run(db, "INSERT INTO usage VALUES(?,'2026-09','autofill',1)", user);
      await assert.rejects(deleteUser(db, user, now), /topup_payment_pending/);
      for (const table of [
        "demand",
        "usage",
        "sessions",
        "topup_purchases",
        "topup_attempt_revisions",
      ])
        assert.equal((await rows(db, table)).length, 1);
      assert.equal((await rows(db, "topup_claims"))[0].state, "granted");
      assert.deepEqual(
        await rows(db, "forget"),
        existing ? [{ user_hash: user, month: "2026-10" }] : [],
      );
    }
}

export async function deletionUsesScopedResolvedIndex(db) {
  const { results } = await db
    .prepare(
      "EXPLAIN QUERY PLAN DELETE FROM topup_checkout_attempts " +
        "WHERE user_hash = ? AND state IN ('expired', 'settled')",
    )
    .bind(user)
    .all();
  assert.ok(
    results.some((row) =>
      /SEARCH topup_checkout_attempts USING INDEX topup_checkout_resolved_user \(user_hash=\?\)/.test(
        row.detail,
      ),
    ),
    "resolved deletion must look up only the requested owner's index entries",
  );
}

export async function deletionErasesLinkedDataOnly(db) {
  await reset(db);
  const owned = await purchase(db),
    unowned = await purchase(db, other);
  const retired = await purchase(db);
  await run(db, "UPDATE topup_claims SET state='retired' WHERE payment_hash=?", retired.hash);
  await attempt(db, "settled");
  await attempt(db, "expired");
  await attempt(db, "open", other);
  await session(db);
  await deleteUser(db, user, now);
  for (const table of ["topup_purchases", "topup_allocations", "topup_reconciliations"])
    assert.deepEqual(
      (await rows(db, table)).map((r) => r.payment_hash),
      [unowned.hash],
    );
  assert.equal((await rows(db, "topup_attempt_revisions")).length, 1);
  assert.deepEqual(
    (await rows(db, "topup_checkout_attempts")).map((r) => r.user_hash),
    [other],
  );
  const claims = await rows(db, "topup_claims");
  assert.equal(claims.find((r) => r.payment_hash === owned.hash).state, "deleted");
  assert.equal(claims.find((r) => r.payment_hash === retired.hash).state, "retired");
  for (const claim of claims)
    assert.deepEqual(Object.keys(claim).sort(), ["checkout_hash", "payment_hash", "state"]);
  await assert.rejects(recordVerifiedTopup(db, owned.input, now), /unavailable/);
  await assert.rejects(
    recordVerifiedTopup(db, { ...owned.input, userHash: other }, now),
    /unavailable/,
  );
  // An existing forget row must not bypass deletion on an explicit later request.
  await attempt(db, "expired");
  await deleteUser(db, user, now);
  assert.deepEqual(await rows(db, "topup_claims"), claims);
  assert.equal((await rows(db, "topup_checkout_attempts")).length, 1);
}

export async function deletionRollsBackLateFailure(db) {
  await reset(db);
  await purchase(db);
  await attempt(db, "settled");
  await session(db);
  await run(db, "INSERT INTO demand VALUES(?,'[]','fixture','fixture')", user);
  const tables = [
    "topup_claims",
    "topup_purchases",
    "topup_allocations",
    "topup_reconciliations",
    "topup_checkout_attempts",
    "topup_attempt_revisions",
    "sessions",
    "demand",
    "forget",
  ];
  const before = await Promise.all(tables.map((t) => rows(db, t)));
  await run(
    db,
    "CREATE TRIGGER fixture_delete_abort BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'fixture_late_failure'); END",
  );
  await assert.rejects(deleteUser(db, user, now), /fixture_late_failure/);
  assert.deepEqual(await Promise.all(tables.map((t) => rows(db, t))), before);
  await run(db, "DROP TRIGGER fixture_delete_abort");
  await deleteUser(db, user, now);
  assert.equal((await rows(db, "topup_claims"))[0].state, "deleted");
}

export async function deletionPreservesMonthlyCleanup(db) {
  await reset(db);
  await run(db, "INSERT INTO forget VALUES(?,'2026-10')", user);
  await run(
    db,
    "INSERT INTO usage VALUES(?,'2026-10','autofill',1),(?,'2026-11','autofill',2)",
    user,
    user,
  );
  await purchase(db);
  await attempt(db, "open");
  const tables = ["topup_claims", "topup_purchases", "topup_checkout_attempts"];
  const before = await Promise.all(tables.map((t) => rows(db, t)));
  await cleanup(db, now);
  assert.deepEqual(await rows(db, "forget"), []);
  assert.deepEqual(
    (await rows(db, "usage")).map((r) => r.month),
    ["2026-11"],
  );
  assert.deepEqual(await Promise.all(tables.map((t) => rows(db, t))), before);
}

export async function deletionReservationOrderings(db) {
  for (const order of ["reserve", "delete", "concurrent"]) {
    await reset(db);
    const { token } = await session(db);
    let calls = 0;
    const capability = {
      enabled: true,
      offer: { verified: true, version: "fixture", amount: 300, currency: "usd", units: 25 },
      create: async () => {
        calls++;
        return null;
      },
    };
    const reserve = () => reserveSessionTopupCheckout(db, user, token, capability, () => now);
    if (order === "reserve") {
      assert.equal((await reserve()).status, "pending");
      await assert.rejects(deleteUser(db, user, now), /topup_payment_pending/);
    } else if (order === "delete") {
      await deleteUser(db, user, now);
      assert.deepEqual(await reserve(), { status: "auth", attempt: null });
    } else {
      const [reservation, deletion] = await Promise.allSettled([
        reserve(),
        deleteUser(db, user, now),
      ]);
      assert.equal(reservation.status, "fulfilled");
      if (deletion.status === "rejected") {
        assert.match(String(deletion.reason), /topup_payment_pending/);
        assert.equal(reservation.value.status, "pending");
      } else assert.deepEqual(reservation.value, { status: "auth", attempt: null });
    }
    const kept = (await rows(db, "topup_checkout_attempts")).length;
    assert.equal(calls, kept);
    assert.equal((await rows(db, "sessions")).length, kept);
    assert.equal((await rows(db, "forget")).length, 1 - kept);
  }
}
