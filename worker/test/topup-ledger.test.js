import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.js";
import { recordVerifiedTopup } from "../src/topup-ledger.js";

const NOW = new Date("2026-11-11T12:00:00Z");
const input = (patch = {}) => ({
  paymentId: "pi_fixture",
  checkoutId: "cs_fixture",
  userHash: "a".repeat(64),
  livemode: false,
  offerVersion: "fixture-v1",
  amount: 300,
  currency: "usd",
  units: 25,
  ...patch,
});
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;

test("top-up concurrent duplicate purchase grants once, independent of webhook receipts", async () => {
  const db = fakeD1();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => recordVerifiedTopup(db, input(), NOW)),
  );
  assert.equal(results.filter((r) => r.granted).length, 1);
  assert.equal((await rows(db, "topup_claims")).length, 1);
  assert.equal((await rows(db, "topup_purchases"))[0].available, 25);
  for (const table of ["bonus", "usage", "runs", "stripe_events", "plans"])
    assert.deepEqual(await rows(db, table), []);
  const replay = await recordVerifiedTopup(db, input(), new Date("2028-01-01T00:00:00Z"));
  assert.equal(replay.granted, false);
  assert.equal(replay.purchase.created, NOW.toISOString());
});

test("top-up aliases cannot create a second grant or change an immutable record", async () => {
  const db = fakeD1();
  await recordVerifiedTopup(db, input(), NOW);
  for (const patch of [
    { paymentId: "pi_other" },
    { checkoutId: "cs_other" },
    { userHash: "b".repeat(64) },
    { offerVersion: "fixture-v2" },
    { amount: 301 },
    { currency: "cad" },
    { units: 26 },
  ]) {
    await assert.rejects(recordVerifiedTopup(db, input(patch), NOW), /Conflicting top-up/);
  }
  assert.equal((await rows(db, "topup_purchases")).length, 1);
  assert.equal((await rows(db, "topup_claims")).length, 1);
});

test("top-up concurrent owner or payment collisions have only one winner", async () => {
  for (const patch of [
    { userHash: "b".repeat(64) },
    { paymentId: "pi_other" },
    { checkoutId: "cs_other" },
  ]) {
    const db = fakeD1();
    const results = await Promise.allSettled(
      [input(), input(patch)].map((x) => recordVerifiedTopup(db, x, NOW)),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await rows(db, "topup_purchases")).length, 1);
  }
});

test("top-up purchase failure rolls back its durable claim and retry succeeds", async () => {
  const db = fakeD1();
  await db.exec(
    "CREATE TRIGGER reject_topup BEFORE INSERT ON topup_purchases BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  await assert.rejects(recordVerifiedTopup(db, input(), NOW), /fixture failure/);
  assert.deepEqual(await rows(db, "topup_claims"), []);
  await db.exec("DROP TRIGGER reject_topup");
  assert.equal((await recordVerifiedTopup(db, input(), NOW)).granted, true);
});

test("top-up replay never replenishes a changed balance; SQL enforces conservation", async () => {
  const db = fakeD1();
  await recordVerifiedTopup(db, input(), NOW);
  await db.exec("UPDATE topup_purchases SET available=10, held=5, consumed=8, revoked=2");
  const { granted, purchase } = await recordVerifiedTopup(db, input(), NOW);
  assert.equal(granted, false);
  assert.deepEqual(
    [purchase.available, purchase.held, purchase.consumed, purchase.revoked],
    [10, 5, 8, 2],
  );
  for (const sql of [
    "available=26",
    "available=-1",
    "available=10.5",
    "held=-1",
    "consumed=-1",
    "revoked=-1",
  ]) {
    await assert.rejects(db.exec(`UPDATE topup_purchases SET ${sql}`), /CHECK constraint/);
  }
});

test("top-up seeded terminal or missing-purchase claims block replay without relinking", async () => {
  for (const state of ["deleted", "retired", "granted"]) {
    const db = fakeD1();
    await recordVerifiedTopup(db, input(), NOW);
    // Fixtures model the required future terminalization/deletion transaction, not a shipped helper.
    await db.batch([
      db.prepare("DELETE FROM topup_purchases"),
      db.prepare("UPDATE topup_claims SET state=?").bind(state),
    ]);
    await assert.rejects(recordVerifiedTopup(db, input(), NOW), /unavailable/);
    assert.deepEqual(await rows(db, "topup_purchases"), []);
    const [claim] = await rows(db, "topup_claims");
    assert.deepEqual(Object.keys(claim).sort(), ["checkout_hash", "payment_hash", "state"]);
    assert.match(claim.payment_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(claim.payment_hash, claim.checkout_hash);
  }
});

test("top-up validates values before writing and snapshots caller input before hashing", async () => {
  const db = fakeD1();
  for (const patch of [
    { paymentId: "bad" },
    { checkoutId: "cs_" },
    { userHash: "email@example.test" },
    { livemode: "false" },
    { currency: "USD" },
    { amount: 0 },
    { amount: 1.5 },
    { units: Number.MAX_SAFE_INTEGER + 1 },
    { units: -1 },
    { offerVersion: "bad\n" },
    { userHash: { toString: () => "a".repeat(64) } },
  ]) {
    await assert.rejects(recordVerifiedTopup(db, input(patch), NOW), /Invalid verified/);
  }
  await assert.rejects(recordVerifiedTopup(db, input(), new Date(NaN)), /Invalid verified/);
  assert.deepEqual(await rows(db, "topup_claims"), []);
  const mutable = input();
  const pending = recordVerifiedTopup(db, mutable, NOW);
  mutable.paymentId = "pi_mutated";
  assert.equal((await pending).purchase.payment_id, "pi_fixture");
});

test("top-up live/test reference namespaces and separate legitimate purchases stay independent", async () => {
  const db = fakeD1();
  await recordVerifiedTopup(db, input(), NOW);
  await recordVerifiedTopup(db, input({ livemode: true }), NOW);
  await recordVerifiedTopup(db, input({ paymentId: "pi_second", checkoutId: "cs_second" }), NOW);
  assert.equal((await rows(db, "topup_purchases")).length, 3);
  assert.equal(
    (await rows(db, "topup_purchases")).reduce((n, r) => n + r.available, 0),
    75,
  );
});
