import assert from "node:assert/strict";
import { reserveTopupCheckout } from "../src/topup-checkout.js";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
const user = "a".repeat(64),
  other = "b".repeat(64);
const now = new Date("2026-11-11T00:00:00Z");
const offer = { verified: true, version: "fixture-v1", amount: 300, currency: "usd", units: 25 };
const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM topup_checkout_attempts").first("n");
const reply = (a) => ({
  status: "open",
  checkoutId: "cs_fixture_" + a.id.replaceAll("-", ""),
  attemptId: a.id,
  userHash: a.user_hash,
  offerVersion: a.offer_version,
  amount: a.amount,
  currency: a.currency,
  units: a.units,
});
const cap = (create) => ({ enabled: true, offer: { ...offer }, create });

export async function checkoutReservation(db) {
  let calls = 0;
  const create = async (a) => {
    calls++;
    assert.match(a.idempotencyKey, /^topup-checkout:[a-f0-9-]{36}$/);
    return reply(a);
  };
  for (const capability of [
    undefined,
    {},
    cap(null),
    { ...cap(create), enabled: false },
    { ...cap(create), offer: { ...offer, verified: false } },
    ...[
      { amount: 0 },
      { units: 1.5 },
      { currency: "USD" },
      { version: "" },
      { version: "fixture.v1" },
      { version: "v".repeat(65) },
    ].map((p) => ({
      ...cap(create),
      offer: { ...offer, ...p },
    })),
  ])
    assert.deepEqual(await reserveTopupCheckout(db, user, capability, now), {
      status: "disabled",
      attempt: null,
    });
  assert.equal(await count(db), 0);
  assert.equal(calls, 0);
  await assert.rejects(reserveTopupCheckout(db, "bad", cap(create), now), /Invalid top-up account/);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reserveTopupCheckout(db, user, cap(create), now)),
  );
  assert.equal(calls, 1);
  assert.equal(await count(db), 1);
  assert.equal(new Set(results.map((r) => r.attempt.id)).size, 1);
  const replay = await reserveTopupCheckout(db, user, cap(create), new Date("2099-01-01"));
  assert.equal(replay.status, "open");
  assert.equal(calls, 1);
  assert.equal(replay.attempt.amount, 300);
  assert.equal(replay.attempt.units, 25);
  const changed = await reserveTopupCheckout(
    db,
    user,
    { ...cap(create), offer: { ...offer, version: "fixture-v2", units: 30 } },
    now,
  );
  assert.equal(changed.attempt.id, replay.attempt.id);
  assert.equal(changed.attempt.units, 25);
  assert.equal(calls, 1);
  await reserveTopupCheckout(db, other, cap(create), now);
  assert.equal(calls, 2);
  assert.equal(await count(db), 2);
  assert.deepEqual(Object.keys(replay.attempt).sort(), [
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
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM topup_purchases").first("n"), 0);
  // The full supported reservation boundary can pass the actual verified-settlement API.
  const boundary = await reserveTopupCheckout(
    db,
    "c".repeat(64),
    {
      enabled: true,
      offer: { ...offer, version: "A".repeat(62) + "_-" },
      create: async (a) => ({ ...reply(a), checkoutId: "cs_" + "x".repeat(250) }),
    },
    now,
  );
  assert.equal(boundary.status, "open");
  const a = boundary.attempt;
  const settled = await recordVerifiedTopup(
    db,
    {
      paymentId: "pi_checkout_boundary",
      checkoutId: a.checkout_id,
      userHash: a.user_hash,
      offerVersion: a.offer_version,
      amount: a.amount,
      currency: a.currency,
      units: a.units,
      livemode: false,
    },
    now,
  );
  assert.equal(settled.granted, true);
  assert.equal(settled.purchase.available, a.units);
}

export async function checkoutAmbiguity(db) {
  let calls = 0;
  const broken = cap(async () => {
    calls++;
    throw Error("synthetic provider uncertainty");
  });
  const pending = await reserveTopupCheckout(db, user, broken, now);
  assert.equal(pending.status, "pending");
  assert.equal(pending.attempt.checkout_id, null);
  const again = await reserveTopupCheckout(
    db,
    user,
    cap(async (a) => {
      calls++;
      return reply(a);
    }),
    new Date("2099-01-01"),
  );
  assert.equal(again.attempt.id, pending.attempt.id);
  assert.equal(again.status, "pending");
  assert.equal(calls, 1);
  // A pending provider promise also owns the only reservation while a concurrent caller returns.
  let finish, started;
  const entered = new Promise((resolve) => (started = resolve));
  const held = reserveTopupCheckout(
    db,
    other,
    cap(
      (a) =>
        new Promise((resolve) => {
          finish = () => resolve(reply(a));
          started();
        }),
    ),
    now,
  );
  await entered;
  const duplicate = await reserveTopupCheckout(
    db,
    other,
    cap(() => {
      throw Error("must not invoke");
    }),
    now,
  );
  assert.equal(duplicate.status, "pending");
  finish();
  assert.equal((await held).status, "open");
}

export async function checkoutAssociation(db) {
  let sequence = 1;
  for (const patch of [
    { status: "complete" },
    { checkoutId: "invalid" },
    { checkoutId: "cs_" + "x".repeat(251) },
    { attemptId: "other" },
    { userHash: other },
    { offerVersion: "other" },
    { amount: 301 },
    { currency: "eur" },
    { units: 26 },
  ]) {
    const owner = (sequence++).toString(16).padStart(64, "0");
    let calls = 0;
    const capability = cap(async (a) => {
      calls++;
      return { ...reply(a), ...patch };
    });
    assert.equal((await reserveTopupCheckout(db, owner, capability, now)).status, "pending");
    const again = await reserveTopupCheckout(db, owner, capability, now);
    assert.equal(calls, 1);
    assert.equal(again.attempt.checkout_id, null);
  }
  // Schema uniqueness prevents two accounts from attaching the same checkout reference.
  await reserveTopupCheckout(
    db,
    user,
    cap(async (a) => ({ ...reply(a), checkoutId: "cs_shared_fixture" })),
    now,
  );
  await assert.rejects(
    reserveTopupCheckout(
      db,
      other,
      cap(async (a) => ({ ...reply(a), checkoutId: "cs_shared_fixture" })),
      now,
    ),
  );
  assert.equal(
    (
      await reserveTopupCheckout(
        db,
        other,
        cap(() => {
          throw Error("no retry");
        }),
        now,
      )
    ).status,
    "pending",
  );
}

export async function checkoutAtomicity(db) {
  let calls = 0;
  await db
    .prepare(
      "CREATE TRIGGER fail_reservation BEFORE INSERT ON topup_checkout_attempts BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
    )
    .run();
  await assert.rejects(
    reserveTopupCheckout(
      db,
      user,
      cap(async (a) => {
        calls++;
        return reply(a);
      }),
      now,
    ),
    /fixture rollback/,
  );
  assert.equal(calls, 0);
  assert.equal(await count(db), 0);
  await db.prepare("DROP TRIGGER fail_reservation").run();
  await db
    .prepare(
      "CREATE TRIGGER fail_attachment BEFORE UPDATE ON topup_checkout_attempts BEGIN SELECT RAISE(ABORT,'fixture attachment'); END",
    )
    .run();
  await assert.rejects(
    reserveTopupCheckout(
      db,
      user,
      cap(async (a) => {
        calls++;
        return reply(a);
      }),
      now,
    ),
    /fixture attachment/,
  );
  assert.equal(calls, 1);
  assert.equal(await count(db), 1);
  await db.prepare("DROP TRIGGER fail_attachment").run();
  assert.equal(
    (
      await reserveTopupCheckout(
        db,
        user,
        cap(() => {
          calls++;
        }),
        now,
      )
    ).status,
    "pending",
  );
  assert.equal(calls, 1);
  // Model a future verified closure racing a stale creation reply. No terminal reopening.
  const closed = await reserveTopupCheckout(
    db,
    other,
    cap(async (a) => {
      await db
        .prepare("UPDATE topup_checkout_attempts SET state='expired' WHERE id=?")
        .bind(a.id)
        .run();
      return reply(a);
    }),
    now,
  );
  assert.equal(closed.attempt.state, "expired");
  assert.equal(closed.attempt.checkout_id, null);
}
