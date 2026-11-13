// Paid listings shown and opened (S9, added 2026-10-14): POST /hit with a placement id, the
// placement_counts table, the rounded monthly report and the 400-day roll-up. B2-technical-plan.md
// section 8 and B1-data-privacy.md sections 4.3 and 4.4.
import test from "node:test";
import assert from "node:assert/strict";
import { CHECKS, COUNT_DAYS, REPORT_MIN, roundedCount, rollupPlacementCounts } from "../src/placements.js";
import { PLACEMENT_DAY_CAP, PLACEMENT_EVENTS } from "../src/visits.js";
import { setup } from "./helpers.js";

const ADMIN = "admin-test-token";
const SITE = { Origin: "https://internscout.org", "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130" };
const LISTING = "3f9c0a1b2c3d4e5f";

async function world() {
  const w = await setup({ env: { ADMIN_TOKEN: ADMIN } });
  const call = (method, path, body) => w.api(method, path, { token: ADMIN, body });
  const make = async (over = {}, on = true) => {
    const res = await call("POST", "/admin/placements", { employer: "Acme Robotics", listing_id: LISTING,
      apply_url: "https://boards.example.com/acme/jobs/1", start: "2026-09-14", end: "2026-10-14", by: "bruce", ...over });
    const p = (await res.json()).placement;
    if (on) {
      await call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: CHECKS });
      await call("POST", "/admin/placements/on", { id: p.id, by: "bruce", paid_ref: "pilot" });
    }
    return p;
  };
  const hit = (body, headers = SITE) => w.api("POST", "/hit", { body, headers });
  const counts = () => w.db.dump().placement_counts.map(({ day, placement, page, event, n }) => ({ day, placement, page, event, n }))
    .sort((a, b) => (a.day + a.placement + a.page + a.event).localeCompare(b.day + b.placement + b.page + b.event));
  const report = (id, month) => call("POST", "/admin/placements/report", { id, month });
  return { ...w, call, make, hit, counts, report };
}

test("POST /hit counts a live placement shown and opened, by day and kind of page, and nothing else", async () => {
  const w = await world();
  const p = await w.make();
  assert.equal((await w.hit({ s: p.id, e: "shown", p: "/" })).status, 204);
  await w.hit({ s: p.id, e: "shown", p: "/?field=swe" });
  await w.hit({ s: p.id, e: "open", p: "/" });
  await w.hit({ s: p.id, e: "shown", p: "/internships/software/" });
  assert.deepEqual(w.counts(), [
    { day: "2026-09-14", placement: p.id, page: "dashboard", event: "open", n: 1 },
    { day: "2026-09-14", placement: p.id, page: "dashboard", event: "shown", n: 2 },
    { day: "2026-09-14", placement: p.id, page: "landing", event: "shown", n: 1 },
  ]);
  // The visit and step tables are untouched by these.
  const d = w.db.dump();
  assert.equal(d.visit_counts.length, 0);
  assert.equal(d.event_counts.length, 0);
  assert.deepEqual([...PLACEMENT_EVENTS].sort(), ["open", "shown"]);
});

test("POST /hit adds nothing for a made-up, draft, paused, ended or future placement, or a bad event or page", async () => {
  const w = await world();
  const draft = await w.make({ employer: "Draft Co" }, false);
  const later = await w.make({ employer: "Later Co", start: "2026-09-20", end: "2026-10-01" });
  const paused = await w.make({ employer: "Paused Co" });
  await w.call("POST", "/admin/placements/pause", { id: paused.id, by: "bruce", reason: "hold" });
  const live = await w.make({ employer: "Live Co" });
  for (const body of [
    { s: "p-made-up", e: "shown", p: "/" }, { s: draft.id, e: "shown", p: "/" }, { s: later.id, e: "shown", p: "/" },
    { s: paused.id, e: "open", p: "/" },
    { s: live.id, e: "click", p: "/" }, { s: live.id, e: "posting_click", p: "/" }, { s: live.id, p: "/" },
    { s: live.id, e: "shown", p: "/install.html" }, { s: live.id, e: "shown", p: "/privacy.html" },
    { s: "bad id!", e: "shown", p: "/" }, { s: 7, e: "shown", p: "/" }, { s: "x".repeat(81), e: "shown", p: "/" },
  ]) assert.equal((await w.hit(body)).status, 204, JSON.stringify(body));
  assert.deepEqual(w.counts(), []);
  // Not from the site, or from a bot: refused or ignored as for every hit.
  assert.equal((await w.hit({ s: live.id, e: "shown", p: "/" }, { ...SITE, Origin: "https://evil.example" })).status, 403);
  await w.hit({ s: live.id, e: "shown", p: "/" }, { ...SITE, "User-Agent": "Googlebot/2.1" });
  assert.deepEqual(w.counts(), []);
  // On its end day it no longer counts.
  w.setNow(new Date("2026-10-14T08:00:00Z"));
  await w.hit({ s: live.id, e: "shown", p: "/" });
  assert.deepEqual(w.counts(), []);
});

test("the daily cap is per placement: a flood on one employer's listing doesn't stop another being counted", async () => {
  // Legal review 2026-10-14: was one cap summed over every placement for the day.
  const w = await world();
  const a = await w.make({ employer: "Flooded Co" });
  const b = await w.make({ employer: "Other Co" });
  await w.db.prepare("INSERT INTO placement_counts (day, placement, page, event, n) VALUES (?, ?, 'dashboard', 'shown', ?)")
    .bind("2026-09-14", a.id, PLACEMENT_DAY_CAP).run();
  await w.hit({ s: a.id, e: "shown", p: "/" });
  await w.hit({ s: a.id, e: "open", p: "/" });
  await w.hit({ s: b.id, e: "shown", p: "/" });
  await w.hit({ s: b.id, e: "open", p: "/" });
  assert.deepEqual(w.counts().filter((r) => r.placement === a.id).map((r) => [r.event, r.n]), [["shown", PLACEMENT_DAY_CAP]]);
  assert.deepEqual(w.counts().filter((r) => r.placement === b.id).map((r) => [r.event, r.n]), [["open", 1], ["shown", 1]]);
  // The next day the flooded one counts again.
  w.setNow(new Date("2026-09-15T08:00:00Z"));
  await w.hit({ s: a.id, e: "shown", p: "/" });
  assert.equal(w.counts().find((r) => r.placement === a.id && r.day === "2026-09-15").n, 1);
});

test("the report: ended months only, rounded down to 10, fewer than 10 below that, no split unless every cell is 10+", async () => {
  const w = await world();
  const p = await w.make();
  const add = (day, page, event, n) => w.db.prepare("INSERT INTO placement_counts (day, placement, page, event, n) VALUES (?, ?, ?, ?, ?)")
    .bind(day, p.id, page, event, n).run();
  await add("2026-08-03", "dashboard", "shown", 1200);
  await add("2026-08-20", "dashboard", "shown", 27);
  await add("2026-08-20", "dashboard", "open", 41);
  await add("2026-08-21", "landing", "shown", 9);
  await add("2026-08-21", "landing", "open", 3);
  await add("2026-07-31", "dashboard", "shown", 500);     // another month
  await add("2026-07", "landing", "open", 8);            // a rolled-up month row
  let res = await w.report(p.id, "2026-08");
  assert.equal(res.status, 200);
  let r = (await res.json()).report;
  assert.equal(r.placement, p.id);
  assert.equal(r.month, "2026-08");
  assert.equal(r.shown, "1,230+");          // 1,236
  assert.equal(r.opened, "40+");            // 44
  assert.equal(r.by_page, null, "landing has cells under 10, so no split");
  assert.match(r.about, /rounded down to the nearest 10/);
  assert.match(r.about, /does not see applications/);
  assert.doesNotMatch(JSON.stringify(r), /1236|1,236|\b44\b|\b27\b|\b41\b|\b9\b|\b3\b/);
  r = (await (await w.report(p.id, "2026-07")).json()).report;
  assert.equal(r.shown, "500+");
  assert.equal(r.opened, "fewer than 10");
  // A split only when every number in it is 10 or more.
  await add("2026-08-22", "landing", "shown", 10);
  await add("2026-08-22", "landing", "open", 10);
  r = (await (await w.report(p.id, "2026-08")).json()).report;
  assert.deepEqual(r.by_page, { dashboard: { shown: "1,220+", opened: "40+" }, landing: { shown: "10+", opened: "10+" } });
  // The month still running, a later one, a bad month, an unknown placement.
  assert.equal((await w.report(p.id, "2026-09")).status, 400);
  assert.equal((await w.report(p.id, "2026-12")).status, 400);
  assert.equal((await w.report(p.id, "2026-8")).status, 400);
  assert.equal((await w.report(p.id, "2026-13")).status, 400);
  assert.equal((await w.report("p-nope", "2026-08")).status, 404);
  // Admin only: no token, and never from a browser.
  assert.equal((await w.api("POST", "/admin/placements/report", { body: { id: p.id, month: "2026-08" } })).status, 401);
  assert.equal((await w.api("POST", "/admin/placements/report", { token: ADMIN, body: { id: p.id, month: "2026-08" }, headers: { Origin: "https://internscout.org" } })).status, 403);
  assert.equal(REPORT_MIN, 10);
  assert.deepEqual([0, 9, 10, 19, 1236].map(roundedCount), ["fewer than 10", "fewer than 10", "10+", "10+", "1,230+"]);
});

test("the daily cron folds daily counts older than 400 days into one row per month", async () => {
  const w = await world();
  const add = (day, n, page = "dashboard", event = "shown") => w.db.prepare("INSERT INTO placement_counts (day, placement, page, event, n) VALUES (?, 'p-a', ?, ?, ?)")
    .bind(day, page, event, n).run();
  const now = new Date("2026-09-14T03:00:00Z");
  const cutoff = new Date(now.getTime() - COUNT_DAYS * 86400e3).toISOString().slice(0, 10);   // 2025-08-10
  assert.equal(cutoff, "2025-08-10");
  await add("2025-07-01", 5); await add("2025-07-31", 7); await add("2025-08-09", 2); await add("2025-08-10", 4);
  await add("2025-07-02", 3, "landing", "open");
  await add("2025-07", 1);   // a month row already there
  await rollupPlacementCounts(w.db, now);
  assert.deepEqual(w.counts().map(({ day, page, event, n }) => [day, page, event, n]), [
    ["2025-07", "dashboard", "shown", 13], ["2025-07", "landing", "open", 3],
    ["2025-08-10", "dashboard", "shown", 4], ["2025-08", "dashboard", "shown", 2],
  ]);
  // Twice is the same as once.
  await rollupPlacementCounts(w.db, now);
  assert.equal(w.counts().find((r) => r.day === "2025-07" && r.page === "dashboard").n, 13);
});

test("the table holds counts only: no column for anything about a visitor", async () => {
  const w = await world();
  const cols = (await w.db.prepare("PRAGMA table_info(placement_counts)").all()).results.map((c) => c.name);
  assert.deepEqual(cols, ["day", "placement", "page", "event", "n"]);
});
