// Paid listings (src/placements.js): admin auth, validation, the state machine, the public read, the
// log and the daily cron. B2-technical-plan.md section 3.5.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { CHECKS, END_REASONS, PUBLIC_KEYS, endExpiredPlacements } from "../src/placements.js";
import { NOW, setup } from "./helpers.js";

const ADMIN = "admin-test-token";
const LISTING = "3f9c0a1b2c3d4e5f";
const URL_ = "https://boards.example.com/acme/jobs/123";
const draft = (over = {}) => ({ employer: "Acme Robotics", listing_id: LISTING, apply_url: URL_,
  start: "2026-09-14", end: "2026-10-14", by: "bruce", ...over });

async function admin(over = {}) {
  const w = await setup({ env: { ADMIN_TOKEN: ADMIN, ...over } });
  const call = (method, path, body, headers = {}) => w.api(method, path, { token: ADMIN, body, headers });
  const make = async (over2 = {}) => {
    const res = await call("POST", "/admin/placements", draft(over2));
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).placement;
  };
  const live = async (over2 = {}) => {
    const p = await make(over2);
    assert.equal((await call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: CHECKS })).status, 200);
    const res = await call("POST", "/admin/placements/on", { id: p.id, by: "bruce", paid_ref: "INV-0042" });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).placement;
  };
  const rows = () => w.db.dump().placements;
  const log = () => w.db.dump().placement_log;
  return { ...w, call, make, live, rows, log };
}

const addLead = (w, company = "Acme Robotics") => w.db.prepare(
  "INSERT INTO employer_leads (created, name, email, company, wants) VALUES (?, ?, ?, ?, ?)",
).bind("2026-09-10T00:00:00.000Z", "Rita Recruiter", "rita@acme-robotics.example", company, "featured").run();

const ADMIN_ROUTES = [
  ["GET", "/admin/placements"], ["GET", "/admin/leads"], ["POST", "/admin/placements"],
  ["POST", "/admin/placements/update"], ["POST", "/admin/placements/check"], ["POST", "/admin/placements/on"],
  ["POST", "/admin/placements/pause"], ["POST", "/admin/placements/end"], ["POST", "/admin/placements/refuse"],
];

test("admin routes are hidden (404) while ADMIN_TOKEN is unset, even with a token", async () => {
  const w = await setup();   // makeEnv sets no ADMIN_TOKEN
  for (const [m, p] of ADMIN_ROUTES) {
    assert.equal((await w.api(m, p, { token: ADMIN, body: m === "POST" ? draft() : undefined })).status, 404, `${m} ${p}`);
  }
  const empty = await setup({ env: { ADMIN_TOKEN: "" } });
  assert.equal((await empty.api("GET", "/admin/placements", { headers: { Authorization: "Bearer " } })).status, 404);
});

test("admin routes: 401 with no token, a wrong one, the CI token or a student token", async () => {
  const w = await admin();
  for (const [m, p] of ADMIN_ROUTES) {
    const body = m === "POST" ? draft() : undefined;
    assert.equal((await w.api(m, p, { body })).status, 401, `${m} ${p} no token`);
    assert.equal((await w.api(m, p, { token: "wrong", body })).status, 401, `${m} ${p} wrong token`);
  }
  assert.equal((await w.api("GET", "/admin/placements", { token: "ci-test-token" })).status, 401, "DEMAND_TOKEN is not the admin token");
  assert.equal((await w.api("GET", "/admin/placements", { token: await w.token() })).status, 401);
  assert.equal(w.rows().length, 0, "nothing was created");
});

test("admin routes: 403 with any Origin header, even with the right token", async () => {
  const w = await admin();
  for (const origin of ["https://internscout.org", "https://evil.example", "null", "chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi"]) {
    for (const [m, p] of ADMIN_ROUTES) {
      const res = await w.call(m, p, m === "POST" ? draft() : undefined, { Origin: origin });
      assert.equal(res.status, 403, `${m} ${p} from ${origin}`);
      assert.equal((await res.json()).error, "forbidden");
    }
  }
  assert.equal(w.rows().length, 0);
});

test("admin routes: 200 with the right token and no Origin", async () => {
  const w = await admin();
  assert.equal((await w.call("GET", "/admin/placements")).status, 200);
  assert.equal((await w.call("GET", "/admin/leads")).status, 200);
  const p = await w.make();
  assert.match(p.id, /^p-2026-09-acme-robotics-1$/);
  assert.equal(p.status, "draft");
  const second = await w.make();
  assert.equal(second.id, "p-2026-09-acme-robotics-2", "ids count up per month and employer");
});

test("create refuses bad fields", async () => {
  const w = await admin();
  const status = async (over) => {
    const res = await w.call("POST", "/admin/placements", draft(over));
    return [res.status, (await res.json()).field];
  };
  assert.deepEqual(await status({ listing_id: "3F9C0A1B2C3D4E5F" }), [400, "listing_id"], "uppercase");
  assert.deepEqual(await status({ listing_id: "3f9c0a1b2c3d4e5" }), [400, "listing_id"], "15 chars");
  assert.deepEqual(await status({ listing_id: "3f9c0a1b2c3d4e5g" }), [400, "listing_id"], "not hex");
  assert.deepEqual(await status({ apply_url: "http://boards.example.com/x" }), [400, "apply_url"]);
  assert.deepEqual(await status({ apply_url: "javascript:alert(1)" }), [400, "apply_url"]);
  assert.deepEqual(await status({ apply_url: "boards.example.com/x" }), [400, "apply_url"]);
  assert.deepEqual(await status({ end: "2026-09-14" }), [400, "end"], "end == start");
  assert.deepEqual(await status({ end: "2026-09-01" }), [400, "end"], "end before start");
  assert.deepEqual(await status({ end: "2026-11-16" }), [400, "end"], "63 days");
  assert.equal((await status({ end: "2026-11-15" }))[0], 200, "62 days is allowed");
  assert.deepEqual(await status({ start: "2026-02-30" }), [400, "start"], "not a real day");
  assert.deepEqual(await status({ start: "14/09/2026" }), [400, "start"]);
  assert.deepEqual(await status({ by: "bruce@example.com" }), [400, "by"], "by is never an email");
  assert.deepEqual(await status({ by: undefined }), [400, "by"]);
  assert.deepEqual(await status({ employer: undefined }), [400, "employer"], "no employer and no lead");
  assert.deepEqual(await status({ lead_id: 999 }), [404, "lead_id"], "unknown lead");
  assert.deepEqual(await status({ lead_id: "1" }), [400, "lead_id"]);
  assert.deepEqual(await status({ note: "x".repeat(501) }), [400, "note"]);
  assert.equal(w.rows().length, 1, "only the 62-day one was stored");
  assert.equal((await w.call("POST", "/admin/placements", [1, 2])).status, 400);
});

test("create from a lead copies the company and never the recruiter's name or email", async () => {
  const w = await admin();
  await addLead(w);
  const res = await w.call("POST", "/admin/placements", draft({ employer: undefined, lead_id: 1 }));
  assert.equal(res.status, 200);
  const { placement } = await res.json();
  assert.equal(placement.employer, "Acme Robotics");
  assert.equal(placement.lead_id, 1);
  const everything = JSON.stringify(w.rows()) + JSON.stringify(w.log()) + JSON.stringify(placement);
  assert.ok(!everything.includes("rita@acme-robotics.example"), "no lead email in any placement record");
  assert.ok(!everything.includes("Rita Recruiter"), "no lead name in any placement record");
  // An employer given by hand wins over the lead's company.
  const named = await (await w.call("POST", "/admin/placements", draft({ employer: "Acme", lead_id: 1 }))).json();
  assert.equal(named.placement.employer, "Acme");
});

test("GET /admin/leads lists id, date, company and wants only", async () => {
  const w = await admin();
  await addLead(w);
  const { leads } = await (await w.call("GET", "/admin/leads")).json();
  assert.deepEqual(leads, [{ id: 1, created: "2026-09-10T00:00:00.000Z", company: "Acme Robotics", wants: "featured" }]);
});

test("state machine: on needs checked and a paid_ref; a missing check stays draft", async () => {
  const w = await admin();
  const p = await w.make();
  const on = (body) => w.call("POST", "/admin/placements/on", { id: p.id, by: "bruce", ...body });
  assert.equal((await on({ paid_ref: "pilot" })).status, 409, "on from draft");

  const res = await w.call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: CHECKS.slice(1) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).placement.status, "draft", "one check missing");
  assert.equal((await on({ paid_ref: "pilot" })).status, 409);

  assert.equal((await w.call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: [...CHECKS, "made_up"] })).status, 400);
  const checked = await (await w.call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: [...CHECKS].reverse(), unpaid_ok: true })).json();
  assert.equal(checked.placement.status, "checked");
  assert.equal(checked.placement.checks, CHECKS.join(","), "stored in CHECKS order");
  assert.equal(checked.placement.unpaid_ok, 1);
  assert.equal(checked.placement.checked_day, "2026-09-14");

  assert.equal((await on({})).status, 400, "no paid_ref");
  assert.equal((await on({ paid_ref: "   " })).status, 400, "blank paid_ref");
  const live = await on({ paid_ref: "pilot" });
  assert.equal(live.status, 200);
  assert.equal((await live.json()).placement.status, "on");
  assert.equal((await on({ paid_ref: "pilot" })).status, 409, "already on");
});

test("state machine: pause, end, refuse and update rules", async () => {
  const w = await admin();
  const p = await w.live();
  const post = (what, body) => w.call("POST", `/admin/placements/${what}`, { id: p.id, by: "bruce", ...body });

  // While on, only a later end and the note can change.
  assert.equal((await post("update", { listing_id: "aaaaaaaaaaaaaaaa" })).status, 409);
  assert.equal((await post("update", { apply_url: "https://other.example/x" })).status, 409);
  assert.equal((await post("update", { end: "2026-10-01" })).status, 409, "shortening while on");
  assert.equal((await post("update", { end: "2026-10-20", note: "extended a week" })).status, 200);
  assert.equal(w.rows()[0].end_day, "2026-10-20");
  assert.equal((await post("update", { status: "on" })).status, 400, "status is not an update field");
  assert.equal((await post("refuse", { reason: "too late" })).status, 409, "refuse is for draft or checked");

  assert.equal((await post("pause", {})).status, 400, "pause needs a reason");
  assert.equal((await post("pause", { reason: "role paused by employer" })).status, 200);
  assert.equal(w.rows()[0].status, "paused");
  assert.equal((await post("pause", { reason: "again" })).status, 409);

  // Paused: moving it to another listing clears the checks and sends it back to draft.
  const moved = await (await post("update", { listing_id: "aaaaaaaaaaaaaaaa" })).json();
  assert.equal(moved.placement.status, "draft");
  assert.equal(moved.placement.checks, "");
  assert.equal((await post("on", { paid_ref: "INV-0042" })).status, 409, "checks again first");

  assert.equal((await post("end", { reason: "because" })).status, 400, "end reasons are a fixed list");
  const ended = await (await post("end", { reason: "refunded" })).json();
  assert.equal(ended.placement.status, "ended");
  assert.equal(ended.placement.ended_reason, "refunded");
  assert.equal((await post("end", { reason: "removed" })).status, 409);
  assert.equal((await post("update", { note: "x" })).status, 409, "an ended placement is not edited");

  const q = await w.make();
  assert.equal((await w.call("POST", "/admin/placements/refuse", { id: q.id, by: "bruce", reason: "unpaid role" })).status, 200);
  assert.equal(w.rows().find((r) => r.id === q.id).status, "refused");
  assert.equal((await w.call("POST", "/admin/placements/on", { id: "p-nope", by: "bruce", paid_ref: "pilot" })).status, 404);
  assert.deepEqual(END_REASONS, ["dates", "role_closed", "listing_gone", "removed", "refunded"]);
});

test("GET /placements: public, only live rows inside their dates, exact public keys, cached", async () => {
  const w = await admin();
  const on = await w.live();
  await w.live({ employer: "Future Co", start: "2026-09-15", end: "2026-10-01" });   // starts tomorrow: included
  await w.live({ employer: "Later Co", start: "2026-09-16", end: "2026-10-01" });    // starts in two days: not yet
  await w.make({ employer: "Draft Co" });                                             // draft: never
  const paused = await w.live({ employer: "Paused Co" });
  await w.call("POST", "/admin/placements/pause", { id: paused.id, by: "bruce", reason: "hold" });

  const res = await w.api("GET", "/placements");   // no token at all
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
  const body = await res.json();
  assert.equal(body.day, "2026-09-14");
  assert.deepEqual(body.placements.map((p) => p.employer), ["Acme Robotics", "Future Co"]);
  for (const p of body.placements) assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_KEYS].sort());
  assert.deepEqual(body.placements[0], { id: on.id, listing_id: LISTING, apply_url: URL_, employer: "Acme Robotics",
    start: "2026-09-14", end: "2026-10-14", page_cap: 1, unpaid_ok: 0 });
  const text = JSON.stringify(body);
  for (const secret of ["INV-0042", "paid_ref", "note", "lead_id", "checks", "created_by", "updated_by"]) {
    assert.ok(!text.includes(secret), `GET /placements leaks ${secret}`);
  }

  // On its end day it is gone from the public read even before the cron runs.
  w.setNow(new Date("2026-10-14T00:00:01Z"));
  assert.deepEqual((await (await w.api("GET", "/placements")).json()).placements, []);
});

test("GET /placements carries unpaid_ok, so the site build keeps a confirmed unpaid role", async () => {
  const w = await admin();
  const p = await w.make({ employer: "Town Library" });
  assert.equal((await w.call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: CHECKS, unpaid_ok: true })).status, 200);
  assert.equal((await w.call("POST", "/admin/placements/on", { id: p.id, by: "bruce", paid_ref: "INV-0043" })).status, 200);
  await w.live({ employer: "Acme Robotics" });
  const body = await (await w.api("GET", "/placements")).json();
  assert.deepEqual(body.placements.map((x) => [x.employer, x.unpaid_ok]).sort(), [["Acme Robotics", 0], ["Town Library", 1]]);
});

test("GET /placements with an Origin still works (no admin check) and with ADMIN_TOKEN unset", async () => {
  const w = await setup();
  const res = await w.api("GET", "/placements", { headers: { Origin: "https://internscout.org" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { day: "2026-09-14", placements: [] });
});

test("log: every change adds exactly one placement_log row with before and after", async () => {
  const w = await admin();
  const p = await w.make();
  assert.equal(w.log().length, 1);
  assert.equal(w.log()[0].action, "create");
  assert.equal(w.log()[0].before, null);
  assert.equal(JSON.parse(w.log()[0].after).status, "draft");

  const steps = [
    ["update", { note: "first pilot" }, "update"],
    ["check", { checks: CHECKS }, "check"],
    ["on", { paid_ref: "pilot" }, "on"],
    ["pause", { reason: "employer asked" }, "pause"],
    ["end", { reason: "removed" }, "end"],
  ];
  for (const [i, [what, body, action]] of steps.entries()) {
    const before = w.rows()[0];
    assert.equal((await w.call("POST", `/admin/placements/${what}`, { id: p.id, by: "bruce", ...body })).status, 200);
    const log = w.log();
    assert.equal(log.length, i + 2, `${what} adds one log row`);
    const last = log.at(-1);
    assert.equal(last.action, action);
    assert.equal(last.by, "bruce");
    assert.equal(last.placement, p.id);
    assert.deepEqual(JSON.parse(last.before), before);
    assert.deepEqual(JSON.parse(last.after), w.rows()[0]);
  }
  assert.equal(w.log().at(-1).reason, "removed");
  assert.equal(w.log().find((e) => e.action === "pause").reason, "employer asked");

  // A refused change writes no log row.
  assert.equal((await w.call("POST", "/admin/placements/on", { id: p.id, by: "bruce", paid_ref: "pilot" })).status, 409);
  assert.equal(w.log().length, steps.length + 1);

  const { placements } = await (await w.call("GET", "/admin/placements")).json();
  assert.equal(placements[0].log.length, steps.length + 1);
  assert.equal(placements[0].log[0].action, "end", "newest first");
  assert.equal(placements[0].paid_ref, "pilot", "the admin list has the private fields");
});

test("a change made from a stale read is refused and writes no log row", async () => {
  const w = await admin();
  const p = await w.make();
  // Another change lands between this request's read and its write: simulated by moving `updated` on.
  const db = w.db;
  const realBatch = db.batch.bind(db);
  db.batch = async (list) => {
    await db.prepare("UPDATE placements SET updated = '2099-01-01T00:00:00.000Z' WHERE id = ?").bind(p.id).run();
    return realBatch(list);
  };
  const res = await w.call("POST", "/admin/placements/update", { id: p.id, by: "bruce", note: "x" });
  db.batch = realBatch;
  assert.equal(res.status, 409);
  assert.equal(w.log().length, 1, "only the create");
  assert.equal(w.rows()[0].note, "");
});

test("cron: an on row whose end day is today ends with reason dates, and is logged", async () => {
  const w = await admin();
  const on = await w.live({ end: "2026-09-20" });
  const paused = await w.live({ employer: "Paused Co", end: "2026-09-20" });
  await w.call("POST", "/admin/placements/pause", { id: paused.id, by: "bruce", reason: "hold" });
  const later = await w.live({ employer: "Later Co", end: "2026-09-21" });
  const drafted = await w.make({ employer: "Draft Co", end: "2026-09-20" });
  const logged = w.log().length;

  assert.equal(await endExpiredPlacements(w.db, new Date("2026-09-19T23:59:59Z")), 0, "the day before: nothing");
  assert.equal(await endExpiredPlacements(w.db, new Date("2026-09-20T07:17:00Z")), 2);
  const byId = Object.fromEntries(w.rows().map((r) => [r.id, r]));
  assert.equal(byId[on.id].status, "ended");
  assert.equal(byId[on.id].ended_reason, "dates");
  assert.equal(byId[on.id].updated_by, "cron");
  assert.equal(byId[paused.id].status, "ended");
  assert.equal(byId[later.id].status, "on");
  assert.equal(byId[drafted.id].status, "draft", "a draft is not touched");
  const added = w.log().slice(logged);
  assert.deepEqual(added.map((e) => [e.placement, e.action, e.reason]).sort(),
    [[on.id, "cron_end", "dates"], [paused.id, "cron_end", "dates"]].sort());
  assert.equal(await endExpiredPlacements(w.db, new Date("2026-09-20T08:00:00Z")), 0, "a second run changes nothing");
});

test("the daily scheduled handler runs endExpiredPlacements", async () => {
  const w = await admin();
  // Insert directly: a placement already past its end day (the routes refuse to switch one on).
  await w.db.prepare(`INSERT INTO placements (id, employer, listing_id, apply_url, start_day, end_day, status, checks,
    created, created_by, updated, updated_by) VALUES ('p-2020-01-old-1', 'Old', ?, ?, '2020-01-01', '2020-02-01', 'on', '',
    '2020-01-01T00:00:00.000Z', 'bruce', '2020-01-01T00:00:00.000Z', 'bruce')`).bind(LISTING, URL_).run();
  const pending = [];
  worker.scheduled({ cron: "17 7 * * *" }, w.env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(w.rows().find((r) => r.id === "p-2020-01-old-1").status, "ended");
});

test("switching on a placement whose end day has passed is refused", async () => {
  const w = await admin();
  const p = await w.make({ start: "2026-09-01", end: "2026-09-14" });
  await w.call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: CHECKS });
  assert.equal((await w.call("POST", "/admin/placements/on", { id: p.id, by: "bruce", paid_ref: "pilot" })).status, 409);
});

test("the schema refuses a page_cap above 1 and a bad listing id even outside the routes", async () => {
  const w = await admin();
  const insert = (cap, listing) => w.db.prepare(`INSERT INTO placements (id, employer, listing_id, apply_url, start_day, end_day,
    page_cap, created, created_by, updated, updated_by) VALUES (?, 'X', ?, ?, '2026-09-14', '2026-09-20', ?, 'a', 'b', 'a', 'b')`)
    .bind("p-" + cap + listing.slice(0, 3), listing, URL_, cap).run();
  await assert.rejects(insert(2, LISTING), /CHECK/);
  await assert.rejects(insert(1, "NOT-HEX-AT-ALL!!"), /CHECK/);
  await insert(1, LISTING);
  assert.equal(NOW.toISOString().slice(0, 10), "2026-09-14");
});
