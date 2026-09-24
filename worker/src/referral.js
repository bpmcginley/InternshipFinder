// Referral credits: a student's invite code, a classmate claiming it, and the extra units both get.
// Rules and amounts are REFERRAL in config.js; spending the extra units is limits.js admit(). Only
// hashed ids, a random code, dates and counts are stored (schema.sql).
import { HttpError } from "./http.js";

// No 0/o, 1/l/i: a code is sometimes read off a screen or a flyer and typed.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE = /^[a-hj-km-np-z2-9]{8}$/;

const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join("");

// The day the Worker first saw this account. Written on /me, /ai and a claim; a no-op after the first.
export async function noteAccount(db, user, now) {
  await db.prepare("INSERT OR IGNORE INTO accounts (user_hash, first) VALUES (?, ?)").bind(user, now.toISOString()).run();
}

// The student's invite code, made on first ask. INSERT OR IGNORE covers both a code that happens to be
// taken (try another) and a parallel request that already made this student's (read it back).
export async function codeFor(db, user, now) {
  for (let i = 0; i < 4; i++) {
    const row = await db.prepare("SELECT code FROM invite_codes WHERE user_hash = ?").bind(user).first();
    if (row) return row.code;
    await db.prepare("INSERT OR IGNORE INTO invite_codes (code, user_hash, created) VALUES (?, ?, ?)")
      .bind(newCode(), user, now.toISOString()).run();
  }
  throw new HttpError(500, "server", "Couldn't make an invite code. Try again.");
}

// Extra units left per task, e.g. { autofill: 3 }. Tasks with none left are left out.
export async function bonusFor(db, user) {
  const { results } = await db.prepare("SELECT task, granted - used AS left FROM bonus WHERE user_hash = ? AND used < granted")
    .bind(user).all();
  return Object.fromEntries(results.map((r) => [r.task, r.left]));
}

// GET /invite: the student's link and how many of their invites have earned them credit.
export async function inviteInfo(db, env, config, user, now) {
  const code = await codeFor(db, user, now);
  const row = await db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer = ? AND rewarded = 1").bind(user).first();
  const site = (env.SITE_URL || "https://internscout.org").replace(/\/+$/, "");
  return { code, link: `${site}/?ref=${code}`, rewarded: row ? row.n : 0, max: config.REFERRAL.maxRewards,
           bonus: config.REFERRAL.bonus, left: await bonusFor(db, user) };
}

// POST /invite/claim: a newly signed-in student names the code that brought them. Both get the bonus,
// the inviter only while under maxRewards. Refusals say why, so the dashboard can say it too.
export async function claim(db, config, user, tier, code, now) {
  const R = config.REFERRAL;
  if (typeof code !== "string" || !CODE.test(code)) throw new HttpError(400, "bad_invite", "That invite link isn't valid.");
  const owner = await db.prepare("SELECT user_hash FROM invite_codes WHERE code = ?").bind(code).first();
  if (!owner) throw new HttpError(404, "bad_invite", "That invite link isn't valid.");
  const referrer = owner.user_hash;
  if (referrer === user) throw new HttpError(400, "own_invite", "That's your own invite link. Send it to a classmate.");
  if (tier !== "edu") {
    throw new HttpError(403, "edu_only", "Invites count for school accounts. Sign in with Google using your .edu email to get the extra runs.");
  }
  await noteAccount(db, user, now);
  const acct = await db.prepare("SELECT first FROM accounts WHERE user_hash = ?").bind(user).first();
  if (acct && now.getTime() - Date.parse(acct.first) > R.windowDays * 86400e3) {
    throw new HttpError(409, "not_new", "Invites are for accounts in their first week.");
  }
  // Whether the inviter still earns credit is decided in the same statement that records the claim,
  // so two classmates claiming at once can't both be the inviter's tenth.
  const ins = await db.prepare(
    "INSERT OR IGNORE INTO referrals (invitee, referrer, rewarded, claimed) " +
    "SELECT ?, ?, (SELECT COUNT(*) FROM referrals WHERE referrer = ? AND rewarded = 1) < ?, ?",
  ).bind(user, referrer, referrer, R.maxRewards, now.toISOString()).run();
  if (ins.meta.changes === 0) throw new HttpError(409, "already_claimed", "This account already joined through an invite.");
  const row = await db.prepare("SELECT rewarded FROM referrals WHERE invitee = ?").bind(user).first();
  const inviterToo = !!(row && row.rewarded);
  const grant = (who) => Object.entries(R.bonus).map(([task, units]) => db.prepare(
    "INSERT INTO bonus (user_hash, task, granted, used) VALUES (?, ?, ?, 0) " +
    "ON CONFLICT(user_hash, task) DO UPDATE SET granted = granted + excluded.granted",
  ).bind(who, task, units));
  await db.batch([...grant(user), ...(inviterToo ? grant(referrer) : [])]);
  return { ok: true, bonus: R.bonus, inviter_rewarded: inviterToo };
}

// "Delete my data": the student's code, extra units and first-seen date go. Rows naming them as an
// inviter lose that name. Their own row as an invitee stays, without the inviter, so deleting and
// signing in again can't claim a second invite.
export function forgetStatements(db, user) {
  return [
    db.prepare("DELETE FROM invite_codes WHERE user_hash = ?").bind(user),
    db.prepare("DELETE FROM bonus WHERE user_hash = ?").bind(user),
    db.prepare("DELETE FROM accounts WHERE user_hash = ?").bind(user),
    db.prepare("UPDATE referrals SET referrer = '' WHERE referrer = ? OR invitee = ?").bind(user, user),
  ];
}
