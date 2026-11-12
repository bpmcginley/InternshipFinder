// Synthetic scenarios shared by SQLite and actual local D1; all creation calls are mocks.
import assert from "node:assert/strict";
import {
  reserveSessionTopupCheckout as reserve,
  reserveTopupCheckout as trusted,
} from "../src/topup-checkout.js";
import { createSession, forgetSessions } from "../src/session.js";
import { deleteUser } from "../src/limits.js";
const user = "a".repeat(64),
  now = new Date("2026-11-10T12:00:00Z"),
  clock = () => new Date(now);
const start = (db, u = user) =>
  createSession(db, { user: u, tier: "edu", provider: "google" }, now);
const rows = async (db) =>
  (await db.prepare("SELECT * FROM topup_checkout_attempts").all()).results;
const refused = { status: "auth", attempt: null };
function capability() {
  const calls = [];
  return {
    calls,
    enabled: true,
    offer: { verified: true, version: "fixture-v1", amount: 300, currency: "usd", units: 25 },
    create: async (attempt) => {
      calls.push(attempt);
      return {
        status: "open",
        attemptId: attempt.id,
        userHash: attempt.user_hash,
        offerVersion: attempt.offer_version,
        amount: attempt.amount,
        currency: attempt.currency,
        units: attempt.units,
        checkoutId: `cs_${attempt.id.replaceAll("-", "")}`,
      };
    },
  };
}
export async function sessionReservationValid(db) {
  const { token } = await start(db),
    cap = capability();
  const outcomes = await Promise.all([
    reserve(db, user, token, cap, clock),
    reserve(db, user, token, cap, clock),
  ]);
  assert.equal(cap.calls.length, 1);
  assert.equal((await rows(db)).length, 1);
  assert.equal(outcomes[0].attempt.id, outcomes[1].attempt.id);
  const again = await reserve(db, user, token, cap, clock);
  assert.equal(again.status, "open");
  assert.equal(cap.calls.length, 1);
  const stored = (await rows(db))[0];
  assert.deepEqual(Object.keys(stored).sort(), [
    "amount",
    "checkout_id",
    "created",
    "currency",
    "id",
    "offer_version",
    "state",
    "units",
    "user_hash",
  ]);
  const session = (await db.prepare("SELECT id FROM sessions WHERE user_hash=?").bind(user).first())
    .id;
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.equal(JSON.stringify(stored).includes(session), false);
  assert.equal(JSON.stringify(cap.calls).includes(token), false);
  assert.equal(JSON.stringify(cap.calls).includes(session), false);
}
export async function sessionReservationRejects(db) {
  const source = await start(db),
    other = await start(db, "b".repeat(64)),
    cap = capability();
  const existing = await trusted(db, user, cap, now);
  assert.equal(cap.calls.length, 1);
  for (const token of [
    null,
    "provider.id.token",
    "iss_short",
    "iss_" + "!".repeat(43),
    "iss_" + "x".repeat(43),
    other.token,
  ]) {
    assert.deepEqual(await reserve(db, user, token, cap, clock), refused);
  }
  assert.deepEqual(await reserve(db, "b".repeat(64), source.token, cap, clock), refused);
  assert.deepEqual(await reserve(db, "bad", source.token, cap, clock), refused);
  await db
    .prepare("UPDATE sessions SET expires=? WHERE user_hash=?")
    .bind(now.toISOString(), user)
    .run();
  assert.deepEqual(await reserve(db, user, source.token, cap, clock), refused);
  await forgetSessions(db, user).run();
  assert.deepEqual(await reserve(db, user, source.token, cap, clock), refused);
  assert.equal(cap.calls.length, 1);
  assert.equal((await rows(db))[0].id, existing.attempt.id);
}
export async function sessionReservationDeletionRace(db) {
  for (const hasAttempt of [false, true]) {
    await db.prepare("DELETE FROM topup_checkout_attempts").run();
    const source = await start(db),
      cap = capability();
    if (hasAttempt) await trusted(db, user, cap, now);
    cap.calls.length = 0;
    const guarded = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        // Revoke after proof hashing, immediately before the real reservation transaction.
        await deleteUser(db, user, now);
        return db.batch(statements);
      },
    };
    if (hasAttempt) {
      // P-2.2m now blocks account deletion once reservation has committed. Sign-out
      // remains independently valid, and must still fence a stale reservation request.
      await assert.rejects(deleteUser(db, user, now), { status: 409, code: "topup_payment_pending" });
      await forgetSessions(db, user).run();
      assert.deepEqual(await reserve(db, user, source.token, cap, clock), refused);
    } else assert.deepEqual(await reserve(guarded, user, source.token, cap, clock), refused);
    assert.equal(cap.calls.length, 0);
    assert.equal((await rows(db)).length, Number(hasAttempt));
    const fresh = await start(db);
    assert.deepEqual(await reserve(db, user, source.token, cap, clock), refused);
    assert.ok((await reserve(db, user, fresh.token, cap, clock)).attempt);
  }
}
export async function sessionReservationClockAndRollback(db) {
  const source = await start(db),
    cap = capability();
  let sampled = false;
  const pending = reserve(db, user, source.token, cap, () => {
    sampled = true;
    return new Date(now.getTime() + 366 * 86400e3);
  });
  assert.equal(sampled, false, "clock sampled after asynchronous hash work");
  assert.deepEqual(await pending, refused);
  assert.equal(sampled, true);
  assert.equal(cap.calls.length, 0);
  assert.deepEqual(await reserve(db, user, source.token, cap, () => new Date(NaN)), refused);
  assert.deepEqual(await reserve(db, user, source.token, {}, clock), {
    status: "disabled",
    attempt: null,
  });
  await db
    .prepare(
      "CREATE TRIGGER fixture_reservation_abort BEFORE INSERT ON topup_checkout_attempts BEGIN SELECT RAISE(ABORT,'fixture_reservation_rollback'); END",
    )
    .run();
  await assert.rejects(
    () => reserve(db, user, source.token, cap, clock),
    /fixture_reservation_rollback/,
  );
  assert.equal((await rows(db)).length, 0);
  assert.equal(cap.calls.length, 0);
  await db.prepare("DROP TRIGGER fixture_reservation_abort").run();
  assert.equal((await reserve(db, user, source.token, cap, clock)).status, "open");
  assert.equal(cap.calls.length, 1);
}

export async function sessionReservationRevokedDuringCreate(db) {
  for (const result of ["open", "invalid", "throw"]) {
    for (const revocation of ["signout", "expiry", "clock"]) {
      await db.prepare("DELETE FROM topup_checkout_attempts").run();
      await forgetSessions(db, user).run();
      const source = await start(db),
        cap = capability(),
        create = cap.create;
      let millis = now.getTime();
      cap.create = async (attempt) => {
        const verified = await create(attempt);
        if (revocation === "signout") await forgetSessions(db, user).run();
        else if (revocation === "expiry")
          await db
            .prepare("UPDATE sessions SET expires=? WHERE user_hash=?")
            .bind(now.toISOString(), user)
            .run();
        else millis += 366 * 86400e3;
        if (result === "throw") throw new Error("synthetic ambiguous response");
        return result === "open" ? verified : {};
      };
      assert.deepEqual(await reserve(db, user, source.token, cap, () => new Date(millis)), refused);
      const stored = (await rows(db))[0];
      assert.equal(stored.state, result === "open" ? "open" : "creating");
      assert.equal(stored.checkout_id !== null, result === "open");
      assert.equal(cap.calls.length, 1);
    }
  }
}
