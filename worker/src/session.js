// "Stay signed in": a session is a random token the extension or dashboard keeps and sends instead of the
// provider's ID token, which lasts about an hour. Only sha256(token) is stored, with the hashed user id,
// the tier worked out at sign-in, the provider and three dates. Never the email or the token itself
// (schema.sql `sessions`, API.md "Sessions").
import { HttpError } from "./http.js";

export const SESSION_PREFIX = "iss_";
const TOKEN = /^iss_[A-Za-z0-9_-]{43}$/;          // "iss_" + base64url(32 bytes), no padding
const LIFETIME_MS = 365 * 86400e3;               // sliding: a year from the last day it was used
export const MAX_SESSIONS = 20;                  // per account; the 21st pushes out the least recently used

const expired = () => new HttpError(401, "auth", "Sign-in expired; sign in again");

export const isSessionToken = (token) => String(token || "").startsWith(SESSION_PREFIX);

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return SESSION_PREFIX + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const expiresFrom = (now) => new Date(now.getTime() + LIFETIME_MS).toISOString();

// POST /session, after the ID token has been verified. Returns the new token and its expiry. The new row
// and the trim to MAX_SESSIONS are one batch; the new row is left out of the trim, so a tie on
// `last_used` (several sign-ins in the same millisecond) can never push out the one just made.
// `also(id)` adds statements to the same batch (copySession's record of where the session came from).
export async function createSession(db, { user, tier, provider }, now, also = () => []) {
  const token = newToken();
  const id = await sha256Hex(token);
  const at = now.toISOString();
  const expires = expiresFrom(now);
  await db.batch([
    db.prepare("INSERT INTO sessions (id, user_hash, tier, provider, created, last_used, expires) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, user, tier, provider, at, at, expires),
    db.prepare(
      "DELETE FROM sessions WHERE user_hash = ? AND id != ? AND id NOT IN " +
      "(SELECT id FROM sessions WHERE user_hash = ? AND id != ? ORDER BY last_used DESC, created DESC LIMIT ?)",
    ).bind(user, id, user, id, MAX_SESSIONS - 1),
    ...also(id),
  ]);
  return { token, expires };
}

const copied = () => new HttpError(409, "copied", "This sign-in has already been passed on once. Sign in with Google or Microsoft instead.");

// POST /session/copy (2026-10-14): a new session for the same account, tier and provider as `token`, so
// the extension can take over the dashboard's sign-in without sharing it (signing out of one then leaves
// the other signed in). Only once per session, and never from a copy (session_copies): the trade for
// letting a session token make a session at all. The INSERT's keys enforce it too, so two calls at once
// can't both get one.
export async function copySession(db, token, deps = {}) {
  const { user, tier, provider } = await sessionUser(db, token, deps);
  const source = await sha256Hex(token);
  if (await db.prepare("SELECT 1 FROM session_copies WHERE source = ? OR copy = ?").bind(source, source).first()) throw copied();
  const now = new Date(deps.now ?? Date.now());
  try {
    const made = await createSession(db, { user, tier, provider }, now, (id) => [
      db.prepare("INSERT INTO session_copies (source, copy, user_hash, created) VALUES (?, ?, ?, ?)")
        .bind(source, id, user, now.toISOString()),
    ]);
    return { session: made.token, account: user.slice(0, 16), provider: provider || null, tier, expires: made.expires };
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) throw copied();
    throw e;
  }
}

// { user, tier } for a session token. A use moves `last_used` and `expires` forward at most once per UTC
// day, in the background (`later`), so a busy day costs one write rather than one per request.
export async function sessionUser(db, token, { now = Date.now(), later } = {}) {
  if (!db) throw new HttpError(500, "server", "Server is missing its database");
  if (!TOKEN.test(String(token))) throw expired();
  const id = await sha256Hex(token);
  // was: SELECT user_hash, tier, last_used, expires. provider is read too, for GET /session (sessionInfo).
  const row = await db.prepare("SELECT user_hash, tier, provider, last_used, expires FROM sessions WHERE id = ?").bind(id).first();
  if (!row || !(Date.parse(row.expires) > now)) throw expired();
  const at = new Date(now);
  const today = at.toISOString().slice(0, 10);
  let expires = row.expires;
  if (String(row.last_used).slice(0, 10) < today) {
    expires = expiresFrom(at);
    // The WHERE repeats the day check, so parallel requests on a new day still write once.
    const refresh = db.prepare("UPDATE sessions SET last_used = ?, expires = ? WHERE id = ? AND substr(last_used, 1, 10) < ?")
      .bind(at.toISOString(), expiresFrom(at), id, today).run();
    if (later) later(refresh);
    else await refresh;
  }
  // provider and expires are for sessionInfo; every other route reads only user and tier.
  return { user: row.user_hash, tier: row.tier, provider: row.provider || null, expires };
}

// GET /session (2026-10-14, U8): what a session token is, so the extension can check a token the
// dashboard offers it with the Worker before keeping it, instead of trusting what the page says about it.
// The same fields as POST /session's reply except the email, which the Worker never stores.
export async function sessionInfo(db, token, deps = {}) {
  const { user, tier, provider, expires } = await sessionUser(db, token, deps);
  return { account: user.slice(0, 16), provider, tier, expires };
}

// DELETE /session: signing out removes this one session. Anything else (an ID token, an unknown or
// already-removed session, no header) is already signed out, so it is not an error.
export async function endSession(db, token) {
  if (!TOKEN.test(String(token || ""))) return;
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
}

// "Delete my data" signs the account out everywhere (limits.js deleteUser).
export const forgetSessions = (db, user) => db.prepare("DELETE FROM sessions WHERE user_hash = ?").bind(user);
export const forgetCopies = (db, user) => db.prepare("DELETE FROM session_copies WHERE user_hash = ?").bind(user);

// Daily cron: sessions nobody has used for a year, and copy records neither of whose sessions is left.
export async function dropExpiredSessions(db, now) {
  await db.prepare("DELETE FROM sessions WHERE expires <= ?").bind(now.toISOString()).run();
  await db.prepare("DELETE FROM session_copies WHERE source NOT IN (SELECT id FROM sessions) AND copy NOT IN (SELECT id FROM sessions)").run();
}
