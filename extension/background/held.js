// U2 (2026-10-14 UX audit): the postings a student wanted to Auto-Apply before setup was done.
//
// Two ways a posting gets here:
//   - The dashboard's Auto-Apply was pressed before setup (index.js enqueue answered "setup_required").
//     was: the jobs were dropped, and after setup the student had to find and tick the rows again.
//   - The site's offer bar or a landing page's "Auto-Apply this" link was pressed before the extension
//     was installed. docs/js/offer.js keeps that one posting in the site's localStorage
//     ("internscout.wanted"); on install, index.js reads it from the internscout.org tabs that are open
//     (install.js) and hands it here.
// Either way nothing starts by itself: the setup page lists them once setup is done, and only the
// student's "Auto-Apply" press there moves them into the queue (index.js "held:start").
//
// Everything here came from a web page, so every field is checked and cut to size, and a posting from the
// offer bar must be on one of the job sites the extension already covers (lib/hosts.js isAtsHost).
import { isAtsHost, hostOf } from "../lib/hosts.js";

export const HELD_KEY = "held_jobs";
export const WANTED_KEY = "internscout.wanted";   // the site's localStorage key (docs/js/offer.js)
export const HELD_MAX = 100;
export const HELD_TTL_MS = 14 * 864e5;            // forgotten after two weeks
export const WANTED_TTL_MS = 3 * 864e5;           // an offer-bar click counts for three days

const text = (v, n) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, n) : "");
const httpUrl = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > 2000) return "";
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.href : ""; } catch (e) { return ""; }
};

// One job from the dashboard's enqueue payload, or null. Same fields as background/queue.js addJobs.
export function cleanHeldJob(j) {
  if (!j || typeof j !== "object") return null;
  const apply_url = httpUrl(j.apply_url);
  if (!apply_url) return null;
  const id = typeof j.id === "string" || typeof j.id === "number" ? text(j.id, 60) : "";
  return { id: id || null, apply_url, company: text(j.company, 120), title: text(j.title, 160),
    location: text(j.location, 200), description: String(typeof j.description === "string" ? j.description : "").slice(0, 6000) };
}

// The offer bar's record ({url, company, title, at} as JSON text) as a job, or null. Only a posting on a
// supported job site, and only a recent one: anything else is ignored.
export function wantedJob(raw, now = Date.now()) {
  let w;
  try { w = typeof raw === "string" && raw.length < 5000 ? JSON.parse(raw) : null; } catch (e) { return null; }
  if (!w || typeof w !== "object") return null;
  const at = Number(w.at);
  if (!Number.isFinite(at) || at > now + 5 * 60e3 || now - at > WANTED_TTL_MS) return null;
  const apply_url = httpUrl(w.url);
  if (!apply_url || !apply_url.startsWith("https:") || !isAtsHost(apply_url)) return null;
  return cleanHeldJob({ apply_url, company: w.company, title: w.title });
}

async function read(now) {
  const list = (await chrome.storage.local.get(HELD_KEY))[HELD_KEY];
  return (Array.isArray(list) ? list : []).filter((j) => j && j.apply_url && now - (j.at || 0) < HELD_TTL_MS);
}

// Adds jobs (already cleaned or not), newest last, one per apply link, at most HELD_MAX. Returns the count held.
export async function holdJobs(list, from = "dashboard", now = Date.now()) {
  const held = await read(now);
  for (const raw of Array.isArray(list) ? list : []) {
    const j = cleanHeldJob(raw);
    if (!j) continue;
    const i = held.findIndex((x) => x.apply_url === j.apply_url);
    if (i >= 0) held.splice(i, 1);
    held.push({ ...j, from: from === "offer" ? "offer" : "dashboard", at: now });
  }
  const kept = held.slice(-HELD_MAX);
  await chrome.storage.local.set({ [HELD_KEY]: kept });
  return kept.length;
}

export async function heldJobs(now = Date.now()) { return read(now); }

// What the setup page shows: names only.
export const heldSummary = (list) => (list || []).map((j) => ({ company: j.company || "", title: j.title || "", host: hostOf(j.apply_url) }));

// Hands back the held jobs, for addJobs, and forgets them.
export async function takeHeld(now = Date.now()) {
  const list = await read(now);
  await chrome.storage.local.remove(HELD_KEY);
  return list.map(({ from, at, ...j }) => j);
}

export const clearHeld = () => chrome.storage.local.remove(HELD_KEY);

// One plain sentence for the setup page: "Acme, Software Intern" or "a posting on x.myworkdayjobs.com".
export function heldLine(list) {
  const name = (j) => (j.company && j.title ? `${j.company}, ${j.title}` : j.company || j.title || `a posting on ${j.host}`);
  const n = (list || []).length;
  if (!n) return "";
  if (n === 1) return `Before setup you picked a posting to Auto-Apply: ${name(list[0])}.`;
  const shown = list.slice(0, 2).map(name);
  return `Before setup you picked ${n} postings to Auto-Apply: ${shown.join("; ")}${n > 2 ? `; and ${n - 2} more` : ""}.`;
}
