// "Save the Deep Dive to your account": one encrypted copy of the student's profile, so it follows them to
// another device. The extension leaves out files, saved logins, API keys and the six demographic answers
// before it sends anything; the Worker strips those six again (defence in depth). At rest the row is
// AES-GCM-256 under a key derived per account from the PROFILE_KEY secret, so a copy of the database alone
// reads as noise (schema.sql `profiles`, API.md "Profile").
import { HttpError } from "./http.js";

export const MAX_PROFILE_BYTES = 256 * 1024;
// Keys in profile.facts that never leave the device (the contract's list; the extension drops them too).
export const DEMOGRAPHICS = ["gender", "race", "hispanic", "veteran", "disability", "lgbtq"];
const SALT = "internscout-profile-v1";
const enc = new TextEncoder();

export const syncOn = (env) => !!env.PROFILE_KEY;

export function requireSync(env) {
  if (!syncOn(env)) throw new HttpError(503, "sync_off", "Saving profiles isn't turned on yet.");
}

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// key = HKDF-SHA256(ikm = base64-decoded PROFILE_KEY, salt = SALT, info = user_hash), one per account, so
// a row copied onto another account's hash does not decrypt.
async function keyFor(env, user) {
  let ikm;
  try {
    ikm = unb64(String(env.PROFILE_KEY).trim().replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    ikm = null;
  }
  if (!ikm || ikm.length !== 32) throw new HttpError(500, "server", "PROFILE_KEY must be 32 random bytes, base64");
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(SALT), info: enc.encode(user) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// base64(iv(12) || ciphertext), with a fresh IV every write.
export async function seal(env, user, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(env, user), enc.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

export async function unseal(env, user, data) {
  const raw = unb64(data);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12) }, await keyFor(env, user), raw.subarray(12));
  return new TextDecoder().decode(pt);
}

// The stored row decrypted: { profile, updated }, null when there is none, or { broken: true } when it no
// longer decrypts (PROFILE_KEY was replaced). A broken row counts as no copy, so the student's next save
// simply replaces it rather than every sync failing from then on.
async function readStored(db, env, user) {
  const row = await db.prepare("SELECT data, updated FROM profiles WHERE user_hash = ?").bind(user).first();
  if (!row) return null;
  try {
    return { profile: JSON.parse(await unseal(env, user, row.data)), updated: row.updated };
  } catch (e) {
    if (e instanceof HttpError) throw e;   // a malformed PROFILE_KEY is a server error, not "no copy"
    console.error("profile decrypt failed:", e && e.name);
    return { broken: true };
  }
}

// GET /profile
export async function getProfile(db, env, user) {
  const stored = await readStored(db, env, user);
  return stored && !stored.broken ? stored : { profile: null, updated: null };
}

// PUT /profile. `updated` is the client's own time for its latest edit. A stored copy with a later time
// wins: the client gets 409 stale with that copy, to merge in. Equal times overwrite, so a retry of the
// same save succeeds. The write itself is conditional on the same rule, so two devices saving at once
// can't both pass the check and leave the older copy on top.
export async function putProfile(db, env, user, body) {
  const profile = body.profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new HttpError(400, "bad_request", "profile must be an object");
  }
  const t = typeof body.updated === "string" ? Date.parse(body.updated) : NaN;
  if (!Number.isFinite(t)) throw new HttpError(400, "bad_request", "updated must be an ISO date");
  const updated = new Date(t).toISOString();
  if (profile.facts && typeof profile.facts === "object") {
    for (const k of DEMOGRAPHICS) delete profile.facts[k];
  }
  const text = JSON.stringify(profile);
  const stale = (stored) => {
    const ok = stored && !stored.broken;
    return new HttpError(409, "stale", "Your account has a newer copy of this profile.",
      { profile: ok ? stored.profile : null, updated: ok ? stored.updated : null });
  };

  const before = await readStored(db, env, user);
  if (before && !before.broken && before.updated > updated) throw stale(before);
  // Stored times are all toISOString(), so comparing them as text is comparing them as times.
  const cond = before && before.broken ? "" : "WHERE profiles.updated <= excluded.updated";
  const res = await db.prepare(
    "INSERT INTO profiles (user_hash, data, updated, bytes) VALUES (?, ?, ?, ?) " +
    `ON CONFLICT(user_hash) DO UPDATE SET data = excluded.data, updated = excluded.updated, bytes = excluded.bytes ${cond}`,
  ).bind(user, await seal(env, user, text), updated, enc.encode(text).length).run();
  if (res.meta.changes === 0) throw stale(await readStored(db, env, user));   // a parallel, later save won
  return { ok: true, updated };
}

// DELETE /profile, the "Save my Deep Dive to my account" switch turned off.
export async function deleteProfile(db, user) {
  await forgetProfile(db, user).run();
}

// "Delete my data" removes the copy too (limits.js deleteUser).
export const forgetProfile = (db, user) => db.prepare("DELETE FROM profiles WHERE user_hash = ?").bind(user);
