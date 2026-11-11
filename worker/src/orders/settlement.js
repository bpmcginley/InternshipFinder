import { HttpError } from "../http.js";
import { addDays, createPlacement, pausePlacement } from "../placements.js";
import { stripe } from "../billing.js";
import { trySend } from "../mail.js";
import { queueOrderMail } from "../order-mail.js";
import { DAYS, fieldsOf, money } from "./shared.js";
import { reserveCapacity } from "./capacity.js";
import { receivedMail, reviewMail } from "./templates.js";
import { loadOrder, orderRoles } from "./records.js";

// ---------------------------------------------------------------- 3. paid

// verified -> paid, once. Then the draft placements and both emails. An email that fails is logged and
// left for the daily cron (review_sent_at stays empty); it never undoes the payment record.
async function markPaid(db, env, order, pay, now) {
  const at = now.toISOString();
  const r = await db.prepare(
    "UPDATE employer_orders SET status = 'paid', paid_ref = ?, paid_amount = ?, payment_intent = ?, paid_session = ?, " +
    "paid_at = ?, updated = ? WHERE id = ? AND status = 'verified'",
  ).bind(pay.ref, pay.amount, pay.pi, pay.session, at, at, order.id).run();
  if (!r.meta.changes) return false;
  const fresh = await loadOrder(db, order.id);
  // A delayed bank payment can arrive after its temporary hold. Keep the payment/review record even
  // if capacity has since filled; approval reserves its dates again and cannot overbook the field.
  try {
    const cap = (await orderRoles(db, order.id)).map(r => ({ id: r.listing_id, fields: fieldsOf(r.fields.split(",")) }));
    await reserveCapacity(db, fresh, cap, fresh.start_day, now);
  } catch (e) {
    if (!(e instanceof HttpError) || e.code !== "full") throw e;
  }
  await settle(db, env, fresh, now);
  return true;
}

// What a paid order needs and may not have yet: its draft placements and Bruce's review email. Safe to
// run again (a Stripe retry, the daily cron).
async function settle(db, env, order, now) {
  if (order.status !== "paid") return;
  await ensurePlacements(db, order, now);
  await queueOrderMail(db, env, { orderId: order.id, kind: "receipt", mail: receivedMail(env, order, await orderRoles(db, order.id)) }, now);
  if (!order.review_sent_at) await sendReview(db, env, order, now);
}

// One draft placement per role (placements.js createPlacement, created_by "checkout"), made once.
async function ensurePlacements(db, order, now) {
  for (const role of await orderRoles(db, order.id)) {
    if (role.placement_id) continue;
    await createPlacement(db, {
      employer: role.company, listing_id: role.listing_id, apply_url: role.apply_url,
      start: order.start_day, end: addDays(order.start_day, DAYS), note: `order ${order.id}`, by: "checkout",
    }, now, order.id); // 2026-10-23: creation and attachment are atomic; was: a second, racy UPDATE (W3).
  }
}

async function sendReview(db, env, order, now, reminder = false) {
  const roles = await orderRoles(db, order.id);
  const sent = await trySend(env, await reviewMail(env, order, roles, reminder), reminder ? "review reminder" : "review");
  if (sent) {
    const col = reminder ? "reminder_sent_at" : "review_sent_at";
    await db.prepare(`UPDATE employer_orders SET ${col} = ? WHERE id = ?`).bind(now.toISOString(), order.id).run();
  }
  return sent;
}

const piOf = (o) => (typeof o.payment_intent === "string" ? o.payment_intent : (o.payment_intent && o.payment_intent.id) || null);

// Called from billing.js applyFresh for every verified Stripe event, before the student plans. Returns
// null when the event is not about a listing, so the student-plan handling runs exactly as before.
export async function listingEvent(db, env, event, now, fetchImpl) {
  const o = (event.data && event.data.object) || {};
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (!o.metadata || o.metadata.kind !== "listing") return null;
    return sessionPaid(db, env, o, now, fetchImpl);
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.refunded") {
    const pi = piOf(o);
    const order = pi ? await db.prepare("SELECT * FROM employer_orders WHERE payment_intent = ?").bind(pi).first() : null;
    if (!order) return null;
    // A refund of a listing payment is one this file made (or Bruce made by hand); the order says so.
    if (event.type === "charge.refunded") return { ok: true, ignored: true };
    return disputed(db, env, order, now);
  }
  return null;
}

async function sessionPaid(db, env, o, now, fetchImpl) {
  // "unpaid" is a bank payment still on its way: checkout.session.async_payment_succeeded follows.
  if (o.payment_status !== "paid" && o.payment_status !== "no_payment_required") return { ok: true, waiting: true };
  const pi = piOf(o);
  const id = (o.metadata && o.metadata.order) || o.client_reference_id;
  let order = await loadOrder(db, id);
  if (!order) {
    console.error("listing payment without an order");
    await trySend(env, { to: env.REVIEW_TO, subject: "Listing payment without an order",
      text: `Stripe reported a paid listing Checkout session (${o.id || "no id"}) for order ${String(id || "none").slice(0, 40)}, ` +
        "which is not in the database. Nothing was changed. Look it up in the Stripe dashboard and refund it there if needed.\n" }, "orphan");
    return { ok: true, ignored: true };
  }
  if (order.status === "verified") {
    const ref = "stripe:" + (pi || "nocharge:" + order.id);
    const amount = Number.isSafeInteger(o.amount_total) ? o.amount_total : order.price;
    if (await markPaid(db, env, order, { ref, amount, pi, session: o.id || null }, now)) return { ok: true };
    order = await loadOrder(db, order.id);
  }
  // The same payment again (a retry, or completed and then async_payment_succeeded): finish what may
  // not have been done.
  if ((o.id && order.paid_session === o.id) || (pi && order.payment_intent === pi)) {
    await settle(db, env, order, now);
    return { ok: true, repeat: true };
  }
  // A second payment for an order that is already paid (two Checkout tabs, both paid): refunded in full.
  if (pi) {
    const refund = await stripe(env, "refunds", { payment_intent: pi, "metadata[order]": order.id, "metadata[why]": "duplicate" },
      fetchImpl, `listing-refund-duplicate:${pi}`);
    const amount = Number.isSafeInteger(refund && refund.amount) ? refund.amount : o.amount_total;
    await trySend(env, { to: env.REVIEW_TO, subject: `Order ${order.id} was paid twice; the second payment was refunded`,
      text: `Order ${order.id} (${order.employer}) was paid a second time (${pi}). That payment, ${money(amount)}, was refunded ` +
        "automatically. Nothing else changed.\n" }, "duplicate");
    await trySend(env, { to: order.email, replyTo: env.REVIEW_TO, subject: "We refunded a second payment for your InternScout order",
      text: `Hello ${order.name},\n\nOrder ${order.id} was paid twice, probably from two open payment pages. We refunded the ` +
        `second payment, ${money(amount)}, to the card it came from. Stripe says a refund usually shows within 5 to 10 ` +
        "business days. Your order itself is unchanged.\n\nInternScout\n" }, "duplicate");
    return { ok: true, refunded: "duplicate" };
  }
  return { ok: true, ignored: true };
}

// A dispute pauses the order's live placements and tells Bruce. Everything else about it stays manual.
async function disputed(db, env, order, now) {
  await db.prepare("UPDATE employer_orders SET disputed_at = ?, updated = ? WHERE id = ?")
    .bind(now.toISOString(), now.toISOString(), order.id).run();
  const paused = [];
  for (const role of await orderRoles(db, order.id)) {
    if (!role.placement_id) continue;
    const p = await db.prepare("SELECT id, status FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (!p || p.status !== "on") continue;
    try {
      await pausePlacement(db, { id: p.id, by: "stripe", reason: "payment dispute" }, now);
      paused.push(`${role.title} (${p.id})`);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  await trySend(env, { to: env.REVIEW_TO, subject: `Payment dispute on listing order ${order.id}`,
    text: `A payment dispute was opened on order ${order.id} (${order.employer}, ${money(order.paid_amount)}).\n\n` +
      (paused.length ? `These listings were paused:\n${paused.map((p) => "- " + p).join("\n")}\n\n` : "No listing was live, so nothing was paused.\n\n") +
      "Answer the dispute in the Stripe dashboard. Switching a listing back on, or ending it, is done with scripts/placement.mjs.\n" }, "dispute");
  return { ok: true, paused: paused.length };
}

export { ensurePlacements, markPaid, sendReview, settle };
