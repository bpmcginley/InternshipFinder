import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { DAY_CAP, pageKind, sourceOf } from "../src/visits.js";

const SITE = { Origin: "https://internscout.org", "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130" };
const hit = (w, body, headers = SITE) => w.api("POST", "/hit", { body, headers });
const rows = async (w) => (await w.db.dump()).visit_counts
  .map(({ day, page, source, views, visits }) => ({ day, page, source, views, visits }))
  .sort((a, b) => (a.page + a.source).localeCompare(b.page + b.source));

test("pages are counted by kind, never by the path sent", () => {
  assert.equal(pageKind("/"), "dashboard");
  assert.equal(pageKind("/index.html"), "dashboard");
  assert.equal(pageKind("/?upgrade=supporter"), "dashboard");
  assert.equal(pageKind("/internships/massachusetts/"), "landing");
  assert.equal(pageKind("/internships"), "landing");
  assert.equal(pageKind("/install.html"), "install");
  assert.equal(pageKind("/privacy.html"), "legal");
  assert.equal(pageKind("/anything-made-up"), "other");
});

test("sources match growth/metrics.py, with our own tagged links first", () => {
  assert.equal(sourceOf(""), "direct");
  assert.equal(sourceOf("www.google.com"), "search");
  assert.equal(sourceOf("google.co.uk"), "search");
  assert.equal(sourceOf("lnkd.in"), "social");
  assert.equal(sourceOf("internscout.org"), "internal");
  assert.equal(sourceOf("example.edu"), "other");
  assert.equal(sourceOf("", "digest", "email"), "email");
  assert.equal(sourceOf("", "linkedin"), "social");
  assert.equal(sourceOf("internscout.org", "campus_partner"), "other", "a tagged link is never internal");
});

test("POST /hit counts views and visits per day, page and source", async () => {
  const w = await setup();
  assert.equal((await hit(w, { p: "/", r: "" })).status, 204);
  await hit(w, { p: "/", r: "" });
  await hit(w, { p: "/internships/ohio/", r: "www.google.com" });
  await hit(w, { p: "/", r: "internscout.org" });   // from another page of the site: a view, not a visit
  assert.deepEqual(await rows(w), [
    { day: "2026-09-14", page: "dashboard", source: "direct", views: 2, visits: 2 },
    { day: "2026-09-14", page: "dashboard", source: "internal", views: 1, visits: 0 },
    { day: "2026-09-14", page: "landing", source: "search", views: 1, visits: 1 },
  ]);
});

test("only the site counts, and not robots", async () => {
  const w = await setup();
  assert.equal((await hit(w, { p: "/" }, { ...SITE, Origin: "https://evil.example" })).status, 403);
  assert.equal((await hit(w, { p: "/" }, { "User-Agent": SITE["User-Agent"] })).status, 403, "no Origin");
  assert.equal((await hit(w, { p: "/" }, { ...SITE, "User-Agent": "Googlebot/2.1" })).status, 204);
  assert.equal((await hit(w, { p: "/" }, { ...SITE, "User-Agent": "Mozilla/5.0 HeadlessChrome/130" })).status, 204);
  assert.deepEqual(await rows(w), []);
});

test("one address can't run up the count, and a day stops at the cap", async () => {
  const w = await setup();
  const from = { ...SITE, "CF-Connecting-IP": "203.0.113.9" };
  for (let i = 0; i < 40; i++) await hit(w, { p: "/" }, from);
  assert.equal((await rows(w))[0].views, 30);
  await w.db.prepare("UPDATE visit_counts SET views = ?").bind(DAY_CAP).run();
  await hit(w, { p: "/install" });
  assert.equal((await rows(w)).length, 1, "past the day's cap nothing new is counted");
});

test("a bad body is refused", async () => {
  const w = await setup();
  const res = await w.api("POST", "/hit", { headers: SITE });
  assert.equal(res.status, 400);
});
