// 2026-10-23: finite anonymous employer steps cannot impersonate server-side order or cash events.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.js";
import { countHit, pageKind, EVENTS, SERVER_EVENTS, EMPLOYER_ENTRIES } from "../src/visits.js";

const now = new Date("2026-10-23T12:00:00Z");
const request = () => new Request("https://api.example/hit", { method: "POST", headers: {
  Origin: "https://internscout.org", "User-Agent": "Mozilla/5.0 Chrome/130",
} });

test("employer buy has its own finite page kind, regardless of query tokens or clean URL spelling", () => {
  for (const path of ["/employers/buy", "/employers/buy/", "/employers/buy/index.html", "/employers/buy.html?order=secret&t=private&company=Acme"]) assert.equal(pageKind(path), "employer_buy");
  assert.equal(pageKind("/employers/"), "employers");
  assert.equal(pageKind("/employers/buy/anything"), "other");
});

test("employer position and intent whitelists produce only day/event/page/count rows", async () => {
  const db = fakeD1();
  assert.deepEqual(EMPLOYER_ENTRIES, ["hero", "packages", "contact", "nav", "employer", "footer", "report"]);
  const events = EMPLOYER_ENTRIES.flatMap((x) => ["employer_view_" + x, "employer_click_" + x]).concat(
    ["employer_buy_open", "employer_company_pick", "employer_company_prefill", "employer_roles_pick", "employer_order_submit"]);
  for (const e of events) {
    assert.equal(EVENTS.has(e), true);
    assert.equal((await countHit(db, request(), { e, p: "/employers/buy/?company=private&order=secret&t=token", company: "never stored", email: "private@company.example" }, now)).counted, true);
  }
  const rows = (await db.dump()).event_counts;
  assert.equal(rows.length, events.length);
  assert.ok(rows.every((row) => row.page === "employer_buy" && row.n === 1));
  assert.ok(rows.every((row) => Object.keys(row).sort().join(",") === "day,event,n,page"));
  assert.doesNotMatch(JSON.stringify(rows), /private|secret|token|company\.example|never stored/);
});

test("browsers cannot forge paid, verified, comped, pilot, repeat or accepted server transitions", async () => {
  const db = fakeD1();
  for (const e of ["employer_order_created", "employer_email_verified", "employer_paid", "employer_pilot", "employer_comped", "employer_repeat_paid"]) {
    assert.equal(SERVER_EVENTS.has(e), true); assert.equal(EVENTS.has(e), false);
    assert.equal((await countHit(db, request(), { e, p: "/employers/buy/" }, now)).counted, false);
  }
  for (const e of ["employer_click_Acme", "employer_view_private@company.example", "employer_buy_unknown"]) assert.equal((await countHit(db, request(), { e, p: "/employers/buy/" }, now)).counted, false);
  assert.deepEqual((await db.dump()).event_counts, []);
});
