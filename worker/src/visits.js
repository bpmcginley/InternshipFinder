// Exact visit counts (added 2026-09-30). Cloudflare Web Analytics samples page loads, about one in
// ten, so the dashboard's small numbers came in steps of 10. Each page on the site (docs/js/count.js)
// sends one POST /hit per load, and this adds one to a daily total by page kind and by where the
// visit came from. Totals only: no cookie, no ID, no IP address, no full referrer is ever stored.
//
// A "visit" is what Cloudflare calls one: a page load that did not come from another page of the
// site. Loads from the site's own pages still count as `views`, so the two can be told apart.
import { HttpError } from "./http.js";

// The same lists growth/metrics.py sorts Cloudflare's referrers by, so the two sets of numbers agree.
const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|yandex\.[a-z.]+|baidu\.com|search\.brave\.com|chatgpt\.com|perplexity\.ai|kagi\.com)$/;
const SOCIAL = /(^|\.)(bsky\.app|t\.co|x\.com|twitter\.com|reddit\.com|instagram\.com|linkedin\.com|lnkd\.in|facebook\.com|discord\.com|discordapp\.com|mastodon\.social|threads\.net|youtube\.com|tiktok\.com|snapchat\.com)$/;
const OWN = /(^|\.)(internscout\.org|bpmcginley\.github\.io)$|^localhost$/;
// Coming back from signing in or from Stripe is the same visit carrying on, not a new one from "another
// site", so these count as internal (a view, not a visit).
const ROUND_TRIP = /^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|checkout\.stripe\.com|billing\.stripe\.com)$/;
// Steps toward using InternScout (added 2026-10-01), counted per day like visits: no person, just how
// many times each happened. Only these names are counted; anything else is ignored.
// "invite_open" (added 2026-10-02): a signed-in student opened their invite link panel, from the
// one-time nudge after a first Auto-Apply or profile, or from the Account menu (docs/js/app.js).
// "posting_click" (added 2026-10-04): a click through to a posting, from a landing page's a.go link or
// the dashboard's a.open-link (docs/js/count.js). The store click was the last step the site could see.
// was: export const EVENTS = new Set(["install_click", "signin_start", "signin", "profile", "autoapply", "checkout"]);
// "digest_signup" (added 2026-10-06): a weekly email sign-up form was sent (docs/js/count.js), on the
// dashboard, a landing page or /digest/. The address goes from the browser to Buttondown only; this is
// the day's count of sends by page kind, so it can't tell a confirmed subscriber from a typo.
// was: export const EVENTS = new Set(["install_click", "signin_start", "signin", "profile", "autoapply", "checkout", "invite_open"]);
// was: export const EVENTS = new Set([..., "invite_open", "posting_click"]);
export const EVENTS = new Set(["install_click", "signin_start", "signin", "profile", "autoapply", "checkout", "invite_open",
  "posting_click", "digest_signup"]);
// Steps only the Worker itself sees (added 2026-10-04), counted by countEvent() below into the same
// table. They are never taken from /hit, so a browser cannot send "paid" and make it so.
//   new_account     the Worker saw an account for the first time (an accounts row was made)
//   ext_signin      a sign-in from the extension (POST /session with the extension's Origin)
//   first_autofill  an account's first Auto-Apply run of the month that Gemini answered
//   cap_hit         a run refused because the month's allowance was used up; page is the task
//   paid            a live Stripe checkout that left a plan active; page is the plan
export const SERVER_EVENTS = new Set(["new_account", "ext_signin", "first_autofill", "cap_hit", "paid"]);
// utm_source values our own links use (growth/digest.py, growth/outreach.py) and the usual social names.
const UTM_SOCIAL = /^(linkedin|instagram|facebook|fb|ig|reddit|bluesky|bsky|mastodon|x|twitter|threads|tiktok|youtube|discord)$/;
// Which social site (added 2026-10-05; the `visit_channels` table). `source` folds every social site
// into "social", which is what the dashboard and growth/metrics.py add up, but the weekly scorecard
// needs YouTube, TikTok, X, Facebook, Reddit, Instagram, Bluesky and Mastodon apart. A utm_source from
// UTM_SOCIAL names the channel, its short forms spelled out so one site is one row (fb -> facebook,
// ig -> instagram, bsky -> bluesky, twitter -> x); otherwise the referring host's family. Only social:
// search, direct and email have no channel, and a host not listed here records nothing.
const UTM_ALIAS = { fb: "facebook", ig: "instagram", bsky: "bluesky", twitter: "x" };
const CHANNEL_HOSTS = [
  ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
  ["x", /(^|\.)(x\.com|twitter\.com|t\.co)$/],
  ["facebook", /(^|\.)(facebook\.com|fb\.com)$/],          // l.facebook.com, m.facebook.com included
  ["reddit", /(^|\.)reddit\.com$/],
  ["instagram", /(^|\.)instagram\.com$/],                  // l.instagram.com included
  ["bluesky", /(^|\.)bsky\.app$/],
  ["mastodon", /(^|\.)(mastodon\.[a-z.]+|mstdn\.[a-z.]+|fosstodon\.org|hachyderm\.io|mas\.to)$/],
  ["linkedin", /(^|\.)(linkedin\.com|lnkd\.in)$/],
  ["threads", /(^|\.)threads\.net$/],
  ["discord", /(^|\.)(discord\.com|discordapp\.com)$/],
];
// A printed flyer's QR code (added 2026-10-06): utm_source "flyer" or "flyer-<spot>" (growth/flyers.py
// gives each posting location its own spot), with utm_medium "print". Its source is "print" and its
// channel the tag as printed, so each location's scans add up on their own. The pattern bounds what a
// hand-typed URL can add, and countHit caps how many flyer rows one day can hold.
const FLYER = /^flyer(-[a-z0-9]{1,16})?$/;
const FLYER_ROWS_PER_DAY = 40;
// Crawlers that run scripts. Most bots never run JavaScript and so never reach this at all.
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|facebookexternalhit|embedly|curl|wget|python|node-fetch|axios/i;

export const DAY_CAP = 50_000;            // views counted per day; past it, a flood cannot run up the table
const PER_MINUTE = 30;                    // per address, per Worker instance, in memory only

// Kept in this instance's memory for the current minute and never written anywhere: enough to stop
// one script from sending thousands of hits, without storing who sent them.
let minute = "", seen = new Map();
function tooFast(ip, now) {
  const m = now.toISOString().slice(0, 16);
  if (m !== minute) { minute = m; seen = new Map(); }
  if (!ip) return false;
  const n = (seen.get(ip) || 0) + 1;
  seen.set(ip, n);
  return n > PER_MINUTE;
}

// "/internships/massachusetts/" -> "landing"; anything unknown is "other", so a made-up path cannot
// add rows. Paths are never stored as sent. "/digest/" (the weekly email's page, added 2026-10-06) is
// "digest" rather than "other", so its visits and its sign-ups can be read apart from /about/ and the rest.
export function pageKind(path) {
  const p = String(path || "/").split(/[?#]/)[0].replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  if (p === "/") return "dashboard";
  if (p === "/internships" || p.startsWith("/internships/")) return "landing";
  if (p === "/install") return "install";
  if (p === "/privacy" || p === "/terms") return "legal";
  if (p === "/digest") return "digest";
  return "other";
}

// Where the load came from: our own tagged links first (utm_source), then the referring host.
export function sourceOf(refHost, utmSource, utmMedium) {
  const u = String(utmSource || "").toLowerCase().trim(), med = String(utmMedium || "").toLowerCase().trim();
  if (u) {
    if (FLYER.test(u)) return "print";
    if (med === "email" || u === "digest" || u === "email") return "email";
    if (UTM_SOCIAL.test(u)) return "social";
    if (u === "chrome_web_store" || u === "extension") return "extension";
  }
  const host = String(refHost || "").toLowerCase().trim().replace(/^www\./, "");
  if (OWN.test(host) || ROUND_TRIP.test(host)) return u ? "other" : "internal";
  if (!host) return u ? "other" : "direct";
  if (SEARCH.test(host)) return "search";
  if (SOCIAL.test(host)) return "social";
  return "other";
}

// The social site a load came from, or "" when it did not come from one (added 2026-10-05). Our own
// tagged links first (utm_source), like sourceOf(), then the referring host's family.
export function channelOf(refHost, utmSource) {
  const u = String(utmSource || "").toLowerCase().trim();
  if (FLYER.test(u)) return u;
  if (UTM_SOCIAL.test(u)) return UTM_ALIAS[u] || u;
  const host = String(refHost || "").toLowerCase().trim().replace(/^www\./, "");
  if (!host) return "";
  for (const [channel, re] of CHANNEL_HOSTS) if (re.test(host)) return channel;
  return "";
}

// One more for a browser's step on a day and page, under the same day's cap as the visit counts.
async function addEvent(db, day, event, page) {
  const ev = await db.prepare(
    "INSERT INTO event_counts (day, event, page, n) SELECT ?, ?, ?, 1 " +
    "WHERE (SELECT COALESCE(SUM(n), 0) FROM event_counts WHERE day = ?) < ? " +
    "ON CONFLICT(day, event, page) DO UPDATE SET n = n + 1",
  ).bind(day, event, page, day, DAY_CAP).run();
  return ev.meta.changes > 0;
}

// A step the Worker saw for itself (SERVER_EVENTS), added to the same daily total as a browser's step.
// Nothing about the account goes in: the day, the event, a page or plan or task name, and one more.
// Never throws, so counting cannot fail the request or the webhook it rides on; false if not counted.
// Not under DAY_CAP: that cap is shared with /hit, so anyone could fill it with forged browser steps
// and the day's real sign-ins and sales would then go uncounted. These rows cannot multiply (the pages
// are a fixed few names) and each one needs a real account, run or Stripe event, so they need no cap.
// was: return await addEvent(db, String(day).slice(0, 10), event, String(page).slice(0, 32));
export async function countEvent(db, day, event, page = "worker") {
  if (!SERVER_EVENTS.has(event)) return false;
  try {
    const ev = await db.prepare(
      "INSERT INTO event_counts (day, event, page, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, event, page) DO UPDATE SET n = n + 1",
    ).bind(String(day).slice(0, 10), event, String(page).slice(0, 32)).run();
    return ev.meta.changes > 0;
  } catch (e) {
    console.error("countEvent failed:", e && e.name);
    return false;
  }
}

export async function countHit(db, request, body, now) {
  const ua = request.headers.get("User-Agent") || "";
  // Only the live site sends hits (a browser always sets Origin on this cross-site POST); a local copy
  // of the site is left out so testing never shows up as visits.
  const origin = request.headers.get("Origin") || "";
  if (!/^https:\/\/(internscout\.org|bpmcginley\.github\.io)$/.test(origin)) {
    throw new HttpError(403, "forbidden", "Hits come from the InternScout site only");
  }
  if (!ua || BOT_UA.test(ua) || tooFast(request.headers.get("CF-Connecting-IP"), now)) return { counted: false };
  const page = pageKind(body.p);
  const day = now.toISOString().slice(0, 10);
  // A step rather than a page load: one more for that event, the day and the page it happened on.
  if (body.e !== undefined) {
    // Browser steps only: SERVER_EVENTS are not in EVENTS, so they stop here.
    if (!EVENTS.has(body.e)) return { counted: false };
    // was: the INSERT inline here; it moved to addEvent() so countEvent() writes the same row.
    return { counted: await addEvent(db, day, body.e, page) };
  }
  const source = sourceOf(body.r, body.u, body.m);
  const visit = source === "internal" ? 0 : 1;
  // One statement that checks the day's cap and counts, so concurrent hits cannot pass it together.
  const res = await db.prepare(
    "INSERT INTO visit_counts (day, page, source, views, visits) SELECT ?, ?, ?, 1, ? " +
    "WHERE (SELECT COALESCE(SUM(views), 0) FROM visit_counts WHERE day = ?) < ? " +
    "ON CONFLICT(day, page, source) DO UPDATE SET views = views + 1, visits = visits + excluded.visits",
  ).bind(day, page, source, visit, day, DAY_CAP).run();
  const counted = res.meta.changes > 0;
  // A social load once more by site (2026-10-05), only when the statement above counted it: a load the
  // cap, the bot check or the per-minute limit left out is left out here too. Only `source` "social"
  // (a tagged email link opened from Facebook is email, not a Facebook visit), so a day's channel rows
  // never add up to more than its `social` row in visit_counts.
  // was: return { counted: res.meta.changes > 0 };
  // Printed flyers too (2026-10-06): a scan's source is "print" and its channel the flyer's own tag.
  // was: counted && source === "social" ? channelOf(body.r, body.u) : ""
  const channel = counted && (source === "social" || source === "print") ? channelOf(body.r, body.u) : "";
  if (channel) {
    // A new flyer tag starts a row only while the day has fewer than FLYER_ROWS_PER_DAY of them, so
    // made-up flyer-xxxx tags cannot fill the table; a tag already counted today always counts again.
    // was: VALUES (?, ?, 1, ?) with no condition (the social channels are a fixed handful of names)
    await db.prepare(
      "INSERT INTO visit_channels (day, channel, views, visits) SELECT ?, ?, 1, ? " +
      "WHERE ?2 NOT LIKE 'flyer%' " +
      "OR EXISTS (SELECT 1 FROM visit_channels WHERE day = ?1 AND channel = ?2) " +
      "OR (SELECT COUNT(*) FROM visit_channels WHERE day = ?1 AND channel LIKE 'flyer%') < ?4 " +
      "ON CONFLICT(day, channel) DO UPDATE SET views = views + 1, visits = visits + excluded.visits",
    ).bind(day, channel, visit, FLYER_ROWS_PER_DAY).run();
  }
  return { counted };
}
