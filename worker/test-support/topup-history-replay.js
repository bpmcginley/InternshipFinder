import assert from "node:assert/strict";
import { captureTopupSettlement, settleFirstTopup } from "../src/topup-first-settlement.js";
import { attempt, session } from "./topup-stripe.js";
import { observeVerifiedTopupEvent } from "../src/topup-history-events.js";
import { replayTopupHistoryTarget as replay } from "../src/topup-history-replay.js";
import {
  rotateTopupCoverage as rotate,
  captureTopupCoverage as capture,
} from "../src/topup-history-coverage.js";
const env = { STRIPE_SECRET_KEY: "fixture-not-a-key", TOPUPS_ENABLED: "0", PAYMENTS_ENABLED: "0" };
const offer = {
  version: "topup-v1",
  priceId: "price_fixture",
  livemode: false,
  amount: 300,
  currency: "usd",
  units: 25,
};
const now = new Date("2026-11-11T00:00:00Z");
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const item = (
  kind,
  status,
  amount = 327,
  id = kind === "refund" ? "re_fixture" : "du_fixture",
) => ({
  object: kind,
  id,
  charge: "ch_fixture",
  payment_intent: "pi_fixture",
  currency: "usd",
  amount,
  status,
  ...(kind === "dispute" ? { livemode: false } : {}),
});
async function paymentFixture(db) {
  await db.batch(
    [
      "DROP TRIGGER IF EXISTS fixture_purchase_abort",
      ...[
        "topup_history_receipts",
        "topup_allocations",
        "topup_reconciliations",
        "topup_purchases",
        "topup_claims",
        "topup_attempt_revisions",
        "topup_checkout_attempts",
        "forget",
      ].map((t) => `DELETE FROM ${t}`),
    ].map((sql) => db.prepare(sql)),
  );
  const a = { ...attempt(), state: "open", checkout_id: "cs_fixture" };
  await db
    .prepare("INSERT INTO topup_checkout_attempts VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(
      a.id,
      a.user_hash,
      a.offer_version,
      a.amount,
      a.currency,
      a.units,
      now.toISOString(),
      a.checkout_id,
      a.state,
    )
    .run();
  const payment = {
    status: "paid_evidence",
    attemptId: a.id,
    userHash: a.user_hash,
    offerVersion: a.offer_version,
    offerAmount: 300,
    units: 25,
    currency: "usd",
    livemode: false,
    checkoutId: a.checkout_id,
    paymentId: "pi_fixture",
    chargeId: "ch_fixture",
    capturedAmount: 327,
  };
  const result = await settleFirstTopup(
    db,
    await captureTopupSettlement(db, a.id),
    payment,
    {
      ...payment,
      status: "reversal_evidence",
      refunds: [],
      disputes: [],
      refundsComplete: true,
      disputesComplete: true,
    },
    now,
  );
  assert.equal(result.status, "settled");
  const checkout = {
    ...session(a),
    status: "complete",
    payment_status: "paid",
    recovered_from: null,
    payment_intent: "pi_fixture",
    url: null,
  };
  checkout.line_items.data[0].price.active = false;
  const f = {
    a,
    key: result.paymentHash,
    checkout,
    intent: {
      object: "payment_intent",
      id: "pi_fixture",
      status: "succeeded",
      amount: 327,
      amount_received: 327,
      amount_capturable: 0,
      currency: "usd",
      livemode: false,
      latest_charge: "ch_fixture",
      metadata: { ...checkout.metadata },
    },
    charge: {
      object: "charge",
      id: "ch_fixture",
      payment_intent: "pi_fixture",
      status: "succeeded",
      amount: 327,
      amount_captured: 327,
      captured: true,
      paid: true,
      currency: "usd",
      livemode: false,
      amount_refunded: 0,
      refunded: false,
      disputed: false,
    },
    refunds: [],
    disputes: [],
    calls: [],
    before: async () => {},
    alter: () => {},
  };
  f.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    f.calls.push(url);
    await f.before(url);
    const path = new URL(url).pathname;
    let value;
    if (path === "/v1/checkout/sessions/cs_fixture") value = f.checkout;
    else if (path === "/v1/payment_intents/pi_fixture") value = f.intent;
    else if (path === "/v1/charges/ch_fixture") value = f.charge;
    else if (/^\/v1\/(refunds|disputes)\//.test(path)) {
      const [, , kind, id] = path.split("/");
      value = f[kind].find((v) => v.id === id) ?? {
        object: kind === "refunds" ? "refund" : "dispute",
        id: "missing",
      };
    } else {
      const kind = path.slice(4);
      assert.ok(["refunds", "disputes"].includes(kind));
      assert.equal(new URL(url).searchParams.get("charge"), "ch_fixture");
      value = { object: "list", url: path, data: f[kind], has_more: false };
    }
    value = structuredClone(value);
    f.alter(value, path);
    const response = new Response(JSON.stringify(value));
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return f;
}

const version = "2026-08-26.dahlia",
  on = { enabled: true };
async function setup(db) {
  const f = await paymentFixture(db);
  await db.prepare("DELETE FROM topup_history_coverage").run();
  await rotate(db, { livemode: false, schemaKey: "synthetic", expected: null }, on);
  const time = Date.parse(
    await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at"),
  );
  await db
    .prepare("UPDATE topup_history_coverage SET starts_at=?")
    .bind(new Date(time - 600000).toISOString())
    .run();
  const input = {
    livemode: false,
    schemaKey: "synthetic",
    apiVersions: [version],
    expected: (await capture(db, false, on)).coverage,
    from: Math.floor(time / 1000) - 120,
    to: Math.floor(time / 1000) - 60,
  };
  const target = {
    object: "event",
    id: "evt_target",
    created: input.from + 1,
    api_version: version,
    livemode: false,
    type: "refund.updated",
    data: { object: item("refund", "pending") },
  };
  f.refunds = [item("refund", "pending")];
  const base = f.fetch;
  f.pages = [[{ ...target, id: "evt_other" }], [target]];
  f.headers = [];
  f.pageCalls = 0;
  f.pageHook = async () => {};
  f.fetch = async (url, init) => {
    f.headers.push(init.headers.Authorization);
    if (new URL(url).pathname !== "/v1/events") return base(url, init);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    const n = f.pageCalls++,
      q = new URL(url).searchParams;
    assert.equal(q.get("limit"), "100");
    assert.equal(q.get("created[gte]"), String(input.from));
    assert.equal(q.get("created[lt]"), String(input.to));
    assert.equal(
      q.get("starting_after"),
      n % f.pages.length ? f.pages[(n - 1) % f.pages.length].at(-1).id : null,
    );
    await f.pageHook(n);
    const data = f.pages[n % f.pages.length],
      r = new Response(
        JSON.stringify({
          object: "list",
          url: "/v1/events",
          data,
          has_more: n % f.pages.length < f.pages.length - 1,
        }),
      );
    Object.defineProperty(r, "url", { value: url });
    return r;
  };
  f.config = { ...env, STRIPE_PRICE_TOPUP: "price_fixture" };
  f.input = input;
  f.target = target;
  f.time = time;
  f.options = {
    enabled: true,
    targetEventId: target.id,
    requestVersion: version,
    fetchImpl: f.fetch,
    resolveOffer: () => offer,
    clock: () => f.time,
    timeoutMs: 10000,
  };
  f.run = (database = db) => replay(database, f.config, f.input, f.options);
  return f;
}
const count = async (db, t) => (await rows(db, t)).length;
const revision = async (db) => (await rows(db, "topup_reconciliations"))[0].revision;
const balance = async (db) => {
  const p = (await rows(db, "topup_purchases"))[0];
  return [p.available, p.held, p.consumed, p.revoked];
};
export async function terminalSameSecondReplayObservesOnceWithoutCoverageOrBalance(db) {
  const f = await setup(db),
    before = (await capture(db, false, on)).coverage;
  assert.equal((await f.run()).status, "observed");
  assert.equal(f.pageCalls, 2);
  assert.equal(f.calls.length, 4);
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 2);
  assert.deepEqual(await balance(db), [25, 0, 0, 0]);
  assert.deepEqual((await capture(db, false, on)).coverage, before);
  assert.equal((await f.run()).status, "duplicate");
  assert.equal(await revision(db), 2);
  assert.equal(await count(db, "topup_history_receipts"), 1);
}
export async function missingDuplicateModeAccountAndTerminalFaultsNeverObserve(db) {
  for (const fault of ["missing", "duplicate", "mode", "account", "context", "terminal"]) {
    const f = await setup(db);
    if (fault === "missing") f.pages[1] = [{ ...f.target, id: "evt_missing" }];
    if (fault === "duplicate") f.pages[1] = [{ ...f.target, id: "evt_other" }];
    if (fault === "mode") f.target.livemode = true;
    if (fault === "account") f.target.account = "synthetic-other-context";
    if (fault === "context") f.target.context = "synthetic-context";
    if (fault === "terminal") {
      f.pages[0] = [f.target];
      f.pages[1] = [{ ...f.target, id: "evt_later", created: f.input.to }];
    }
    assert.equal((await f.run()).status, "closed", fault);
    if (fault === "terminal") assert.equal(f.pageCalls, 2);
    assert.equal(f.calls.length, 0);
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 1);
  }
}
export async function epochRotationDuringProviderReadsBlocksAdmission(db) {
  const f = await setup(db);
  let rotated = false;
  f.before = async () => {
    if (!rotated) {
      rotated = true;
      assert.equal(
        (await rotate(db, { livemode: false, schemaKey: "next", expected: f.input.expected }, on))
          .status,
        "committed",
      );
    }
  };
  assert.equal((await f.run()).status, "held");
  assert.equal(await count(db, "topup_history_receipts"), 0);
  const current = (await capture(db, false, on)).coverage;
  assert.equal(current.schema_key, "next");
  assert.equal(current.health, "unproven");
}
export async function deadlineAndLateProviderCannotReachObservation(db) {
  for (const phase of ["page", "target"]) {
    const f = await setup(db);
    if (phase === "page")
      f.pageHook = async () => {
        f.time += 10000;
      };
    else
      f.before = async (url) => {
        if (url.includes("/refunds/")) f.time += 10000;
      };
    assert.ok(["closed", "held"].includes((await f.run()).status));
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 1);
  }
}
export async function uncertainObservationCommitIsNeverRetried(db) {
  const f = await setup(db);
  let writes = 0;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (s) => {
      const result = await db.batch(s);
      if (s.length === 4) {
        writes++;
        throw Error("synthetic lost acknowledgement");
      }
      return result;
    },
  };
  assert.equal((await f.run(wrapped)).status, "closed");
  assert.equal(writes, 1);
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 2);
  assert.deepEqual(await balance(db), [25, 0, 0, 0]);
}
export async function oneCredentialSnapshotAndMalformedNoIo(db) {
  const f = await setup(db);
  f.pageHook = async () => {
    f.config.STRIPE_SECRET_KEY = "synthetic-rotated";
    f.config.STRIPE_PRICE_TOPUP = "price_changed";
  };
  assert.equal((await f.run()).status, "observed");
  assert.ok(f.headers.every((v) => v === "Bearer fixture-not-a-key"));
  let io = 0;
  const absent = {
    prepare() {
      io++;
      throw Error();
    },
    batch() {
      io++;
      throw Error();
    },
  };
  for (const options of [
    {},
    { ...f.options, enabled: false },
    { ...f.options, targetEventId: [] },
    { ...f.options, timeoutMs: 0 },
  ])
    assert.ok(["disabled", "held"].includes((await replay(absent, {}, f.input, options)).status));
  assert.equal(io, 0);
}

export async function noncooperativeLatePageIsCancelledWithoutAdmission(db) {
  const f = await setup(db);
  let release,
    cancelled = 0;
  f.options.timeoutMs = 1000;
  f.options.fetchImpl = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const result = await f.run();
  assert.ok(["closed", "held"].includes(result.status));
  assert.equal(typeof release, "function");
  {
    const response = new Response(
      new ReadableStream(
        {
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
    );
    release(response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, 1);
  }
  assert.equal(await count(db, "topup_history_receipts"), 0);
  assert.equal(await revision(db), 1);
}
export async function alreadyAdmittedObservationMayCommitAfterDeadlineAndRotation(db) {
  const f = await setup(db);
  let writes = 0;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (s) => {
      if (s.length === 4) {
        writes++;
        await rotate(db, { livemode: false, schemaKey: "next", expected: f.input.expected }, on);
        f.time += 10000;
      }
      return db.batch(s);
    },
  };
  assert.equal((await f.run(wrapped)).status, "held");
  assert.equal(writes, 1);
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 2);
  assert.equal((await capture(db, false, on)).coverage.schema_key, "next");
  assert.deepEqual(await balance(db), [25, 0, 0, 0]);
}

export async function observationAdmissionRequiresExactTrue(db) {
  for (const value of [false, { status: "unknown" }, "reject"]) {
    const f = await setup(db);
    const result = await observeVerifiedTopupEvent(db, f.config, f.target, {
      ...f.options,
      livemode: false,
      apiVersions: [version],
      beforeObserve: async () => {
        if (value === "reject") throw Error("synthetic uncertainty");
        return value;
      },
    });
    assert.ok(["pending", "unavailable"].includes(result.status));
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 1);
  }
}

export async function closureHasOneOwnerAcrossDeadlineAndDelayedCommittedAck(db) {
  for (const fault of ["503", "throw", "stall"]) {
    const f = await setup(db);
    let attempts = 0,
      release,
      latePage,
      cancelled = 0,
      captures = 0;
    f.options.timeoutMs = 500;
    f.options.fetchImpl = async () => {
      if (fault === "throw") throw Error("synthetic read failure");
      if (fault === "stall")
        return new Promise((resolve) => {
          latePage = resolve;
        });
      return new Response(null, { status: 503 });
    };
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        const result = await db.batch(s);
        if (fault === "stall" && s.length === 1 && captures++ === 0)
          await new Promise((resolve) => setTimeout(resolve, 250));
        if (s.length === 2) {
          attempts++;
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return result;
      },
    };
    assert.equal((await f.run(wrapped)).status, "held");
    // The real D1 commit can precede its unavailable acknowledgement.
    for (let n = 0; !release && n < 50; n++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(typeof release, "function");
    assert.equal(attempts, 1);
    assert.equal((await capture(db, false, on)).coverage.revision, f.input.expected.revision + 1);
    release();
    if (fault === "stall") {
      assert.equal(typeof latePage, "function");
      latePage(
        new Response(
          new ReadableStream(
            {
              cancel() {
                cancelled++;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts, 1);
    if (fault === "stall") assert.equal(cancelled, 1);
    assert.equal(await count(db, "topup_history_receipts"), 0);
  }
}
export async function observationAckCannotReportSuccessForReplacementEpoch(db) {
  const f = await setup(db);
  let writes = 0;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (s) => {
      if (s.length === 4) {
        writes++;
        await rotate(
          db,
          { livemode: false, schemaKey: "replacement", expected: f.input.expected },
          on,
        );
      }
      return db.batch(s);
    },
  };
  assert.equal((await f.run(wrapped)).status, "held");
  assert.equal(writes, 1);
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 2);
  const epoch = (await capture(db, false, on)).coverage;
  assert.equal(epoch.schema_key, "replacement");
  assert.equal(epoch.health, "unproven");
  assert.deepEqual(await balance(db), [25, 0, 0, 0]);
}
export async function noClosureAuthorityBeforeValidatedCaptureAndRequestVersion(db) {
  for (const fault of ["cross-mode", "version", "date", "malformed", "window"]) {
    const f = await setup(db);
    await rotate(db, { livemode: true, schemaKey: "synthetic", expected: null }, on);
    const live = (await capture(db, true, on)).coverage,
      test = (await capture(db, false, on)).coverage;
    if (fault === "cross-mode") f.input.expected = live;
    if (fault === "version") delete f.options.requestVersion;
    if (fault === "date") f.options.requestVersion = "2026-02-30";
    if (fault === "malformed") f.options.requestVersion = "invalid";
    if (fault === "window") f.input.from = f.input.to;
    let samples = 0,
      closeCalls = 0;
    f.options.clock = () => f.time + (samples++ ? 10000 : 0);
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        if (s.length === 2) closeCalls++;
        return db.batch(s);
      },
    };
    assert.equal((await f.run(wrapped)).status, "held");
    assert.equal(closeCalls, 0);
    assert.equal(f.pageCalls, 0);
    assert.deepEqual((await capture(db, true, on)).coverage, live);
    assert.deepEqual((await capture(db, false, on)).coverage, test);
    assert.equal(await count(db, "topup_history_receipts"), 0);
  }
}
