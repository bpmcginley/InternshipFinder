import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import { handle } from "../src/index.js";
import { CONFIG } from "../src/config.js";
import { createSession } from "../src/session.js";
import { hmacHex } from "../src/billing.js";
import { attempt, env as stripeEnv, price, reply, session } from "../test-support/topup-stripe.js";

const site = "https://internscout.org";
const owner = attempt().user_hash;
const answer = {
  candidates: [{ content: { parts: [{ text: "synthetic answer" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
};

async function setup() {
  // Qualify the already deployed schema boundary, without dormant history/owner migrations.
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) <= 29),
  );
  const db = env.DB,
    now = new Date(),
    pending = [],
    calls = [];
  await db.batch(
    [
      "runs",
      "usage",
      "bonus",
      "budget",
      "spend",
      "rate",
      "forget",
      "sessions",
      "plans",
      "event_counts",
      "topup_purchases",
      "topup_claims",
      "topup_checkout_attempts",
      "stripe_events",
    ].map((table) => db.prepare("DELETE FROM " + table)),
  );
  const { token } = await createSession(db, { user: owner, tier: "edu", provider: "google" }, now);
  const settings = {
    ...stripeEnv,
    DB: db,
    SITE_URL: site,
    STRIPE_TOPUP_MODE: "test",
    STRIPE_WEBHOOK_SECRET: "fixture-not-a-secret",
    GEMINI_API_KEY: "fixture-not-an-ai-key",
    FUNDED_RUNS_MODE: "create",
    FUNDED_PURCHASES: "1",
    FUNDED_RESPONSE_MAX_BYTES: "16384",
    FUNDED_RESPONSE_EVENT_BYTES: "8192",
    FUNDED_RESPONSE_DEADLINE_MS: "5000",
  };
  const config = {
    ...CONFIG,
    TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, allowance: 1 } },
    MAX_CALLS_PER_RUN: 2,
    USER_BUDGET_CENTS: { free: 1000 },
    MONTHLY_BUDGET_CENTS: 10000,
    DAILY_BUDGET_CENTS: 1000,
  };
  let checkout,
    paid = false;
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://generativelanguage.googleapis.com") {
      assert.equal(init.method, "POST");
      calls.push("ai");
      return reply(answer);
    }
    assert.equal(parsed.origin, "https://api.stripe.com");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers["Stripe-Version"], "2026-08-26.dahlia");
    const path = parsed.pathname;
    calls.push(init.method + " " + path);
    if (path === "/v1/prices/price_fixture") {
      assert.equal(init.method, "GET");
      return reply(price());
    }
    if (path === "/v1/checkout/sessions") {
      assert.equal(init.method, "POST");
      assert.equal(checkout, undefined, "Only one provider creation is allowed");
      const form = new URLSearchParams(init.body);
      const id = form.get("metadata[attempt_id]");
      assert.equal(init.headers["Idempotency-Key"], "topup-checkout:" + id);
      assert.equal(form.get("line_items[0][price]"), stripeEnv.STRIPE_PRICE_TOPUP);
      assert.equal(form.get("payment_intent_data[metadata][attempt_id]"), id);
      assert.equal(form.get("metadata[user_hash]"), owner);
      assert.equal(form.get("success_url"), site + "/");
      assert.equal(form.get("cancel_url"), site + "/");
      checkout = {
        ...session({ ...attempt(), id }),
        success_url: site + "/",
        cancel_url: site + "/",
      };
      return reply(checkout);
    }
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    let value;
    if (path === "/v1/checkout/sessions/cs_fixture") value = currentCheckout();
    else if (path === "/v1/payment_intents/pi_fixture") {
      assert.equal(paid, true);
      value = {
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
    } else if (path === "/v1/charges/ch_fixture") {
      assert.equal(paid, true);
      value = {
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
    } else {
      assert.ok(
        ["/v1/refunds", "/v1/disputes"].includes(path),
        "Unexpected synthetic request path",
      );
      value = { object: "list", url: path, data: [], has_more: false };
    }
    const response = reply(value);
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  function currentCheckout() {
    assert.ok(checkout);
    return paid
      ? {
          ...checkout,
          status: "complete",
          payment_status: "paid",
          recovered_from: null,
          payment_intent: "pi_fixture",
          url: null,
        }
      : checkout;
  }
  async function send(path, method = "GET", body, headers = {}) {
    const response = await handle(
      new Request("https://local.invalid" + path, {
        method,
        headers: { Origin: site, Authorization: "Bearer " + token, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      settings,
      { waitUntil: (p) => pending.push(p) },
      { now: () => new Date(now), config, fetch },
    );
    const result = await response.json();
    await Promise.all(pending.splice(0));
    return { response, result };
  }
  const me = async () => {
    const before = calls.length,
      got = await send("/me");
    assert.equal(got.response.status, 200);
    assert.equal(got.response.headers.get("Cache-Control"), "no-store");
    assert.equal(calls.length, before, "Balance reads must not contact a provider");
    return got.result.allowance.autofill;
  };
  const ai = (run) =>
    send("/ai", "POST", {
      task: "autofill",
      run_id: run,
      request: { contents: [{ role: "user", parts: [{ text: "synthetic input" }] }] },
    });
  const deliver = async (valid = true) => {
    const event = {
      object: "event",
      id: "evt_sales_flow",
      type: "checkout.session.completed",
      livemode: false,
      data: { object: currentCheckout() },
    };
    const raw = JSON.stringify(event),
      t = Math.floor(+now / 1000);
    const signature = await hmacHex(settings.STRIPE_WEBHOOK_SECRET, t + "." + raw);
    return send("/billing/webhook", "POST", event, {
      "Stripe-Signature": valid ? `t=${t},v1=${signature}` : "invalid",
    });
  };
  const count = (table) => db.prepare("SELECT COUNT(*) AS n FROM " + table).first("n");
  const balance = () =>
    db.prepare("SELECT available,held,consumed,revoked FROM topup_purchases").first();
  return {
    db,
    settings,
    calls,
    send,
    me,
    ai,
    deliver,
    count,
    balance,
    pay: () => {
      paid = true;
    },
  };
}

for (const first of ["signed delivery", "attached recovery"]) {
  it(`native sales flow from ${first} grants once and funds the same account`, async () => {
    const w = await setup();
    assert.deepEqual(await w.me(), { used: 0, limit: 1 });
    assert.equal((await w.ai("included")).response.status, 200);
    assert.deepEqual(await w.me(), { used: 1, limit: 1 });
    const beforeCap = w.calls.length;
    assert.equal((await w.ai("exhausted")).response.status, 429);
    assert.equal(w.calls.length, beforeCap);
    assert.equal((await w.send("/config")).result.topups, true);
    const offer = await w.send("/billing/topup/offer");
    assert.equal(offer.response.status, 200);
    assert.equal(offer.response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(offer.result, {
      enabled: true,
      offer: { amount: 300, currency: "usd", units: 25 },
    });
    const opened = await w.send("/billing/topup/checkout", "POST");
    assert.equal(opened.response.status, 200);
    assert.equal(opened.response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(opened.result, { status: "open", url: session().url });
    assert.deepEqual((await w.send("/billing/topup/checkout", "POST")).result, opened.result);
    assert.equal(await w.count("topup_checkout_attempts"), 1);
    assert.equal(await w.count("topup_purchases"), 0);
    assert.deepEqual(await w.me(), { used: 1, limit: 1 }, "Opening Checkout does not grant runs");
    w.pay();
    const beforeInvalid = w.calls.length;
    assert.equal((await w.deliver(false)).response.status, 400);
    assert.equal(w.calls.length, beforeInvalid);
    assert.equal(await w.count("stripe_events"), 0);
    assert.equal(await w.count("topup_purchases"), 0);
    if (first === "attached recovery") {
      // Paid recovery must remain available after sales are disabled.
      w.settings.TOPUPS_ENABLED = "0";
      const recovered = await w.send("/billing/topup/recover", "POST");
      assert.equal(recovered.response.status, 200);
      assert.deepEqual(recovered.result, { status: "settled" });
    }
    assert.equal((await w.deliver()).response.status, 200);
    const beforeRepeat = w.calls.length;
    assert.deepEqual((await w.deliver()).result, { ok: true, repeat: true });
    assert.equal(w.calls.length, beforeRepeat);
    assert.equal(await w.count("stripe_events"), 1);
    assert.equal(await w.count("topup_purchases"), 1);
    assert.deepEqual(await w.balance(), { available: 25, held: 0, consumed: 0, revoked: 0 });
    assert.deepEqual(await w.me(), { used: 1, limit: 26, purchased: 25 });
    const funded = await w.ai("purchased");
    assert.equal(funded.response.status, 200);
    assert.deepEqual(funded.result, answer);
    assert.equal(funded.response.headers.get("X-InternScout-Remaining"), "24");
    assert.equal(
      await w.db
        .prepare("SELECT funding FROM funded_runs WHERE run_id='purchased'")
        .first("funding"),
      "purchase",
    );
    assert.deepEqual(await w.balance(), { available: 24, held: 0, consumed: 1, revoked: 0 });
    assert.equal((await w.ai("purchased")).response.status, 200);
    assert.deepEqual(await w.balance(), { available: 24, held: 0, consumed: 1, revoked: 0 });
    w.settings.TOPUPS_ENABLED = "0";
    assert.equal((await w.send("/config")).result.topups, undefined);
    assert.equal((await w.send("/billing/topup/checkout", "POST")).response.status, 503);
    assert.deepEqual(await w.me(), { used: 2, limit: 26, purchased: 24 });
    const recovered = await w.send("/billing/topup/recover", "POST");
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(recovered.result, { status: "inactive" });
    assert.equal(w.calls.filter((c) => c === "POST /v1/checkout/sessions").length, 1);
    assert.equal(w.calls.filter((c) => c === "ai").length, 3);
  });
}

it("native sales flow rejects incomplete funded or payment settings before provider creation", async () => {
  const w = await setup();
  for (const patch of [
    { TOPUPS_ENABLED: "0" },
    { PAYMENTS_ENABLED: "0" },
    { STRIPE_SECRET_KEY: "" },
    { STRIPE_PRICE_TOPUP: "invalid" },
    { FUNDED_RUNS_MODE: "legacy" },
    { FUNDED_RUNS_MODE: "drain" },
    { FUNDED_PURCHASES: "0" },
    { FUNDED_RESPONSE_MAX_BYTES: "" },
    { FUNDED_RESPONSE_EVENT_BYTES: "20000" },
    { FUNDED_RESPONSE_DEADLINE_MS: "0" },
  ]) {
    const original = { ...w.settings };
    Object.assign(w.settings, patch);
    assert.equal((await w.send("/config")).result.topups, undefined);
    for (const [path, method] of [
      ["/billing/topup/offer", "GET"],
      ["/billing/topup/checkout", "POST"],
    ]) {
      const got = await w.send(path, method);
      assert.equal(got.response.status, 503);
      assert.equal(got.response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(got.result, { status: "disabled" });
    }
    Object.assign(w.settings, original);
  }
  assert.equal(w.calls.length, 0);
  assert.equal(await w.count("topup_checkout_attempts"), 0);
  assert.equal(await w.count("topup_purchases"), 0);
});
