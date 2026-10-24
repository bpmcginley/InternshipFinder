// 2026-10-23: the same race runs against SQLite and actual local D1, never live Stripe/mail (W3).
import { listingEvent, reviewDecision, reviewSig, TERMS_VERSION } from "../src/orders.js";

export async function settlementRace(db, orderId) {
  const now = new Date("2026-09-14T10:05:30Z"), at = now.toISOString();
  await db.prepare("INSERT INTO employer_orders (id, created, updated, status, package, start_day, employer_key, employer, company, name, email, email_domain, terms_version, terms_at, price, paid_at, paid_ref, paid_amount, payment_intent, paid_session) VALUES (?, ?, ?, 'paid', 'one', '2026-09-20', 'acme', 'Acme', 'Acme', 'Synthetic', 'synthetic@acme.example', 'acme.example', ?, ?, 2900, ?, 'stripe:pi_synthetic', 2900, 'pi_synthetic', 'cs_synthetic')")
    .bind(orderId, at, at, TERMS_VERSION, at, at).run();
  await db.prepare("INSERT INTO employer_order_roles (order_id, listing_id, employer_key, company, title, apply_url, fields) VALUES (?, 'a000000000000001', 'acme', 'Acme', 'Synthetic role', 'https://acme.example/jobs/1', 'engineering')").bind(orderId).run();
  const local = { EMAIL: { send: async () => ({ messageId: "synthetic" }) }, ORDER_FROM: "InternScout <listings@internscout.example>", REVIEW_TO: "synthetic@internscout.example", ADMIN_TOKEN: "synthetic-test-only" };
  const event = type => ({ type, data: { object: { id: "cs_synthetic", metadata: { kind: "listing", order: orderId }, payment_status: "paid", payment_intent: "pi_synthetic" } } });

  // A transaction failure must leave neither an unattached draft nor a misleading create log.
  await db.prepare(`CREATE TRIGGER synthetic_settlement_failure BEFORE UPDATE OF placement_id ON employer_order_roles WHEN NEW.order_id = '${orderId}' BEGIN SELECT RAISE(ABORT, 'synthetic_attach_failure'); END`).run();
  let rollbackRejected = false;
  try { await listingEvent(db, local, event("checkout.session.completed"), now); } catch (e) { rollbackRejected = /synthetic_attach_failure/.test(String(e)); }
  const afterRollback = await db.prepare("SELECT COUNT(*) AS n FROM placements WHERE listing_id = 'a000000000000001'").first("n");
  const rollbackLogs = await db.prepare("SELECT COUNT(*) AS n FROM placement_log").first("n");
  await db.prepare("DROP TRIGGER synthetic_settlement_failure").run();

  // Both events must read a NULL role attachment before either creates a draft.
  let arrived = 0, release;
  const both = new Promise(r => { release = r; });
  const concurrent = { prepare: sql => db.prepare(sql), batch: async statements => {
    if (++arrived <= 2) { if (arrived === 2) release(); await both; }
    return db.batch(statements);
  } };
  await Promise.all([
    listingEvent(concurrent, local, event("checkout.session.completed"), now),
    listingEvent(concurrent, local, event("checkout.session.async_payment_succeeded"), now),
  ]);
  await listingEvent(db, local, event("checkout.session.completed"), now); // retries stay idempotent
  const placements = (await db.prepare("SELECT * FROM placements WHERE listing_id = 'a000000000000001'").all()).results;
  const orphaned = await db.prepare("SELECT COUNT(*) AS n FROM placements WHERE id NOT IN (SELECT placement_id FROM employer_order_roles WHERE placement_id IS NOT NULL)").first("n");
  const logs = await db.prepare("SELECT COUNT(*) AS n FROM placement_log WHERE action = 'create'").first("n");
  const form = new URLSearchParams({ order: orderId, sig: await reviewSig(local, orderId), action: "approve" });
  const response = await reviewDecision(db, local, new Request("https://api.synthetic.test/employer/review", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form }), now);
  return { rollbackRejected, afterRollback, rollbackLogs, placements: placements.length, orphaned, logs, approval: response.status,
    approved: await db.prepare("SELECT status FROM employer_orders WHERE id = ?").bind(orderId).first("status") };
}
