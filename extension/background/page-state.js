// A posting that has been filled or pulled almost never 404s. Breezy, Lever and Greenhouse all
// bounce the student to the company's list of other openings instead, and the run would then be
// looking at a page full of Apply buttons for jobs nobody chose — fill one of those and the
// student is handed a finished application for a job they never picked. VetsEZ's Full Stack
// Developer Intern did exactly this: its apply URL landed on the board root, fifteen other roles.
// Two things have to be true before saying so, because a real application also moves between
// pages: the posting's own id or slug is gone from the URL, and not one distinctive word of its
// title is anywhere on the page. A Workday or iCIMS step still names the job it belongs to.
const TITLE_NOISE_RE = /^(a|an|the|and|for|with|our|new|us|usa|united|states|intern|interns|internship|internships|co|op|coop|summer|fall|spring|winter|remote|hybrid|onsite|student|students|program|programs|programme|position|positions|role|roles|opportunity|opportunities|full|part|time|year|level|entry|grad|graduate|undergraduate|\d+)$/i;

// The distinctive part of an apply URL is its longest path segment: a posting id or slug. The words
// every careers site shares are not distinctive, and taking the longest without dropping them first
// picked "careers" out of /careers/131/ — so when Fullbay's Software Engineer Intern closed and
// BambooHR bounced the run to /careers, the board root still "contained" the key and the closed
// posting went unnoticed. A bare number is a posting id as much as a slug is.
const KEY_NOISE_RE = /^(jobs?|careers?|apply|application|openings?|positions?|posting|details?|view|list|board|search|index|en|us|en-us|p)$/i;
// The name of the page that draws the posting is not the posting either, whatever the server writes
// its templates in. Taleo's URL is /careersection/<company>/jobdetail.ftl?job=343181: the id is in the
// query string, which leaves "careersection" and "jobdetail.ftl" tied at thirteen characters for the
// longest segment. "careersection" happens to win that tie today, and it is in the login URL Taleo
// redirects to, so the posting reads as still there — but the tie is decided by the order the
// segments happen to appear in, and had it gone the other way every Taleo application would have
// been abandoned as a dead posting at the login wall.
const PAGE_FILE_RE = /\.(html?|aspx?|php|jsp|ftl|jsf|jss|cfm|do|action)$/i;
function postingKey(u) {
  try {
    return new URL(u).pathname.split("/").filter(Boolean)
      .filter((s) => !KEY_NOISE_RE.test(s) && !PAGE_FILE_RE.test(s))
      .sort((a, b) => b.length - a.length)[0] || "";
  } catch (e) { return ""; }
}

// Some postings do not redirect anywhere: the link simply 404s, and the site says so. AcreTrader's
// Data Intern on Rippling answers with "404 | Page Not Found", a footer and a site-search box — one
// field, so there is something to fill and nothing worth filling, which is how it slipped past both
// the redirect check and the empty-page check. Take the page at its word, but only when it is not
// also asking for an application: a form that mentions "not found" in an error is still a form.
const NOT_FOUND_RE = /\b(404|page not found|job not found|no longer (available|accepting|posted|open)|position (has been )?(filled|closed)|posting (is )?(closed|expired|removed|no longer))\b/i;
const APPLICATION_FIELD_RE = /e-?mail|r[eé]sum[eé]|\bcv\b|first name|last name|full name|phone/i;

export function pageGone(frames) {
  const top = frames.find((f) => f.frameId === 0) || frames[0];
  if (!top) return false;
  if (!NOT_FOUND_RE.test(top.title || "") && !(top.headings || []).some((h) => NOT_FOUND_RE.test(h))) return false;
  return !frames.some((f) => (f.elements || []).some((e) => e.kind === "file" || APPLICATION_FIELD_RE.test(e.label || "")));
}

export function postingGone(job, snap, frames) {
  const key = postingKey(job.apply_url);
  const here = (snap.top && snap.top.url) || "";
  if ((key.length < 6 && !/^\d{2,}$/.test(key)) || here.includes(key)) return false;
  const words = String(job.title || "").split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 4 && !TITLE_NOISE_RE.test(w));
  if (!words.length) return false;
  const hay = (here + " " + frames.map((f) => [f.title, (f.headings || []).join(" "),
    (f.buttons || []).map((b) => b.text).join(" "), f.text || ""].join(" ")).join(" ")).toLowerCase();
  return !words.some((w) => hay.includes(w.toLowerCase()));
}

// A dead link is not a rare accident: postings get pulled, a career centre link loses the tenant id
// it needs, a whole site answers from behind a cookie wall. Mathtech's Web Application Developer
// Intern on ADP draws a OneTrust banner and nothing else - no job, no form, no Apply - and the run
// would have spent a turn, and a slice of the student's allowance, asking a model what to make of
// it. Nothing to fill and no way forward is not a page worth thinking about.
const FORWARD_RE = /appl|start|begin|continue|next|proceed|submit|sign ?(in|up)|log ?in|register|create|upload|autofill|r[eé]sum[eé]|interested/i;

// A rough measure of how much page there is, used only to tell "still arriving" from "this is all
// there is". It does not matter what the number means, only whether it is still changing.
export function pageBulk(frames) {
  return frames.reduce((n, f) => n + (f.elements || []).length + (f.buttons || []).length + String(f.text || "").length, 0);
}

export function deadPage(frames) {
  return frames.length > 0
    && !frames.some((f) => (f.elements || []).length)
    && !frames.some((f) => (f.buttons || []).some((b) => FORWARD_RE.test(b.text || "")))
    && !frames.some((f) => f.busy || f.captcha || f.captchaFrame);
}
