import test from "node:test";
import assert from "node:assert/strict";
import { CHECKS } from "../../src/placements.js";
import { reviewSig } from "../../src/orders.js";
import { ID, TODAY, world } from "./fixtures.js";

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
