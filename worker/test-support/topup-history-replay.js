import assert from "node:assert/strict";
import { captureTopupSettlement, settleFirstTopup } from "../src/topup-first-settlement.js";
import { attempt, session } from "./topup-stripe.js";
import { validateTopupHistoryTraversal } from "../src/topup-history-traversal.js";
import { observeVerifiedTopupEvent } from "../src/topup-history-events.js";
import { readEmployerHistoryObject } from "../src/topup-stripe.js";
import {
  replayTopupHistoryTarget as replay,
  replayTopupHistoryWindow,
} from "../src/topup-history-replay.js";
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

const windowReplay = (db, f, extra = {}) => {
  const { targetEventId: _target, ...options } = f.options;
  return replayTopupHistoryWindow(db, f.config, f.input, { ...options, ...extra });
};
export async function wholeWindowSequentialMixedSameSecondAndDuplicateReplay(db) {
  const f = await setup(db),
    before = (await capture(db, false, on)).coverage;
  f.disputes = [item("dispute", "under_review")];
  const dispute = {
      ...f.target,
      id: "evt_dispute",
      type: "charge.dispute.updated",
      data: { object: f.disputes[0] },
    },
    charge = {
      ...f.target,
      id: "evt_charge",
      type: "charge.refunded",
      data: { object: { ...f.charge } },
    };
  f.pages = [[f.target, dispute], [charge]];
  assert.deepEqual(await windowReplay(db, f), {
    status: "handled_unproven",
    observed: 3,
    duplicate: 0,
    inactive: 0,
  });
  assert.equal(await count(db, "topup_history_receipts"), 3);
  assert.equal(await revision(db), 4);
  assert.equal(f.calls.length, 11);
  assert.equal(f.pageCalls, 2);
  assert.deepEqual((await capture(db, false, on)).coverage, before);
  assert.deepEqual(await balance(db), [25, 0, 0, 0]);
  assert.deepEqual(await windowReplay(db, f), {
    status: "handled_unproven",
    observed: 0,
    duplicate: 3,
    inactive: 0,
  });
  assert.equal(await revision(db), 4);
  assert.equal(await count(db, "topup_history_receipts"), 3);
  // The old target API still admits only its explicitly selected event.
  assert.equal((await f.run()).status, "duplicate");
  assert.equal(await revision(db), 4);
}
export async function wholeWindowTerminalValidationPrecedesEveryObservation(db) {
  for (const fault of ["duplicate", "terminal", "mode", "context", "pages"]) {
    const f = await setup(db);
    f.pages = [[f.target], [{ ...f.target, id: "evt_last" }]];
    if (fault === "duplicate") f.pages[1][0].id = f.target.id;
    if (fault === "terminal") f.pages[1][0].created = f.input.to;
    if (fault === "mode") f.pages[1][0].livemode = true;
    if (fault === "context") f.pages[1][0].account = "synthetic-other";
    if (fault === "pages")
      f.pages = Array.from({ length: 5 }, (_, i) => [{ ...f.target, id: "evt_page" + i }]);
    assert.equal((await windowReplay(db, f)).status, "closed", fault);
    assert.equal(f.calls.length, 0);
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 1);
    assert.equal(f.pageCalls, fault === "pages" ? 4 : 2);
  }
}
export async function wholeWindowUnknownOrUnmatchedAfterObservationNeverSkips(db) {
  for (const fault of ["unknown", "unmatched"]) {
    const f = await setup(db),
      bad = structuredClone(f.target);
    bad.id = "evt_unresolved";
    if (fault === "unknown") bad.type = "customer.updated";
    else bad.data.object.payment_intent = "pi_unmatched";
    f.pages = [[f.target, bad]];
    assert.equal((await windowReplay(db, f)).status, "closed");
    assert.equal(await count(db, "topup_history_receipts"), 1);
    assert.equal(await revision(db), 2);
    assert.deepEqual(await balance(db), [25, 0, 0, 0]);
    assert.equal(f.calls.length, 4);
    assert.equal((await capture(db, false, on)).coverage.health, "closed");
  }
}
export async function wholeWindowCommitLossRotationAndDeadlineStopRemainingEvents(db) {
  for (const fault of ["lost-ack", "rotate", "deadline"]) {
    const f = await setup(db);
    f.pages = [[f.target, { ...f.target, id: "evt_second" }, { ...f.target, id: "evt_third" }]];
    let writes = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        const result = await db.batch(s);
        if (s.length === 4) {
          writes++;
          if (fault === "lost-ack" && writes === 2) throw Error("synthetic acknowledgement lost");
          if (fault === "rotate")
            await rotate(
              db,
              { livemode: false, schemaKey: "replacement", expected: f.input.expected },
              on,
            );
          if (fault === "deadline") f.time += 10000;
        }
        return result;
      },
    };
    assert.ok(["closed", "held"].includes((await windowReplay(wrapped, f)).status));
    assert.equal(writes, fault === "lost-ack" ? 2 : 1);
    assert.equal(await count(db, "topup_history_receipts"), writes);
    assert.equal(await revision(db), writes + 1);
    assert.deepEqual(await balance(db), [25, 0, 0, 0]);
    if (fault === "rotate") {
      const epoch = (await capture(db, false, on)).coverage;
      assert.equal(epoch.schema_key, "replacement");
      assert.equal(epoch.health, "unproven");
    }
  }
}
export async function wholeWindowEmptyAndStaleEpochRemainUnproven(db) {
  const f = await setup(db),
    before = (await capture(db, false, on)).coverage;
  f.pages = [[]];
  assert.deepEqual(await windowReplay(db, f), {
    status: "handled_unproven",
    observed: 0,
    duplicate: 0,
    inactive: 0,
  });
  assert.deepEqual((await capture(db, false, on)).coverage, before);
  assert.equal(f.calls.length, 0);
  await rotate(db, { livemode: false, schemaKey: "replacement", expected: before }, on);
  assert.equal((await windowReplay(db, f)).status, "held");
  assert.equal(f.pageCalls, 1);
  assert.equal(await count(db, "topup_history_receipts"), 0);
  assert.equal((await windowReplay(db, f, { enabled: false })).status, "disabled");
  assert.equal((await windowReplay(db, f, { targetEventId: "evt_target" })).status, "held");
}

export async function terminalCollectionUsesExistingFourHundredEventBound(db) {
  const f = await setup(db);
  let pages = 0;
  const options = {
    enabled: true,
    collectEvents: true,
    clock: () => f.time,
    readPage: async (query) => {
      const page = pages++;
      assert.equal(query.limit, 100);
      assert.equal(query.starting_after, page ? `evt_${page - 1}_99` : undefined);
      const data = Array.from({ length: 100 }, (_, i) => ({ ...f.target, id: `evt_${page}_${i}` }));
      return new Response(
        JSON.stringify({ object: "list", url: "/v1/events", data, has_more: page < 3 }),
      );
    },
  };
  const result = await validateTopupHistoryTraversal(db, f.input, options);
  assert.equal(result.status, "unproven");
  assert.equal(result.events.length, 400);
  assert.equal(pages, 4);
  assert.equal(await count(db, "topup_history_receipts"), 0);
  assert.equal(await revision(db), 1);
  for (const extra of [{ collectEvents: "1" }, { targetEventId: "evt_target" }]) {
    const rejected = await validateTopupHistoryTraversal(db, f.input, {
      ...options,
      ...extra,
      readPage: () => assert.fail("no IO"),
    });
    assert.equal(rejected.status, "held");
  }
}

async function employerFixture(db, kind = "refund") {
  const f = await setup(db),
    orderId = "o-1111111111111111";
  await db.prepare("DELETE FROM employer_orders").run();
  await db
    .prepare(
      "INSERT INTO employer_orders(id,created,updated,status,package,start_day,employer_key,employer,company,name,email,email_domain,terms_version,terms_at,price,paid_amount,paid_at,paid_ref,payment_intent,paid_session) VALUES(?,?,?,'paid','one','2026-11-11','fixture','Fixture','Fixture','Synthetic','fixture@example.invalid','example.invalid','fixture',?,1000,900,?,'stripe:pi_employer','pi_employer','cs_employer')",
    )
    .bind(orderId, now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString())
    .run();
  const metadata = { kind: "listing", order: orderId };
  f.employer = {
    target: {
      ...item(kind === "charge" ? "refund" : kind, "succeeded", 100),
      charge: "ch_employer",
      payment_intent: "pi_employer",
    },
    charge: {
      ...f.charge,
      id: "ch_employer",
      payment_intent: "pi_employer",
      amount: 900,
      amount_captured: 900,
    },
    intent: {
      ...f.intent,
      id: "pi_employer",
      latest_charge: "ch_employer",
      amount: 900,
      amount_received: 900,
      metadata,
    },
    checkout: {
      object: "checkout.session",
      id: "cs_employer",
      livemode: false,
      currency: "usd",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      client_reference_id: orderId,
      recovered_from: null,
      payment_intent: "pi_employer",
      metadata,
      amount_subtotal: 1000,
      amount_total: 900,
      total_details: { amount_discount: 100, amount_tax: 0, amount_shipping: 0 },
      line_items: {
        object: "list",
        url: "/v1/checkout/sessions/cs_employer/line_items",
        has_more: false,
        data: [
          {
            object: "item",
            id: "li_employer",
            quantity: 1,
            currency: "usd",
            amount_subtotal: 1000,
            amount_total: 900,
            price: {
              object: "price",
              id: "price_employer",
              type: "one_time",
              livemode: false,
              currency: "usd",
              unit_amount: 1000,
            },
          },
        ],
      },
    },
  };
  f.employer.target.id = kind === "dispute" ? "du_employer" : "re_employer";
  f.employerEvent = {
    ...f.target,
    id: "evt_employer",
    type:
      kind === "charge"
        ? "charge.refunded"
        : kind === "dispute"
          ? "charge.dispute.updated"
          : "refund.updated",
    data: { object: structuredClone(kind === "charge" ? f.employer.charge : f.employer.target) },
  };
  f.pages = [[f.employerEvent]];
  const original = f.fetch;
  f.encode = (value) => JSON.stringify(value);
  f.options.fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const name = new Map([
      ["/v1/charges/ch_employer", "charge"],
      ["/v1/payment_intents/pi_employer", "intent"],
      ["/v1/checkout/sessions/cs_employer", "checkout"],
      ["/v1/refunds/re_employer", "target"],
      ["/v1/disputes/du_employer", "target"],
    ]).get(path);
    if (!name) return original(url, init);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, "Bearer fixture-not-a-key");
    assert.equal(init.headers["Stripe-Version"], version);
    if (name === "checkout")
      assert.deepEqual([...new URL(url).searchParams], [["expand[]", "line_items"]]);
    f.calls.push(url);
    await f.before(url);
    const value = structuredClone(f.employer[name]);
    f.alter(value, path);
    const r = new Response(f.encode(value, path));
    Object.defineProperty(r, "url", { value: url });
    return r;
  };
  f.exclude = (database = db, extra = {}) =>
    windowReplay(database, f, { excludeEmployerPayments: true, ...extra });
  return f;
}

export async function employerPositiveMixedWindowHasNoFinancialOrCoverageAuthority(db) {
  for (const kind of ["refund", "dispute", "charge"]) {
    const f = await employerFixture(db, kind),
      before = (await capture(db, false, on)).coverage;
    f.employerEvent.data.object.metadata = { kind: "listing", order: "o-1111111111111111" };
    delete f.config.STRIPE_PRICE_TOPUP;
    assert.deepEqual(await f.exclude(), {
      status: "handled_unproven",
      observed: 0,
      duplicate: 0,
      inactive: 0,
      excluded: 1,
    });
    assert.equal(f.calls.length, kind === "charge" ? 3 : 4);
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 1);
    assert.deepEqual(await balance(db), [25, 0, 0, 0]);
    assert.deepEqual((await capture(db, false, on)).coverage, before);
  }
  const f = await employerFixture(db);
  f.pages = [[f.target, f.employerEvent]];
  assert.deepEqual(await f.exclude(), {
    status: "handled_unproven",
    observed: 1,
    duplicate: 0,
    inactive: 0,
    excluded: 1,
  });
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 2);
  assert.deepEqual(await balance(db), [25, 0, 0, 0]);
}
export async function employerProofRejectsWrongCurrentProviderAssociation(db) {
  const mutations = [
    (f) => (f.employer.target.metadata = []),
    (f) =>
      (f.employerEvent.data.object.metadata = { kind: "listing", order: "o-2222222222222222" }),
    (f) => (f.employer.target.charge = "ch_other"),
    (f) => (f.employer.target.payment_intent = "pi_other"),
    (f) => (f.employer.target.id = "re_other"),
    (f) => (f.employer.charge.payment_intent = "pi_other"),
    (f) => (f.employer.intent.latest_charge = "ch_other"),
    (f) => (f.employer.intent.metadata = { kind: "autofill_topup" }),
    (f) => (f.employer.checkout.metadata = { kind: "listing", order: "o-2222222222222222" }),
    (f) => (f.employer.checkout.metadata.attempt_id = "synthetic"),
    (f) => (f.employer.checkout.payment_intent = "pi_other"),
    (f) => (f.employer.checkout.livemode = true),
  ];
  for (const mutate of mutations) {
    const f = await employerFixture(db);
    mutate(f);
    assert.equal((await f.exclude()).status, "closed");
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.ok(f.calls.length <= 4);
  }
}
export async function employerProofRequiresCompleteExactPaidEconomics(db) {
  for (const fault of [
    "partial",
    "items",
    "quantity",
    "currency",
    "subtotal",
    "total",
    "price",
    "discount",
    "charge",
    "intent",
  ]) {
    const f = await employerFixture(db),
      s = f.employer.checkout,
      i = s.line_items.data[0];
    if (fault === "partial") s.line_items.has_more = true;
    if (fault === "items") s.line_items.data.push(structuredClone(i));
    if (fault === "quantity") i.quantity = 2;
    if (fault === "currency") i.currency = "eur";
    if (fault === "subtotal") s.amount_subtotal++;
    if (fault === "total") i.amount_total++;
    if (fault === "price") i.price.unit_amount++;
    if (fault === "discount") s.total_details.amount_discount++;
    if (fault === "charge") f.employer.charge.amount_captured--;
    if (fault === "intent") f.employer.intent.amount_received--;
    assert.equal((await f.exclude()).status, "closed", fault);
    assert.equal(await count(db, "topup_history_receipts"), 0);
  }
}
export async function employerExclusionNeverUsesGenericPendingOrUnknownFamily(db) {
  for (const fault of [
    "default",
    "unknown",
    "marked",
    "missing-order",
    "unpaid-order",
    "zero-paid",
    "false-claim-ack",
  ]) {
    const f = await employerFixture(db);
    if (fault === "unknown") f.employerEvent.type = "customer.updated";
    if (fault === "marked") f.employerEvent.data.object.metadata = { kind: "autofill_topup" };
    if (fault === "missing-order") await db.prepare("DELETE FROM employer_orders").run();
    if (fault === "unpaid-order")
      await db.prepare("UPDATE employer_orders SET status='verified'").run();
    if (fault === "zero-paid") await db.prepare("UPDATE employer_orders SET paid_amount=0").run();
    const wrapped = {
      prepare: (sql) => db.prepare(sql),
      batch: async (ss) => {
        const r = await db.batch(ss);
        if (fault === "false-claim-ack" && ss.length === 1 && r[0].results.length === 0)
          r[0].success = false;
        return r;
      },
    };
    assert.equal(
      (await f.exclude(wrapped, { excludeEmployerPayments: fault !== "default" })).status,
      "closed",
      fault,
    );
    assert.equal(f.calls.length, 0, fault);
    assert.equal(await count(db, "topup_history_receipts"), 0);
  }
}
export async function employerFinalTupleEpochAndDeadlineRacesStayHeld(db) {
  for (const fault of ["delete", "change", "claim", "attempt", "epoch", "deadline", "ack"]) {
    const f = await employerFixture(db);
    f.before = async (url) => {
      if (!url.includes("checkout/sessions")) return;
      if (fault === "delete") await db.prepare("DELETE FROM employer_orders").run();
      if (fault === "change") await db.prepare("UPDATE employer_orders SET paid_amount=901").run();
      if (fault === "attempt")
        await db.prepare("UPDATE topup_checkout_attempts SET checkout_id='cs_employer'").run();
      if (fault === "claim")
        await db
          .prepare("UPDATE topup_claims SET checkout_hash=?")
          .bind(
            await import("../src/topup-ledger.js").then((m) =>
              m.referenceHash("checkout", false, "cs_employer"),
            ),
          )
          .run();
      if (fault === "epoch")
        await rotate(
          db,
          { livemode: false, schemaKey: "replacement", expected: f.input.expected },
          on,
        );
      if (fault === "deadline") f.time += 10000;
    };
    let lost = 0;
    const wrapped = {
      prepare: (sql) => db.prepare(sql),
      batch: async (ss) => {
        const r = await db.batch(ss);
        if (fault === "ack" && ss.length === 2 && r[0].results[0]?.id === "o-1111111111111111") {
          lost++;
          throw Error("synthetic lost read ack");
        }
        return r;
      },
    };
    assert.ok(["held", "closed"].includes((await f.exclude(wrapped)).status), fault);
    assert.equal(lost, fault === "ack" ? 1 : 0);
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.deepEqual(await balance(db), [25, 0, 0, 0]);
    if (fault === "epoch")
      assert.equal((await capture(db, false, on)).coverage.schema_key, "replacement");
  }
}
export async function employerDiscoveryUsesFiveReadsAndFixedPortRejectsInvalidKind(db) {
  const f = await employerFixture(db);
  delete f.employerEvent.data.object.payment_intent;
  assert.equal((await f.exclude()).excluded, 1);
  assert.equal(f.calls.length, 5);
  for (const kind of ["constructor", "__proto__", "refunds", "prices", "charges/elsewhere"]) {
    await assert.rejects(
      readEmployerHistoryObject(env, kind, "ch_employer", () => assert.fail("no IO")),
    );
  }
  const g = await employerFixture(db);
  g.pages = [[g.employerEvent], [{ ...g.employerEvent, id: "evt_invalid", created: g.input.to }]];
  assert.equal((await g.exclude()).status, "closed");
  assert.equal(g.calls.length, 0);
}

async function malformedEmployerBytes(db, fault) {
  for (const phase of ["refund", "dispute", "charge", "intent", "checkout", "discovery"]) {
    const f = await employerFixture(db, phase === "dispute" ? "dispute" : "refund");
    if (phase === "discovery") delete f.employerEvent.data.object.payment_intent;
    const paths = {
      refund: "/v1/refunds/re_employer",
      dispute: "/v1/disputes/du_employer",
      charge: "/v1/charges/ch_employer",
      intent: "/v1/payment_intents/pi_employer",
      checkout: "/v1/checkout/sessions/cs_employer",
      discovery: "/v1/charges/ch_employer",
    };
    let malformed = 0;
    f.encode = (value, path) => {
      const text = JSON.stringify(value);
      if (path !== paths[phase]) return text;
      malformed++;
      if (fault === "utf8") {
        const encoder = new TextEncoder();
        return new Uint8Array([
          ...encoder.encode(text.slice(0, -1) + ',"ignored":"'),
          255,
          ...encoder.encode('"}'),
        ]);
      }
      const first = fault === "escaped" ? '"meta\\u0064ata"' : '"metadata"';
      const contradiction = first + ':{"kind":"autofill_topup"},"metadata":';
      return text.includes('"metadata":')
        ? text.replace('"metadata":', contradiction)
        : text.slice(0, -1) + "," + contradiction + "{}}";
    };
    assert.equal((await f.exclude()).status, "closed", phase + ":" + fault);
    assert.equal(malformed, 1);
    assert.equal(
      f.calls.length,
      { refund: 1, dispute: 1, charge: 2, intent: 3, checkout: 4, discovery: 1 }[phase],
    );
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 1);
    assert.deepEqual(await balance(db), [25, 0, 0, 0]);
  }
}
export async function employerRawDuplicateMetadataCannotHideTopupAssociation(db) {
  await malformedEmployerBytes(db, "duplicate");
}
export async function employerEscapedDuplicateNamesCannotHideTopupAssociation(db) {
  await malformedEmployerBytes(db, "escaped");
}
export async function employerMalformedUtf8CannotAuthorizeExclusion(db) {
  await malformedEmployerBytes(db, "utf8");
}
