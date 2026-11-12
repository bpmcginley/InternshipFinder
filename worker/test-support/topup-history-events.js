// Real readers and SQL helpers; synthetic GET responses only in Node and local Workers/D1.
import assert from "node:assert/strict";
import { captureTopupSettlement, settleFirstTopup } from "../src/topup-first-settlement.js";
import { observeVerifiedTopupEvent as observe } from "../src/topup-history-events.js";
import { readVerifiedTopupPurchase } from "../src/topup-purchase-recovery.js";
import { readTopupAssociation } from "../src/topup-stripe.js";
import { attempt, session } from "./topup-stripe.js";
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
async function setup(db) {
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

const version = "2026-08-26.dahlia";
const event = (kind = "refund", id = "evt_fixture") => ({
  object: "event",
  id,
  api_version: version,
  livemode: false,
  type: { refund: "refund.updated", dispute: "charge.dispute.updated", charge: "charge.refunded" }[
    kind
  ],
  data: {
    object: {
      ...item(kind, "pending", 1),
      id: { refund: "re_fixture", dispute: "du_fixture", charge: "ch_fixture" }[kind],
      ...(kind === "charge" ? { livemode: false } : {}),
    },
  },
});
const call = (db, f, e = event(), extra = {}) =>
  observe(db, { ...env, STRIPE_PRICE_TOPUP: "price_fixture" }, e, {
    enabled: true,
    livemode: false,
    apiVersions: [version],
    resolveOffer: () => offer,
    fetchImpl: f.fetch,
    ...extra,
  });
const state = async (db) => ({
  purchase: await db.prepare("SELECT * FROM topup_purchases").first(),
  receipts: await rows(db, "topup_history_receipts"),
  revision: (await rows(db, "topup_reconciliations"))[0]?.revision,
  retention: (await rows(db, "topup_retention"))[0],
});
export async function verifiedFamiliesObserveWithoutChangingBalances(db) {
  for (const kind of ["refund", "dispute", "charge"]) {
    const f = await setup(db);
    f.refunds = [item("refund", "pending", 1)];
    f.disputes = [item("dispute", "under_review", 1)];
    f.charge.disputed = true;
    const before = await state(db);
    assert.deepEqual(await call(db, f, event(kind)), { status: "observed", revision: 2 });
    const after = await state(db);
    assert.deepEqual(after.purchase, before.purchase);
    assert.equal(after.receipts.length, 1);
    assert.equal(after.retention.resolved_zero_since, null);
    assert.equal(after.retention.evidence_digest, null);
    assert.deepEqual(await call(db, f, event(kind)), { status: "duplicate" });
    assert.equal((await state(db)).revision, 2);
    assert.deepEqual(await call(db, f, event(kind, "evt_new")), {
      status: "observed",
      revision: 3,
    });
  }
}
export async function discoveryIsHintThenExactCaptureAndMembership(db) {
  const f = await setup(db);
  f.refunds = [item("refund", "pending", 1)];
  const e = event();
  delete e.data.object.payment_intent;
  let first = true;
  f.before = async (url) => {
    if (first) {
      first = false;
      assert.ok(url.endsWith("charges/ch_fixture"));
      await db.prepare("UPDATE topup_reconciliations SET revision=2").run();
    } else assert.equal((await state(db)).revision, 2);
  };
  assert.deepEqual(await call(db, f, e), { status: "observed", revision: 3 });
  assert.equal(f.calls.length, 5);
}
export async function missingCrossedUnsupportedAndUnsettledNeverObserve(db) {
  for (const fault of [
    "member",
    "charge",
    "payment",
    "mode",
    "schema",
    "type",
    "account",
    "deleted",
    "unsettled",
  ]) {
    const f = await setup(db);
    f.refunds = [item("refund", "pending", 1)];
    const e = event();
    if (fault === "member") e.data.object.id = "re_other";
    if (fault === "charge") e.data.object.charge = "ch_other";
    if (fault === "payment") e.data.object.payment_intent = "pi_other";
    if (fault === "mode") e.livemode = true;
    if (fault === "schema") e.api_version = "unknown";
    if (fault === "type") e.type = "refund.unreviewed";
    if (fault === "account") e.account = "fixture-account";
    if (fault === "deleted") {
      await db.prepare("UPDATE topup_claims SET state='deleted'").run();
      await db.prepare("DELETE FROM topup_purchases").run();
    }
    if (fault === "unsettled") await db.prepare("DELETE FROM topup_purchases").run();
    assert.deepEqual(await call(db, f, e), {
      status: fault === "deleted" ? "inactive" : "pending",
    });
    assert.equal((await rows(db, "topup_history_receipts")).length, 0);
  }
}
export async function concurrentRevisionDeletionAndRollbackStayClosed(db) {
  for (const fault of ["revision", "delete", "rollback"]) {
    const f = await setup(db);
    f.refunds = [item("refund", "pending", 1)];
    let once = true;
    f.before = async () => {
      if (!once) return;
      once = false;
      if (fault === "revision")
        await db.prepare("UPDATE topup_reconciliations SET revision=revision+1").run();
      if (fault === "delete") {
        await db.prepare("UPDATE topup_claims SET state='deleted'").run();
        await db.prepare("DELETE FROM topup_purchases").run();
      }
      if (fault === "rollback")
        await db
          .prepare(
            "CREATE TRIGGER fixture_purchase_abort BEFORE INSERT ON topup_history_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END",
          )
          .run();
    };
    const result = await call(db, f);
    assert.ok(["pending", "unavailable"].includes(result.status));
    assert.equal((await rows(db, "topup_history_receipts")).length, 0);
  }
}
export async function unknownCommittedAcknowledgementNeverRetries(db) {
  const f = await setup(db);
  f.refunds = [item("refund", "pending", 1)];
  let observed = 0;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (statements) => {
      const result = await db.batch(statements);
      if (statements.length === 4) {
        observed++;
        throw new Error("fixture-private");
      }
      return result;
    },
  };
  assert.deepEqual(await call(wrapped, f), { status: "unavailable" });
  assert.equal(observed, 1);
  assert.equal((await state(db)).revision, 2);
  assert.equal((await state(db)).receipts.length, 1);
  assert.deepEqual(await call(db, f), { status: "duplicate" });
  assert.equal((await state(db)).revision, 2);
}
export async function deadlineCancelsLateResponseAndCannotObserve(db) {
  const f = await setup(db);
  let resolve,
    cancelled = 0,
    calls = 0,
    signal;
  const transport = async (url, init) => {
    calls++;
    signal = init.signal;
    return new Promise((r) => {
      resolve = () => {
        const response = new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
        );
        Object.defineProperty(response, "url", { value: url });
        r(response);
      };
    });
  };
  assert.deepEqual(await call(db, f, event(), { fetchImpl: transport, timeoutMs: 1000 }), {
    status: "unavailable",
  });
  assert.equal(signal.aborted, true);
  resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.equal((await state(db)).receipts.length, 0);
}
export async function stalledBodyAndDisabledFailClosed(db) {
  const f = await setup(db);
  let cancelled = 0;
  assert.deepEqual(await call(db, f, event(), { enabled: false }), { status: "disabled" });
  assert.equal(f.calls.length, 0);
  const fetchImpl = async (url) => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    );
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  assert.deepEqual(await call(db, f, event(), { fetchImpl, timeoutMs: 1000 }), {
    status: "unavailable",
  });
  assert.equal(cancelled, 1);
  assert.equal((await state(db)).receipts.length, 0);
}
export async function rejectedProviderResponsesNeverObserve(db) {
  for (const fault of ["status", "redirect", "url", "getter", "unknown"]) {
    const f = await setup(db);
    let calls = 0,
      cancelled = 0;
    const fetchImpl = async (url) => {
      calls++;
      if (fault === "unknown") throw new Error("fixture-private");
      const response = new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: fault === "status" ? 500 : 200 },
      );
      Object.defineProperty(
        response,
        "url",
        fault === "getter"
          ? {
              get() {
                throw new Error("fixture-private");
              },
            }
          : { value: fault === "url" ? "https://example.invalid" : url },
      );
      if (fault === "redirect") Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    assert.ok(
      ["pending", "unavailable"].includes((await call(db, f, event(), { fetchImpl })).status),
    );
    assert.equal(calls, 1);
    assert.equal(cancelled, fault === "unknown" ? 0 : 1);
    assert.equal((await state(db)).receipts.length, 0);
  }
}
export async function admittedCommitMayOutliveDeadlineWithoutRetry(db) {
  const f = await setup(db);
  f.refunds = [item("refund", "pending", 1)];
  let release,
    commits = 0;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (statements) => {
      const result = await db.batch(statements);
      if (statements.length === 4) {
        commits++;
        await new Promise((r) => {
          release = r;
        });
      }
      return result;
    },
  };
  const result = await call(wrapped, f, event(), { timeoutMs: 1000 });
  assert.deepEqual(result, { status: "unavailable" });
  assert.equal(commits, 1);
  assert.equal((await state(db)).revision, 2);
  assert.equal((await state(db)).receipts.length, 1);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(result, { status: "unavailable" });
  assert.deepEqual(await call(db, f), { status: "duplicate" });
  assert.equal((await state(db)).revision, 2);
}
export async function schemaVersionsMustBePrimitiveDenseOwnDataBeforeIO(db) {
  const f = await setup(db);
  f.refunds = [item("refund", "pending", 1)];
  const before = await state(db);
  let io = 0,
    getters = 0;
  const source = {
    prepare() {
      io++;
      throw new Error("unexpected database access");
    },
    batch() {
      io++;
      throw new Error("unexpected database access");
    },
  };
  const missing = event();
  delete missing.api_version;
  assert.deepEqual(await call(db, f, missing, { apiVersions: new Array(1) }), {
    status: "pending",
  });
  assert.deepEqual(await state(db), before);
  assert.equal(f.calls.length, 0);
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, { 0: { value: version } }));
  const accessor = [version];
  Object.defineProperty(accessor, 0, {
    get() {
      getters++;
      return version;
    },
  });
  const inheritedEvent = event();
  delete inheritedEvent.api_version;
  Object.setPrototypeOf(inheritedEvent, { api_version: version });
  const accessorEvent = event();
  Object.defineProperty(accessorEvent, "api_version", {
    get() {
      getters++;
      return version;
    },
  });
  const cases = [
    [missing, new Array(1)],
    [event(), new Array(1)],
    [event(), inherited],
    [event(), accessor],
    [event(), [version, version]],
    [inheritedEvent, [version]],
    [accessorEvent, [version]],
    ...[undefined, null, {}, new String(version), 1, "", "bad version"].map((v) => [
      { ...event(), api_version: v },
      [version],
    ]),
  ];
  for (const [e, apiVersions] of cases)
    assert.deepEqual(await call(source, f, e, { apiVersions }), { status: "pending" });
  assert.equal(io, 0);
  assert.equal(getters, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await state(db), before);
}
export async function providerConfigurationIsPinnedBeforeDiscovery(db) {
  const f = await setup(db);
  f.refunds = [item("refund", "pending", 1)];
  const e = event();
  delete e.data.object.payment_intent;
  const config = { STRIPE_SECRET_KEY: "fixture-before", STRIPE_PRICE_TOPUP: "price_fixture" };
  const auth = [];
  const fetchImpl = async (url, init) => {
    auth.push(init.headers.Authorization);
    const response = await f.fetch(url, init);
    config.STRIPE_SECRET_KEY = "fixture-after";
    config.STRIPE_PRICE_TOPUP = "price_changed";
    return response;
  };
  assert.deepEqual(
    await observe(db, config, e, {
      enabled: true,
      livemode: false,
      apiVersions: [version],
      resolveOffer: () => offer,
      fetchImpl,
    }),
    { status: "observed", revision: 2 },
  );
  assert.equal(auth.length, 5);
  assert.deepEqual(auth, Array(5).fill("Bearer fixture-before"));
}
export async function oversizedLengthNeverPullsUpstreamBody(db) {
  const f = await setup(db);
  let pulls = 0,
    cancelled = 0,
    calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const response = new Response(
      new ReadableStream(
        {
          pull(out) {
            pulls++;
            out.enqueue(new Uint8Array([123]));
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "Content-Length": "262145" } },
    );
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  assert.deepEqual(await call(db, f, event(), { fetchImpl }), { status: "pending" });
  assert.equal(calls, 1);
  assert.equal(pulls, 0);
  assert.equal(cancelled, 1);
  assert.equal((await state(db)).receipts.length, 0);
  assert.equal((await state(db)).revision, 1);
}
export async function targetedReadsMatchCanonicalFullVerifierWithoutInventory(db) {
  for (const kind of ["refund", "dispute", "charge"]) {
    const f = await setup(db);
    f.refunds = [item("refund", "pending", 1)];
    f.disputes = [item("dispute", "under_review", 1)];
    f.charge.disputed = true;
    const full = await readVerifiedTopupPurchase(db, env, f.key, offer, f.fetch);
    assert.equal(full.status, "verified");
    assert.equal(full.reversals.chargeId, "ch_fixture");
    if (kind !== "charge")
      assert.ok(full.reversals[kind + "s"].some((v) => v.id === event(kind).data.object.id));
    f.calls = [];
    assert.deepEqual(await call(db, f, event(kind)), { status: "observed", revision: 2 });
    assert.equal(f.calls.length, kind === "charge" ? 3 : 4);
    assert.deepEqual(
      f.calls.map((url) => new URL(url).pathname),
      [
        "/v1/checkout/sessions/cs_fixture",
        "/v1/payment_intents/pi_fixture",
        "/v1/charges/ch_fixture",
        ...(kind === "charge" ? [] : ["/v1/" + kind + "s/" + event(kind).data.object.id]),
      ],
    );
  }
}
export async function authoritativeTargetReferencesMustMatchCanonicalCharge(db) {
  for (const kind of ["refund", "dispute"])
    for (const fault of [
      "kind",
      "id",
      "charge_null",
      "charge_cross",
      "charge_expanded_mode",
      "pi_cross",
      "pi_expanded_mode",
      "mode",
    ]) {
      const f = await setup(db);
      f[kind + "s"] = [item(kind, kind === "refund" ? "pending" : "under_review", 1)];
      f.alter = (value, path) => {
        if (path !== "/v1/" + kind + "s/" + event(kind).data.object.id) return;
        if (fault === "kind") value.object = "other";
        if (fault === "id") value.id = "re_other";
        if (fault === "charge_null") value.charge = null;
        if (fault === "charge_cross") value.charge = "ch_other";
        if (fault === "charge_expanded_mode")
          value.charge = { object: "charge", id: "ch_fixture", livemode: true };
        if (fault === "pi_cross") value.payment_intent = "pi_other";
        if (fault === "pi_expanded_mode")
          value.payment_intent = { object: "payment_intent", id: "pi_fixture", livemode: true };
        if (fault === "mode") value.livemode = true;
      };
      assert.deepEqual(await call(db, f, event(kind)), { status: "pending" });
      assert.equal((await state(db)).receipts.length, 0);
      assert.equal((await state(db)).revision, 1);
      assert.equal(f.calls.length, 4);
    }
  for (const kind of ["refund", "dispute"]) {
    const f = await setup(db);
    const target = item(kind, "pending", 1);
    target.payment_intent = null;
    f[kind + "s"] = [target];
    assert.deepEqual(await call(db, f, event(kind)), { status: "observed", revision: 2 });
  }
}
export async function historicalOrFailedChargeSharingPaymentNeverObserves(db) {
  for (const fault of ["historical", "failed", "captured", "paid", "canonical_mismatch"]) {
    const f = await setup(db);
    f.refunds = [item("refund", "pending", 1)];
    const e = event("charge");
    if (fault === "historical") e.data.object.id = "ch_old";
    if (fault === "failed") f.charge.status = "failed";
    if (fault === "captured") f.charge.captured = false;
    if (fault === "paid") f.charge.paid = false;
    if (fault === "canonical_mismatch") f.intent.latest_charge = "ch_other";
    if (fault !== "historical")
      assert.notEqual(
        (await readVerifiedTopupPurchase(db, env, f.key, offer, f.fetch)).status,
        "verified",
      );
    f.calls = [];
    const result = await call(db, f, e);
    assert.ok(["pending", "unavailable"].includes(result.status));
    assert.equal((await state(db)).receipts.length, 0);
    assert.equal((await state(db)).revision, 1);
    assert.ok(f.calls.length <= 3);
  }
}
export async function directAssociationKindsAreFixedBeforeTransport(db) {
  let calls = 0;
  const config = { ...env, STRIPE_PRICE_TOPUP: "price_fixture" };
  const fetchImpl = async (url) => {
    calls++;
    const response = new Response("{}");
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  for (const kind of ["constructor", "__proto__", "toString", "refunds/other", "events", {}, null])
    await assert.rejects(() => readTopupAssociation(config, kind, "re_fixture", fetchImpl));
  assert.equal(calls, 0);
  for (const [kind, id] of [
    ["charges", "ch_fixture"],
    ["payment_intents", "pi_fixture"],
    ["checkout/sessions", "cs_fixture"],
    ["refunds", "re_fixture"],
    ["disputes", "du_fixture"],
  ])
    assert.deepEqual(await readTopupAssociation(config, kind, id, fetchImpl), {});
  assert.equal(calls, 5);
}
export async function historicalDiscoveryCannotSubstituteForCanonicalCharge(db) {
  const f = await setup(db);
  f.refunds = [item("refund", "pending", 1)];
  const e = event();
  e.data.object.charge = "ch_old";
  delete e.data.object.payment_intent;
  const base = f.fetch;
  let discovery = 0;
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/v1/charges/ch_old") {
      discovery++;
      const response = new Response(
        JSON.stringify({
          ...f.charge,
          id: "ch_old",
          status: "failed",
          paid: false,
          captured: false,
        }),
      );
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    return base(url, init);
  };
  assert.deepEqual(await call(db, f, e, { fetchImpl }), { status: "pending" });
  assert.equal(discovery, 1);
  assert.equal(f.calls.length, 3);
  assert.equal((await state(db)).receipts.length, 0);
}
export async function lateTargetResponseCannotReachObservation(db) {
  const f = await setup(db);
  f.refunds = [item("refund", "pending", 1)];
  const base = f.fetch;
  let release,
    cancelled = 0,
    targetCalls = 0;
  const fetchImpl = (url, init) => {
    if (new URL(url).pathname !== "/v1/refunds/re_fixture") return base(url, init);
    targetCalls++;
    return new Promise((resolve) => {
      release = () => {
        const response = new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
        );
        Object.defineProperty(response, "url", { value: url });
        resolve(response);
      };
    });
  };
  assert.deepEqual(await call(db, f, event(), { fetchImpl, timeoutMs: 1000 }), {
    status: "unavailable",
  });
  assert.equal(targetCalls, 1);
  assert.equal(f.calls.length, 3);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelled, 1);
  assert.equal((await state(db)).receipts.length, 0);
  assert.equal((await state(db)).revision, 1);
}
