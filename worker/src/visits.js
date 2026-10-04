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
// was: export const EVENTS = new Set(["install_click", "signin_start", "signin", "profile", "autoapply", "checkout", "invite_open"]);
export const EVENTS = new Set(["install_click", "signin_start", "signin", "profile", "autoapply", "checkout", "invite_open",
  "posting_click"]);
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
// add rows. Paths are never stored as sent.
export function pageKind(path) {
  const p = String(path || "/").split(/[?#]/)[0].replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  if (p === "/") return "dashboard";
  if (p === "/internships" || p.startsWith("/internships/")) return "landing";
  if (p === "/install") return "install";
  if (p === "/privacy" || p === "/terms") return "legal";
  return "other";
}

// Where the load came from: our own tagged links first (utm_source), then the referring host.
export function sourceOf(refHost, utmSource, utmMedium) {
  const u = String(utmSource || "").toLowerCase().trim(), med = String(utmMedium || "").toLowerCase().trim();
  if (u) {
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

// One more for an event on a day and page, under the same day's cap as everything else in the table.
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
export async function countEvent(db, day, event, page = "worker") {
  if (!SERVER_EVENTS.has(event)) return false;
  try {
    return await addEvent(db, String(day).slice(0, 10), event, String(page).slice(0, 32));
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
  return { counted: res.meta.changes > 0 };
}
