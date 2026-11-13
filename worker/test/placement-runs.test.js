// The site build's record of each live paid listing (added 2026-10-14): the placement_runs table that
// backend/internscout/placements.py record_runs writes over the D1 HTTP API, and `runs` in
// GET /admin/placements and `node scripts/placement.mjs list`. The writing side is tested in
// backend/tests/test_placement_runs.py.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_API, run } from "../scripts/placement.mjs";
import { handle } from "../src/index.js";
import { CHECKS, placementRuns } from "../src/placements.js";
import { NOW, setup } from "./helpers.js";

const ADMIN = "admin-test-token";
const draft = (over = {}) => ({ employer: "Acme Robotics", listing_id: "3f9c0a1b2c3d4e5f",
  apply_url: "https://boards.example.com/acme/jobs/123", start: "2026-09-14", end: "2026-10-14", by: "bruce", ...over });

async function world() {
  const w = await setup({ env: { ADMIN_TOKEN: ADMIN } });
  const call = (method, path, body) => w.api(method, path, { token: ADMIN, body });
  const live = async (over = {}) => {
    const p = (await (await call("POST", "/admin/placements", draft(over))).json()).placement;
    await call("POST", "/admin/placements/check", { id: p.id, by: "bruce", checks: CHECKS });
    return (await (await call("POST", "/admin/placements/on", { id: p.id, by: "bruce", paid_ref: "INV-1" })).json()).placement;
  };
  const addRun = (id, day, shown, dropped, reason = null) => w.db.prepare(
    "INSERT INTO placement_runs (placement_id, day, shown, dropped, reason, updated) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, day, shown, dropped, reason, `${day}T12:00:00Z`).run();
  return { ...w, call, live, addRun };
}

test("GET /admin/placements carries each placement's runs: days shown, days dropped and the drops", async () => {
  const w = await world();
  const p = await w.live();
  const q = await w.live({ employer: "Quiet Co" });
  await w.addRun(p.id, "2026-09-14", 2, 0);
  await w.addRun(p.id, "2026-09-15", 1, 1, "closed");          // two builds that day disagreed
  await w.addRun(p.id, "2026-09-16", 0, 2, "listing_gone");
  await w.addRun(p.id, "2026-09-17", 3, 0);
  await w.addRun("p-2026-09-other-1", "2026-09-14", 0, 1, "deadline");   // no such placement: not listed
  const res = await w.call("GET", "/admin/placements");
  assert.equal(res.status, 200);
  const { placements } = await res.json();
  assert.deepEqual(placements.map((x) => x.id).sort(), [p.id, q.id].sort());
  const one = placements.find((x) => x.id === p.id), two = placements.find((x) => x.id === q.id);
  assert.deepEqual(one.runs, { days_shown: 3, days_dropped: 2,
    drops: [{ day: "2026-09-15", reason: "closed" }, { day: "2026-09-16", reason: "listing_gone" }] });
  assert.deepEqual(two.runs, { days_shown: 0, days_dropped: 0, drops: [] });
  assert.ok(Array.isArray(one.log) && one.paid_ref === "INV-1", "the rest of the row is as before");
});

test("placementRuns reads the table once and orders drops by day", async () => {
  const w = await world();
  await w.addRun("p-a", "2026-09-20", 0, 1, "url_changed");
  await w.addRun("p-a", "2026-09-18", 0, 1, null);
  let statements = 0;
  const db = { prepare: (q) => (statements++, w.db.prepare(q)) };
  assert.deepEqual(await placementRuns(db), { "p-a": { days_shown: 0, days_dropped: 2,
    drops: [{ day: "2026-09-18", reason: "" }, { day: "2026-09-20", reason: "url_changed" }] } });
  assert.equal(statements, 1);
});

test("the table holds the build's record only, and schema.sql can be applied twice", () => {
  const sql = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  sql.exec(schema);
  sql.exec(schema);   // npm run deploy runs it before every deploy
  assert.deepEqual(sql.prepare("PRAGMA table_info(placement_runs)").all().map((c) => c.name),
    ["placement_id", "day", "shown", "dropped", "reason", "updated"]);
  // The upsert backend placements.py runs_sql sends: counts add up across builds on one day.
  const up = "INSERT INTO placement_runs (placement_id, day, shown, dropped, reason, updated) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(placement_id, day) DO UPDATE SET shown = shown + excluded.shown, dropped = dropped + excluded.dropped, " +
    "reason = COALESCE(excluded.reason, placement_runs.reason), updated = excluded.updated";
  sql.prepare(up).run("p-a", "2026-09-14", 0, 1, "closed", "t1");
  sql.prepare(up).run("p-a", "2026-09-14", 1, 0, null, "t2");
  assert.deepEqual({ ...sql.prepare("SELECT * FROM placement_runs").get() },
    { placement_id: "p-a", day: "2026-09-14", shown: 1, dropped: 1, reason: "closed", updated: "t2" });
});

test("node scripts/placement.mjs list shows the run days, still without paid_ref or the token", async () => {
  const w = await world();
  const p = await w.live();
  await w.addRun(p.id, "2026-09-15", 0, 1, "closed");
  const lines = [];
  const fetch = async (url, init) => handle(new Request(url.replace(DEFAULT_API, "https://api.test"), init), w.env,
    { waitUntil() {} }, { now: () => NOW });
  const code = await run(["list"], { env: { INTERNSCOUT_ADMIN_TOKEN: ADMIN }, fetch,
    out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)) });
  assert.equal(code, 0, lines.join("\n"));
  const text = lines.join("\n");
  const listed = JSON.parse(text).placements[0];
  assert.deepEqual(listed.runs, { days_shown: 0, days_dropped: 1, drops: [{ day: "2026-09-15", reason: "closed" }] });
  assert.ok(!text.includes("INV-1") && !text.includes(ADMIN));
});
