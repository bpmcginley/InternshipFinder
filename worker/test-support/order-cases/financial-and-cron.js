import test from "node:test";
import assert from "node:assert/strict";
import { endExpiredPlacements } from "../../src/placements.js";
import { FIELD_CAP, TERMS_VERSION, ordersCron } from "../../src/orders.js";
import { NOW, makeEnv } from "../../test/helpers.js";
import { ID, ON, ROLES, SITE, TODAY, fakeEmail, hold, siteReply, stripeFake, world } from "./fixtures.js";

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
