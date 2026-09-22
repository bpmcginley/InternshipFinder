// The optional paid plans: they stay invisible until turned on, only Stripe can change a plan, a
// retried webhook cannot pay twice, a paid student gets a bigger allowance, and each tier is told
// apart by the Stripe price the student actually bought.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CAPPED_DEEP_DIVE, NOW, aiBody, setup } from "./helpers.js";

const SECRET = "whsec_test";
const PAID = { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: "sk_test_1", STRIPE_PRICE_ID: "price_1", STRIPE_WEBHOOK_SECRET: SECRET, SITE_URL: "https://site.test/app" };
// Both tiers on offer. Supporter is 2.5x the free allowance and Pro is 6x (src/config.js).
const BOTH = { ...PAID, STRIPE_PRICE_ID_PRO: "price_pro" };

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

  it("asks Stripe to be merchant of record only when told to", async () => {
    for (const [flag, want] of [["1", "true"], ["0", null], [undefined, null]]) {
      const { api, token, fetch } = await setup({ env: { ...PAID, STRIPE_MANAGED_PAYMENTS: flag } });
      assert.equal((await api("POST", "/billing/checkout", { token: await token() })).status, 200);
      const call = fetch.calls.find((c) => c.url.includes("checkout/sessions"));
      assert.equal(new URLSearchParams(call.init.body).get("managed_payments[enabled]"), want, String(flag));
      assert.equal(call.init.headers["Stripe-Version"], "2026-08-26.dahlia");
    }
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

  // Two tabs, or a double click: both must land on the one session Stripe can only take payment for once.
  it("gives a repeat checkout the same idempotency key, and a new one per plan", async () => {
    const { api, token, fetch } = await setup({ env: BOTH });
    for (const plan of ["supporter", "supporter", "pro"]) {
      assert.equal((await api("POST", "/billing/checkout", { token: await token(), body: { plan } })).status, 200);
    }
    const keys = fetch.calls.filter((c) => c.url.includes("checkout/sessions")).map((c) => c.init.headers["Idempotency-Key"]);
    assert.equal(keys.length, 3);
    assert.ok(keys[0] && keys[0].length <= 255);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
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

  // While a secret is rolled Stripe signs with both, one v1 per secret, and ours may not be last.
  it("accepts an event when any one of several signatures matches", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    const event = completed(user);
    const ours = (await sign(JSON.stringify(event))).split(",")[1];
    const theirs = (await sign(JSON.stringify(event), "whsec_old")).split(",")[1];
    const t = Math.floor(NOW.getTime() / 1000);
    assert.equal((await post(api, event, { header: `t=${t},${ours},${theirs}` })).status, 200);
    assert.equal((await db.dump()).plans.length, 1);
    assert.equal((await post(api, { ...event, id: "evt_2" }, { header: `t=${t},${theirs},v1=00` })).status, 400);
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
    assert.equal(after.allowance.autofill.limit, before.allowance.autofill.limit * 2.5);
    assert.equal(after.plan_renews, "2026-11-06T21:20:00.000Z");
  });

  // Which tier the student bought is the price they paid, not what the checkout metadata remembers:
  // switching tiers inside Stripe's own portal rewrites the price and leaves the metadata behind.
  it("puts the student on the tier their Stripe price belongs to", async () => {
    const sub = (price) => (url) =>
      url.includes("subscriptions/")
        ? Response.json({ id: "sub_1", status: "active", current_period_end: 1794000000, items: { data: [{ price: { id: price } }] } })
        : Response.json({ id: "cs_test_1", url: "https://checkout.stripe.test/pay/cs_test_1" });

    for (const [price, plan, autofill] of [["price_1", "supporter", 50], ["price_pro", "pro", 120]]) {
      const { api, db, token } = await setup({ env: BOTH, stripe: sub(price) });
      const user = await whoami(api, token, db);
      // Stale metadata from an earlier tier must not win over the price actually being billed.
      assert.equal((await post(api, completed(user, { metadata: { plan: "supporter" } }))).status, 200);
      const me = await (await api("GET", "/me", { token: await token() })).json();
      assert.equal(me.plan, plan);
      assert.equal(me.allowance.autofill.limit, autofill);
      // Pro is the top tier, so there is nothing left to upgrade to.
      assert.equal(me.can_upgrade, plan === "supporter");
    }
  });

  it("offers only the tiers whose Stripe price is set", async () => {
    const one = await (await (await setup({ env: PAID })).api("GET", "/config")).json();
    assert.deepEqual(one.payments.plans.map((p) => p.plan), ["supporter"]);
    const two = await (await (await setup({ env: BOTH })).api("GET", "/config")).json();
    assert.deepEqual(two.payments.plans.map((p) => p.plan), ["supporter", "pro"]);
    assert.deepEqual(two.payments.plans.map((p) => p.multiplier), [2.5, 6]);
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

  // The event id is recorded before the plan row is written. If that write fails, Stripe retries,
  // and the retry must not be waved through as a repeat or the student paid for nothing.
  it("applies the retry of an event whose first attempt failed", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    const prepare = db.prepare;
    db.prepare = (q) => {
      if (q.startsWith("INSERT INTO plans")) throw new Error("D1 is down");
      return prepare(q);
    };
    assert.equal((await post(api, completed(user))).status, 500);
    db.prepare = prepare;
    const again = await post(api, completed(user));
    assert.equal(again.status, 200);
    assert.notEqual((await again.json()).repeat, true);
    assert.equal((await (await api("GET", "/me", { token: await token() })).json()).plan, "supporter");
  });

  // Stripe does not deliver in order. A late "updated: active" after the subscription ended must not
  // hand the plan back.
  it("reads a subscription's state from Stripe rather than from a possibly stale update event", async () => {
    let live = "active";
    const { api, db, token, fetch } = await setup({
      env: PAID,
      stripe: (url) => url.includes("subscriptions/")
        ? Response.json({ id: "sub_1", status: live, customer: "cus_1", current_period_end: 1794000000 })
        : Response.json({ id: "cs_test_1", url: "https://checkout.stripe.test/pay/cs_test_1" }),
    });
    const user = await whoami(api, token, db);
    await post(api, completed(user));
    live = "canceled";
    await post(api, {
      id: "evt_late", type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { user_hash: user } } },
    });
    assert.equal((await (await api("GET", "/me", { token: await token() })).json()).plan, "free");
    const read = fetch.calls.filter((c) => c.url.includes("subscriptions/sub_1")).pop();
    assert.equal(read.init.method, "GET");
    assert.equal(read.init.body, undefined);
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
    const { api, db, token } = await setup({ env: PAID, config: CAPPED_DEEP_DIVE });
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

// From the independent review of the audit fixes (September 2026).
describe("what Stripe still holds", () => {
  const subReply = (status) => (url) => url.includes("subscriptions/")
    ? Response.json({ id: url.split("subscriptions/")[1], status: status(), customer: "cus_1", current_period_end: 1794000000 })
    : Response.json({ id: "cs_test_1", url: "https://checkout.stripe.test/pay/cs_test_1" });

  it("ignores a late event about an earlier subscription", async () => {
    const { api, db, token } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    await post(api, completed(user, { subscription: "sub_2" }));
    const late = await post(api, {
      id: "evt_old", type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { user_hash: user } } },
    });
    assert.equal((await late.json()).ignored, true);
    assert.equal((await (await api("GET", "/me", { token: await token() })).json()).plan, "supporter");
    assert.equal((await db.dump()).plans[0].subscription, "sub_2");
  });

  it("reads the new subscription with GET, never an empty update", async () => {
    const { api, db, token, fetch } = await setup({ env: PAID });
    const user = await whoami(api, token, db);
    await post(api, completed(user));
    const reads = fetch.calls.filter((c) => c.url.includes("subscriptions/"));
    assert.ok(reads.length >= 1);
    for (const c of reads) assert.equal(c.init.method, "GET");
  });

  it("a failed renewal still blocks Delete my data and a second checkout", async () => {
    let live = "active";
    const { api, db, token } = await setup({ env: PAID, stripe: subReply(() => live) });
    const user = await whoami(api, token, db);
    await post(api, completed(user));
    live = "past_due";
    await post(api, { id: "evt_pd", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "past_due", metadata: { user_hash: user } } } });
    assert.equal((await (await api("GET", "/me", { token: await token() })).json()).plan, "free");

    const del = await api("DELETE", "/me", { token: await token() });
    assert.equal(del.status, 409);
    assert.equal((await del.json()).error, "subscribed");
    const buy = await api("POST", "/billing/checkout", { token: await token() });
    assert.equal(buy.status, 409);

    live = "canceled";                                     // the student cancels in the portal
    await post(api, { id: "evt_end", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { user_hash: user } } } });
    assert.equal((await api("POST", "/billing/checkout", { token: await token() })).status, 200);
    assert.equal((await api("DELETE", "/me", { token: await token() })).status, 200);
  });

  it("measures a request body in bytes, not characters", async () => {
    const { api, token } = await setup({ env: PAID, config: { MAX_BODY_BYTES: 120 } });
    const ok = await api("POST", "/billing/checkout", { token: await token(), body: { plan: "supporter", pad: "a".repeat(60) } });
    assert.equal(ok.status, 200);
    const wide = await api("POST", "/billing/checkout", { token: await token(), body: { plan: "supporter", pad: "中".repeat(60) } });
    assert.equal(wide.status, 400);                        // 60 characters, 180 bytes
  });
});

// The user_hash never leaves the Worker, so tests read it from a row the student's own call wrote.
async function whoami(api, token, db) {
  await api("POST", "/demand", { token: await token(), body: { states: ["MA"] } });
  return (await db.dump()).demand[0].user_hash;
}
