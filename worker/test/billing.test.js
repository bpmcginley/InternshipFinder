// The optional Supporter plan: it stays invisible until it is turned on, only Stripe can change a
// plan, a retried webhook cannot pay twice, and a paid student gets a bigger allowance.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { NOW, aiBody, setup } from "./helpers.js";

const SECRET = "whsec_test";
const PAID = { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: "sk_test_1", STRIPE_PRICE_ID: "price_1", STRIPE_WEBHOOK_SECRET: SECRET, SITE_URL: "https://site.test/app" };

async function sign(body, secret = SECRET, at = NOW) {
  const t = Math.floor(at.getTime() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Stripe posts a raw body, so the signature covers exactly the bytes the api helper will send.
const post = async (api, event, { secret = SECRET, at = NOW, header } = {}) => {
  const body = JSON.stringify(event);
  return api("POST", "/billing/webhook", {
    body: event,
    headers: { "Stripe-Signature": header !== undefined ? header : await sign(body, secret, at) },
  });
};

const completed = (user, over = {}) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { client_reference_id: user, customer: "cus_1", subscription: "sub_1", payment_status: "paid", ...over } },
});

describe("payments turned off", () => {
  it("offers nothing and refuses every billing route", async () => {
    const { api, token } = await setup();
    const config = await (await api("GET", "/config")).json();
    assert.equal(config.payments.enabled, false);

    const me = await (await api("GET", "/me", { token: await token() })).json();
    assert.equal(me.plan, "free");
    assert.equal(me.can_upgrade, false);

    for (const path of ["/billing/checkout", "/billing/portal", "/billing/webhook"]) {
      const res = await api("POST", path, { token: await token(), body: {} });
      assert.equal(res.status, 404, path);
    }
  });
});

describe("checkout", () => {
  it("sends the student to Stripe, tagged with their hashed id only", async () => {
    const { api, token, fetch } = await setup({ env: PAID });
    const res = await api("POST", "/billing/checkout", { token: await token() });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).url, "https://checkout.stripe.test/pay/cs_test_1");

    const call = fetch.calls.find((c) => c.url.includes("checkout/sessions"));
    const form = new URLSearchParams(call.init.body);
    assert.equal(form.get("mode"), "subscription");
    assert.equal(form.get("line_items[0][price]"), "price_1");
    assert.match(form.get("client_reference_id"), /^[0-9a-f]{64}$/);   // the hash, not an email
    assert.equal(form.get("success_url"), "https://site.test/app/?upgraded=1");
    assert.ok(!call.init.body.includes("umass.edu"));
  });

  it("needs a signed-in student", async () => {
    const { api } = await setup({ env: PAID });
    assert.equal((await api("POST", "/billing/checkout")).status, 401);
  });

  it("will not start a second subscription", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    await post(api, completed(user));
    const res = await api("POST", "/billing/checkout", { token: await token() });
    assert.equal(res.status, 409);
  });

  it("hides Stripe's own error text", async () => {
    const { api, token } = await setup({
      env: PAID,
      stripe: () => Response.json({ error: { message: "No such price: price_1 on account acct_123" } }, { status: 400 }),
    });
    const res = await api("POST", "/billing/checkout", { token: await token() });
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes("acct_123"));
  });
});

describe("webhook", () => {
  it("refuses an unsigned, mis-signed or stale event", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);

    assert.equal((await post(api, completed(user), { header: "" })).status, 400);
    assert.equal((await post(api, completed(user), { secret: "whsec_wrong" })).status, 400);
    const old = new Date(NOW.getTime() - 20 * 60_000);
    assert.equal((await post(api, completed(user), { at: old })).status, 400);
    assert.equal((await db.dump()).plans.length, 0);
  });

  it("upgrades on payment and raises the allowance", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);

    const before = await (await api("GET", "/me", { token: await token() })).json();
    assert.equal(before.plan, "free");

    assert.equal((await post(api, completed(user))).status, 200);
    const after = await (await api("GET", "/me", { token: await token() })).json();
    assert.equal(after.plan, "supporter");
    assert.equal(after.can_upgrade, false);
    assert.equal(after.can_manage, true);
    assert.equal(after.allowance.resume_tailor.limit, before.allowance.resume_tailor.limit * 4);
    assert.equal(after.plan_renews, "2026-11-06T21:20:00.000Z");
  });

  // Stripe's newer API versions put the renewal date on the subscription item instead.
  it("reads the renewal date from either place Stripe puts it", async () => {
    const { api, db, token } = await setup({
      env: PAID,
      stripe: (url) =>
        url.includes("subscriptions/")
          ? Response.json({ id: "sub_1", status: "active", items: { data: [{ current_period_end: 1794000000 }] } })
          : Response.json({ id: "cs_test_1", url: "https://checkout.stripe.test/pay/cs_test_1" }),
    });
    await post(api, completed(await whoami(api, token, db)));
    const me = await (await api("GET", "/me", { token: await token() })).json();
    assert.equal(me.plan, "supporter");
    assert.equal(me.plan_renews, "2026-11-06T21:20:00.000Z");
  });

  it("applies a retried event only once", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    await post(api, completed(user));
    const again = await post(api, completed(user));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).repeat, true);
    assert.equal((await db.dump()).plans.length, 1);
  });

  it("drops the plan when the subscription ends", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    await post(api, completed(user));
    await post(api, {
      id: "evt_2",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { user_hash: user } } },
    });
    const me = await (await api("GET", "/me", { token: await token() })).json();
    assert.equal(me.plan, "free");
    assert.equal(me.can_upgrade, true);
  });

  it("ignores an unpaid session and an unknown event type", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    await post(api, completed(user, { payment_status: "unpaid" }));
    await post(api, { id: "evt_9", type: "invoice.created", data: { object: {} } });
    assert.equal((await db.dump()).plans.length, 0);
  });
});

describe("running out", () => {
  // The extension only offers the plan when this flag says it exists, so it must track both the
  // switch and the student's current plan.
  it("tells a free student the cap can be raised, and a supporter that it cannot", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const t = await token();
    let n = 0;
    const spend = async () => {
      await api("POST", "/ai", { token: t, body: aiBody("deep_dive", "run-" + n++) });
    };
    for (let i = 0; i < 3; i++) await spend();
    let err = await (await api("POST", "/ai", { token: t, body: aiBody("deep_dive", "run-z") })).json();
    assert.equal(err.error, "cap");
    assert.equal(err.upgrade, true);

    const user = await whoami(api, token, db);
    await post(api, completed(user));
    // The supporter's own allowance is larger, so exhaust it before checking the message.
    for (let i = 0; i < 8; i++) await spend();
    err = await (await api("POST", "/ai", { token: t, body: aiBody("deep_dive", "run-y") })).json();
    assert.equal(err.error, "cap");
    assert.equal(err.upgrade, false);
  });
});

describe("deleting data", () => {
  it("asks the student to cancel first while they are paying", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    await post(api, completed(user));
    const res = await api("DELETE", "/me", { token: await token() });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "subscribed");
  });

  it("still deletes everything on the free plan", async () => {
    const { api, db, token } = await setup({ env: PAID });
    await api("POST", "/demand", { token: await token(), body: { states: ["MA"] } });
    assert.equal((await api("DELETE", "/me", { token: await token() })).status, 200);
    const d = await db.dump();
    assert.equal(d.demand.length, 0);
    assert.equal(d.plans.length, 0);
  });
});

// The user_hash never leaves the Worker, so tests read it from a row the student's own call wrote.
async function whoami(api, token, db) {
  await api("POST", "/demand", { token: await token(), body: { states: ["MA"] } });
  return (await db.dump()).demand[0].user_hash;
}
