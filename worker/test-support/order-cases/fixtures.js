import assert from "node:assert/strict";
import { TERMS_VERSION } from "../../src/orders/shared.js";
import { reviewSig } from "../../src/orders/templates.js";
import { NOW, setup } from "../../test/helpers.js";

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

export { ADMIN, GOOD, ID, ON, ROLES, SITE, TODAY, fakeEmail, hold, sessionEvent, siteReply, stripeFake, world };
