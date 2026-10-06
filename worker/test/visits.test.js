import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { DAY_CAP, EVENTS, SERVER_EVENTS, channelOf, countEvent, pageKind, sourceOf } from "../src/visits.js";

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
  // The weekly email's page has a kind of its own (2026-10-06), however the path is written.
  assert.equal(pageKind("/digest/"), "digest");
  assert.equal(pageKind("/digest"), "digest");
  assert.equal(pageKind("/digest/index.html"), "digest");
  assert.equal(pageKind("/digest/?utm_source=extension&utm_medium=extension"), "digest");
  assert.equal(pageKind("/digest/anything"), "other");
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
  // back from signing in or from Stripe: the same visit going on
  assert.equal(sourceOf("accounts.google.com"), "internal");
  assert.equal(sourceOf("login.microsoftonline.com"), "internal");
  assert.equal(sourceOf("checkout.stripe.com"), "internal");
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

// Visits by social site (added 2026-10-05): the scorecard needs YouTube, TikTok, X and the rest apart,
// while `source` keeps folding them into "social" for the dashboard and growth/metrics.py.
const channels = async (w) => (await w.db.dump()).visit_channels
  .map(({ day, channel, views, visits }) => ({ day, channel, views, visits }))
  .sort((a, b) => a.channel.localeCompare(b.channel));

test("a channel is the tagged link's utm_source, spelled out, or else the referring site's family", () => {
  assert.equal(channelOf("", "youtube"), "youtube");
  assert.equal(channelOf("www.google.com", "YouTube"), "youtube", "the tag wins over the referrer");
  assert.equal(channelOf("", "fb"), "facebook");
  assert.equal(channelOf("", "ig"), "instagram");
  assert.equal(channelOf("", "bsky"), "bluesky");
  assert.equal(channelOf("", "twitter"), "x");
  assert.equal(channelOf("youtu.be"), "youtube");
  assert.equal(channelOf("www.youtube.com"), "youtube");
  assert.equal(channelOf("www.tiktok.com"), "tiktok");
  assert.equal(channelOf("t.co"), "x");
  assert.equal(channelOf("twitter.com"), "x");
  assert.equal(channelOf("l.facebook.com"), "facebook");
  assert.equal(channelOf("fb.com"), "facebook");
  assert.equal(channelOf("old.reddit.com"), "reddit");
  assert.equal(channelOf("l.instagram.com"), "instagram");
  assert.equal(channelOf("bsky.app"), "bluesky");
  assert.equal(channelOf("mastodon.social"), "mastodon");
  assert.equal(channelOf("fosstodon.org"), "mastodon");
  assert.equal(channelOf("lnkd.in"), "linkedin");
  assert.equal(channelOf("www.google.com"), "", "search is not a channel");
  assert.equal(channelOf(""), "", "nor direct");
  assert.equal(channelOf("", "digest"), "", "nor email");
  assert.equal(channelOf("example.edu", "campus_partner"), "");
});

test("POST /hit counts social loads once more by site, and only those", async () => {
  const w = await setup();
  await hit(w, { p: "/internships/ohio/", r: "", u: "youtube" });
  await hit(w, { p: "/internships/ohio/", r: "", u: "youtube", m: "social" });
  await hit(w, { p: "/", r: "l.facebook.com" });
  await hit(w, { p: "/", r: "www.google.com" });                      // search: no channel row
  await hit(w, { p: "/", r: "" });                                    // direct: none
  await hit(w, { p: "/", r: "", u: "digest", m: "email" });           // email: none
  await hit(w, { p: "/", r: "l.facebook.com", u: "digest", m: "email" });  // email, not Facebook
  await hit(w, { p: "/", r: "snapchat.com" });                        // social, but no family: none
  assert.deepEqual(await channels(w), [
    { day: "2026-09-14", channel: "facebook", views: 1, visits: 1 },
    { day: "2026-09-14", channel: "youtube", views: 2, visits: 2 },
  ]);
  // `source` is unchanged: every one of those is still "social" there, so the sums the dashboard
  // and growth/metrics.py make are the same as before.
  const social = (await rows(w)).filter((r) => r.source === "social");
  assert.deepEqual(social, [
    { day: "2026-09-14", page: "dashboard", source: "social", views: 2, visits: 2 },
    { day: "2026-09-14", page: "landing", source: "social", views: 2, visits: 2 },
  ]);
});

test("channel rows stop at the day's cap and skip robots, like the visit counts", async () => {
  const w = await setup();
  assert.equal((await hit(w, { p: "/", u: "tiktok" }, { ...SITE, "User-Agent": "Googlebot/2.1" })).status, 204);
  assert.deepEqual(await channels(w), []);
  await hit(w, { p: "/", u: "tiktok" });
  await w.db.prepare("UPDATE visit_counts SET views = ?").bind(DAY_CAP).run();
  await hit(w, { p: "/", u: "tiktok" });
  await hit(w, { p: "/", r: "www.reddit.com" });
  assert.deepEqual(await channels(w), [{ day: "2026-09-14", channel: "tiktok", views: 1, visits: 1 }],
    "past the day's cap no channel is counted either");
});

// Printed flyers (2026-10-06): growth/flyers.py prints ?utm_source=flyer-<spot>&utm_medium=print.
test("a flyer scan is source print, and its own channel per posting spot", async () => {
  assert.equal(sourceOf("", "flyer-library", "print"), "print");
  assert.equal(sourceOf("", "flyer", ""), "print");
  assert.equal(channelOf("", "flyer-library"), "flyer-library");
  assert.equal(channelOf("", "flyer-ThisIsWayTooLongForASpotTag"), "", "only short [a-z0-9-] tags");
  assert.equal(channelOf("", "flyers"), "");
  const w = await setup();
  await hit(w, { p: "/", r: "", u: "flyer-library", m: "print" });
  await hit(w, { p: "/", r: "", u: "flyer-library", m: "print" });
  await hit(w, { p: "/", r: "", u: "flyer-isb", m: "print" });
  assert.deepEqual(await channels(w), [
    { day: "2026-09-14", channel: "flyer-isb", views: 1, visits: 1 },
    { day: "2026-09-14", channel: "flyer-library", views: 2, visits: 2 },
  ]);
  assert.deepEqual((await rows(w)).map((r) => r.source), ["print"]);
});

test("made-up flyer tags cannot add more than a day's share of rows", async () => {
  const w = await setup();
  // Each from its own address, past the per-minute limit's reach.
  for (let i = 0; i < 45; i++) {
    await hit(w, { p: "/", r: "", u: `flyer-x${i}` }, { ...SITE, "CF-Connecting-IP": `10.0.0.${i}` });
  }
  const flyer = (await channels(w)).filter((c) => c.channel.startsWith("flyer"));
  assert.equal(flyer.length, 40);
  // A tag already counted today keeps counting, and social channels are never held back.
  await hit(w, { p: "/", r: "", u: "flyer-x0" }, { ...SITE, "CF-Connecting-IP": "10.0.1.1" });
  await hit(w, { p: "/", r: "", u: "youtube" }, { ...SITE, "CF-Connecting-IP": "10.0.1.2" });
  const after = await channels(w);
  assert.equal(after.find((c) => c.channel === "flyer-x0").views, 2);
  assert.ok(after.find((c) => c.channel === "youtube"));
});

test("steps are counted by event and page, and only known ones", async () => {
  const w = await setup();
  await hit(w, { e: "install_click", p: "/internships/ohio/" });
  await hit(w, { e: "install_click", p: "/internships/texas/" });
  await hit(w, { e: "signin", p: "/" });
  await hit(w, { e: "made_up", p: "/" });
  const ev = (await w.db.dump()).event_counts.map(({ event, page, n }) => ({ event, page, n }))
    .sort((a, b) => a.event.localeCompare(b.event));
  assert.deepEqual(ev, [{ event: "install_click", page: "landing", n: 2 }, { event: "signin", page: "dashboard", n: 1 }]);
  assert.deepEqual(await rows(w), [], "a step is not a page load");
  assert.equal((await hit(w, { e: "signin" }, { ...SITE, Origin: "https://evil.example" })).status, 403);
});

test("opening the invite panel is a step of its own", async () => {
  const w = await setup();
  assert.ok(EVENTS.has("invite_open"));
  await hit(w, { e: "invite_open", p: "/" });
  await hit(w, { e: "invite_open", p: "/" });
  const ev = (await w.db.dump()).event_counts.map(({ event, page, n }) => ({ event, page, n }));
  assert.deepEqual(ev, [{ event: "invite_open", page: "dashboard", n: 2 }]);
});

// Funnel steps added 2026-10-04. A click through to a posting comes from the site; the rest only the
// Worker sees, and a browser must not be able to send them (a forged "paid" would be a fake sale).
const events = async (w) => (await w.db.dump()).event_counts.map(({ event, page, n }) => ({ event, page, n }))
  .sort((a, b) => (a.event + a.page).localeCompare(b.event + b.page));

test("a click through to a posting is a step the site sends; the Worker's own steps are not", async () => {
  const w = await setup();
  await hit(w, { e: "posting_click", p: "/internships/ohio/" });
  await hit(w, { e: "posting_click", p: "/" });
  for (const e of SERVER_EVENTS) {
    assert.ok(!EVENTS.has(e), e + " must not be accepted from /hit");
    await hit(w, { e, p: "/" });
  }
  assert.deepEqual(await events(w), [{ event: "posting_click", page: "dashboard", n: 1 }, { event: "posting_click", page: "landing", n: 1 }]);
});

// Added 2026-10-06: a weekly email sign-up form sent, from whichever page had the form. Only the event
// and the page kind are stored; the body carries no address, and anything extra in it is not kept.
test("a weekly email sign-up is a step the site sends, counted by the page the form was on", async () => {
  const w = await setup();
  assert.ok(EVENTS.has("digest_signup"));
  assert.ok(!SERVER_EVENTS.has("digest_signup"));
  await hit(w, { e: "digest_signup", p: "/" });
  await hit(w, { e: "digest_signup", p: "/internships/machine-learning-ai/" });
  await hit(w, { e: "digest_signup", p: "/internships/new/" });
  await hit(w, { e: "digest_signup", p: "/digest/", email: "someone@school.edu" });
  assert.deepEqual(await events(w), [
    { event: "digest_signup", page: "dashboard", n: 1 },
    { event: "digest_signup", page: "digest", n: 1 },
    { event: "digest_signup", page: "landing", n: 2 },
  ]);
  assert.ok(!JSON.stringify(await w.db.dump()).includes("someone@school.edu"), "nothing but the count is kept");
  assert.deepEqual(await rows(w), [], "a step is not a page load");
});

test("a load of the weekly email's page is counted under its own kind", async () => {
  const w = await setup();
  await hit(w, { p: "/digest/", r: "", u: "bluesky", m: "social" });
  assert.deepEqual(await rows(w), [{ day: (await rows(w))[0].day, page: "digest", source: "social", views: 1, visits: 1 }]);
});

test("countEvent adds to the same daily totals, only for the Worker's own steps, and never throws", async () => {
  const w = await setup();
  assert.equal(await countEvent(w.db, "2026-09-14T10:05:30Z", "paid", "supporter"), true);
  assert.equal(await countEvent(w.db, "2026-09-14", "paid", "supporter"), true);
  assert.equal(await countEvent(w.db, "2026-09-14", "first_autofill"), true);
  assert.equal(await countEvent(w.db, "2026-09-14", "install_click"), false, "a browser step is the site's to send");
  assert.equal(await countEvent(w.db, "2026-09-14", "made_up"), false);
  assert.deepEqual((await w.db.dump()).event_counts.map(({ day, event, page, n }) => ({ day, event, page, n }))
    .sort((a, b) => a.event.localeCompare(b.event)), [
    { day: "2026-09-14", event: "first_autofill", page: "worker", n: 1 },
    { day: "2026-09-14", event: "paid", page: "supporter", n: 2 },
  ]);
  const broken = { prepare: () => { throw new Error("D1 down"); } };
  assert.equal(await countEvent(broken, "2026-09-14", "paid"), false);
});

test("a day filled to the cap with browser steps still counts the Worker's own", async () => {
  const w = await setup();
  await hit(w, { e: "posting_click", p: "/" });
  const today = (await w.db.dump()).event_counts[0].day;
  await w.db.prepare("UPDATE event_counts SET n = ?").bind(DAY_CAP).run();
  await hit(w, { e: "install_click", p: "/" });
  assert.equal(await countEvent(w.db, today, "paid", "supporter"), true, "forged clicks must not hide a sale");
  assert.deepEqual((await events(w)).map((r) => r.event), ["paid", "posting_click"]);
});

test("a sign-in from the extension and a first-seen account are counted, with nothing about who", async () => {
  const w = await setup();
  const EXT = { Origin: "chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi" };
  assert.equal((await w.api("POST", "/session", { token: await w.token(), headers: EXT })).status, 200);
  assert.equal((await w.api("POST", "/session", { token: await w.token(), headers: SITE })).status, 200);
  // The account is new to the Worker on its first /me; later calls see it already.
  assert.equal((await w.api("GET", "/me", { token: await w.token(), headers: EXT })).status, 200);
  assert.equal((await w.api("GET", "/me", { token: await w.token(), headers: EXT })).status, 200);
  assert.equal((await w.api("GET", "/me", { token: await w.token({ sub: "other-student" }), headers: SITE })).status, 200);
  assert.deepEqual(await events(w), [
    { event: "ext_signin", page: "extension", n: 1 },
    { event: "new_account", page: "dashboard", n: 1 },
    { event: "new_account", page: "extension", n: 1 },
  ]);
});

test("a bad body is refused", async () => {
  const w = await setup();
  const res = await w.api("POST", "/hit", { headers: SITE });
  assert.equal(res.status, 400);
});
