// POST /employer-interest (src/leads.js): the interest form on internscout.org/employers/.
import test from "node:test";
import assert from "node:assert/strict";
import { NOW, setup } from "./helpers.js";
import { readFileSync } from "node:fs";
import { ALL_PER_DAY, LIMITS, PER_ADDRESS_PER_DAY, WANTS, WANTS_NOW, WANTS_OLD, cleanLead, dropOldLeads } from "../src/leads.js";
import { cleanup } from "../src/limits.js";

const SITE = { Origin: "https://internscout.org", "CF-Connecting-IP": "203.0.113.7" };
const GOOD = {
  name: "  Dana   Reyes ", email: "dana.reyes@example.com", company: "Example Robotics",
  title: "University Recruiting Lead", hiring_for: "mechanical and electrical engineering",
  wants: ["board", "placement_field", "made-up"], message: "Summer 2027 interns.\r\nAbout 20 roles.", website: "",
};
const send = (w, body, headers = SITE) => w.api("POST", "/employer-interest", { body, headers });
const leads = (w) => w.db.prepare("SELECT * FROM employer_leads ORDER BY id").all().then((r) => r.results);
const events = (w) => w.db.dump().event_counts.filter((r) => r.event === "employer_interest");

test("a good send is stored, cleaned, and counted as a step", async () => {
  const w = await setup();
  const res = await send(w, GOOD);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://internscout.org");
  const [row] = await leads(w);
  assert.deepEqual({ ...row, id: undefined }, {
    id: undefined, created: NOW.toISOString(), name: "Dana Reyes", email: "dana.reyes@example.com",
    company: "Example Robotics", title: "University Recruiting Lead",
    hiring_for: "mechanical and electrical engineering",
    // In the form's order, unknown boxes dropped.
    wants: "placement_field,board", message: "Summer 2027 interns.\nAbout 20 roles.",
  });
  // No address in the row; the rate count is under a salted hash, never the address itself.
  assert.ok(!JSON.stringify(row).includes("203.0.113.7"));
  assert.ok(!JSON.stringify(w.db.dump().rate).includes("203.0.113.7"));
  assert.deepEqual(events(w), [{ day: "2026-09-14", event: "employer_interest", page: "employers", n: 1 }]);
});

test("the first form's boxes are still accepted from a cached page, and stored before the new ones", async () => {
  const w = await setup();
  assert.equal((await send(w, { ...GOOD, wants: ["other", "promoted", "details", "featured", "majors_schools"] })).status, 200);
  const [row] = await leads(w);
  assert.equal(row.wants, "featured,promoted,majors_schools,details,other");
  assert.deepEqual(WANTS, [...WANTS_OLD, ...WANTS_NOW]);
});

test("the employers page offers exactly the current boxes, and none of the old ones", () => {
  const html = readFileSync(new URL("../../docs/employers/index.html", import.meta.url), "utf8");
  const boxes = [...html.matchAll(/name="wants" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(boxes, WANTS_NOW);
  // The placement rule: nothing promises rank, targeting or applicants, and the label words are never used.
  const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
  for (const banned of [/promoted/i, /sponsored/i, /featured/i, /reach students/i, /specific majors/i, /more applicants/i, /—/]) {
    assert.doesNotMatch(text, banned);
  }
  assert.match(text, /free for every employer, whether or not you ever pay/);
  assert.match(text, /Paying never changes where any listing ranks/);
});

test("only the optional fields may be left out", async () => {
  const w = await setup();
  const res = await send(w, { name: "Sam", email: "sam@small.co", company: "Small Co" });
  assert.equal(res.status, 200);
  const [row] = await leads(w);
  assert.equal(row.title, "");
  assert.equal(row.wants, "");
  assert.equal(row.message, "");
});

test("each field is checked and the answer names it", async () => {
  const w = await setup();
  const cases = [
    [{ ...GOOD, name: "   " }, "name"],
    [{ ...GOOD, company: undefined }, "company"],
    [{ ...GOOD, email: "" }, "email"],
    [{ ...GOOD, email: "not-an-email" }, "email"],
    [{ ...GOOD, email: "a@b" }, "email"],
    [{ ...GOOD, email: "two@@example.com" }, "email"],
    [{ ...GOOD, email: "space in@example.com" }, "email"],
    [{ ...GOOD, email: "x@" + "a".repeat(250) + ".com" }, "email"],
    [{ ...GOOD, name: "n".repeat(LIMITS.name + 1) }, "name"],
    [{ ...GOOD, company: "c".repeat(LIMITS.company + 1) }, "company"],
    [{ ...GOOD, title: "t".repeat(LIMITS.title + 1) }, "title"],
    [{ ...GOOD, hiring_for: "h".repeat(LIMITS.hiring_for + 1) }, "hiring_for"],
    [{ ...GOOD, message: "m".repeat(LIMITS.message + 1) }, "message"],
    [{ ...GOOD, name: 42 }, "name"],
    [{ ...GOOD, wants: "board" }, "wants"],
  ];
  for (const [body, field] of cases) {
    const res = await send(w, body);
    assert.equal(res.status, 400, field);
    const out = await res.json();
    assert.equal(out.error, "bad_request");
    assert.equal(out.field, field, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await leads(w)).length, 0);
  assert.deepEqual(events(w), []);
  // A refused send does not use up the address's day.
  assert.equal(w.db.dump().rate.length, 0);
});

test("limits are counted after trimming, and control characters are dropped", () => {
  const lead = cleanLead({ ...GOOD, name: " " + "n".repeat(LIMITS.name) + " ", company: "Acme\u0000\u0007 Inc" });
  assert.equal(lead.name.length, LIMITS.name);
  assert.equal(lead.company, "Acme Inc");
});

test("a body that is too big or not an object is refused", async () => {
  const w = await setup();
  assert.equal((await send(w, { ...GOOD, message: "m".repeat(9_000) })).status, 400);
  assert.equal((await send(w, [GOOD])).status, 400);
  assert.equal((await leads(w)).length, 0);
});

test("the honeypot gets a normal answer and nothing is kept", async () => {
  const w = await setup();
  for (const website of ["https://spam.example", " x ", 1]) {
    const res = await send(w, { ...GOOD, website });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
  // Even a bot's send that would fail the checks is answered the same way.
  assert.equal((await send(w, { website: "x" })).status, 200);
  assert.equal((await leads(w)).length, 0);
  assert.deepEqual(events(w), []);
  assert.equal(w.db.dump().rate.length, 0);
});

test("only the live site can send, so a local copy never writes a lead", async () => {
  const w = await setup();
  for (const Origin of ["https://evil.example", "http://localhost:8000", undefined]) {
    const headers = { ...SITE, Origin };
    if (!Origin) delete headers.Origin;
    assert.equal((await send(w, GOOD, headers)).status, 403, String(Origin));
  }
  assert.equal((await send(w, GOOD, { ...SITE, Origin: "https://bpmcginley.github.io" })).status, 200);
  assert.equal((await leads(w)).length, 1);
});

test("one address gets a few sends a day, and the next day it starts again", async () => {
  const w = await setup();
  for (let i = 0; i < PER_ADDRESS_PER_DAY; i++) assert.equal((await send(w, GOOD)).status, 200, `send ${i + 1}`);
  const res = await send(w, GOOD);
  assert.equal(res.status, 429);
  const out = await res.json();
  assert.equal(out.error, "rate");
  assert.ok(out.retry_after > 0 && out.retry_after <= 86400);
  assert.equal((await leads(w)).length, PER_ADDRESS_PER_DAY);
  // Another address is not held up by this one.
  assert.equal((await send(w, GOOD, { ...SITE, "CF-Connecting-IP": "198.51.100.4" })).status, 200);
  // The next day the address may send again.
  w.setNow(new Date("2026-09-15T09:00:00Z"));
  assert.equal((await send(w, GOOD)).status, 200);
  assert.deepEqual(events(w).map((r) => [r.day, r.n]), [["2026-09-14", PER_ADDRESS_PER_DAY + 1], ["2026-09-15", 1]]);
});

test("a flood from many addresses stops at the day's total", async () => {
  const w = await setup();
  await w.db.prepare("INSERT INTO rate (user_hash, bucket, calls) VALUES ('lead:*', 'd:2026-09-14', ?)").bind(ALL_PER_DAY).run();
  const res = await send(w, GOOD);
  assert.equal(res.status, 429);
  assert.equal((await leads(w)).length, 0);
});

test("the daily cron sweeps the rate counts and drops leads after a year", async () => {
  const w = await setup();
  await send(w, GOOD);
  w.setNow(new Date("2027-03-01T09:00:00Z"));
  await send(w, { ...GOOD, email: "later@example.com" });
  // Two days on, the day buckets behind the per-address limit are gone.
  await cleanup(w.db, new Date("2027-03-04T07:17:00Z"));
  assert.equal(w.db.dump().rate.length, 0);
  await dropOldLeads(w.db, new Date("2027-03-04T07:17:00Z"));
  assert.equal((await leads(w)).length, 2, "both are under a year old");
  await dropOldLeads(w.db, new Date("2027-09-15T07:17:00Z"));
  assert.deepEqual((await leads(w)).map((r) => r.email), ["later@example.com"]);
});

test("a preflight from the site is allowed", async () => {
  const w = await setup();
  const res = await w.api("OPTIONS", "/employer-interest", {
    headers: { Origin: "https://internscout.org", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://internscout.org");
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
});
