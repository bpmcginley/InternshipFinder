import { HttpError } from "../http.js";
import { addDays } from "../placements.js";
import { stripe } from "../billing.js";
import { trySend } from "../mail.js";
import { CREDIT_DEFAULT_DAYS, PRICES, bad, conflict } from "./shared.js";
import { creditMail } from "./templates.js";
import { siteOnly, tokenOk } from "./access.js";

const CREDIT_ID = /^c-[0-9a-f]{16}$/;

// ---------------------------------------------------------------- 5. a role closes early

// GET /employer/credit?credit=&t=: the offer, for the buy page to show.
export async function creditInfo(db, params, now) {
  const credit = await loadCredit(db, params.get("credit"), params.get("t"));
  const job = await db.prepare("SELECT state FROM employer_credit_jobs WHERE credit_id = ?").bind(credit.id).first();
  const role = await db.prepare("SELECT title, company FROM employer_order_roles WHERE placement_id = ?").bind(credit.placement_id).first();
  return {
    credit: credit.id, status: credit.status, amount: credit.amount, unused_days: credit.unused_days,
    role: role ? { title: role.title, company: role.company } : null,
    choose_by: addDays((credit.offer_sent_at || now.toISOString()).slice(0, 10), CREDIT_DEFAULT_DAYS),
    ...(job && job.state !== "done" ? { processing: job.state } : {}),
    ...(credit.status === "credit" ? { code: credit.promotion_code } : {}),
  };
}

async function loadCredit(db, id, token) {
  const credit = typeof id === "string" && CREDIT_ID.test(id)
    ? await db.prepare("SELECT * FROM employer_credits WHERE id = ?").bind(id).first() : null;
  if (!credit || !(await tokenOk(token, credit.token_hash))) {
    throw new HttpError(403, "link", "This link isn't right. Please use the link in our email, or reply to it.");
  }
  return credit;
}

// POST /employer/credit { credit, token, choice: "refund" | "credit" }.
export async function chooseCredit(db, env, request, body, now, fetchImpl) {
  siteOnly(request);
  const credit = await loadCredit(db, body.credit, body.token);
  if (body.choice !== "refund" && body.choice !== "credit") throw bad("choice", "choice must be \"refund\" or \"credit\"");
  if (credit.status !== "offered") {
    throw conflict("decided", credit.status === "credit" ? "You already chose a promotion code." : "This has already been refunded.",
      { status: credit.status, ...(credit.status === "credit" ? { code: credit.promotion_code } : {}) });
  }
  const done = await settleCredit(db, env, credit, body.choice, "employer", now, fetchImpl);
  if (!done) throw conflict("processing", "Your choice is being reconciled. Do not choose again; reply to your order email for help.");
  return body.choice === "refund" ? { done: "refund", amount: credit.amount } : { done: "credit", code: done.code, amount: credit.amount };
}

// A permanent choice claim precedes Stripe. An ambiguous result or a crash cannot change choice or
// blindly repeat a payout after the provider's idempotency window; the owner reconciles it instead.
async function settleCredit(db, env, credit, choice, who, now, fetchImpl) {
  const at = now.toISOString();
  const claim = await db.prepare("INSERT OR IGNORE INTO employer_credit_jobs (credit_id, order_id, choice, state, created, updated) " +
    "SELECT ?, ?, ?, 'running', ?, ? WHERE EXISTS (SELECT 1 FROM employer_credits WHERE id = ? AND status = 'offered')")
    .bind(credit.id, credit.order_id, choice, at, at, credit.id).run();
  if (!claim.meta.changes) return null;
  const order = await db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(credit.order_id).first();
  try {
    if (!order || order.disputed_at || order.status === "refused") {
      throw conflict("reconcile", "This order needs payment reconciliation before any refund or promotion code. Reply to your order email for help.");
    }
    if (choice === "refund") {
      const refund = await stripe(env, "refunds", { payment_intent: order.payment_intent, amount: String(credit.amount),
        "metadata[order]": order.id, "metadata[credit]": credit.id, "metadata[why]": "role_closed" }, fetchImpl, `listing-credit-refund:${credit.id}`);
      if (!refund || typeof refund.id !== "string" || !refund.id) throw new Error("Refund result unknown");
      await db.batch([
        db.prepare("UPDATE employer_credits SET status = 'refund', refund_id = ?, chosen_at = ?, chosen_by = ?, updated = ? WHERE id = ? AND status = 'offered'")
          .bind(refund.id, at, who, at, credit.id),
        db.prepare("UPDATE employer_credit_jobs SET state = 'done', updated = ? WHERE credit_id = ?").bind(at, credit.id),
      ]);
      await trySend(env, creditMail(env, order, credit, who === "default" ? "default" : "refund"), "credit refund");
      return { refund: refund.id };
    }
    // A one-time code worth the amount. Restricted to orders of at least the smallest listing price, so
    // it can't be spent on a student plan, whose Checkout also takes promotion codes.
    const coupon = await stripe(env, "coupons", { amount_off: String(credit.amount), currency: "usd", duration: "once",
      max_redemptions: "1", name: "InternScout listing credit", "metadata[credit]": credit.id }, fetchImpl, `listing-coupon:${credit.id}`);
    if (!coupon || typeof coupon.id !== "string" || !coupon.id) throw new Error("Coupon result unknown");
    const promo = await stripe(env, "promotion_codes", { "promotion[type]": "coupon", "promotion[coupon]": String(coupon.id),
      max_redemptions: "1", "restrictions[minimum_amount]": String(PRICES.one.public_body_cents),
      "restrictions[minimum_amount_currency]": "usd", "metadata[credit]": credit.id }, fetchImpl, `listing-promo:${credit.id}`);
    if (!promo || typeof promo.code !== "string" || !promo.code) throw new Error("Promotion result unknown");
    const code = promo.code;
    await db.batch([
      db.prepare("UPDATE employer_credits SET status = 'credit', promotion_code = ?, chosen_at = ?, chosen_by = ?, updated = ? WHERE id = ? AND status = 'offered'")
        .bind(code, at, who, at, credit.id),
      db.prepare("UPDATE employer_credit_jobs SET state = 'done', updated = ? WHERE credit_id = ?").bind(at, credit.id),
    ]);
    await trySend(env, creditMail(env, order, { ...credit, promotion_code: code }, "credit"), "credit code");
    return { code };
  } catch (e) {
    await db.prepare("UPDATE employer_credit_jobs SET state = 'unknown', updated = ? WHERE credit_id = ?")
      .bind(at, credit.id).run();
    throw e;
  }
}

export { settleCredit };
