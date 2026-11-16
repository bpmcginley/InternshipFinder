import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { runTopupReconciliationScheduled as run } from "../src/topup-reconciliation-scheduled.js";
import { createTopupReconciliationStorage } from "../src/topup-reconciliation-storage.js";
import { captureTopupSettlement, settleFirstTopup } from "../src/topup-first-settlement.js";
import { deleteUser } from "../src/limits.js";
import { attempt, session } from "../test-support/topup-stripe.js";

const cron = "1 3 * * *";
const policy = {
  enabled: true,
  cron,
  livemode: false,
  limit: 5,
  maxRequests: 39,
  deadlineMs: 10_000,
};
const date = new Date("2026-11-11T00:00:00Z");
const paid = 327;
let db, cursor;

beforeEach(async () => {
  db = env.DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch(
    [
      "topup_purchases",
      "topup_claims",
      "topup_checkout_attempts",
      "topup_history_coverage",
      "topup_reconciliation_cursor",
      "topup_reconciliation_observations",
      "forget",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS fixture_topup_cursor"),
    db.prepare(
      "CREATE TABLE fixture_topup_cursor(mode TEXT PRIMARY KEY, after TEXT, revision INTEGER)",
    ),
    db.prepare("INSERT INTO fixture_topup_cursor VALUES('test','',0),('live','',0)"),
  ]);
  // This fixture implements the production port's durable CAS and committed receipt contract.
  const mode = (live) => (live ? "live" : "test");
  cursor = {
    read: (live) =>
      db
        .prepare("SELECT after,revision FROM fixture_topup_cursor WHERE mode=?")
        .bind(mode(live))
        .first(),
    advance: (live, expected, next) =>
      db
        .prepare(
          "UPDATE fixture_topup_cursor SET after=?,revision=? WHERE mode=? AND after=? AND revision=? RETURNING after,revision",
        )
        .bind(next.after, next.revision, mode(live), expected.after, expected.revision)
        .first(),
  };
});

async function purchase(n, livemode = false) {
  const a = {
    ...attempt(),
    id: crypto.randomUUID(),
    user_hash: String(n).repeat(64),
    state: "open",
    checkout_id: `cs_${n}`,
  };
  await db
    .prepare("INSERT INTO topup_checkout_attempts VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(
      a.id,
      a.user_hash,
      a.offer_version,
      a.amount,
      a.currency,
      a.units,
      date.toISOString(),
      a.checkout_id,
      a.state,
    )
    .run();
  const identity = {
    status: "paid_evidence",
    attemptId: a.id,
    userHash: a.user_hash,
    offerVersion: a.offer_version,
    offerAmount: a.amount,
    units: a.units,
    currency: a.currency,
    livemode,
    checkoutId: a.checkout_id,
    paymentId: `pi_${n}`,
    chargeId: `ch_${n}`,
    capturedAmount: paid,
  };
  const settled = await settleFirstTopup(
    db,
    await captureTopupSettlement(db, a.id),
    identity,
    {
      ...identity,
      status: "reversal_evidence",
      refunds: [],
      disputes: [],
      refundsComplete: true,
      disputesComplete: true,
    },
    date,
  );
  expect(settled.status).toBe("settled");
  const checkout = {
    ...session(a),
    id: a.checkout_id,
    livemode,
    status: "complete",
    payment_status: "paid",
    recovered_from: null,
    payment_intent: identity.paymentId,
    url: null,
    amount_total: paid,
  };
  const intent = {
    id: identity.paymentId,
    object: "payment_intent",
    livemode,
    currency: "usd",
    status: "succeeded",
    amount: paid,
    amount_received: paid,
    amount_capturable: 0,
    latest_charge: identity.chargeId,
    metadata: checkout.metadata,
  };
  const charge = {
    id: identity.chargeId,
    object: "charge",
    livemode,
    currency: "usd",
    status: "succeeded",
    paid: true,
    captured: true,
    amount: paid,
    amount_captured: paid,
    payment_intent: identity.paymentId,
    amount_refunded: 0,
    refunded: false,
    disputed: true,
  };
  const dispute = {
    id: `du_${n}`,
    object: "dispute",
    livemode,
    currency: "usd",
    status: "needs_response",
    amount: paid,
    charge: identity.chargeId,
    payment_intent: identity.paymentId,
  };
  return { a, checkout, intent, charge, dispute, key: settled.paymentHash };
}

function context(purchases = [], overrides = {}) {
  return {
    cursor,
    db,
    env: { STRIPE_SECRET_KEY: "fixture-not-a-key", STRIPE_PRICE_TOPUP: "price_fixture" },
    monotonicNow: () => performance.now(),
    fetch: async (url, options) => {
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("manual");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const { pathname, searchParams } = new URL(url);
      const id = pathname.split("/").at(-1);
      const payment = purchases.find(
        (p) =>
          [p.checkout.id, p.intent.id, p.charge.id].includes(id) ||
          p.charge.id === searchParams.get("charge"),
      );
      if (!payment) return new Response(null, { status: 404 });
      const data = [payment.checkout, payment.intent, payment.charge].find((e) => e.id === id) ?? {
        object: "list",
        url: pathname,
        has_more: false,
        data: id === "disputes" ? [payment.dispute] : [],
      };
      return new Response(JSON.stringify(data));
    },
    ...overrides,
  };
}
const balance = (p) =>
  db.prepare("SELECT available,held FROM topup_purchases WHERE payment_hash=?").bind(p.key).first();

it("default off, unmatched and malformed selectors do not open context or storage", async () => {
  const unopened = Object.defineProperty({}, "db", {
    get() {
      throw Error("unexpected");
    },
  });
  expect(await run(cron, {}, unopened)).toEqual({ status: "disabled" });
  expect(await run("2 3 * * *", policy, unopened)).toEqual({ status: "disabled" });
  expect((await run(cron, { ...policy, maxRequests: 20 }, unopened)).status).toBe("held");
  expect(await cursor.read(false)).toEqual({ after: "", revision: 0 });
});

it("persists ordered rotation past an unavailable record and wraps after a deleted cursor row", async () => {
  const items = [await purchase(1), await purchase(2)].sort((a, b) => (a.key < b.key ? -1 : 1));
  const [missing, good] = items;
  await db
    .prepare("UPDATE topup_retention SET history_proven=0 WHERE payment_hash=?")
    .bind(good.key)
    .run();
  expect(await run(cron, { ...policy, limit: 1 }, context([good]))).toMatchObject({
    status: "complete",
    attempted: 1,
    applied: 0,
    pending: 1,
    requests: 1,
  });
  expect(await cursor.read(false)).toEqual({ after: missing.key, revision: 1 });
  expect(await run(cron, { ...policy, limit: 1 }, context([good]))).toMatchObject({
    status: "complete",
    attempted: 1,
    applied: 1,
    pending: 0,
    requests: 9,
  });
  expect(await balance(good)).toEqual({ available: 0, held: 25 });
  expect(await cursor.read(true)).toEqual({ after: "", revision: 0 });
  expect(
    await db
      .prepare("SELECT coverage_epoch,history_proven FROM topup_retention WHERE payment_hash=?")
      .bind(good.key)
      .first(),
  ).toEqual({ coverage_epoch: null, history_proven: 0 });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM topup_history_coverage").first("n")).toBe(0);
  await deleteUser(db, good.a.user_hash);
  expect(await run(cron, policy, context([good]))).toMatchObject({
    status: "wrapped",
    requests: 0,
  });
  expect(await cursor.read(false)).toEqual({ after: "", revision: 3 });
});

it("reserves enough of the shared provider budget before advancing the next purchase", async () => {
  const items = [await purchase(1), await purchase(2), await purchase(3)];
  expect(await run(cron, { ...policy, maxRequests: 25 }, context(items))).toEqual({
    status: "partial",
    attempted: 1,
    applied: 1,
    pending: 0,
    requests: 9,
  });
  expect((await cursor.read(false)).revision).toBe(1);
  expect(await run(cron, policy, context(items))).toMatchObject({
    status: "complete",
    attempted: 2,
    applied: 2,
    requests: 18,
  });
});

it("stale, malformed and late cursor acknowledgements admit no Stripe requests", async () => {
  const p = await purchase(1);
  const assertHeld = async (advance, extra = {}) =>
    run(cron, policy, context([p], { cursor: { ...cursor, advance }, ...extra }));
  expect(await assertHeld(() => null)).toMatchObject({ status: "held", requests: 0 });
  expect(await assertHeld(() => ({ after: p.key, revision: 2 }))).toMatchObject({
    status: "held",
    requests: 0,
  });
  let monotonic = 0;
  expect(
    await assertHeld(
      async (...args) => {
        const receipt = await cursor.advance(...args);
        monotonic = policy.deadlineMs;
        return receipt;
      },
      { monotonicNow: () => monotonic },
    ),
  ).toMatchObject({ status: "partial", attempted: 0, requests: 0 });
  expect(await cursor.read(false)).toEqual({ after: p.key, revision: 1 });
  expect(await balance(p)).toEqual({ available: 25, held: 0 });
});

it("overlapping observations cannot acquire the same purchase cursor", async () => {
  const p = await purchase(1);
  let arrived = 0;
  let release;
  const both = new Promise((resolve) => {
    release = resolve;
  });
  const gated = {
    ...cursor,
    async read(livemode) {
      const state = await cursor.read(livemode);
      if (++arrived === 2) release();
      await both;
      return state;
    },
  };
  const invocations = await Promise.all(
    Array.from({ length: 2 }, () => run(cron, policy, context([p], { cursor: gated }))),
  );
  expect(invocations.sort((a, b) => a.requests - b.requests)).toEqual([
    { status: "held", attempted: 0, applied: 0, pending: 0, requests: 0 },
    { status: "complete", attempted: 1, applied: 1, pending: 0, requests: 9 },
  ]);
  expect(await cursor.read(false)).toEqual({ after: p.key, revision: 1 });
  expect(await balance(p)).toEqual({ available: 0, held: 25 });
});

const storage = (bindings = db) => createTopupReconciliationStorage(bindings, policy.deadlineMs);
const marker = (p) =>
  db
    .prepare("SELECT * FROM topup_reconciliation_observations WHERE payment_hash=?")
    .bind(p.key)
    .first();

it("the durable mode lease prevents another pass wrapping during an admitted Stripe read", async () => {
  const p = await purchase(1);
  const primary = context([p], { cursor: storage() });
  let unblock, started;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });
  const called = new Promise((resolve) => {
    started = resolve;
  });
  let entered = false;
  const originalFetch = primary.fetch;
  primary.fetch = async (...args) => {
    if (!entered) {
      entered = true;
      started();
      await blocked;
    }
    return originalFetch(...args);
  };
  const first = run(cron, policy, primary);
  await Promise.race([called, first]);
  try {
    expect(entered).toBe(true);
    expect((await marker(p)).outcome).toBe("pending");
    expect(await run(cron, policy, context([p], { cursor: storage() }))).toEqual({
      status: "held",
      attempted: 0,
      applied: 0,
      pending: 0,
      requests: 0,
    });
    expect((await marker(p)).reservation_revision).toBe(1);
  } finally {
    unblock();
  }
  expect(await first).toMatchObject({ status: "complete", applied: 1, requests: 9 });
  expect(await marker(p)).toMatchObject({
    mode: "test",
    reservation_revision: 1,
    outcome: "completed",
    last_completed_at_ms: expect.any(Number),
    last_gap_at_ms: null,
  });
  expect(await run(cron, policy, context([p], { cursor: storage() }))).toMatchObject({
    status: "wrapped",
    requests: 0,
  });
  expect(await balance(p)).toEqual({ available: 0, held: 25 });
});

it("a missed observation and an interrupted reservation stay visible after successful refresh", async () => {
  const p = await purchase(1);
  expect(await run(cron, policy, context([], { cursor: storage() }))).toMatchObject({
    status: "complete",
    pending: 1,
    requests: 1,
  });
  const missed = await marker(p);
  expect(missed).toMatchObject({
    outcome: "missed",
    last_gap_at_ms: expect.any(Number),
    last_completed_at_ms: null,
  });
  await run(cron, policy, context([], { cursor: storage() })); // bounded wrap
  const interrupted = storage();
  const state = await interrupted.read(false);
  expect(
    await interrupted.advance(false, state, { after: p.key, revision: state.revision + 1 }),
  ).toBeTruthy();
  expect((await marker(p)).outcome).toBe("pending");
  await db
    .prepare("UPDATE topup_reconciliation_cursor SET lease_until_ms=0 WHERE mode='test'")
    .run();
  expect(await interrupted.guard(false)).toBe(false);
  expect(
    await interrupted.finish(false, { after: p.key, revision: state.revision + 1 }, 2),
  ).toBeNull();
  await run(cron, policy, context([], { cursor: storage() })); // bounded wrap
  expect(await run(cron, policy, context([p], { cursor: storage() }))).toMatchObject({
    status: "complete",
    applied: 1,
    requests: 9,
  });
  const complete = await marker(p);
  expect(complete.outcome).toBe("completed");
  expect(complete.last_gap_at_ms).toBeGreaterThanOrEqual(missed.last_gap_at_ms);
  expect(complete.last_completed_at_ms).toBeGreaterThanOrEqual(complete.last_gap_at_ms);
  await deleteUser(db, p.a.user_hash);
  expect(await marker(p)).toBeNull();
});

it("the expired lease rejects the financial transaction even after an earlier positive owner check", async () => {
  const p = await purchase(1);
  let injectExpiry = false;
  const port = storage({
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      if (injectExpiry) {
        await db
          .prepare("UPDATE topup_reconciliation_cursor SET lease_until_ms=0 WHERE mode='test'")
          .run();
      }
      return db.batch(statements);
    },
  });
  const before = await port.read(false);
  const reserved = await port.advance(false, before, {
    after: p.key,
    revision: before.revision + 1,
  });
  expect(await port.guard(false)).toBe(true);
  injectExpiry = true;
  await expect(
    port.write(false, [
      db.prepare("UPDATE topup_purchases SET available=0,held=25 WHERE payment_hash=?").bind(p.key),
    ]),
  ).rejects.toThrow();
  expect(await balance(p)).toEqual({ available: 25, held: 0 });
  expect(await port.finish(false, reserved, 1)).toBeNull();
});

it("mixed-mode rows never create an observation marker for the other account mode", async () => {
  const p = await purchase(1, true);
  expect(await run(cron, policy, context([p], { cursor: storage() }))).toMatchObject({
    status: "complete",
    pending: 1,
    requests: 0,
  });
  expect(await marker(p)).toBeNull();
  expect(
    await run(cron, { ...policy, livemode: true }, context([p], { cursor: storage() })),
  ).toMatchObject({
    status: "complete",
    applied: 1,
    requests: 9,
  });
  expect(await marker(p)).toMatchObject({ mode: "live", outcome: "completed" });
});

it("a newer reconciliation revision leaves a missed marker after a prior write acknowledgment", async () => {
  const p = await purchase(1);
  const port = storage();
  const gated = {
    ...port,
    async finish(live, reservation, appliedRevision) {
      expect(appliedRevision).toBe(2);
      // Model the independently verified webhook winning between financial acknowledgement
      // and the scheduled marker write.
      await db
        .prepare("UPDATE topup_reconciliations SET revision=3 WHERE payment_hash=? AND revision=?")
        .bind(p.key, appliedRevision)
        .run();
      return port.finish(live, reservation, appliedRevision);
    },
  };
  expect(await run(cron, policy, context([p], { cursor: gated }))).toMatchObject({
    status: "complete",
    attempted: 1,
    applied: 0,
    pending: 1,
  });
  expect(await marker(p)).toMatchObject({
    outcome: "missed",
    last_completed_at_ms: null,
    last_gap_at_ms: expect.any(Number),
  });
  expect(await balance(p)).toEqual({ available: 0, held: 25 });
});
