import { HttpError } from "../http.js";
import { CHECKS, addDays, checkPlacement, dayOf, pausePlacement, refusePlacement, switchOn, updatePlacement } from "../placements.js";
import { stripe } from "../billing.js";
import { queueOrderMail } from "../order-mail.js";
import { DAYS, FIELD_CAP, LIMITS, conflict, fieldsOf, money, rolesWord, text } from "./shared.js";
import { readShard, shardOf } from "./roles.js";
import { busiest, heldRoles, reserveCapacity } from "./capacity.js";
import { approvedMail, refusedMail, reviewSig } from "./templates.js";
import { loadOrder, orderRoles } from "./records.js";
import { esc, message, page } from "./review-html.js";
import { ensurePlacements } from "./settlement.js";
import { sigOk } from "./access.js";

export const MAX_FORM_BYTES = 4_000;

// ---------------------------------------------------------------- 4. review

// GET /employer/review?order=&sig=: everything Bruce needs for the sponsor checks, on one page.
export async function reviewPage(db, env, params, now, fetchImpl) {
  const id = params.get("order");
  if (!(await sigOk(env, id, params.get("sig")))) return message("Link not valid", "This review link is not valid.", 403);
  const order = await loadOrder(db, id);
  if (!order) return message("No such order", "This order is not in the database.", 404);
  const roles = await orderRoles(db, id);
  const sig = await reviewSig(env, id);
  const today = dayOf(now);

  let index = null;
  try {
    index = await readShard(env, shardOf(order.employer_key), fetchImpl);
  } catch {}
  const placements = {};
  for (const r of roles) {
    if (r.placement_id) placements[r.placement_id] = await db.prepare("SELECT * FROM placements WHERE id = ?").bind(r.placement_id).first();
  }
  const start = order.start_day < today ? today : order.start_day;
  const end = addDays(start, DAYS);
  const held = await heldRoles(db, now, id);
  const fields = [...new Set(roles.flatMap((r) => r.fields.split(",").filter(Boolean)))];

  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const host = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  const rolesHtml = roles.map((r) => {
    const now_ = index ? index.get(r.listing_id) : null;
    const state = !index ? "<span class=\"warn\">The role index could not be read just now.</span>"
      : !now_ ? "<span class=\"warn\">No longer listed as open on InternScout.</span>"
      : "<span class=\"ok\">Listed as open on InternScout today.</span>" +
        (now_.u !== r.apply_url ? ` <span class="warn">Its apply link changed to <code>${esc(now_.u)}</code>.</span>` : "") +
        (now_.unpaid ? " <span class=\"warn\">The posting doesn't say it is paid.</span>" : "");
    const p = r.placement_id && placements[r.placement_id];
    return `<li><strong>${esc(r.title)}</strong>, ${esc(r.company)}${r.location ? ", " + esc(r.location) : ""}<br>` +
      `Apply link: <a href="${esc(r.apply_url)}" rel="noreferrer noopener" target="_blank"><code>${esc(r.apply_url)}</code></a> ` +
      `(host ${esc(host(r.apply_url))})<br>Fields: ${esc(r.fields || "other")}. ${r.unpaid ? "<span class=\"warn\">Unpaid when ordered.</span> " : ""}` +
      `${state}<br>Placement: ${p ? `${esc(p.id)}, ${esc(p.status)}, ${esc(p.start_day)} to ${esc(p.end_day)}` : "not made yet"}</li>`;
  }).join("");
  const fieldsHtml = fields.map((f) =>
    `<li>${esc(f)}: ${busiest(held, f, start, end)} other paid roles on the busiest day (cap ${FIELD_CAP}, this order adds ` +
    `${roles.filter((r) => r.fields.split(",").includes(f)).length})</li>`).join("");

  const decided = order.status !== "paid";
  const forms = decided
    ? `<p class="warn">This order is ${esc(order.status)}; there is nothing to decide.</p>`
    : (order.disputed_at ? "<p class=\"warn\">A payment dispute is open on this order, so it can't be approved. Refuse it, or answer the dispute in Stripe first.</p>" :
      `<form method="post" action="/employer/review"><input type="hidden" name="order" value="${esc(id)}">` +
      `<input type="hidden" name="sig" value="${esc(sig)}"><input type="hidden" name="action" value="approve">` +
      `<p>Approve records all ${CHECKS.length} sponsor checks as done by you, switches every role on from ` +
      `${esc(start)} to ${esc(addDays(end, -1))} (last day) and emails the employer the dates.</p><button>Approve</button></form>`) +
      `<form method="post" action="/employer/review"><input type="hidden" name="order" value="${esc(id)}">` +
      `<input type="hidden" name="sig" value="${esc(sig)}"><input type="hidden" name="action" value="refuse">` +
      `<p><label for="reason">Refuse: the reason the employer will read (required)</label></p>` +
      `<textarea id="reason" name="reason" rows="3" maxlength="${LIMITS.reason}" required></textarea>` +
      `<p>Refuse refunds ${order.payment_intent ? "the full amount through Stripe" : "nothing (no card payment)"}, marks the placements ` +
      `refused${order.pilot_code ? ", frees the pilot code" : ""} and emails the employer the reason.</p><button>Refuse</button></form>`;

  const body = `<h1>Listing order ${esc(id)}</h1>` +
    `<table>${[
      row("Status", esc(order.status) + (order.disputed_at ? " <span class=\"warn\">(payment disputed)</span>" : "")),
      row("Employer (role index)", esc(order.employer)),
      row("Company typed", esc(order.company)),
      row("Contact", esc(order.name)),
      row("Verified work email", `${esc(order.email)} (domain <strong>${esc(order.email_domain)}</strong>; compare with the apply link hosts below)`),
      row("Nonprofit or public body", order.public_body ? "<span class=\"warn\">Yes, claimed. Check it.</span>" : "No"),
      row("Package", `${esc(order.package)}, ${rolesWord(roles.length)}, ${DAYS} days each`),
      row("Paid", `${money(order.paid_amount)} (${esc(order.paid_ref || "")})${order.pilot_code ? " pilot" : ""}`),
      row("Start asked", esc(order.start_day) + (order.start_day < today ? ` <span class="warn">has passed; approving today runs ${esc(start)} to ${esc(addDays(end, -1))}</span>` : "")),
      row("Terms accepted", `${esc(order.terms_version)} at ${esc(order.terms_at)}: "${esc(order.terms_box || "")}"`),
      row("Ordered", esc(order.created)),
    ].join("")}</table>` +
    `<h2>The roles, as InternScout lists them now</h2><ul>${rolesHtml}</ul>` +
    `<h2>Field counts for ${esc(start)} to ${esc(addDays(end, -1))}</h2><ul>${fieldsHtml}</ul>` +
    `<h2>The sponsor checks Approve records</h2><ul>${CHECKS.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ul>` +
    `<h2>Decision</h2>${forms}`;
  return page(`Order ${id}`, body);
}

async function readForm(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_FORM_BYTES) throw new HttpError(400, "bad_request", "Request body is too large");
  const type = request.headers.get("Content-Type") || "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) throw new HttpError(400, "bad_request", "Send the review form");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_FORM_BYTES) throw new HttpError(400, "bad_request", "Request body is too large");
  return new URLSearchParams(raw);
}

// POST /employer/review (form): approve or refuse. Answers a plain page.
export async function reviewDecision(db, env, request, now, fetchImpl) {
  const form = await readForm(request);
  const id = form.get("order");
  if (!(await sigOk(env, id, form.get("sig")))) return message("Link not valid", "This review link is not valid.", 403);
  const order = await loadOrder(db, id);
  if (!order) return message("No such order", "This order is not in the database.", 404);
  if (order.status !== "paid") return message("Already decided", `This order is ${order.status}; nothing was changed.`, 409);
  const action = form.get("action");
  if (!["approve", "refuse"].includes(action)) return message("Not done", "Choose Approve or Refuse.", 400);
  let reason;
  if (action === "refuse") {
    try { reason = text({ reason: form.get("reason") }, "reason", { required: true }); }
    catch (e) { if (e instanceof HttpError) return message("Not done", e.message, e.status); throw e; }
  }
  if (action === "approve" && order.disputed_at) return message("Not approved", "A payment dispute is open on this order, so it was not approved.", 409);
  const claim = await db.prepare("INSERT OR IGNORE INTO employer_decisions (order_id, action, state, created, updated) VALUES (?, ?, 'running', ?, ?)")
    .bind(id, action, now.toISOString(), now.toISOString()).run();
  if (!claim.meta.changes) return message("Decision held", "A decision already started for this order. Check its records and Stripe before retrying or choosing the opposite action.", 409);
  try {
    if (action === "approve") {
      if (order.disputed_at) return message("Not approved", "A payment dispute is open on this order, so it was not approved.", 409);
      const dates = await approve(db, env, order, now);
      await db.prepare("UPDATE employer_decisions SET state = 'done', updated = ? WHERE order_id = ?").bind(now.toISOString(), id).run();
      return message("Approved", `Order ${id} is approved. Its roles run ${dates}. Confirmation email is recorded for delivery.`);
    }
    if (action === "refuse") {
      const refunded = await refuse(db, env, order, reason, now, fetchImpl);
      await db.prepare("UPDATE employer_decisions SET state = 'done', updated = ? WHERE order_id = ?").bind(now.toISOString(), id).run();
      return message("Refused", `Order ${id} is refused. ${refunded ? `${money(refunded)} was refunded. ` : ""}The reason email is recorded for delivery.`);
    }
  } catch (e) {
    // Capacity refusal happens before approval changes anything; it is safe to choose refusal later.
    if (action === "approve" && e instanceof HttpError && e.code === "full") {
      await db.prepare("DELETE FROM employer_decisions WHERE order_id = ?").bind(id).run();
    } else {
      await db.prepare("UPDATE employer_decisions SET state = 'unknown', updated = ? WHERE order_id = ?").bind(now.toISOString(), id).run();
    }
    if (e instanceof HttpError) return message("Not done", e.message, e.status);
    throw e;
  }
  return message("Not done", "Choose Approve or Refuse.", 400);
}

// The same steps Bruce runs by hand, by "bruce", each one skipped if it is already done, so a second
// click after a failure finishes the job. Returns the dates as text for the page.
async function approve(db, env, order, now) {
  const today = dayOf(now);
  const roles = await orderRoles(db, order.id);
  const start = order.start_day < today ? today : order.start_day;
  await reserveCapacity(db, order, roles.map(r => ({ id: r.listing_id, fields: fieldsOf(r.fields.split(",")) })), start, now);
  await ensurePlacements(db, order, now);
  const placed = await orderRoles(db, order.id);
  const done = [];
  for (const role of placed) {
    let p = await db.prepare("SELECT * FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (["draft", "checked"].includes(p.status) && p.start_day < today) {
      // No paid day is lost to the review: the 30 days start on the day of approval.
      p = await updatePlacement(db, { id: p.id, by: "bruce", start: today, end: addDays(today, DAYS) }, now);
    }
    if (p.status === "draft") {
      p = await checkPlacement(db, { id: p.id, by: "bruce", checks: CHECKS, unpaid_ok: !!(role.unpaid && order.public_body) }, now);
    }
    if (p.status === "checked") p = await switchOn(db, { id: p.id, by: "bruce", paid_ref: order.paid_ref }, now);
    if ((await loadOrder(db, order.id)).disputed_at) {
      if (p.status === "on") await pausePlacement(db, { id: p.id, by: "stripe", reason: "payment dispute during approval" }, now);
      throw conflict("disputed", "A payment dispute arrived during approval. The listing is paused; reconcile the order before continuing.");
    }
    if (p.status !== "on") throw conflict("conflict", `Placement ${p.id} is ${p.status}, so it was not switched on.`);
    done.push({ role, p });
  }
  const at = now.toISOString();
  const approvalNotice = { orderId: order.id, kind: "approved", mail: approvedMail(env, order, done) };
  await queueOrderMail(db, env, { ...approvalNotice, defer: true }, now);
  const approved = await db.prepare("UPDATE employer_orders SET status = 'approved', decided_at = ?, updated = ? WHERE id = ? AND status = 'paid' AND disputed_at IS NULL")
    .bind(at, at, order.id).run();
  if (!approved.meta.changes) throw conflict("disputed", "The order changed during approval. Reconcile it before continuing.");
  await queueOrderMail(db, env, approvalNotice, now);
  const spans = [...new Set(done.map(({ p }) => `${p.start_day} to ${addDays(p.end_day, -1)}`))];
  return spans.join(", ");
}

// Refund first (one idempotency key per order, so a second click never refunds twice), then the records.
async function refuse(db, env, order, reason, now, fetchImpl) {
  let refund = null;
  if (order.payment_intent && order.paid_amount > 0) {
    refund = await stripe(env, "refunds", { payment_intent: order.payment_intent, "metadata[order]": order.id, "metadata[why]": "refused" },
      fetchImpl, `listing-refund:${order.id}`);
    if (!refund || typeof refund.id !== "string" || !refund.id) throw new Error("Refund result unknown");
  }
  for (const role of await orderRoles(db, order.id)) {
    if (!role.placement_id) continue;
    const p = await db.prepare("SELECT status FROM placements WHERE id = ?").bind(role.placement_id).first();
    if (p && ["draft", "checked"].includes(p.status)) await refusePlacement(db, { id: role.placement_id, by: "bruce", reason }, now);
  }
  const at = now.toISOString();
  const amount = refund ? (Number.isSafeInteger(refund.amount) ? refund.amount : order.paid_amount) : 0;
  const refusalNotice = { orderId: order.id, kind: "refused", mail: refusedMail(env, order, reason, amount) };
  await queueOrderMail(db, env, { ...refusalNotice, defer: true }, now);
  await db.batch([
    db.prepare("UPDATE employer_orders SET status = 'refused', decided_at = ?, decided_reason = ?, refund_id = ?, " +
      "refunded_amount = ?, updated = ? WHERE id = ? AND status = 'paid'")
      .bind(at, reason, refund ? String(refund.id || "") : null, amount, at, order.id),
    // A refused pilot does not use up one of the five.
    db.prepare("UPDATE pilot_codes SET order_id = NULL, used_at = NULL WHERE order_id = ?").bind(order.id),
  ]);
  await queueOrderMail(db, env, refusalNotice, now);
  return amount;
}
