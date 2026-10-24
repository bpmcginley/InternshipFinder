import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { checkout, applyEvent, blocksDeletion } from "../src/billing.js";
import { CONFIG } from "../src/config.js";

const now = new Date("2026-10-23T12:00:00Z");
const paidEnv = { STRIPE_SECRET_KEY: "synthetic", PAYMENTS_ENABLED: "1", STRIPE_PRICE_ID: "price_test", STRIPE_PRICE_ID_PRO: "price_pro_test" };

it("actual D1 reserves one cross-tier student checkout under concurrent requests", async () => {
  await env.DB.batch(env.TEST_SCHEMA_SQL.map(s => env.DB.prepare(s)));
  const keys = new Set();
  const provider = async (url, init) => {
    keys.add(init.headers["Idempotency-Key"]);
    return Response.json({ id: "cs_d1_student", status: "open", url: "https://checkout.stripe.test/d1" });
  };
  const attempts = await Promise.allSettled(["supporter", "pro"].map(plan =>
    checkout(env.DB, paidEnv, CONFIG, "student-d1-checkout", plan, now, provider)));
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(keys.size).toBe(1);
  const rows = await env.DB.prepare("SELECT * FROM student_checkouts WHERE user_hash = ?").bind("student-d1-checkout").all();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0].state).toBe("open");
});

it("actual D1 preserves cancellation-pending on provider failure and resolves a webhook retry", async () => {
  await env.DB.batch(env.TEST_SCHEMA_SQL.map(s => env.DB.prepare(s)));
  const user = "student-d1-cancel";
  let failing = true;
  const provider = async (url, init) => {
    if (init.method === "DELETE") return failing ? Response.json({}, { status: 503 })
      : Response.json({ id: "sub_d1_cancel", status: "canceled" });
    return Response.json({ id: "sub_d1_cancel", customer: "cus_d1_cancel", status: "active" });
  };
  await applyEvent(env.DB, paidEnv, CONFIG, { id: "evt_d1_paid", type: "checkout.session.completed", data: { object: {
    id: "cs_d1_paid", client_reference_id: user, subscription: "sub_d1_cancel", customer: "cus_d1_cancel", payment_status: "paid",
  } } }, now, provider);
  const refund = { id: "evt_d1_refund", type: "charge.refunded", data: { object: {
    id: "ch_d1_cancel", customer: "cus_d1_cancel", amount: 400, amount_refunded: 400, refunded: true,
    invoice: { id: "in_d1_cancel", customer: "cus_d1_cancel", parent: { subscription_details: { subscription: "sub_d1_cancel" } } },
  } } };
  await expect(applyEvent(env.DB, paidEnv, CONFIG, refund, now, provider)).rejects.toMatchObject({ status: 502 });
  expect(await env.DB.prepare("SELECT status FROM plans WHERE user_hash = ?").bind(user).first("status")).toBe("cancel_pending");
  expect(await blocksDeletion(env.DB, user, paidEnv, provider)).toBe(true);
  expect(await env.DB.prepare("SELECT id FROM stripe_events WHERE id = ?").bind(refund.id).first()).toBeNull();
  failing = false;
  await applyEvent(env.DB, paidEnv, CONFIG, refund, now, provider);
  expect(await env.DB.prepare("SELECT status FROM plans WHERE user_hash = ?").bind(user).first("status")).toBe("canceled");
  expect(await blocksDeletion(env.DB, user, paidEnv, provider)).toBe(false);
  expect(await env.DB.prepare("SELECT state FROM student_billing_recovery WHERE subscription = ?").bind("sub_d1_cancel").first("state")).toBe("resolved");
});
