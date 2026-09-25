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
  // The lifetime count in `inviters`, the same number claim() checks against maxRewards. Counting
  // `referrals` rows undercounted once "Delete my data" blanked `referrer` on some of them.
  // was: const row = await db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer = ? AND rewarded = 1").bind(user).first();
  const row = await db.prepare("SELECT rewarded FROM inviters WHERE user_hash = ?").bind(user).first();
  const site = (env.SITE_URL || "https://internscout.org").replace(/\/+$/, "");
  // was: return { code, link: `${site}/?ref=${code}`, rewarded: row ? row.n : 0, max: config.REFERRAL.maxRewards,
  return { code, link: `${site}/?ref=${code}`, rewarded: row ? row.rewarded : 0, max: config.REFERRAL.maxRewards,
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
  // auth.js tierOf() gives "edu" to a verified .edu email from Google and to a Microsoft school or
  // work account whose tenant owns the domain (xms_edov), so the refusal can't name one provider.
  if (tier !== "edu") {
    // was: throw new HttpError(403, "edu_only", "Invites count for school accounts. Sign in with Google using your .edu email to get the extra runs.");
    throw new HttpError(403, "edu_only", "Invites count for school accounts. Sign in with a school (.edu) email to get the extra runs.");
  }
  // For an account that existed before invites did, the row comes from schema.sql's backfill (its
  // earliest usage month, states or plan), not from this call; and "Delete my data" keeps it
  // (forgetStatements below), so deleting can't make an old account new again.
  await noteAccount(db, user, now);
  const acct = await db.prepare("SELECT first FROM accounts WHERE user_hash = ?").bind(user).first();
  if (acct && now.getTime() - Date.parse(acct.first) > R.windowDays * 86400e3) {
    throw new HttpError(409, "not_new", "Invites are for accounts in their first week.");
  }
  const taken = () => new HttpError(409, "already_claimed", "This account already joined through an invite.");
  const claimed = async () => !!(await db.prepare("SELECT 1 AS x FROM referrals WHERE invitee = ?").bind(user).first());
  if (await claimed()) throw taken();
  // The claim and every grant are one batch, and a D1 batch is one transaction: if any statement
  // fails, none of them happened. Before, the claim was its own statement and the grants a second
  // batch after it, so a failure between the two used up the account's one claim with nothing given.
  //
  // The claim is a plain INSERT, not INSERT OR IGNORE, so a parallel claim that got there first makes
  // it fail and takes the grants down with it. That is what lets the grants below trust that the
  // referral row they read is the one this batch just wrote.
  //
  // Whether the inviter still earns credit is decided inside the same transaction that counts the
  // credit, so two classmates claiming at once can't both be the inviter's tenth. The count is the
  // lifetime one in `inviters`, which "Delete my data" keeps: it used to be COUNT(*) over `referrals`
  // rows naming the inviter, and deleting blanks that name, so an inviter at the cap who deleted (or a
  // rewarded classmate who deleted) freed up slots to earn again.
  // was: const ins = await db.prepare(
  // was:   "INSERT OR IGNORE INTO referrals (invitee, referrer, rewarded, claimed) " +
  // was:   "SELECT ?, ?, (SELECT COUNT(*) FROM referrals WHERE referrer = ? AND rewarded = 1) < ?, ?",
  // was: ).bind(user, referrer, referrer, R.maxRewards, now.toISOString()).run();
  // was: if (ins.meta.changes === 0) throw new HttpError(409, "already_claimed", "This account already joined through an invite.");
  // was: const row = await db.prepare("SELECT rewarded FROM referrals WHERE invitee = ?").bind(user).first();
  // was: const inviterToo = !!(row && row.rewarded);
  // was: const grant = (who) => Object.entries(R.bonus).map(([task, units]) => db.prepare(
  // was:   "INSERT INTO bonus (user_hash, task, granted, used) VALUES (?, ?, ?, 0) " +
  // was:   "ON CONFLICT(user_hash, task) DO UPDATE SET granted = granted + excluded.granted",
  // was: ).bind(who, task, units));
  // was: await db.batch([...grant(user), ...(inviterToo ? grant(referrer) : [])]);
  const record = db.prepare(
    "INSERT INTO referrals (invitee, referrer, rewarded, claimed) " +
    "SELECT ?, ?, COALESCE((SELECT rewarded FROM inviters WHERE user_hash = ?), 0) < ?, ?",
  ).bind(user, referrer, referrer, R.maxRewards, now.toISOString());
  // The inviter's grants and the count only happen when the row just recorded says they were rewarded.
  // (`WHERE` before `ON CONFLICT` also keeps SQLite from reading the upsert as a join.)
  const rewarded = "(SELECT rewarded FROM referrals WHERE invitee = ?) = 1";
  const grant = (who, onlyIfRewarded) => Object.entries(R.bonus).map(([task, units]) => db.prepare(
    "INSERT INTO bonus (user_hash, task, granted, used) SELECT ?, ?, ?, 0 WHERE " + (onlyIfRewarded ? rewarded : "1") + " " +
    "ON CONFLICT(user_hash, task) DO UPDATE SET granted = granted + excluded.granted",
  ).bind(...(onlyIfRewarded ? [who, task, units, user] : [who, task, units])));
  const count = db.prepare(
    "INSERT INTO inviters (user_hash, rewarded) SELECT ?, 1 WHERE " + rewarded + " " +
    "ON CONFLICT(user_hash) DO UPDATE SET rewarded = rewarded + 1",
  ).bind(referrer, user);
  try {
    await db.batch([record, ...grant(user, false), ...grant(referrer, true), count]);
  } catch (e) {
    if (await claimed()) throw taken();       // lost the race to a parallel claim; nothing was granted
    throw e;
  }
  const row = await db.prepare("SELECT rewarded FROM referrals WHERE invitee = ?").bind(user).first();
  const inviterToo = !!(row && row.rewarded);
  return { ok: true, bonus: R.bonus, inviter_rewarded: inviterToo };
}

// "Delete my data": the student's code and extra units go. Rows naming them as an inviter lose that
// name. Three things stay, each a hashed id with a date or a number, because each is what stops
// deleting and signing in again from being a way to earn more: their own row as an invitee (without
// the inviter), so they can't claim a second invite; their first-seen date in `accounts`, so an old
// account can't come back as one in its first week; and their lifetime count of rewarded invites in
// `inviters`, so an inviter at maxRewards can't start again from zero. docs/privacy.html says so.
// was: // "Delete my data": the student's code, extra units and first-seen date go. Rows naming them as an
// was: // inviter lose that name. Their own row as an invitee stays, without the inviter, so deleting and
// was: // signing in again can't claim a second invite.
export function forgetStatements(db, user) {
  return [
    db.prepare("DELETE FROM invite_codes WHERE user_hash = ?").bind(user),
    db.prepare("DELETE FROM bonus WHERE user_hash = ?").bind(user),
    // was: db.prepare("DELETE FROM accounts WHERE user_hash = ?").bind(user),
    db.prepare("UPDATE referrals SET referrer = '' WHERE referrer = ? OR invitee = ?").bind(user, user),
  ];
}
