import test from "node:test";
import assert from "node:assert/strict";
import { FIELD_CAP, PRICES, TERMS_VERSION } from "../../src/orders/shared.js";
import { ordersCron } from "../../src/orders/cron.js";
import { reviewSig } from "../../src/orders/templates.js";
import { NOW } from "../../test/helpers.js";
import { GOOD, ID, ON, ROLES, SITE, TODAY, hold, sessionEvent, world } from "./fixtures.js";

// ---------------------------------------------------------------- gating

const ORDER_ROUTES = [
  ["GET", "/employer/availability?shard=a&ids=" + ID(1)], ["POST", "/employer/order"], ["POST", "/employer/order/confirm"],
  ["GET", "/employer/review?order=o-0000000000000001&sig=00"], ["POST", "/employer/review"], ["GET", "/employer/credit?credit=c-1&t=x"],
  ["POST", "/employer/credit"],
];

test("off: every /employer route but the config is 404 until everything is set; the config says enabled false", async () => {
  const missing = [{ EMPLOYER_CHECKOUT: "0" }, { EMPLOYER_CHECKOUT: undefined }, { STRIPE_SECRET_KEY: "" }, { STRIPE_WEBHOOK_SECRET: "" },
    { ADMIN_TOKEN: "" }, { REVIEW_TO: "" }, { ORDER_FROM: "" }, { EMAIL: undefined }, { EMAIL: {} }];
  for (const over of missing) {
    const w = await world({ env: over });
    for (const [m, p] of ORDER_ROUTES) {
      const res = await w.api(m, p, { body: m === "POST" ? GOOD : undefined, headers: SITE });
      assert.equal(res.status, 404, `${m} ${p} with ${JSON.stringify(Object.keys(over))}`);
    }
    const cfg = await (await w.api("GET", "/employer/config")).json();
    assert.equal(cfg.enabled, false);
    assert.deepEqual(cfg.prices, PRICES);
    assert.equal(w.db.dump().employer_orders.length, 0);
  }
  const on = await world();
  const cfg = await (await on.api("GET", "/employer/config", { headers: SITE })).json();
  assert.deepEqual(cfg, { enabled: true, prices: PRICES, days: 30, field_cap: 5, max_start_days: 90, terms_version: TERMS_VERSION });
  assert.deepEqual(PRICES, { one: { roles: 1, cents: 2900, public_body_cents: 1500 }, three: { roles: 3, cents: 6900, public_body_cents: 3500 } });
});

// ---------------------------------------------------------------- the order

test("an order is stored unverified, with the terms version and time, and the link goes to the work address", async () => {
  const w = await world();
  const res = await w.order({ name: "  Dana   Reyes ", company: "Acme <b>Robotics</b>" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://internscout.org");
  const [o] = w.db.dump().employer_orders;
  assert.equal(o.status, "unverified");
  assert.equal(o.name, "Dana Reyes");
  assert.equal(o.email_domain, "acme-robotics.example");
  assert.equal(o.employer, "Acme Robotics");
  assert.equal(o.terms_version, TERMS_VERSION);
  assert.equal(o.terms_at, NOW.toISOString());
  assert.equal(o.price, 2900);
  assert.equal(o.token_expires, "2026-09-16T10:05:30.000Z", "48 hours");
  const [r] = w.db.dump().employer_order_roles;
  assert.deepEqual([r.listing_id, r.title, r.apply_url, r.fields, r.unpaid, r.placement_id], [ID(1), ROLES[0].t, ROLES[0].u, "engineering", 0, null]);

  assert.equal(w.mail.sent.length, 1);
  const m = w.mail.sent[0];
  assert.equal(m.to, "dana@acme-robotics.example");
  assert.deepEqual(m.from, { email: "listings@internscout.org", name: "InternScout" });
  assert.equal(m.replyTo, "bruce@internscout.test");
  const { id, token } = w.lastLink();
  assert.equal(id, o.id);
  assert.notEqual(o.token_hash, token, "only the hash is kept");
  assert.match(o.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(w.db.dump()).includes(token));
  assert.doesNotMatch(m.text + m.subject, /—/, "no em dash in an email");
  assert.match(m.text, /within 48 hours/);
  assert.match(m.text, /\$29\.00/);
});

test("order rules: webmail, unpaid roles, unlisted roles, one employer, 1 or 3 roles, the start window, the terms box", async () => {
  const w = await world();
  const field = async (over) => {
    const res = await w.order(over);
    return [res.status, (await res.json()).field];
  };
  assert.deepEqual(await field({ email: "dana@gmail.com" }), [400, "email"]);
  assert.deepEqual(await field({ email: "Dana@Outlook.COM" }), [400, "email"]);
  assert.deepEqual(await field({ email: "not-an-address" }), [400, "email"]);
  assert.deepEqual(await field({ name: " " }), [400, "name"]);
  assert.deepEqual(await field({ roles: [ID(4)] }), [400, "roles"], "an unpaid role needs a public body");
  assert.deepEqual(await field({ roles: [ID(9)] }), [400, "roles"], "not in the index");
  assert.deepEqual(await field({ roles: [ID(7)] }), [400, "roles"], "an http:// role is not taken from the index");
  assert.deepEqual(await field({ roles: ["not-an-id"] }), [400, "roles"]);
  assert.deepEqual(await field({ package: "three", roles: [ID(1), ID(2), ID(5)] }), [400, "roles"], "two employers");
  assert.deepEqual(await field({ package: "one", roles: [ID(1), ID(2)] }), [400, "roles"]);
  assert.deepEqual(await field({ package: "three", roles: [ID(1)] }), [400, "roles"]);
  assert.deepEqual(await field({ package: "three", roles: [ID(1), ID(1), ID(2)] }), [400, "roles"], "each picked once");
  assert.deepEqual(await field({ package: "two" }), [400, "package"]);
  assert.deepEqual(await field({ package: "__proto__" }), [400, "package"]);
  assert.deepEqual(await field({ start: "2026-09-13" }), [400, "start"], "yesterday");
  assert.deepEqual(await field({ start: "2026-12-14" }), [400, "start"], "91 days ahead");
  assert.deepEqual(await field({ start: "2026-02-30" }), [400, "start"]);
  assert.deepEqual(await field({ terms: undefined }), [400, "terms"]);
  assert.deepEqual(await field({ terms: "yes" }), [400, "terms"]);
  assert.deepEqual(await field({ shard: "ab" }), [400, "shard"]);
  assert.deepEqual(await field({ public_body: "yes" }), [400, "public_body"]);
  assert.equal(w.db.dump().employer_orders.length, 0);
  assert.equal(w.mail.sent.length, 0);

  // The edges that are allowed.
  // (From another address: the refusals above that got past the form checks used up this one's day.)
  const fresh = { ...SITE, "CF-Connecting-IP": "198.51.100.77" };
  assert.equal((await w.order({ start: TODAY }, fresh)).status, 200, "today");
  assert.equal((await w.order({ start: "2026-12-13", email: "b@acme-robotics.example" }, fresh)).status, 200, "90 days ahead");
  const pb = await world();
  assert.equal((await pb.order({ roles: [ID(4)], public_body: true })).status, 200, "an unpaid role for a public body");
  assert.equal(pb.db.dump().employer_orders[0].price, 1500);
  assert.equal(pb.db.dump().employer_order_roles[0].unpaid, 1);
  const three = await world();
  assert.equal((await three.order({ package: "three", roles: [ID(1), ID(2), ID(6)] })).status, 200);
  assert.equal(three.db.dump().employer_orders[0].price, 6900);
  assert.deepEqual(three.db.dump().employer_order_roles.map((r) => r.fields), ["engineering", "engineering,software", "other"],
    "a role with no field tags counts as other");
});

test("order: the site's Origin only, the honeypot, the per-address limit, and a role index that can't be read", async () => {
  const w = await world();
  assert.equal((await w.order({}, { "CF-Connecting-IP": "203.0.113.9" })).status, 403, "no Origin");
  assert.equal((await w.order({}, { ...SITE, Origin: "http://localhost:8000" })).status, 403);
  assert.equal((await w.order({}, { ...SITE, Origin: "https://evil.example" })).status, 403);
  const bot = await w.order({ website: "http://spam.example" });
  assert.equal(bot.status, 200);
  assert.deepEqual(await bot.json(), { ok: true });
  assert.equal(w.db.dump().employer_orders.length, 0);
  assert.equal(w.mail.sent.length, 0);

  for (let i = 0; i < 5; i++) assert.equal((await w.order({ email: `p${i}@acme-robotics.example` })).status, 200);
  const sixth = await w.order({ email: "p6@acme-robotics.example" });
  assert.equal(sixth.status, 429);
  assert.ok((await sixth.json()).retry_after > 0);
  assert.equal((await w.order({}, { ...SITE, "CF-Connecting-IP": "198.51.100.1" })).status, 200, "another address");
  assert.ok(!JSON.stringify(w.db.dump().rate).includes("203.0.113.9"), "the address is hashed");

  const down = await world({ site: (url) => (url.includes("/data/roles/") ? new Response("oops", { status: 500 }) : null) });
  const res = await down.order();
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "roles_unavailable");
  const garbled = await world({ site: (url) => (url.includes("/data/roles/") ? Response.json({ roles: "nope" }) : null) });
  assert.equal((await garbled.order()).status, 502);
});

test("an email that can't be sent undoes the unpaid order and says so", async () => {
  const w = await world();
  w.mail.failNext = 1;
  const res = await w.order();
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "mail");
  assert.equal(w.db.dump().employer_orders.length, 0);
  assert.equal(w.db.dump().employer_order_roles.length, 0);
});

// ---------------------------------------------------------------- the field cap

test("field cap: at most 5 paid roles at once per field, with the first day the role fits", async () => {
  const w = await world();
  // Five engineering roles, starting a day apart: the 20th has all five, the first one ends on 10-14.
  for (let i = 0; i < FIELD_CAP; i++) await hold(w, { start: `2026-09-${14 + i}` });
  const res = await w.order({ start: "2026-09-20" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "full");
  assert.equal(body.next_start, "2026-10-14");
  assert.deepEqual(body.roles, [{ id: ID(1), fits: false, full: ["engineering"] }]);

  const avail = await (await w.api("GET", `/employer/availability?shard=a&ids=${ID(1)},${ID(6)},${ID(9)}&start=2026-09-20`, { headers: SITE })).json();
  assert.deepEqual(avail, { start: "2026-09-20", roles: [
    { id: ID(1), listed: true, fits: false, full: ["engineering"], next_start: "2026-10-14" },
    { id: ID(6), listed: true, fits: true },
    { id: ID(9), listed: false },
  ] });
  assert.equal((await w.order({ start: "2026-10-14" })).status, 200, "it fits from next_start");
  assert.equal((await w.order({ roles: [ID(6)], start: "2026-09-20", email: "o@acme-robotics.example" })).status, 200, "another field fits");
  assert.equal((await w.api("GET", "/employer/availability?shard=a&ids=zz", { headers: SITE })).status, 400);
});

test("field cap: the roles of one order count against each other; Checkout holds days 35 minutes; ended placements don't", async () => {
  const w = await world();
  for (let i = 0; i < 3; i++) await hold(w, { start: TODAY });
  const three = await w.order({ package: "three", roles: [ID(1), ID(2), ID(3)], start: TODAY });
  assert.equal(three.status, 409, "3 held + 3 in this order is 6 in engineering");
  assert.deepEqual((await three.json()).roles.map((r) => r.id), [ID(3)]);

  const v = await world();
  for (let i = 0; i < 4; i++) await hold(v, { start: TODAY });
  await hold(v, { start: TODAY, status: "verified", checkoutAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() });
  assert.equal((await v.order({ start: TODAY })).status, 409, "a Checkout opened 10 minutes ago holds its place");
  const old = await world();
  for (let i = 0; i < 4; i++) await hold(old, { start: TODAY });
  await hold(old, { start: TODAY, status: "verified", checkoutAt: new Date(NOW.getTime() - 40 * 60_000).toISOString() });
  await hold(old, { start: TODAY, status: "verified" });
  await hold(old, { start: TODAY, status: "refused" });
  assert.equal((await old.order({ start: TODAY })).status, 200, "an abandoned Checkout, an unopened one and a refusal hold nothing");

  const same = await world();
  await hold(same, { start: TODAY, listing: ID(6), fields: "other" });
  const taken = await same.order({ roles: [ID(6)], start: "2026-09-20" });
  assert.equal(taken.status, 409);
  const tb = await taken.json();
  assert.deepEqual(tb.roles, [{ id: ID(6), fits: false, taken: true }]);
  assert.equal(tb.next_start, "2026-10-14", "the same role can be bought again once its days end");
});

// ---------------------------------------------------------------- the email link

test("the link confirms only its own order, and only for 48 hours", async () => {
  const w = await world();
  await w.order();
  const a = w.lastLink();
  await w.order({ email: "other@acme-robotics.example" });
  const b = w.lastLink();
  assert.equal((await w.confirm(b.id, a.token)).status, 403, "A's token on B");
  assert.equal((await w.confirm(a.id, a.token.slice(0, -1) + (a.token.endsWith("A") ? "B" : "A"))).status, 403);
  assert.equal((await w.confirm(a.id, "")).status, 403);
  assert.equal((await w.confirm("o-ffffffffffffffff", a.token)).status, 403);
  assert.equal((await w.confirm(a.id, a.token, { Origin: "https://evil.example" })).status, 403);
  assert.equal(w.orderRow(a.id).status, "unverified");

  w.setNow(new Date(NOW.getTime() + 48 * 3600e3 + 1000));
  const late = await w.confirm(a.id, a.token);
  assert.equal(late.status, 403);
  assert.equal((await late.json()).error, "link");
  w.setNow(new Date(NOW.getTime() + 47 * 3600e3));
  const ok = await w.confirm(a.id, a.token);
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(w.orderRow(a.id).status, "verified");
});

test("confirming twice inside 30 minutes hands back the same Checkout; a paid order says so", async () => {
  const w = await world();
  await w.order();
  const { id, token } = w.lastLink();
  const one = await (await w.confirm(id, token)).json();
  const two = await (await w.confirm(id, token)).json();
  assert.equal(one.url, two.url);
  assert.equal(w.stripe.calls.filter((c) => c.url.endsWith("checkout/sessions")).length, 1);
  await w.webhook(sessionEvent(id));
  assert.deepEqual(await (await w.confirm(id, token)).json(), { done: "paid" });
});

// ---------------------------------------------------------------- Checkout

test("Checkout: a one-off payment priced by package and public body, tagged as a listing, never Managed Payments", async () => {
  const cases = [
    [{}, 2900], [{ public_body: true }, 1500],
    [{ package: "three", roles: [ID(1), ID(2), ID(6)] }, 6900], [{ package: "three", roles: [ID(1), ID(2), ID(4)], public_body: true }, 3500],
  ];
  for (const [over, cents] of cases) {
    const w = await world({ env: { STRIPE_MANAGED_PAYMENTS: "1", PAYMENTS_ENABLED: "1", STRIPE_PRICE_ID: "price_1" } });
    assert.equal((await w.order(over)).status, 200);
    const { id, token } = w.lastLink();
    assert.equal((await w.confirm(id, token)).status, 200);
    const [call] = w.stripe.calls;
    const f = call.form;
    assert.ok(call.url.endsWith("/v1/checkout/sessions"));
    assert.equal(call.version, "2026-08-26.dahlia");
    assert.equal(f.mode, "payment");
    assert.equal(f["line_items[0][price_data][unit_amount]"], String(cents), JSON.stringify(over));
    assert.equal(f["line_items[0][price_data][currency]"], "usd");
    assert.equal(f["line_items[0][quantity]"], "1");
    assert.equal(f.customer_email, "dana@acme-robotics.example");
    assert.equal(f.client_reference_id, id);
    assert.equal(f["metadata[kind]"], "listing");
    assert.equal(f["metadata[order]"], id);
    assert.equal(f["payment_intent_data[metadata][kind]"], "listing");
    assert.equal(f["payment_intent_data[metadata][order]"], id);
    assert.equal(f["invoice_creation[enabled]"], "true");
    assert.equal(f.allow_promotion_codes, "true");
    assert.equal(f.expires_at, String(Math.floor(NOW.getTime() / 1000) + 31 * 60));
    assert.equal(f.success_url, `https://internscout.org/employers/buy/?paid=${id}`);
    assert.equal(f.cancel_url, "https://internscout.org/employers/buy/?cancelled=1");
    assert.ok(!Object.keys(f).some((k) => k.startsWith("managed_payments")), "no Managed Payments");
    assert.ok(!Object.keys(f).some((k) => k.startsWith("subscription")));
    assert.match(call.key, new RegExp(`^listing-checkout:${id}:`));
  }
});

// ---------------------------------------------------------------- paid

test("paid: draft placements, Bruce's review email, the employer's receipt email; a retried event changes nothing", async () => {
  const w = await world();
  await w.order({ package: "three", roles: [ID(1), ID(2), ID(6)] });
  const { id, token } = w.lastLink();
  await w.confirm(id, token);
  const event = sessionEvent(id, { amount_total: 6900 });
  const res = await w.webhook(event);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const o = w.orderRow(id);
  assert.equal(o.status, "paid");
  assert.equal(o.paid_ref, "stripe:pi_1");
  assert.equal(o.paid_amount, 6900);
  assert.equal(o.payment_intent, "pi_1");
  assert.ok(o.review_sent_at);
  const ps = w.placementsOf(id);
  assert.equal(ps.length, 3);
  for (const p of ps) {
    assert.equal(p.status, "draft");
    assert.equal(p.created_by, "checkout");
    assert.equal(p.start_day, "2026-09-20");
    assert.equal(p.end_day, "2026-10-20");
    assert.equal(p.employer, "Acme Robotics");
    assert.equal(p.paid_ref, "");
  }
  const review = w.mail.sent.find(m => /^Review listing/.test(m.subject));
  const received = w.mail.sent.find(m => /^We have your/.test(m.subject));
  assert.equal(review.to, "bruce@internscout.test");
  assert.match(review.text, new RegExp(`/employer/review\\?order=${id}&sig=${await reviewSig(w.env, id)}`));
  assert.equal(received.to, "dana@acme-robotics.example");
  assert.match(received.text, /within 2 business days/);
  assert.match(received.text, /\$69\.00/);
  for (const m of w.mail.sent) assert.doesNotMatch(m.text + m.subject, /—/);

  const again = await w.webhook(event);
  assert.deepEqual(await again.json(), { ok: true, repeat: true }, "the same event id");
  const async_ = await w.webhook(sessionEvent(id, { amount_total: 6900 }, "checkout.session.async_payment_succeeded"));
  assert.deepEqual(await async_.json(), { ok: true, repeat: true }, "the same payment again");
  assert.equal(w.placementsOf(id).length, 3);
  assert.equal(w.mail.sent.length, 3);
  assert.ok(!w.stripe.calls.some((c) => c.url.endsWith("refunds")));
});

test("paid: a bank payment waits for async_payment_succeeded; the webhook works with the student plans off", async () => {
  const w = await world();   // ON has no PAYMENTS_ENABLED
  await w.order();
  const { id, token } = w.lastLink();
  await w.confirm(id, token);
  assert.deepEqual(await (await w.webhook(sessionEvent(id, { payment_status: "unpaid" }))).json(), { ok: true, waiting: true });
  assert.equal(w.orderRow(id).status, "verified");
  assert.equal((await w.webhook(sessionEvent(id, {}, "checkout.session.async_payment_succeeded"))).status, 200);
  assert.equal(w.orderRow(id).status, "paid");
  assert.equal(w.db.dump().plans.length, 0, "no student plan was touched");
});

test("a second paid session for an order already paid is refunded in full, automatically", async () => {
  const w = await world();
  const id = await w.paid();
  const res = await w.webhook(sessionEvent(id, { id: "cs_test_other", payment_intent: "pi_2" }));
  assert.deepEqual(await res.json(), { ok: true, refunded: "duplicate" });
  const refunds = w.stripe.calls.filter((c) => c.url.endsWith("refunds"));
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].form.payment_intent, "pi_2");
  assert.equal(refunds[0].form.amount, undefined, "the whole payment");
  assert.equal(refunds[0].key, "listing-refund-duplicate:pi_2");
  assert.equal(w.orderRow(id).payment_intent, "pi_1", "the order keeps its first payment");
  assert.ok(w.mail.sent.some((m) => m.to === "bruce@internscout.test" && /paid twice/.test(m.subject)));
  assert.ok(w.mail.sent.some((m) => m.to === "dana@acme-robotics.example" && /second payment/.test(m.subject)));
});

test("a review email that fails never undoes the payment; the daily cron sends it, and a reminder once after a day", async () => {
  const w = await world();
  await w.order();
  const { id, token } = w.lastLink();
  await w.confirm(id, token);
  const send = w.mail.send;
  let failReview = true;
  w.mail.send = async m => {
    if (failReview && m.to === ON.REVIEW_TO) { failReview = false; throw new Error("synthetic review outage"); }
    return send(m);
  };
  assert.equal((await w.webhook(sessionEvent(id))).status, 200);
  let o = w.orderRow(id);
  assert.equal(o.status, "paid");
  assert.equal(o.review_sent_at, null);
  assert.equal(w.placementsOf(id).length, 1);
  const before = w.mail.sent.length;
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 3600e3), w.fetch);
  assert.equal(w.mail.sent.length, before + 1);
  assert.equal(w.mail.sent.at(-1).to, "bruce@internscout.test");
  assert.ok(w.orderRow(id).review_sent_at);
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 2 * 3600e3), w.fetch);
  assert.equal(w.mail.sent.length, before + 1, "not sent twice, no reminder before a day");
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 25 * 3600e3), w.fetch);
  assert.match(w.mail.sent.at(-1).subject, /^Reminder/);
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 50 * 3600e3), w.fetch);
  assert.equal(w.mail.sent.filter((m) => /^Reminder/.test(m.subject)).length, 1, "once");
});

// ---------------------------------------------------------------- pilot codes

test("pilot codes: at most 5 ever, each used once, freed when the order is refused", async () => {
  const w = await world();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const res = await w.adminCall("POST", "/admin/pilot-codes", { note: `pilot ${i + 1}` });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.match(body.code, /^PILOT-[A-Z2-9]{8}$/);
    assert.equal(body.made, i + 1);
    codes.push(body.code);
  }
  assert.equal((await w.adminCall("POST", "/admin/pilot-codes", { note: "sixth" })).status, 409);
  assert.equal(w.db.dump().pilot_codes.length, 5);

  assert.deepEqual((await (await w.order({ pilot_code: "PILOT-NOPE1234" })).json()).field, "pilot_code");
  assert.equal((await w.order({ pilot_code: codes[0].toLowerCase() })).status, 200, "case does not matter");
  const { id, token } = w.lastLink();
  assert.equal(w.orderRow(id).price, 0);
  assert.match(w.mail.sent.at(-1).text, /nothing to pay/);
  assert.deepEqual(await (await w.confirm(id, token)).json(), { done: "pilot" });
  assert.equal(w.stripe.calls.length, 0, "no Stripe for a pilot");
  const o = w.orderRow(id);
  assert.equal(o.status, "paid");
  assert.equal(o.paid_ref, `pilot:${codes[0]}`);
  assert.equal(o.paid_amount, 0);
  assert.equal(w.placementsOf(id).length, 1);
  assert.ok(w.mail.sent.some((m) => m.to === "bruce@internscout.test"));
  assert.equal(w.db.dump().pilot_codes.find((c) => c.code === codes[0]).order_id, id);

  const reuse = await w.order({ pilot_code: codes[0], email: "x@acme-robotics.example" });
  assert.equal(reuse.status, 400, "a code is used once");
  assert.equal((await reuse.json()).field, "pilot_code");

  // Two orders with one free code: the first to confirm takes it.
  await w.order({ pilot_code: codes[1], email: "y@acme-robotics.example", roles: [ID(2)] });
  const y = w.lastLink();
  const zr = await w.order({ pilot_code: codes[1], email: "z@acme-robotics.example", roles: [ID(3)] });
  assert.equal(zr.status, 200, await zr.clone().text());
  const z = w.lastLink();
  assert.equal((await w.confirm(y.id, y.token)).status, 200);
  const lost = await w.confirm(z.id, z.token);
  assert.equal(lost.status, 409);
  assert.equal((await lost.json()).error, "pilot_used");

  const refused = await w.reviewForm(id, { action: "refuse", reason: "The role is not open on the employer's own site." });
  assert.equal(refused.status, 200);
  assert.equal(w.db.dump().pilot_codes.find((c) => c.code === codes[0]).order_id, null, "freed");
  assert.match(w.mail.sent.at(-1).text, /pilot code can be used again/);
  assert.ok(!w.stripe.calls.some((c) => c.url.endsWith("refunds")), "nothing to refund");
  const again = await w.order({ pilot_code: codes[0], email: "again@acme-robotics.example" }, { ...SITE, "CF-Connecting-IP": "198.51.100.5" });
  assert.equal(again.status, 200, "the freed code works again");
});
