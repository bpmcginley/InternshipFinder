import test from "node:test";
import assert from "node:assert/strict";
import { FIELD_CAP, TERMS_VERSION, ordersCron } from "../../src/orders.js";
import { parseArgs, toRequest, run } from "../../scripts/placement.mjs";
import { handle } from "../../src/index.js";
import { NOW, makeEnv } from "../../test/helpers.js";
import { ADMIN, GOOD, ID, world } from "./fixtures.js";

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
