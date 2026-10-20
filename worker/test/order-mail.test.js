// Durable messages and retention against real in-memory SQLite; no email or payment services.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1 } from "./helpers.js";
import { queueOrderMail, retryOrderMail, dropRetainedOrders } from "../src/order-mail.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const ORDER = "o-0000000000000001";
const MAIL = { to: "hiring@employer.example", subject: "Your order", text: "Your order is approved.",
  replyTo: "listings@internscout.example" };
async function world() {
  const db = fakeD1();
  await db.exec(readFileSync(new URL("../order-mail-schema.sql", import.meta.url), "utf8"));
  const sent = [];
  const email = { failures: 0, send: async (mail) => {
    if (email.failures-- > 0) throw Object.assign(new Error("test outage"), { code: "E_DELIVERY_FAILED" });
    sent.push(mail); return { messageId: "fake" };
  } };
  return { db, sent, email, env: { ORDER_FROM: "InternScout <listings@internscout.example>", EMAIL: email } };
}

test("failed decision mail survives and retries; accepted mail erases content and is not resent", async () => {
  const w = await world();
  w.email.failures = 1;
  assert.equal(await queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "approved", mail: MAIL }, NOW), false);
  let row = await w.db.prepare("SELECT * FROM employer_order_mail").first();
  assert.equal(row.sent_at, null); assert.equal(row.body, MAIL.text); assert.equal(row.attempts, 1);
  assert.deepEqual(await retryOrderMail(w.db, w.env, new Date(NOW.getTime() + 86400e3)), { attempted: 1, sent: 1 });
  row = await w.db.prepare("SELECT * FROM employer_order_mail").first();
  assert.ok(row.sent_at); assert.equal(row.body, null); assert.equal(row.to_address, null);
  assert.equal(row.subject, null); assert.equal(row.reply_to, null); assert.equal(row.attempts, 2);
  assert.equal(await queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "approved", mail: MAIL }, NOW), true);
  assert.equal(w.sent.length, 1);
  assert.deepEqual(await retryOrderMail(w.db, w.env, NOW), { attempted: 0, sent: 0 });
});

test("concurrent webhook/decision calls send each message kind once and keep the original message", async () => {
  const w = await world();
  await Promise.all([queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "receipt", mail: MAIL }, NOW),
    queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "receipt", mail: { ...MAIL, text: "Do not replace it" } }, NOW)]);
  assert.equal(w.sent.length, 1); assert.equal(w.sent[0].text, MAIL.text);
  assert.equal(await queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "approved", mail: MAIL }, NOW), true);
  assert.equal(w.sent.length, 2, "receipt and decision are separate messages");
});

test("an interrupted sender's lease expires and retries without discarding its queued message", async () => {
  const w = await world();
  const until = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  await w.db.prepare("INSERT INTO employer_order_mail (order_id, kind, created, to_address, subject, body, sending_until) " +
    "VALUES (?, 'refused', ?, ?, ?, ?, ?)").bind(ORDER, NOW.toISOString(), MAIL.to, MAIL.subject, MAIL.text, until).run();
  assert.deepEqual(await retryOrderMail(w.db, w.env, NOW), { attempted: 0, sent: 0 });
  assert.deepEqual(await retryOrderMail(w.db, w.env, new Date(until)), { attempted: 1, sent: 1 });
  assert.equal(w.sent.length, 1);
});

test("unknown kinds and malformed messages cannot become persisted order messages", async () => {
  const w = await world();
  await assert.rejects(queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "arbitrary", mail: MAIL }, NOW));
  await assert.rejects(queueOrderMail(w.db, w.env, { orderId: "invalid", kind: "receipt", mail: MAIL }, NOW));
  await assert.rejects(queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "receipt", mail: { ...MAIL, to: null } }, NOW));
  assert.equal((await w.db.prepare("SELECT * FROM employer_order_mail").all()).results.length, 0);
});

test("seven-year retention deletes confirmed contact records and related jobs but preserves current records and pilot history", async () => {
  const w = await world();
  // These integration tables are owned by the separate financial-safety patch. Replace only this
  // test's empty in-memory tables with their reference columns, so its unrelated required financial
  // fields do not become duplicated fixtures here. The integrated order tests exercise the full schema.
  await w.db.exec("DROP TABLE IF EXISTS employer_capacity_reservations; DROP TABLE IF EXISTS employer_decisions; " +
    "DROP TABLE IF EXISTS employer_credit_jobs; CREATE TABLE employer_capacity_reservations (order_id TEXT); " +
    "CREATE TABLE employer_decisions (order_id TEXT); CREATE TABLE employer_credit_jobs (credit_id TEXT, order_id TEXT);");
  const order = async (id, status, verified, paid = null) => w.db.prepare(
    "INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, company, name, email, " +
    "email_domain, terms_version, terms_at, price, verified_at, paid_at) VALUES (?, '2020-01-01', '2020-01-01', ?, " +
    "'one', '2026-10-20', 'acme', 'Acme', 'Acme', 'Hiring', 'hiring@employer.example', 'employer.example', '2026-10-19', " +
    "'2026-10-19', 2900, ?, ?)").bind(id, status, verified, paid).run();
  const boundary = "o-0000000000000002", newer = "o-0000000000000003", unverified = "o-0000000000000004";
  await order(ORDER, "approved", "2026-10-18T12:00:00.000Z", "2026-10-18T12:00:00.000Z");
  await order(boundary, "verified", "2026-10-19T12:00:00.000Z");
  await order(newer, "paid", "2026-10-18T12:00:00.000Z", "2026-10-20T12:00:00.000Z");
  await order(unverified, "unverified", null);
  await w.db.prepare("INSERT INTO employer_order_roles (order_id, listing_id, employer_key, company, title, apply_url) " +
    "VALUES (?, 'role', 'acme', 'Acme', 'Intern', 'https://employer.example/apply')").bind(ORDER).run();
  await w.db.prepare("INSERT INTO employer_credits (id, order_id, placement_id, created, updated, amount, unused_days, token_hash, status) " +
    "VALUES ('credit-old', ?, 'placement-kept', '2026-10-18', '2026-10-18', 500, 5, 'hash', 'refund')").bind(ORDER).run();
  for (const name of ["employer_capacity_reservations", "employer_decisions"]) {
    await w.db.prepare(`INSERT INTO ${name} (order_id) VALUES (?)`).bind(ORDER).run();
  }
  await w.db.prepare("INSERT INTO employer_credit_jobs (credit_id, order_id) VALUES ('credit-old', ?)").bind(ORDER).run();
  await w.db.prepare("INSERT INTO pilot_codes (code, created, order_id, used_at) VALUES ('PILOT1', '2026-10-18', ?, '2026-10-18')").bind(ORDER).run();
  await queueOrderMail(w.db, w.env, { orderId: ORDER, kind: "receipt", mail: MAIL }, NOW);
  await dropRetainedOrders(w.db, new Date("2033-10-19T12:00:00.000Z"));
  const remaining = (await w.db.prepare("SELECT id FROM employer_orders ORDER BY id").all()).results.map((r) => r.id);
  assert.deepEqual(remaining, [boundary, newer, unverified]);
  for (const name of ["employer_order_roles", "employer_credits", "employer_capacity_reservations", "employer_decisions", "employer_credit_jobs", "employer_order_mail"]) {
    assert.equal((await w.db.prepare(`SELECT * FROM ${name}`).all()).results.length, 0, name);
  }
  const pilot = await w.db.prepare("SELECT * FROM pilot_codes").first();
  assert.equal(pilot.code, "PILOT1"); assert.equal(pilot.order_id, null); assert.equal(pilot.used_at, null);
});
