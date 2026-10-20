// Employer interest (added 2026-10-13): the form on internscout.org/employers/ asks whether a company
// would want a clearly labelled paid listing, before any such thing is built, and takes free requests
// to add a job board or correct a company's details. This stores what was sent so Bruce can read it and
// write back. Nothing is sold here and no price is taken.
//
// Kept: what the person typed (name, work email, company and the optional fields), when, and nothing
// else. No IP address goes in the row. To stop a script from filling the table, sends are counted per
// network address in the `rate` table under a salted hash of the address (never the address itself),
// in a day bucket that the daily cron already deletes after two days (limits.js cleanup()). Rows older
// than LEAD_DAYS are deleted by the same cron (dropOldLeads), which is what docs/privacy.html#employers
// promises. Read them with:
//   npx wrangler d1 execute internscout --remote --command "SELECT * FROM employer_leads ORDER BY created DESC"
import { HttpError } from "./http.js";
import { bumpUnder } from "./limits.js";
import { countEvent } from "./visits.js";

export const MAX_LEAD_BYTES = 8_000;
// Per field, in characters after trimming. The form's maxlength attributes say the same.
export const LIMITS = { name: 100, email: 254, company: 120, title: 100, hiring_for: 300, message: 2000 };
// The checkboxes on the form. Anything else is dropped rather than refused, so a stale page still sends.
// The form's boxes since 2026-10-14: placement (a paid listing for one open role; it shows wherever the
// role already matches a student's search, so there is nothing to target), board and details (free: add a job board, correct a company's details) and
// other. featured, promoted and majors_schools were the first form's boxes. They are no longer offered,
// because promoted roles and reaching chosen majors or schools are things a placement never does, but
// they are still accepted so a page cached from before the change still sends, and stored rows read the same.
export const WANTS_NOW = ["placement", "board", "details", "other"];
export const WANTS_OLD = ["featured", "promoted", "majors_schools"];
export const WANTS = [...WANTS_OLD, ...WANTS_NOW];
export const PER_ADDRESS_PER_DAY = 5;
// Across everyone. Real interest will be a handful a week; this only bounds a flood from many addresses.
export const ALL_PER_DAY = 100;
export const LEAD_DAYS = 365;
const ALL = "lead:*";             // the day's total, like limits.js GLOBAL_USER: no sha256 hex looks like it
// Only the site's own pages send this (a browser always sets Origin on a cross-site POST). A local copy
// of the site gets a 403, so testing a page never writes a lead into the live table.
const SITE = /^https:\/\/(internscout\.org|bpmcginley\.github\.io)$/;
// Plausible, not proof: one @, no spaces or angle brackets, a dot in the domain and a 2+ letter ending.
// Exported (2026-10-19) so the paid listing orders (orders.js) check a work address the same way.
// was: const EMAIL = /^...
export const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
// Control characters other than the newline and tab a message may hold.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const bad = (field, message) => new HttpError(400, "bad_request", message, { field });

// One text field: a string (or absent), trimmed, control characters gone, and inside its limit.
// A one-line field also has its runs of whitespace (and any newline) folded to one space.
function text(body, field, { required = false, multiline = false } = {}) {
  const v = body[field];
  if (v != null && typeof v !== "string") throw bad(field, `${field} must be text`);
  let s = (v || "").replace(CONTROL, "");
  s = multiline ? s.replace(/\r\n?/g, "\n").trim() : s.replace(/\s+/g, " ").trim();
  if (required && !s) throw bad(field, `${field} is required`);
  if (s.length > LIMITS[field]) throw bad(field, `${field} is too long (at most ${LIMITS[field]} characters)`);
  return s;
}

// The cleaned lead, or a 400 that names the first field at fault.
export function cleanLead(body) {
  const lead = {
    name: text(body, "name", { required: true }),
    email: text(body, "email", { required: true }),
    company: text(body, "company", { required: true }),
    title: text(body, "title"),
    hiring_for: text(body, "hiring_for"),
    message: text(body, "message", { multiline: true }),
  };
  if (!EMAIL.test(lead.email)) throw bad("email", "That email address doesn't look right");
  const w = body.wants;
  if (w != null && !Array.isArray(w)) throw bad("wants", "wants must be a list");
  lead.wants = WANTS.filter((k) => (w || []).includes(k)).join(",");
  return lead;
}

// The honeypot: a "website" box the page hides from people (off-screen, aria-hidden, not tabbable).
// A bot that fills every field fills it too; it gets the same answer a person does and nothing is kept.
export const isBot = (body) => typeof body.website === "string" ? body.website.trim() !== "" : body.website != null;

async function addressKey(request, env) {
  if (!env.HASH_SALT) throw new HttpError(500, "server", "Server is missing HASH_SALT");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lead|${ip}|${env.HASH_SALT}`));
  return "lead:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// POST /employer-interest. `later` carries the event count past the response, like index.js does.
export async function takeLead(db, request, env, body, now, later = (p) => p) {
  if (!SITE.test(request.headers.get("Origin") || "")) {
    throw new HttpError(403, "forbidden", "This form is sent from internscout.org only");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad(null, "Body must be a JSON object");
  if (isBot(body)) return { ok: true };
  const lead = cleanLead(body);
  const day = "d:" + now.toISOString().slice(0, 10);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const retry = { retry_after: Math.ceil((midnight - now.getTime()) / 1000) };
  if (!(await bumpUnder(db, await addressKey(request, env), day, PER_ADDRESS_PER_DAY))) {
    throw new HttpError(429, "rate", "That's a lot of sends from one place today. Please try again tomorrow, or email us.", retry);
  }
  if (!(await bumpUnder(db, ALL, day, ALL_PER_DAY))) {
    throw new HttpError(429, "rate", "The form is taking no more today. Please try again tomorrow, or email us.", retry);
  }
  await db.prepare(
    "INSERT INTO employer_leads (created, name, email, company, title, hiring_for, wants, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(now.toISOString(), lead.name, lead.email, lead.company, lead.title, lead.hiring_for, lead.wants, lead.message).run();
  // A count by day in event_counts, so the analytics see the form working without reading the leads.
  later(countEvent(db, now.toISOString(), "employer_interest", "employers"));
  return { ok: true };
}

// Daily cron: leads older than LEAD_DAYS go (docs/privacy.html#employers says a year).
export async function dropOldLeads(db, now) {
  const cutoff = new Date(now.getTime() - LEAD_DAYS * 86400e3).toISOString();
  await db.prepare("DELETE FROM employer_leads WHERE created < ?").bind(cutoff).run();
}
