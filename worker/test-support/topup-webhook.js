import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { hmacHex, verifyWebhook, applyEvent } from "../src/billing.js";
import { referenceHash } from "../src/topup-ledger.js";
import { CONFIG } from "../src/config.js";
import { deleteUser } from "../src/limits.js";
import { topupWebhook } from "../src/topup-webhook.js";
import { attempt, session } from "./topup-stripe.js";
const now = new Date("2026-11-11T12:00:00Z");
const env = {
  STRIPE_SECRET_KEY: "fixture-not-a-key",
  STRIPE_WEBHOOK_SECRET: "fixture-not-a-secret",
  STRIPE_PRICE_TOPUP: "price_fixture",
  TOPUPS_ENABLED: "0",
  PAYMENTS_ENABLED: "0",
};
const count = (db, table) => db.prepare("SELECT COUNT(*) AS n FROM " + table).first("n");
async function fixture(db) {
  await db.prepare("DROP TRIGGER IF EXISTS fixture_webhook_abort").run();
  await db.batch(
    [
      "topup_checkout_attempts",
      "topup_purchases",
      "topup_claims",
      "stripe_events",
      "topup_history_receipts",
      "forget",
      "plans",
      "employer_orders",
    ].map((t) => db.prepare("DELETE FROM " + t)),
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
  const checkout = {
    ...session(a),
    status: "complete",
    payment_status: "paid",
    recovered_from: null,
    payment_intent: "pi_fixture",
    url: null,
  };
  checkout.line_items.data[0].price.active = false;
  const intent = {
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
  };
  const charge = {
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
  };
  const f = { a, checkout, intent, charge, refunds: [], disputes: [], calls: [], fail: false };
  f.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    f.calls.push(new URL(url).pathname);
    if (f.fail) throw Error("synthetic failure");
    const path = new URL(url).pathname;
    await f.before?.(path);
    let value =
      path === "/v1/checkout/sessions/cs_fixture"
        ? f.checkout
        : path === "/v1/payment_intents/pi_fixture"
          ? f.intent
          : path === "/v1/charges/ch_fixture"
            ? f.charge
            : null;
    if (!value && /^\/v1\/(refunds|disputes)\//.test(path)) {
      const [, , kind, id] = path.split("/");
      value = f[kind].find((v) => v.id === id) ?? { object: "missing" };
    }
    if (!value) {
      const kind = path.slice(4);
      assert.ok(["refunds", "disputes"].includes(kind));
      value = { object: "list", url: path, data: f[kind], has_more: false };
    }
    const response = new Response(JSON.stringify(value));
    Object.defineProperty(response, "url", { value: url });
    await f.after?.(path);
    return response;
  };
  f.event = (type = "checkout.session.completed", object = f.checkout, id = "evt_fixture") => ({
    object: "event",
    id,
    type,
    livemode: false,
    data: { object },
  });
  f.post = async (event = f.event(), config = env, signature = true) => {
    const body = JSON.stringify(event),
      t = Math.floor(+now / 1000),
      mac = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + body);
    return handle(
      new Request("https://local.invalid/billing/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": signature ? `t=${t},v1=${mac}` : "invalid" },
        body,
      }),
      { ...config, DB: db },
      null,
      { now: () => new Date(now), fetch: f.fetch },
    );
  };
  return f;
}
const balance = (db) =>
  db.prepare("SELECT available,held,consumed,revoked FROM topup_purchases").first();
const item = (object, status) => ({
  object,
  id: object === "refund" ? "re_fixture" : "du_fixture",
  charge: "ch_fixture",
  payment_intent: "pi_fixture",
  currency: "usd",
  amount: 327,
  status,
  ...(object === "dispute" ? { livemode: false } : {}),
});

export async function topupAssociationBoundaries(db) {
  const f = await fixture(db);
  const event = f.event("refund.created", { ...item("refund", "succeeded"), payment_intent: null });
  const invoke = (fetchImpl = f.fetch) =>
    topupWebhook({ db, env, event, fetchImpl, clock: () => now });
  assert.deepEqual(await invoke(), { status: "pending" });
  assert.deepEqual(f.calls, ["/v1/charges/ch_fixture", "/v1/payment_intents/pi_fixture"]);
  assert.equal(await count(db, "topup_purchases"), 0);
  for (const value of [
    { ...f.charge, id: "ch_wrong" },
    { ...f.charge, livemode: true },
    { ...f.charge, payment_intent: ["pi_fixture"] },
  ]) {
    let calls = 0;
    assert.deepEqual(
      await invoke(async () => {
        calls++;
        return new Response(JSON.stringify(value));
      }),
      { status: "pending" },
    );
    assert.equal(calls, 1);
  }
  for (const response of [
    new Response(null, { status: 302, headers: { Location: "https://foreign.invalid/" } }),
    new Response("x".repeat(262145)),
    new Response("invalid JSON"),
  ]) {
    let calls = 0;
    assert.deepEqual(
      await invoke(async (url, options) => {
        calls++;
        assert.equal(new URL(url).origin, "https://api.stripe.com");
        assert.equal(options.redirect, "manual");
        return response;
      }),
      { status: "pending" },
    );
    assert.equal(calls, 1);
  }
  f.charge.payment_intent = null;
  assert.equal(await invoke(), null); // Authoritative legacy Charge with no PI.
  f.charge.metadata = { kind: "autofill_topup" };
  assert.deepEqual(await invoke(), { status: "pending" });
}

export async function topupKnownEmployerAvoidsDiscovery(db) {
  const f = await fixture(db);
  await db
    .prepare(
      "INSERT INTO employer_orders(id,created,updated,status,package,start_day,employer_key,employer,company,name,email,email_domain,terms_version,terms_at,price,payment_intent) VALUES('fixture',?,?,'paid','one','2026-11-11','fixture','Fixture','Fixture','Synthetic','fixture@example.invalid','example.invalid','fixture',?,300,'pi_fixture')",
    )
    .bind(now.toISOString(), now.toISOString(), now.toISOString())
    .run();
  const event = f.event("refund.created", item("refund", "succeeded"));
  assert.equal(
    await topupWebhook({
      db,
      env,
      event,
      fetchImpl: () => assert.fail("Known employer needs no discovery"),
    }),
    null,
  );
  assert.equal(
    await topupWebhook({
      db,
      env,
      event,
      historyPolicy: { enabled: true, apiVersions: new Array(1) },
      fetchImpl: () => assert.fail("No unrelated discovery"),
    }),
    null,
  );
  assert.deepEqual(
    await topupWebhook({ db, env, event: f.event(), fetchImpl: f.fetch, clock: () => now }),
    { status: "settled" },
  );
  f.calls = [];
  assert.deepEqual(await topupWebhook({ db, env, event, fetchImpl: f.fetch, clock: () => now }), {
    status: "reconciled",
  });
  assert.ok(f.calls.length > 0); // A known top-up takes precedence over legacy discovery.
}

export async function signedTopupSettlementReplay(db) {
  const f = await fixture(db);
  const results = await Promise.all([f.post(), f.post()]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(await balance(db), { available: 25, held: 0, consumed: 0, revoked: 0 });
  assert.equal(await count(db, "stripe_events"), 1);
  assert.equal(await count(db, "plans"), 0);
  const calls = f.calls.length;
  assert.deepEqual(await (await f.post()).json(), { ok: true, repeat: true });
  assert.equal(f.calls.length, calls);
  assert.equal(
    (await f.post(f.event("checkout.session.async_payment_succeeded", f.checkout, "evt_repeat")))
      .status,
    200,
  );
  assert.equal(f.calls.length, calls);
  assert.equal(await count(db, "topup_purchases"), 1);
}
export async function signedTopupPendingAndExpiry(db) {
  const f = await fixture(db);
  f.fail = true;
  assert.equal((await f.post()).status, 502);
  assert.equal(await count(db, "stripe_events"), 0);
  assert.equal(await count(db, "topup_purchases"), 0);
  f.fail = false;
  assert.equal((await f.post()).status, 200);
  const g = await fixture(db);
  g.checkout.status = "expired";
  g.checkout.payment_status = "unpaid";
  g.checkout.payment_intent = null;
  assert.equal((await g.post(g.event("checkout.session.expired"))).status, 200);
  assert.equal(
    (await db.prepare("SELECT state FROM topup_checkout_attempts").first()).state,
    "expired",
  );
  assert.equal(await count(db, "topup_purchases"), 0);
  assert.equal(g.calls.length, 1);
}
export async function signedTopupBeforeGrantAndReversals(db) {
  const f = await fixture(db);
  const early = item("refund", "succeeded");
  early.payment_intent = null;
  assert.equal((await f.post(f.event("refund.created", early, "evt_early"))).status, 502);
  assert.deepEqual(f.calls, ["/v1/charges/ch_fixture", "/v1/payment_intents/pi_fixture"]);
  assert.equal(await count(db, "stripe_events"), 0);
  f.refunds = [item("refund", "succeeded")];
  f.charge.amount_refunded = 327;
  f.charge.refunded = true;
  assert.equal((await f.post()).status, 200);
  assert.deepEqual(await balance(db), { available: 0, held: 0, consumed: 0, revoked: 25 });
  assert.equal((await f.post(f.event("refund.created", early, "evt_early"))).status, 200);
  const g = await fixture(db);
  assert.equal((await g.post()).status, 200);
  g.disputes = [item("dispute", "under_review")];
  g.charge.disputed = true;
  const dispute = { ...g.disputes[0], payment_intent: null };
  g.calls = [];
  assert.equal((await g.post(g.event("charge.dispute.created", dispute, "evt_hold"))).status, 200);
  assert.equal(g.calls[0], "/v1/charges/ch_fixture");
  assert.deepEqual(await balance(db), { available: 0, held: 25, consumed: 0, revoked: 0 });
  g.disputes[0].status = "won";
  g.calls = [];
  assert.equal((await g.post(g.event("charge.dispute.closed", dispute, "evt_won"))).status, 200);
  assert.deepEqual(await balance(db), { available: 25, held: 0, consumed: 0, revoked: 0 });
}
export async function signedTopupGuardsAndTerminalClaims(db) {
  const f = await fixture(db);
  assert.equal((await f.post(f.event(), env, false)).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal(await count(db, "stripe_events"), 0);
  assert.equal((await f.post(f.event(), {})).status, 404);
  assert.equal(
    (await f.post(f.event(), { ...env, STRIPE_PRICE_TOPUP: "price_wrong" })).status,
    502,
  );
  assert.equal(await count(db, "topup_purchases"), 0);
  assert.equal(await count(db, "stripe_events"), 0);
  assert.equal((await f.post()).status, 200);
  await deleteUser(db, f.a.user_hash, now);
  f.calls = [];
  assert.equal(
    (await f.post(f.event("refund.updated", item("refund", "succeeded"), "evt_deleted"))).status,
    200,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(await count(db, "topup_purchases"), 0);
  assert.equal((await db.prepare("SELECT state FROM topup_claims").first()).state, "deleted");
}
export async function topupDormantLegacyAndMalformed(db) {
  const f = await fixture(db),
    noDb = {
      prepare() {
        assert.fail("Unconfigured unrelated event must not access D1");
      },
      batch() {
        assert.fail("No topup D1");
      },
    };
  const ordinary = { id: "legacy", type: "customer.subscription.updated", data: { object: {} } };
  assert.equal(
    await topupWebhook({
      db: noDb,
      env: {},
      event: ordinary,
      fetchImpl: () => assert.fail("No fetch"),
    }),
    null,
  );
  const legacy = {
    ...env,
    STRIPE_PRICE_TOPUP: undefined,
    PAYMENTS_ENABLED: "1",
    STRIPE_PRICE_ID: "price_subscription",
  };
  assert.deepEqual(
    await (
      await f.post({ id: "evt_other", type: "unhandled", data: { object: {} } }, legacy)
    ).json(),
    { ok: true, ignored: true },
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post(f.event(), legacy)).status, 502); // explicit top-up never becomes a subscription
  assert.equal(await count(db, "plans"), 0);
  const bad = f.event(
    "refund.created",
    { ...item("refund", "succeeded"), payment_intent: ["pi_fixture"] },
    "evt_bad",
  );
  assert.equal((await f.post(bad)).status, 502);
  assert.equal(f.calls.length, 0);
  const unknown = item("refund", "succeeded");
  f.intent.metadata = {};
  const result = await f.post(f.event("refund.created", unknown, "evt_unrelated"));
  assert.deepEqual(await result.json(), { ok: true, ignored: true });
  assert.deepEqual(f.calls, ["/v1/payment_intents/pi_fixture"]);
}

export async function signedTopupRollbackAndUnsupported(db) {
  const f = await fixture(db);
  const unsupported = f.event("payment_intent.succeeded", f.intent, "evt_unsupported");
  assert.deepEqual(await (await f.post(unsupported)).json(), { ok: true, ignored: true });
  assert.equal(f.calls.length, 0);
  assert.equal(await count(db, "topup_purchases"), 0);
  await db
    .prepare(
      "CREATE TRIGGER fixture_webhook_abort BEFORE INSERT ON topup_purchases BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  assert.equal((await f.post()).status, 502);
  assert.equal(await count(db, "topup_claims"), 0);
  assert.equal(await count(db, "topup_purchases"), 0);
  assert.equal(await count(db, "stripe_events"), 1); // only the safely ignored unsupported receipt
  await db.prepare("DROP TRIGGER fixture_webhook_abort").run();
  assert.equal((await f.post()).status, 200);
  assert.equal(await count(db, "topup_claims"), 1);
  const event = f.event(
    "checkout.session.completed",
    { ...f.checkout, metadata: {} },
    "evt_unmarked_known",
  );
  assert.equal((await f.post(event)).status, 502);
  assert.equal(await count(db, "plans"), 0);
}
const historyPolicy = { enabled: true, livemode: false, apiVersions: ["2026-08-26.dahlia"] };
const historyEvent = (f, id = "evt_history") => ({
  ...f.event("refund.updated", item("refund", "succeeded"), id),
  api_version: "2026-08-26.dahlia",
});
async function signedApply(db, f, event, policy, signature = true, config = env) {
  const body = JSON.stringify(event),
    t = Math.floor(+now / 1000),
    mac = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + body);
  const verified = await verifyWebhook(
    env.STRIPE_WEBHOOK_SECRET,
    signature ? `t=${t},v1=${mac}` : "invalid",
    body,
    now,
  );
  f.verified = verified;
  return applyEvent(db, config, CONFIG, verified, now, f.fetch, policy);
}
const revision = async (db) =>
  (await db.prepare("SELECT revision FROM topup_reconciliations").first()).revision;
const receipt = (db, id) =>
  db.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE id=?").bind(id).first("n");
export async function signedHistoryDefaultOffPreservesLegacyRecovery(db) {
  for (const policy of [undefined, { enabled: false }, { enabled: "1" }]) {
    const f = await fixture(db);
    assert.equal((await f.post()).status, 200);
    f.refunds = [item("refund", "pending")];
    f.calls = [];
    const event = f.event("refund.updated", f.refunds[0], "evt_legacy_history");
    assert.deepEqual(await signedApply(db, f, event, policy), { ok: true });
    assert.equal(f.calls.length, 9);
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 2);
  }
}
export async function signedHistoryObservesThenFreshlyRecoversAndReplays(db) {
  const f = await fixture(db);
  assert.equal((await f.post()).status, 200);
  f.refunds = [item("refund", "pending")];
  f.calls = [];
  const revisions = [];
  f.before = async () => revisions.push(await revision(db));
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (statements) => {
      const result = await db.batch(statements);
      if (statements.length === 4) {
        f.refunds[0].status = "succeeded";
        f.charge.amount_refunded = 327;
        f.charge.refunded = true;
      }
      return result;
    },
  };
  assert.deepEqual(await signedApply(wrapped, f, historyEvent(f), historyPolicy), { ok: true });
  assert.equal(f.calls.length, 13);
  assert.deepEqual(revisions, [1, 1, 1, 1, ...Array(9).fill(2)]);
  assert.equal(await revision(db), 3);
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.deepEqual(await balance(db), { available: 0, held: 0, consumed: 0, revoked: 25 });
  assert.deepEqual(await signedApply(db, f, historyEvent(f), historyPolicy), {
    ok: true,
    repeat: true,
  });
  assert.equal(f.calls.length, 13);
  await assert.rejects(
    () => signedApply(db, f, historyEvent(f, "evt_bad_signature"), historyPolicy, false),
    (e) => e.status === 400,
  );
  assert.equal(await receipt(db, "evt_bad_signature"), 0);
  assert.equal(f.calls.length, 13);
}
export async function signedHistoryReceiptCannotAcknowledgeFailedRecovery(db) {
  const f = await fixture(db);
  assert.equal((await f.post()).status, 200);
  f.refunds = [item("refund", "pending")];
  f.calls = [];
  f.before = async (path) => {
    if (path === "/v1/checkout/sessions/cs_fixture" && (await count(db, "topup_history_receipts")))
      throw Error("synthetic recovery failure");
  };
  await assert.rejects(
    () => signedApply(db, f, historyEvent(f), historyPolicy),
    (e) => e.status === 502,
  );
  assert.equal(await receipt(db, "evt_history"), 0);
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 2);
  assert.deepEqual(await balance(db), { available: 25, held: 0, consumed: 0, revoked: 0 });
  f.before = null;
  f.calls = [];
  assert.deepEqual(await signedApply(db, f, historyEvent(f), historyPolicy), { ok: true });
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 3);
  assert.equal(f.calls.length, 13);
}
export async function signedHistoryUnknownCommitReleasesPreclaimWithoutRetry(db) {
  const f = await fixture(db);
  assert.equal((await f.post()).status, 200);
  f.refunds = [item("refund", "pending")];
  f.calls = [];
  let commits = 0;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (statements) => {
      const result = await db.batch(statements);
      if (statements.length === 4) {
        commits++;
        throw Error("synthetic lost ack");
      }
      return result;
    },
  };
  await assert.rejects(
    () => signedApply(wrapped, f, historyEvent(f), historyPolicy),
    (e) => e.status === 502,
  );
  assert.equal(commits, 1);
  assert.equal(f.calls.length, 4);
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 2);
  assert.equal(await receipt(db, "evt_history"), 0);
  assert.deepEqual(await signedApply(db, f, historyEvent(f), historyPolicy), { ok: true });
  assert.equal(await revision(db), 3);
}
export async function signedHistoryPendingDeletionAndRaceCannotFallThrough(db) {
  for (const fault of ["schema", "policy", "target", "delete", "revision"]) {
    const f = await fixture(db);
    assert.equal((await f.post()).status, 200);
    f.refunds = [item("refund", "pending")];
    f.calls = [];
    const event = historyEvent(f);
    if (fault === "schema") delete event.api_version;
    if (fault === "target") f.refunds[0].charge = "ch_other";
    if (fault === "delete" || fault === "revision")
      f.before = async (path) => {
        if (path !== "/v1/refunds/re_fixture") return;
        if (fault === "delete") await deleteUser(db, f.a.user_hash, now);
        else await db.prepare("UPDATE topup_reconciliations SET revision=revision+1").run();
      };
    await assert.rejects(
      () =>
        signedApply(
          db,
          f,
          event,
          fault === "policy" ? { ...historyPolicy, apiVersions: new Array(1) } : historyPolicy,
        ),
      (e) => e.status === 502,
    );
    assert.equal(await receipt(db, "evt_history"), 0);
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await count(db, "plans"), 0);
    assert.equal(await count(db, "employer_orders"), 0);
    if (fault === "delete") {
      f.before = null;
      f.calls = [];
      assert.deepEqual(await signedApply(db, f, event, historyPolicy), { ok: true, ignored: true });
      assert.equal(f.calls.length, 0);
    }
  }
}
export async function signedHistoryDiscoveryAndRecoveryKeepPinnedPolicyAndCredential(db) {
  const f = await fixture(db);
  assert.equal((await f.post()).status, 200);
  f.refunds = [item("refund", "pending")];
  f.calls = [];
  const e = historyEvent(f);
  e.data.object.payment_intent = null;
  const config = { ...env },
    policy = { enabled: true, livemode: false, apiVersions: ["2026-08-26.dahlia"] };
  const base = f.fetch,
    authorizations = [];
  f.fetch = async (url, init) => {
    authorizations.push(init.headers.Authorization);
    const response = await base(url, init);
    policy.livemode = true;
    policy.apiVersions[0] = "unsupported";
    return response;
  };
  let observations = 0;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (statements) => {
      const result = await db.batch(statements);
      if (statements.length === 4) {
        observations++;
        config.STRIPE_SECRET_KEY = "fixture-changed";
        config.STRIPE_PRICE_TOPUP = "price_changed";
      }
      return result;
    },
  };
  assert.deepEqual(await signedApply(wrapped, f, e, policy, true, config), { ok: true });
  assert.equal(observations, 1);
  assert.equal(authorizations.length, 14);
  assert.ok(authorizations.every((v) => v === "Bearer fixture-not-a-key"));
  assert.equal(await count(db, "topup_history_receipts"), 1);
  assert.equal(await revision(db), 3);
}

export async function signedHistoryPinsOriginalEventBeforeDiscovery(db) {
  for (const direct of [false, true]) {
    const f = await fixture(db);
    assert.equal((await f.post()).status, 200);
    f.refunds = [item("refund", "pending")];
    const event = historyEvent(f);
    event.data.object.payment_intent = null;
    f.before = async () => {
      (direct ? event : f.verified).id = "evt_replacement";
    };
    if (direct)
      assert.deepEqual(await topupWebhook({ db, env, event, fetchImpl: f.fetch, historyPolicy }), {
        status: "reconciled",
      });
    else assert.deepEqual(await signedApply(db, f, event, historyPolicy), { ok: true });
    const digest = await referenceHash("history-event", false, "evt_history");
    assert.equal(
      await db
        .prepare("SELECT COUNT(*) AS n FROM topup_history_receipts WHERE event_digest=?")
        .bind(digest)
        .first("n"),
      1,
    );
    assert.equal(await count(db, "topup_history_receipts"), 1);
    if (!direct) assert.equal(await receipt(db, "evt_history"), 1);
  }
}
export async function signedHistoryPinsPolicyBeforePreclaim(db) {
  for (const fault of ["enabled", "malformed", "config"]) {
    const malformed = fault === "malformed";
    const f = await fixture(db);
    assert.equal((await f.post()).status, 200);
    f.refunds = [item("refund", "succeeded")];
    f.charge.amount_refunded = 327;
    f.charge.refunded = true;
    f.calls = [];
    const policy = {
      ...historyPolicy,
      apiVersions: malformed ? new Array(1) : [...historyPolicy.apiVersions],
    };
    const config = { ...env };
    const wrapped = {
      batch: (s) => db.batch(s),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("INSERT OR IGNORE INTO stripe_events")) return statement;
        return {
          bind(...args) {
            const bound = statement.bind(...args);
            return {
              async run() {
                const result = await bound.run();
                policy.enabled = false;
                if (fault === "config") {
                  config.STRIPE_SECRET_KEY = "fixture-rotated";
                  config.STRIPE_PRICE_TOPUP = "price_changed";
                }
                return result;
              },
            };
          },
        };
      },
    };
    const base = f.fetch,
      headers = [];
    f.fetch = (url, init) => {
      headers.push(init.headers.Authorization);
      return base(url, init);
    };
    if (malformed) {
      await assert.rejects(
        () => signedApply(wrapped, f, historyEvent(f), policy, true, config),
        (e) => e.status === 502,
      );
      assert.equal(await receipt(db, "evt_history"), 0);
      assert.equal(await revision(db), 1);
      assert.equal(f.calls.length, 0);
    } else {
      assert.deepEqual(await signedApply(wrapped, f, historyEvent(f), policy, true, config), {
        ok: true,
      });
      assert.equal(await count(db, "topup_history_receipts"), 1);
      assert.equal(await revision(db), 3);
      assert.ok(headers.every((v) => v === "Bearer fixture-not-a-key"));
    }
  }
}

export async function signedHistoryDisabledPolicyCannotEnableAfterPreclaim(db) {
  for (const initial of [false, "1", undefined]) {
    const f = await fixture(db);
    assert.equal((await f.post()).status, 200);
    f.refunds = [item("refund", "pending")];
    f.calls = [];
    const policy = { ...historyPolicy, enabled: initial };
    const wrapped = {
      batch: (s) => db.batch(s),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("INSERT OR IGNORE INTO stripe_events")) return statement;
        return {
          bind(...args) {
            const bound = statement.bind(...args);
            return {
              async run() {
                const result = await bound.run();
                policy.enabled = true;
                return result;
              },
            };
          },
        };
      },
    };
    assert.deepEqual(await signedApply(wrapped, f, historyEvent(f), policy), { ok: true });
    assert.equal(f.calls.length, 9);
    assert.equal(await count(db, "topup_history_receipts"), 0);
    assert.equal(await revision(db), 2);
  }
}
