// Paid listings bought on the site (src/orders.js, worker/ORDERS.md): the gating, the order rules, the
// field cap, the email link, the pilot codes, Checkout, the webhook, Bruce's review page, disputes, the
// daily cron and the admin routes. No network: the role index, Stripe and the email binding are fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { CHECKS, endExpiredPlacements } from "../src/placements.js";
import { FIELD_CAP, PRICES, TERMS_VERSION, ordersCron, reviewSig } from "../src/orders.js";
import { parseArgs, toRequest, run } from "../scripts/placement.mjs";
import { handle } from "../src/index.js";
import { NOW, makeEnv, setup } from "./helpers.js";

const ADMIN = "admin-test-token";
const WH = "whsec_orders_test";
const ON = {
  EMPLOYER_CHECKOUT: "1", STRIPE_SECRET_KEY: "sk_test_orders", STRIPE_WEBHOOK_SECRET: WH, ADMIN_TOKEN: ADMIN,
  REVIEW_TO: "bruce@internscout.test", ORDER_FROM: "InternScout <listings@internscout.org>",
};
const SITE = { Origin: "https://internscout.org", "CF-Connecting-IP": "203.0.113.9" };
const ID = (n) => "a" + String(n).padStart(15, "0");
const TODAY = "2026-09-14";   // NOW in helpers.js

// The site's role index, shard "a" (backend role_index.py).
const ROLES = [
  { id: ID(1), k: "acme", co: "Acme Robotics", t: "Mechanical Engineering Intern", loc: "Boston, MA", u: "https://jobs.acme.example/1", f: ["engineering"], unpaid: false },
  { id: ID(2), k: "acme", co: "Acme Robotics", t: "Software Intern", loc: "Remote", u: "https://jobs.acme.example/2", f: ["engineering", "software"], unpaid: false },
  { id: ID(3), k: "acme", co: "Acme Robotics", t: "Controls Intern", loc: "Boston, MA", u: "https://jobs.acme.example/3", f: ["engineering"], unpaid: false },
  { id: ID(4), k: "acme", co: "Acme Robotics", t: "Outreach Volunteer", loc: "Boston, MA", u: "https://jobs.acme.example/4", f: ["outreach"], unpaid: true },
  { id: ID(5), k: "apex", co: "Apex Labs", t: "Lab Intern", loc: "Austin, TX", u: "https://apex.example/5", f: ["science"], unpaid: false },
  { id: ID(6), k: "acme", co: "Acme Robotics", t: "Office Intern", loc: "", u: "https://jobs.acme.example/6", f: [], unpaid: false },
  { id: ID(7), k: "acme", co: "Acme Robotics", t: "Bad link", loc: "", u: "http://jobs.acme.example/7", f: [], unpaid: false },
  { id: "not-an-id", k: "acme", co: "x", t: "x", u: "https://x.example", f: [] },
  "junk",
];
const siteReply = (url) => {
  if (url === "https://internscout.org/data/roles/a.json") return Response.json({ generated: "2026-09-14T06:00:00Z", roles: ROLES });
  if (url.startsWith("https://internscout.org/data/roles/")) return new Response("Not found", { status: 404 });
  return null;
};

function fakeEmail() {
  const sent = [];
  const box = { sent, failNext: 0, send: async (m) => {
    if (box.failNext > 0) {
      box.failNext -= 1;
      throw Object.assign(new Error("send failed"), { code: "E_DELIVERY_FAILED" });
    }
    sent.push(m);
    return { messageId: "m" + sent.length };
  } };
  return box;
}

function stripeFake() {
  const calls = [];
  let n = 0;
  const fn = (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body || ""));
    calls.push({ url, form, key: init.headers["Idempotency-Key"], version: init.headers["Stripe-Version"] });
    n += 1;
    if (url.endsWith("checkout/sessions")) return Response.json({ id: `cs_test_${n}`, url: `https://checkout.stripe.test/pay/cs_test_${n}` });
    if (url.endsWith("refunds")) return Response.json({ id: `re_${n}`, amount: form.amount ? Number(form.amount) : 2900 });
    if (url.endsWith("coupons")) return Response.json({ id: `co_${n}` });
    if (url.endsWith("promotion_codes")) return Response.json({ id: `promo_${n}`, code: "CREDIT7X2" });
    return Response.json({ error: { type: "invalid_request_error" } }, { status: 400 });
  };
  fn.calls = calls;
  return fn;
}

const GOOD = {
  shard: "a", roles: [ID(1)], package: "one", start: "2026-09-20", name: "Dana Reyes",
  email: "dana@acme-robotics.example", company: "Acme Robotics", public_body: false, terms: true, terms_version: TERMS_VERSION, website: "",
};

async function sign(body, at) {
  const t = Math.floor(at.getTime() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WH), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let evt = 0;
const sessionEvent = (order, over = {}, type = "checkout.session.completed") => ({
  id: `evt_listing_${++evt}`, type, livemode: false,
  data: { object: { id: "cs_test_1", object: "checkout.session", client_reference_id: order,
    metadata: { kind: "listing", order }, payment_status: "paid", payment_intent: "pi_1", amount_total: 2900, ...over } },
});

async function world({ env = {}, site = siteReply, stripe: customStripe } = {}) {
  const mail = fakeEmail();
  const stripe = customStripe || stripeFake();
  const w = await setup({ env: { ...ON, EMAIL: mail, ...env }, site, stripe });
  const t = { now: NOW };
  const setNow = (d) => { t.now = d; w.setNow(d); };
  const order = (over = {}, headers = SITE) => w.api("POST", "/employer/order", { body: { ...GOOD, ...over }, headers });
  const lastLink = () => {
    const m = [...mail.sent].reverse().map((x) => /\/employers\/buy\/\?order=(o-[0-9a-f]{16})&t=([A-Za-z0-9_-]{43})/.exec(x.text)).find(Boolean);
    return m ? { id: m[1], token: m[2] } : null;
  };
  const confirm = (id, token, headers = SITE) => w.api("POST", "/employer/order/confirm", { body: { order: id, token }, headers });
  const webhook = async (event) => {
    const body = JSON.stringify(event);
    return w.api("POST", "/billing/webhook", { body: event, headers: { "Stripe-Signature": await sign(body, t.now) } });
  };
  // An order taken, confirmed and paid; returns its id.
  const paid = async (over = {}, pay = {}) => {
    const res = await order(over);
    assert.equal(res.status, 200, await res.clone().text());
    const { id, token } = lastLink();
    const c = await confirm(id, token);
    assert.equal(c.status, 200, await c.clone().text());
    const h = await webhook(sessionEvent(id, pay));
    assert.equal(h.status, 200, await h.clone().text());
    return id;
  };
  const orderRow = (id) => w.db.dump().employer_orders.find((o) => o.id === id);
  const placementsOf = (id) => {
    const ids = w.db.dump().employer_order_roles.filter((r) => r.order_id === id).map((r) => r.placement_id);
    return w.db.dump().placements.filter((p) => ids.includes(p.id));
  };
  const reviewForm = async (id, fields, sig) => w.api("POST", "/employer/review", {
    raw: new URLSearchParams({ order: id, sig: sig ?? await reviewSig(w.env, id), ...fields }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const adminCall = (method, path, body, headers = {}) => w.api(method, path, { token: ADMIN, body, headers });
  return { ...w, mail, stripe, setNow, order, lastLink, confirm, webhook, paid, orderRow, placementsOf, reviewForm, adminCall };
}

// A paid role that holds days, written straight into the tables (no placement yet: the order's own days).
let held = 0;
async function hold(w, { fields = "engineering", start = "2026-09-20", status = "paid", listing, checkoutAt = null } = {}) {
  const id = "o-" + String(++held).padStart(16, "0");
  await w.db.prepare(
    "INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, company, name, email, " +
    "email_domain, terms_version, terms_at, price, checkout_at) VALUES (?, ?, ?, ?, 'one', ?, 'x', 'X', 'X', 'N', 'n@x.example', 'x.example', ?, ?, 2900, ?)",
  ).bind(id, NOW.toISOString(), NOW.toISOString(), status, start, TERMS_VERSION, NOW.toISOString(), checkoutAt).run();
  await w.db.prepare("INSERT INTO employer_order_roles (order_id, listing_id, employer_key, company, title, apply_url, fields) VALUES (?, ?, 'x', 'X', 'T', 'https://x.example/j', ?)")
    .bind(id, listing || "b" + String(held).padStart(15, "0"), fields).run();
  return id;
}

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

// ---------------------------------------------------------------- review

test("the review page needs the right signature, escapes everything and runs no script", async () => {
  const w = await world();
  const id = await w.paid({ company: "Acme <script>alert(1)</script>", name: "Dana \"<i>\" Reyes" });
  const sig = await reviewSig(w.env, id);
  assert.equal((await w.api("GET", `/employer/review?order=${id}`)).status, 403);
  assert.equal((await w.api("GET", `/employer/review?order=${id}&sig=${"0".repeat(64)}`)).status, 403);
  const other = await reviewSig({ ADMIN_TOKEN: "another-token" }, id);
  assert.equal((await w.api("GET", `/employer/review?order=${id}&sig=${other}`)).status, 403);
  assert.equal((await w.api("GET", `/employer/review?order=o-ffffffffffffffff&sig=${sig}`)).status, 403, "a signature is for one order");

  const res = await w.api("GET", `/employer/review?order=${id}&sig=${sig}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /^text\/html/);
  const csp = res.headers.get("Content-Security-Policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.doesNotMatch(csp, /script-src|unsafe-inline/);
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const html = await res.text();
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Acme &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Dana &quot;&lt;i&gt;&quot; Reyes/);
  assert.match(html, /Listed as open on InternScout today/);
  assert.match(html, /acme-robotics\.example/);
  assert.match(html, /jobs\.acme\.example/);
  assert.match(html, /engineering: 0 other paid roles/);
  for (const c of CHECKS) assert.ok(html.includes(c), c);
  assert.match(html, /name="action" value="approve"/);
  assert.match(html, /name="action" value="refuse"/);

  const wrong = await w.reviewForm(id, { action: "approve" }, "0".repeat(64));
  assert.equal(wrong.status, 403);
  assert.equal(w.orderRow(id).status, "paid", "nothing changed");
  assert.ok(w.placementsOf(id).every((p) => p.status === "draft"));
  const json = await w.api("POST", "/employer/review", { body: { order: id, sig, action: "approve" } });
  assert.equal(json.status, 400, "a form, not JSON");
});

test("approve: every check recorded by bruce, switched on with paid_ref, the employer emailed the dates", async () => {
  const w = await world();
  const id = await w.paid();
  const res = await w.reviewForm(id, { action: "approve" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(await res.text(), /2026-09-20 to 2026-10-19/);
  const [p] = w.placementsOf(id);
  assert.equal(p.status, "on");
  assert.equal(p.paid_ref, "stripe:pi_1");
  assert.equal(p.checks, CHECKS.join(","));
  assert.equal(p.unpaid_ok, 0);
  assert.equal(p.updated_by, "bruce");
  assert.equal(p.start_day, "2026-09-20");
  const actions = w.db.dump().placement_log.filter((l) => l.placement === p.id).map((l) => `${l.action}:${l.by}`);
  assert.deepEqual(actions, ["create:checkout", "check:bruce", "on:bruce"]);
  assert.equal(w.orderRow(id).status, "approved");
  const m = w.mail.sent.at(-1);
  assert.equal(m.to, "dana@acme-robotics.example");
  assert.match(m.text, /September 20, 2026 through October 19, 2026/);
  assert.equal((await w.reviewForm(id, { action: "approve" })).status, 409, "already decided");
  const live = await (await w.api("GET", "/placements")).json();
  assert.deepEqual(live.placements, [], "it starts on the 20th");
});

test("approve after the start day shifts the 30 days to start on the day of approval", async () => {
  const w = await world();
  const id = await w.paid({ start: TODAY, roles: [ID(4)], public_body: true }, { amount_total: 1500 });
  w.setNow(new Date("2026-09-17T15:00:00Z"));
  assert.equal((await w.reviewForm(id, { action: "approve" })).status, 200);
  const [p] = w.placementsOf(id);
  assert.equal(p.start_day, "2026-09-17");
  assert.equal(p.end_day, "2026-10-17");
  assert.equal(p.status, "on");
  assert.equal(p.unpaid_ok, 1, "an unpaid role of a public body");
  const live = await (await w.api("GET", "/placements")).json();
  assert.equal(live.placements.length, 1);
});

test("refuse: a reason is required; the full amount is refunded, the placements refused, the reason emailed", async () => {
  const w = await world();
  const id = await w.paid();
  const blank = await w.reviewForm(id, { action: "refuse", reason: "  " });
  assert.equal(blank.status, 400);
  assert.equal(w.orderRow(id).status, "paid");
  const res = await w.reviewForm(id, { action: "refuse", reason: "The role is not on Acme's own careers site." });
  assert.equal(res.status, 200);
  const [refund] = w.stripe.calls.filter((c) => c.url.endsWith("refunds"));
  assert.equal(refund.form.payment_intent, "pi_1");
  assert.equal(refund.form.amount, undefined, "the full amount");
  assert.equal(refund.key, `listing-refund:${id}`);
  const o = w.orderRow(id);
  assert.equal(o.status, "refused");
  assert.equal(o.refunded_amount, 2900);
  assert.equal(o.decided_reason, "The role is not on Acme's own careers site.");
  assert.ok(w.placementsOf(id).every((p) => p.status === "refused"));
  const m = w.mail.sent.at(-1);
  assert.equal(m.to, "dana@acme-robotics.example");
  assert.match(m.text, /The reason: The role is not on Acme's own careers site\./);
  assert.match(m.text, /refunded the full amount, \$29\.00/);
  assert.equal((await w.reviewForm(id, { action: "refuse", reason: "again" })).status, 409);
  assert.equal(w.stripe.calls.filter((c) => c.url.endsWith("refunds")).length, 1);
});

test("a dispute pauses the order's live placements and emails Bruce; other disputes are left to the student plans", async () => {
  const w = await world();
  const id = await w.paid();
  w.setNow(new Date("2026-09-21T09:00:00Z"));
  await w.reviewForm(id, { action: "approve" });
  const res = await w.webhook({ id: "evt_dispute_1", type: "charge.dispute.created",
    data: { object: { id: "dp_1", object: "dispute", payment_intent: "pi_1", charge: "ch_1", amount: 2900 } } });
  assert.deepEqual(await res.json(), { ok: true, paused: 1 });
  const [p] = w.placementsOf(id);
  assert.equal(p.status, "paused");
  assert.equal(p.updated_by, "stripe");
  assert.ok(w.orderRow(id).disputed_at);
  const m = w.mail.sent.at(-1);
  assert.equal(m.to, "bruce@internscout.test");
  assert.match(m.subject, /dispute/);
  const other = await w.webhook({ id: "evt_dispute_2", type: "charge.dispute.created",
    data: { object: { id: "dp_2", payment_intent: "pi_unknown", customer: "cus_nobody" } } });
  assert.deepEqual(await other.json(), { ok: true, ignored: true });
});

// ---------------------------------------------------------------- a role closes early

async function liveOrder(w) {
  const id = await w.paid({ start: TODAY });
  await w.reviewForm(id, { action: "approve" });
  const [p] = w.placementsOf(id);
  assert.equal(p.status, "on");
  return { id, p };
}

const dropped = (w, placement, day, reason = "listing_gone", shown = 0) => w.db.prepare(
  "INSERT INTO placement_runs (placement_id, day, shown, dropped, reason, updated) VALUES (?, ?, ?, 1, ?, ?)",
).bind(placement, day, shown, reason, day + "T12:00:00Z").run();

test("financial safety: simultaneous Checkouts cannot both reserve the final field slot", async () => {
  const base = stripeFake();
  const delayed = async (...args) => { await new Promise(r => setTimeout(r, 10)); return base(...args); };
  delayed.calls = base.calls;
  const w = await world({ stripe: delayed });
  for (let i = 0; i < 4; i++) await hold(w);
  await w.order(); const a = w.lastLink();
  await w.order({ roles: [ID(2)] }); const b = w.lastLink();
  const results = await Promise.all([w.confirm(a.id, a.token), w.confirm(b.id, b.token)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(base.calls.filter(c => c.url.endsWith("checkout/sessions")).length, 1);
  const rows = (await w.db.prepare("SELECT day, field, COUNT(*) AS n FROM employer_capacity_reservations GROUP BY day, field").all()).results;
  assert.ok(rows.every(r => r.n <= FIELD_CAP));
});

test("financial safety: a three-role, twenty-field order reserves its full capacity without per-row bindings", async () => {
  const tags = Array.from({ length: 20 }, (_, i) => `field_${i}`);
  const w = await world({ site: url => url.endsWith("/data/roles/a.json")
    ? Response.json({ roles: ROLES.slice(0, 3).map(r => ({ ...r, f: tags })) }) : siteReply(url) });
  await w.order({ roles: [ID(1), ID(2), ID(3)], package: "three" }); const { id, token } = w.lastLink();
  assert.equal((await w.confirm(id, token)).status, 200);
  assert.equal(await w.db.prepare("SELECT COUNT(*) AS n FROM employer_capacity_reservations WHERE order_id = ?").bind(id).first("n"), 1800);
});

test("financial safety: a used pilot creates no leaked capacity and its own interrupted claim can resume", async () => {
  const w = await world();
  const { code } = await (await w.adminCall("POST", "/admin/pilot-codes", {})).json();
  await w.order({ pilot_code: code }); const a = w.lastLink();
  await w.order({ pilot_code: code, roles: [ID(2)] }); const b = w.lastLink();
  // Simulates a process interruption immediately after its pilot claim.
  await w.db.prepare("UPDATE pilot_codes SET order_id = ?, used_at = ? WHERE code = ?").bind(a.id, NOW.toISOString(), code).run();
  assert.equal((await w.confirm(a.id, a.token)).status, 200);
  assert.equal((await w.confirm(b.id, b.token)).status, 409);
  assert.equal(await w.db.prepare("SELECT COUNT(*) AS n FROM employer_capacity_reservations WHERE order_id = ?").bind(b.id).first("n"), 0);
  assert.equal(w.orderRow(a.id).status, "paid");
});

test("financial safety: shifted approval dates reserve capacity again before activating", async () => {
  const w = await world();
  const id = await w.paid({ start: TODAY });
  for (let i = 0; i < FIELD_CAP; i++) await hold(w, { start: "2026-10-14" });
  w.setNow(new Date("2026-09-15T10:00:00Z"));
  assert.equal((await w.reviewForm(id, { action: "approve" })).status, 409);
  assert.ok(w.placementsOf(id).every(p => p.status === "draft"));
  assert.equal((await w.reviewForm(id, { action: "refuse", reason: "No room on the shifted dates" })).status, 200);
});

test("financial safety: approve and refuse claim one immutable decision before side effects", async () => {
  const w = await world(); const id = await w.paid();
  const results = await Promise.all([w.reviewForm(id, { action: "approve" }),
    w.reviewForm(id, { action: "refuse", reason: "Synthetic opposite decision" })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const o = w.orderRow(id);
  const refunded = w.stripe.calls.some(c => c.url.endsWith("refunds"));
  assert.equal(refunded, o.status === "refused");
  assert.ok(w.placementsOf(id).every(p => p.status === (refunded ? "refused" : "on")));
});

test("financial safety: an accepted refund with a lost response cannot switch to a promotion code", async () => {
  const base = stripeFake(); let accepted = 0;
  const uncertain = (...args) => {
    if (args[0].endsWith("refunds")) { accepted++; throw new Error("synthetic response lost after acceptance"); }
    return base(...args);
  };
  uncertain.calls = base.calls;
  const w = await world({ stripe: uncertain }); const { p } = await liveOrder(w);
  await dropped(w, p.id, "2026-09-22"); await dropped(w, p.id, "2026-09-23");
  const at = new Date("2026-09-24T07:17:00Z"); w.setNow(at);
  await ordersCron(w.db, w.env, at, w.fetch);
  const link = /credit=(c-[0-9a-f]{16})&t=([A-Za-z0-9_-]{43})/.exec(w.mail.sent.at(-1).text);
  const choose = choice => w.api("POST", "/employer/credit", { body: { credit: link[1], token: link[2], choice }, headers: SITE });
  assert.equal((await choose("refund")).status, 500);
  assert.equal((await choose("credit")).status, 409);
  assert.equal((await choose("refund")).status, 409);
  assert.equal(accepted, 1);
  assert.equal((await w.db.prepare("SELECT state FROM employer_credit_jobs").first()).state, "unknown");
  await ordersCron(w.db, w.env, new Date("2026-11-01T07:17:00Z"), w.fetch);
  assert.equal(accepted, 1, "cron cannot blindly repeat an ambiguous payout");
  assert.ok(w.mail.sent.some(m => /needs reconciliation/.test(m.subject)));
});

test("financial safety: a crash after credit claim remains held and alerts the owner instead of paying twice", async () => {
  const w = await world(); const { p, id } = await liveOrder(w);
  await dropped(w, p.id, "2026-09-22"); await dropped(w, p.id, "2026-09-23");
  const at = new Date("2026-09-24T07:17:00Z"); await ordersCron(w.db, w.env, at, w.fetch);
  const c = w.db.dump().employer_credits[0];
  await w.db.prepare("INSERT INTO employer_credit_jobs (credit_id, order_id, choice, state, created, updated) VALUES (?, ?, 'credit', 'running', ?, ?)")
    .bind(c.id, id, at.toISOString(), at.toISOString()).run();
  const before = w.stripe.calls.length;
  await ordersCron(w.db, w.env, new Date("2026-11-01T07:17:00Z"), w.fetch);
  assert.equal(w.stripe.calls.length, before);
  assert.equal(w.db.dump().employer_credits[0].status, "offered", "money owed is retained");
  assert.ok(w.mail.sent.some(m => /needs reconciliation/.test(m.subject)));
});

test("financial safety: closing and recording money owed are one rollback-safe transaction", async () => {
  const w = await world(); const { p } = await liveOrder(w);
  await dropped(w, p.id, "2026-09-22"); await dropped(w, p.id, "2026-09-23");
  const prepare = w.db.prepare;
  w.db.prepare = query => {
    if (query.startsWith("INSERT OR IGNORE INTO employer_credits")) return { bind: () => ({ run: async () => { throw new Error("synthetic insert failure"); } }) };
    return prepare(query);
  };
  const at = new Date("2026-09-24T07:17:00Z");
  await ordersCron(w.db, w.env, at, w.fetch);
  assert.equal(w.placementsOf(w.orderRow(w.db.dump().employer_orders[0].id).id)[0].status, "on");
  assert.equal(w.db.dump().employer_credits.length, 0);
  w.db.prepare = prepare;
  await ordersCron(w.db, w.env, at, w.fetch);
  assert.equal(w.db.dump().employer_credits.length, 1);
  assert.equal(w.db.dump().placements[0].status, "ended");
});

test("financial safety: bundle refunds allocate remainder cents without exceeding the $35 payment", async () => {
  const w = await world();
  const id = await w.paid({ start: TODAY, roles: [ID(1), ID(2), ID(3)], package: "three", public_body: true }, { amount_total: 3500 });
  await w.reviewForm(id, { action: "approve" });
  for (const p of w.placementsOf(id)) { await dropped(w, p.id, TODAY); await dropped(w, p.id, "2026-09-15"); }
  await ordersCron(w.db, w.env, new Date("2026-09-16T07:17:00Z"), w.fetch);
  const amounts = w.db.dump().employer_credits.map(c => c.amount).sort();
  assert.deepEqual(amounts, [1166, 1167, 1167]);
  assert.equal(amounts.reduce((a, b) => a + b), 3500);
});

test("financial safety: normal expiry cannot erase unused days detected by the simultaneous closure cron", async () => {
  const w = await world(); const { p } = await liveOrder(w);
  await dropped(w, p.id, "2026-10-12"); await dropped(w, p.id, "2026-10-13");
  const at = new Date("2026-10-14T07:17:00Z");
  await endExpiredPlacements(w.db, at);
  assert.equal(w.db.dump().placements[0].ended_reason, "dates");
  await ordersCron(w.db, w.env, at, w.fetch);
  assert.equal(w.db.dump().employer_credits[0].unused_days, 2);
  assert.equal(w.db.dump().employer_credits[0].amount, Math.round(2900 * 2 / 30));
});

test("current clickwrap version is required and availability checks selected roles together", async () => {
  const w = await world();
  for (const terms_version of [undefined, "2000-01-01"]) {
    const bad = await w.order({ terms_version }); assert.equal(bad.status, 400);
    assert.equal((await bad.json()).field, "terms_version");
  }
  for (let i = 0; i < 3; i++) await hold(w);
  const result = await (await w.api("GET", `/employer/availability?shard=a&ids=${[ID(1), ID(2), ID(3)].join(",")}&start=2026-09-20`)).json();
  assert.ok(result.roles.some(r => r.fits === false));
});

test("manual placements seed atomic reservations and direct activation/edits cannot bypass live checkout capacity", async () => {
  const w = await world();
  for (let i = 0; i < 4; i++) {
    const made = await w.adminCall("POST", "/admin/placements", { employer: "Acme Robotics", listing_id: ID(1),
      apply_url: "https://jobs.acme.example/1", start: "2026-09-18", end: "2026-10-18", by: "bruce" });
    assert.equal(made.status, 200);
  }
  await w.order({ roles: [ID(3)] }); const first = w.lastLink();
  assert.equal((await w.confirm(first.id, first.token)).status, 200);
  const manual = w.db.dump().placements[0];
  assert.ok((await w.db.prepare("SELECT COUNT(*) AS n FROM employer_capacity_reservations WHERE order_id LIKE 'manual:%'").first("n")) > 0);
  const on = await w.adminCall("POST", "/admin/placements/on", { id: manual.id, paid_ref: "synthetic", by: "bruce" });
  assert.equal(on.status, 409); assert.equal((await on.json()).error, "manual_capacity_hold");
  assert.equal((await w.adminCall("POST", "/admin/placements/update", { id: manual.id, start: "2026-09-19", end: "2026-10-19", by: "bruce" })).status, 409);
  assert.equal((await w.adminCall("POST", "/admin/placements/end", { id: manual.id, reason: "removed", by: "bruce" })).status, 200);
  await w.order({ roles: [ID(2)] }); const next = w.lastLink();
  assert.equal((await w.confirm(next.id, next.token)).status, 200, "ending a manual placement frees its atomic capacity");
});

test("refund choice window starts with a successfully sent offer, not an earlier failed send", async () => {
  const w = await world(); const { p } = await liveOrder(w);
  await dropped(w, p.id, "2026-09-22"); await dropped(w, p.id, "2026-09-23");
  w.mail.failNext = 2; // closeRoles and the same run's resendOffers both fail.
  await ordersCron(w.db, w.env, new Date("2026-09-24T07:17:00Z"), w.fetch);
  assert.equal(w.db.dump().employer_credits[0].offer_sent_at, null);
  await ordersCron(w.db, w.env, new Date("2026-10-01T07:17:00Z"), w.fetch);
  assert.equal(w.db.dump().employer_credits[0].offer_sent_at, "2026-10-01T07:17:00.000Z");
  assert.match(w.mail.sent.at(-1).text, /October 31, 2026/);
  await ordersCron(w.db, w.env, new Date("2026-10-25T07:17:00Z"), w.fetch);
  assert.equal(w.db.dump().employer_credits[0].status, "offered");
  await ordersCron(w.db, w.env, new Date("2026-11-01T07:17:00Z"), w.fetch);
  assert.equal(w.db.dump().employer_credits[0].status, "refund");
});

test("failed decision email remains queued and daily cron retries without another decision", async () => {
  const w = await world(); const id = await w.paid();
  w.mail.failNext = 1;
  const res = await w.reviewForm(id, { action: "approve" });
  assert.equal(res.status, 200); assert.match(await res.text(), /recorded for delivery/);
  assert.equal((await w.db.prepare("SELECT sent_at FROM employer_order_mail WHERE order_id = ? AND kind = 'approved'").bind(id).first()).sent_at, null);
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 3600e3), w.fetch);
  assert.ok((await w.db.prepare("SELECT sent_at FROM employer_order_mail WHERE order_id = ? AND kind = 'approved'").bind(id).first()).sent_at);
  assert.equal(w.orderRow(id).status, "approved");
});

test("cron: a role every build dropped on both of the last two days ends, and its unused days are offered back", async () => {
  const w = await world();
  const { id, p } = await liveOrder(w);
  await dropped(w, p.id, "2026-09-22");
  const at = new Date("2026-09-24T07:17:00Z");
  await ordersCron(w.db, w.env, at, w.fetch);
  assert.equal(w.placementsOf(id)[0].status, "on", "one day is not enough");
  await dropped(w, p.id, "2026-09-23", "closed");
  await ordersCron(w.db, w.env, at, w.fetch);
  const [ended] = w.placementsOf(id);
  assert.equal(ended.status, "ended");
  assert.equal(ended.ended_reason, "role_closed");
  const [c] = w.db.dump().employer_credits;
  assert.equal(c.unused_days, 22, "from 09-22, the first dropped day, to the end on 10-14");
  assert.equal(c.amount, Math.round(22 * 2900 / 30));
  assert.equal(c.status, "offered");
  assert.ok(c.offer_sent_at);
  const m = w.mail.sent.at(-1);
  assert.equal(m.to, "dana@acme-robotics.example");
  const link = /\/employers\/buy\/\?credit=(c-[0-9a-f]{16})&t=([A-Za-z0-9_-]{43})/.exec(m.text);
  assert.ok(link, m.text);
  assert.match(m.text, /\$21\.27/);
  assert.match(m.text, /22 of its 30 days/);
  assert.doesNotMatch(m.text, /—/);
  await ordersCron(w.db, w.env, at, w.fetch);
  assert.equal(w.db.dump().employer_credits.length, 1, "offered once");

  // The offer, then the employer's choice: a promotion code.
  assert.equal((await w.api("GET", `/employer/credit?credit=${link[1]}&t=${(link[2][0] === "x" ? "y" : "x") + link[2].slice(1)}`)).status, 403);
  const info = await (await w.api("GET", `/employer/credit?credit=${link[1]}&t=${link[2]}`, { headers: SITE })).json();
  assert.deepEqual(info, { credit: link[1], status: "offered", amount: 2127, unused_days: 22,
    role: { title: ROLES[0].t, company: "Acme Robotics" }, choose_by: "2026-10-24" });
  const choose = (choice, headers = SITE) => w.api("POST", "/employer/credit", { body: { credit: link[1], token: link[2], choice }, headers });
  assert.equal((await choose("cash")).status, 400);
  assert.equal((await choose("credit", {})).status, 403, "the site only");
  const got = await choose("credit");
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), { done: "credit", code: "CREDIT7X2", amount: 2127 });
  const coupon = w.stripe.calls.find((c) => c.url.endsWith("coupons"));
  assert.deepEqual([coupon.form.amount_off, coupon.form.currency, coupon.form.duration, coupon.form.max_redemptions], ["2127", "usd", "once", "1"]);
  const promo = w.stripe.calls.find((c) => c.url.endsWith("promotion_codes"));
  assert.equal(promo.form["promotion[type]"], "coupon");
  assert.equal(promo.form["promotion[coupon]"], "co_" + (w.stripe.calls.indexOf(coupon) + 1));
  assert.equal(promo.form.max_redemptions, "1");
  assert.match(w.mail.sent.at(-1).text, /CREDIT7X2/);
  const twice = await choose("refund");
  assert.equal(twice.status, 409);
  assert.equal((await twice.json()).code, "CREDIT7X2");
  assert.ok(!w.stripe.calls.some((c) => c.url.endsWith("refunds") && c.form["metadata[credit]"]));
});

test("cron: the refund choice, the 30-day default, a pilot told it stopped, and reasons that don't close a role", async () => {
  const w = await world();
  const { p } = await liveOrder(w);
  await dropped(w, p.id, "2026-09-22");
  await dropped(w, p.id, "2026-09-23");
  await ordersCron(w.db, w.env, new Date("2026-09-24T07:17:00Z"), w.fetch);
  const link = /credit=(c-[0-9a-f]{16})&t=([A-Za-z0-9_-]{43})/.exec(w.mail.sent.at(-1).text);
  const res = await w.api("POST", "/employer/credit", { body: { credit: link[1], token: link[2], choice: "refund" }, headers: SITE });
  assert.deepEqual(await res.json(), { done: "refund", amount: 2127 });
  const refund = w.stripe.calls.find((c) => c.url.endsWith("refunds"));
  assert.deepEqual([refund.form.payment_intent, refund.form.amount], ["pi_1", "2127"]);
  assert.equal(refund.key, `listing-credit-refund:${link[1]}`);
  assert.equal(w.db.dump().employer_credits[0].status, "refund");
  assert.equal(w.db.dump().employer_credits[0].chosen_by, "employer");

  // No answer in 30 days.
  const d = await world();
  const { p: q } = await liveOrder(d);
  await dropped(d, q.id, "2026-09-22");
  await dropped(d, q.id, "2026-09-23");
  await ordersCron(d.db, d.env, new Date("2026-09-24T07:17:00Z"), d.fetch);
  await ordersCron(d.db, d.env, new Date("2026-10-20T07:17:00Z"), d.fetch);
  assert.equal(d.db.dump().employer_credits[0].status, "offered", "not before 30 days");
  await ordersCron(d.db, d.env, new Date("2026-10-25T07:17:00Z"), d.fetch);
  const [c] = d.db.dump().employer_credits;
  assert.equal(c.status, "refund");
  assert.equal(c.chosen_by, "default");
  assert.equal(d.stripe.calls.filter((x) => x.url.endsWith("refunds")).length, 1);
  assert.match(d.mail.sent.at(-1).text, /did not choose within 30 days/);

  // A pilot has nothing to refund.
  const pw = await world();
  const { code } = await (await pw.adminCall("POST", "/admin/pilot-codes", {})).json();
  await pw.order({ pilot_code: code, start: TODAY });
  const l = pw.lastLink();
  await pw.confirm(l.id, l.token);
  await pw.reviewForm(l.id, { action: "approve" });
  const [pp] = pw.placementsOf(l.id);
  await dropped(pw, pp.id, "2026-09-22", "deadline");
  await dropped(pw, pp.id, "2026-09-23", "url_changed");
  await ordersCron(pw.db, pw.env, new Date("2026-09-24T07:17:00Z"), pw.fetch);
  assert.equal(pw.placementsOf(l.id)[0].status, "ended");
  assert.equal(pw.db.dump().employer_credits.length, 0);
  assert.match(pw.mail.sent.at(-1).text, /pilot listing, so there is nothing to refund/);

  // A build that also kept it, or a drop for another reason, does not close it.
  const k = await world();
  const { id: kid, p: kp } = await liveOrder(k);
  await dropped(k, kp.id, "2026-09-22");
  await dropped(k, kp.id, "2026-09-23", "listing_gone", 1);
  await ordersCron(k.db, k.env, new Date("2026-09-24T07:17:00Z"), k.fetch);
  assert.equal(k.placementsOf(kid)[0].status, "on", "one build kept it on the 23rd");
  const r = await world();
  const { id: rid, p: rp } = await liveOrder(r);
  await dropped(r, rp.id, "2026-09-22", "duplicate");
  await dropped(r, rp.id, "2026-09-23", "duplicate");
  await ordersCron(r.db, r.env, new Date("2026-09-24T07:17:00Z"), r.fetch);
  assert.equal(r.placementsOf(rid)[0].status, "on");
});

test("cron: an order never confirmed is deleted after 7 days; a confirmed one is kept", async () => {
  const w = await world();
  await w.order();
  const a = w.lastLink();
  await w.order({ email: "kept@acme-robotics.example" });
  const b = w.lastLink();
  await w.confirm(b.id, b.token);
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 6 * 86400e3), w.fetch);
  assert.equal(w.db.dump().employer_orders.length, 2);
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 7 * 86400e3 + 1000), w.fetch);
  assert.deepEqual(w.db.dump().employer_orders.map((o) => o.id), [b.id]);
  assert.ok(!w.db.dump().employer_order_roles.some((r) => r.order_id === a.id));
  // Orders off: the cleanup still runs, nothing else does.
  const off = await world({ env: { EMPLOYER_CHECKOUT: "0" } });
  await off.db.prepare("INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, company, name, " +
    "email, email_domain, terms_version, terms_at, price) VALUES ('o-0000000000000abc', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', " +
    "'unverified', 'one', '2026-09-20', 'acme', 'Acme', 'Acme', 'N', 'n@acme.example', 'acme.example', ?, '2026-09-01T00:00:00Z', 2900)")
    .bind(TERMS_VERSION).run();
  await ordersCron(off.db, off.env, NOW, off.fetch);
  assert.equal(off.db.dump().employer_orders.length, 0);
});

test("the Worker's daily cron runs the orders cron too", async () => {
  const env = makeEnv({ ...ON, EMAIL: fakeEmail() });
  await env.DB.prepare("INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, company, name, " +
    "email, email_domain, terms_version, terms_at, price) VALUES ('o-0000000000000def', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', " +
    "'unverified', 'one', '2020-01-02', 'acme', 'Acme', 'Acme', 'N', 'n@acme.example', 'acme.example', ?, '2020-01-01T00:00:00Z', 2900)")
    .bind(TERMS_VERSION).run();
  const worker = (await import("../src/index.js")).default;
  const waits = [];
  worker.scheduled({ cron: "17 7 * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(env.DB.dump().employer_orders.length, 0);
});

// ---------------------------------------------------------------- admin

test("GET /admin/orders lists the orders without the employer's name or email; admin rules apply", async () => {
  const w = await world();
  const id = await w.paid();
  assert.equal((await w.api("GET", "/admin/orders")).status, 401);
  assert.equal((await w.api("GET", "/admin/orders", { token: "wrong" })).status, 401);
  assert.equal((await w.adminCall("GET", "/admin/orders", undefined, { Origin: "https://internscout.org" })).status, 403);
  assert.equal((await w.adminCall("POST", "/admin/pilot-codes", {}, { Origin: "https://internscout.org" })).status, 403);
  const res = await w.adminCall("GET", "/admin/orders");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("dana@acme-robotics.example"));
  assert.ok(!text.includes("Dana Reyes"));
  assert.deepEqual(JSON.parse(text).orders, [{ id, created: NOW.toISOString(), status: "paid", package: "one", start: "2026-09-20",
    amount: 2900, company: "Acme Robotics", roles: 1 }]);
  const noAdmin = await world({ env: { ADMIN_TOKEN: "" } });
  assert.equal((await noAdmin.adminCall("GET", "/admin/orders")).status, 404);
});

test("scripts/placement.mjs: orders and pilot-code, printing no name or email", async () => {
  assert.deepEqual(toRequest(parseArgs(["orders"])), { method: "GET", path: "/admin/orders", admin: true });
  assert.deepEqual(toRequest(parseArgs(["pilot-code", "--note", "first pilot"])),
    { method: "POST", path: "/admin/pilot-codes", admin: true, body: { note: "first pilot" } });
  assert.deepEqual(toRequest(parseArgs(["pilot-code"])).body, {});

  const env = makeEnv({ ADMIN_TOKEN: ADMIN });
  const f = async (url, init) => handle(new Request(url.replace("https://internscout-api.bpmcginley.workers.dev", "https://api.test"), init),
    env, { waitUntil() {} }, { now: () => NOW });
  const lines = [];
  const out = (s) => lines.push(String(s));
  assert.equal(await run(["pilot-code", "--note", "first pilot"], { env: { INTERNSCOUT_ADMIN_TOKEN: ADMIN }, fetch: f, out, err: out }), 0);
  assert.match(lines.join("\n"), /PILOT-[A-Z2-9]{8}/);
  await env.DB.prepare("INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, company, name, " +
    "email, email_domain, terms_version, terms_at, price) VALUES ('o-0000000000000123', ?, ?, 'verified', 'one', '2026-09-20', 'acme', 'Acme', " +
    "'Acme', 'Secret Name', 'secret@acme.example', 'acme.example', ?, ?, 2900)").bind(NOW.toISOString(), NOW.toISOString(), TERMS_VERSION, NOW.toISOString()).run();
  lines.length = 0;
  assert.equal(await run(["orders"], { env: { INTERNSCOUT_ADMIN_TOKEN: ADMIN }, fetch: f, out, err: out }), 0);
  const printed = lines.join("\n");
  assert.match(printed, /o-0000000000000123/);
  assert.ok(!printed.includes("Secret Name") && !printed.includes("secret@acme.example") && !printed.includes(ADMIN));
});

// Legal review round 4 (2026-10-19): the terms promise at most five paid listings in a field however they
// were bought, so placements Bruce makes by hand count too, under their role's fields from the index.
test("placements made by hand count toward the field cap under their role's fields", async () => {
  const w = await world();
  const make = (listing) => w.adminCall("POST", "/admin/placements", { employer: "Acme Robotics", listing_id: listing,
    apply_url: "https://jobs.acme.example/1", start: "2026-09-18", end: "2026-10-18", by: "bruce" });
  for (let i = 0; i < FIELD_CAP; i++) assert.equal((await make(ID(1))).status, 200);
  const looked = w.db.dump().placement_fields;
  assert.equal(looked.length, FIELD_CAP);
  assert.ok(looked.every((f) => f.fields === "engineering" && f.listing_id === ID(1)));
  // ID(3) is engineering too, on overlapping days: full, with the day the hand-made ones end.
  const res = await w.order({ roles: [ID(3)] });
  assert.equal(res.status, 409, await res.clone().text());
  const out = await res.json();
  assert.equal(out.error, "full");
  assert.equal(out.next_start, "2026-10-18");
  // Apex's science role shares no field with them.
  assert.equal((await w.order({ roles: [ID(5)], email: "lab@apex.example", company: "Apex Labs" })).status, 200);
  // An ended one stops holding days.
  const id = w.db.dump().placements[0].id;
  assert.equal((await w.adminCall("POST", "/admin/placements/end", { id, reason: "removed", by: "bruce" })).status, 200);
  assert.equal((await w.order({ roles: [ID(3)] })).status, 200);
});

test("the daily cron looks up a hand-made placement's fields the admin route missed, and placements of orders are left alone", async () => {
  const w = await world();
  await w.db.prepare("INSERT INTO placements (id, employer, listing_id, apply_url, start_day, end_day, status, created, created_by, updated, updated_by) " +
    "VALUES ('p-2026-09-acme-robotics-9', 'Acme Robotics', ?, 'https://jobs.acme.example/2', '2026-09-15', '2026-10-15', 'on', ?, 'bruce', ?, 'bruce')")
    .bind(ID(2), NOW.toISOString(), NOW.toISOString()).run();
  const id = await w.paid();
  await ordersCron(w.db, w.env, new Date(NOW.getTime() + 3600e3), w.fetch);
  const rows = w.db.dump().placement_fields;
  assert.deepEqual(rows.map((r) => [r.placement_id, r.fields]), [["p-2026-09-acme-robotics-9", "engineering,software"]]);
  assert.ok(!rows.some((r) => w.placementsOf(id).map((p) => p.id).includes(r.placement_id)));
});

test("the order records the clickwrap box's words, and the received email links the terms version accepted", async () => {
  const w = await world();
  const id = await w.paid();
  assert.match(w.orderRow(id).terms_box, /^I have read and accept the InternScout terms, including the section for employers, on behalf of my company/);
  const got = w.mail.sent.find((m) => m.to === GOOD.email && /We have your/.test(m.subject));
  assert.match(got.text, new RegExp(`version ${TERMS_VERSION}`));
  assert.match(got.text, new RegExp(`blob/terms-${TERMS_VERSION}/docs/terms\.html#employers`));
  assert.match(got.text, /Until we approve it, you can cancel it for a full refund by replying to this email/);
});
