// Referral credits: invite codes, who may claim one, and how the extra units are spent and given back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOW, aiBody, setup } from "./helpers.js";
import { CONFIG } from "../src/config.js";

const me = async (w, token) => (await w.api("GET", "/me", { token })).json();
const invite = async (w, token) => (await w.api("GET", "/invite", { token })).json();
const claim = (w, token, code) => w.api("POST", "/invite/claim", { token, body: { code } });
// Two Auto-Apply runs a month for a .edu account, so the tests reach the end of the allowance quickly.
const SMALL = { TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, allowance: 2 } } };
const classmate = (w, n = 2, email = `friend${n}@umass.edu`) => w.token({ sub: `sub-${n}`, email });

test("a student's invite link is stable, and /config says what an invite is worth", async () => {
  const w = await setup();
  const token = await w.token();
  const a = await invite(w, token);
  assert.match(a.code, /^[a-hj-km-np-z2-9]{8}$/);
  assert.equal(a.link, `https://internscout.org/?ref=${a.code}`);
  assert.deepEqual([a.rewarded, a.max, a.bonus, a.left], [0, 10, { autofill: 3 }, {}]);
  assert.equal((await invite(w, token)).code, a.code);
  const cfg = await (await w.api("GET", "/config")).json();
  assert.deepEqual(cfg.invite, { bonus: { autofill: 3 }, max: 10 });
});

test("a new .edu classmate who claims an invite gets 3 extra Auto-Apply runs, and so does the inviter", async () => {
  const w = await setup();
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  const friend = await classmate(w);
  const res = await claim(w, friend, code);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, bonus: { autofill: 3 }, inviter_rewarded: true });
  for (const t of [inviter, friend]) {
    const a = (await me(w, t)).allowance.autofill;
    assert.deepEqual([a.used, a.limit, a.bonus], [0, 23, 3]);     // 20 for .edu, plus 3
  }
  assert.equal((await invite(w, inviter)).rewarded, 1);
  // once per account, never your own, and only a real code
  assert.equal((await (await claim(w, friend, code)).json()).error, "already_claimed");
  assert.equal((await (await claim(w, inviter, code)).json()).error, "own_invite");
  assert.equal((await claim(w, await classmate(w, 3), "notacode")).status, 400);
  assert.equal((await claim(w, await classmate(w, 3), "abcdefgh")).status, 404);
});

test("only a school account in its first week can claim", async () => {
  const w = await setup();
  const { code } = await invite(w, await w.token());
  const gmail = await w.token({ sub: "sub-g", email: "someone@gmail.com" });
  const res = await claim(w, gmail, code);
  assert.equal(res.status, 403);
  // was: assert.equal((await res.json()).error, "edu_only");
  // Provider-neutral: a Microsoft school account (xms_edov) is edu too, so the message can't say Google.
  const body = await res.json();
  assert.equal(body.error, "edu_only");
  assert.doesNotMatch(body.message, /Google|Microsoft/);
  assert.match(body.message, /school \(\.edu\) email/);

  const late = await classmate(w, 4);
  await me(w, late);                                          // first seen now
  w.setNow(new Date(NOW.getTime() + 8 * 86400e3));
  const old = await claim(w, await classmate(w, 4), code);
  assert.equal(old.status, 409);
  assert.equal((await old.json()).error, "not_new");
  assert.equal(w.db.dump().referrals.length, 0);
});

test("extra units are spent only after the month's allowance, and a failed call gives its unit back", async () => {
  let fail = false;
  const w = await setup({ config: SMALL, gemini: (url) => (fail ? new Response("down", { status: 500 }) : Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  })) });
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  const friend = await classmate(w);
  await claim(w, friend, code);
  const run = (id) => w.api("POST", "/ai", { token: friend, body: aiBody("autofill", id) });

  const left = [];
  for (const id of ["r1", "r2", "r3"]) left.push((await run(id)).headers.get("X-InternScout-Remaining"));
  assert.deepEqual(left, ["4", "3", "2"]);                     // 2 of the month's, then the extra 3
  const units = () => w.db.dump().bonus.map((b) => [b.granted, b.used]).sort();
  assert.deepEqual(units(), [[3, 0], [3, 1]]);                 // the inviter's untouched, one of the friend's spent

  fail = true;
  assert.notEqual((await run("r4")).status, 200);
  assert.deepEqual(units(), [[3, 0], [3, 1]]);                 // the failed run's unit came back
  fail = false;

  for (const id of ["r4", "r5"]) assert.equal((await run(id)).status, 200);
  const capped = await run("r6");
  assert.equal(capped.status, 429);
  assert.equal((await capped.json()).error, "cap");
  const a = (await me(w, friend)).allowance.autofill;
  assert.deepEqual([a.used, a.limit, a.bonus], [5, 5, undefined]);    // none left: no `bonus`, and limit - used = 0
});

test("a task switched off (allowance 0) stays off even with extra units", async () => {
  const off = { TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, allowance: 0 } } };
  const w = await setup({ config: off });
  const { code } = await invite(w, await w.token());
  const friend = await classmate(w);
  await claim(w, friend, code);
  assert.equal((await w.api("POST", "/ai", { token: friend, body: aiBody("autofill", "x") })).status, 429);
});

test("an inviter stops earning after maxRewards, but the classmate still gets theirs", async () => {
  const w = await setup({ config: { REFERRAL: { ...CONFIG.REFERRAL, maxRewards: 1 } } });
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  assert.equal((await (await claim(w, await classmate(w, 2), code)).json()).inviter_rewarded, true);
  const second = await claim(w, await classmate(w, 3), code);
  assert.deepEqual(await second.json(), { ok: true, bonus: { autofill: 3 }, inviter_rewarded: false });
  assert.equal((await me(w, inviter)).allowance.autofill.bonus, 3);
  assert.equal((await me(w, await classmate(w, 3))).allowance.autofill.bonus, 3);
});

test("delete my data removes the code, the extra units and the link to an inviter, and can't reset a claim", async () => {
  const w = await setup();
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  const friend = await classmate(w);
  await claim(w, friend, code);
  assert.equal((await w.api("DELETE", "/me", { token: friend })).status, 200);
  assert.equal((await w.api("DELETE", "/me", { token: inviter })).status, 200);
  const d = w.db.dump();
  // The friend's first-seen date and the inviter's lifetime count stay (hashed id + date / number):
  // they are what stop a deletion from reopening the first week or the 10-invite cap (tests below).
  // was: assert.deepEqual([d.invite_codes.length, d.bonus.length, d.accounts.length], [0, 0, 0]);
  assert.deepEqual([d.invite_codes.length, d.bonus.length, d.accounts.length, d.inviters.length], [0, 0, 1, 1]);
  assert.deepEqual(Object.keys(d.accounts[0]).sort(), ["first", "user_hash"]);
  assert.deepEqual(d.inviters.map((r) => r.rewarded), [1]);
  assert.deepEqual(d.referrals.map((r) => r.referrer), [""]);
  // Signing in again, the friend's account can't claim a second invite.
  const other = await w.token({ sub: "sub-9", email: "other@umass.edu" });
  const { code: code2 } = await invite(w, other);
  assert.equal((await (await claim(w, await classmate(w), code2)).json()).error, "already_claimed");
});

// The review of 2026-09-25 (fixed in referral.js and schema.sql): "Delete my data" used to reopen the
// 10-invite cap and the first week, the claim and its grants weren't one transaction, and accounts
// from before invites existed all counted as new.
const CAP1 = { REFERRAL: { ...CONFIG.REFERRAL, maxRewards: 1 } };
const hashOf = (w) => w.db.dump().accounts.at(-1).user_hash;
// Runs schema.sql again over the live fake, the way `npm run deploy` runs it before every deploy.
const redeploy = (w) => w.db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

test("an inviter at the cap who deletes their data and signs in again doesn't start again from zero", async () => {
  const w = await setup({ config: CAP1 });
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  assert.equal((await (await claim(w, await classmate(w, 2), code)).json()).inviter_rewarded, true);
  assert.equal((await w.api("DELETE", "/me", { token: inviter })).status, 200);
  const again = await invite(w, inviter);                       // a new code, the same hashed id
  assert.notEqual(again.code, code);
  assert.equal(again.rewarded, 1);                              // was 0: the blanked rows no longer counted
  const res = await (await claim(w, await classmate(w, 3), again.code)).json();
  assert.deepEqual(res, { ok: true, bonus: { autofill: 3 }, inviter_rewarded: false });
  assert.equal((await me(w, inviter)).allowance.autofill.bonus, undefined);    // deleted, and not re-earned
});

test("a rewarded classmate deleting their data doesn't free a slot under the inviter's cap", async () => {
  const w = await setup({ config: CAP1 });
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  const friend = await classmate(w, 2);
  await claim(w, friend, code);
  assert.equal((await w.api("DELETE", "/me", { token: friend })).status, 200);
  assert.deepEqual(w.db.dump().referrals.map((r) => [r.referrer, r.rewarded]), [["", 1]]);
  assert.equal((await invite(w, inviter)).rewarded, 1);
  assert.equal((await (await claim(w, await classmate(w, 3), code)).json()).inviter_rewarded, false);
  assert.equal((await me(w, inviter)).allowance.autofill.bonus, 3);    // the first invite's, only
});

test("deleting data keeps the first-seen date, so an old account can't come back as new", async () => {
  const w = await setup();
  const { code } = await invite(w, await w.token());
  const late = await classmate(w, 4);
  await me(w, late);                                            // first seen now
  assert.equal((await w.api("DELETE", "/me", { token: late })).status, 200);
  w.setNow(new Date(NOW.getTime() + 8 * 86400e3));
  const again = await classmate(w, 4);
  await me(w, again);                                           // signs in again a week later
  const res = await claim(w, again, code);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_new");
  assert.equal(w.db.dump().accounts[0].first, NOW.toISOString());
});

test("the schema backfill dates accounts from before invites, and never moves a date later", async () => {
  const w = await setup();
  const put = (q) => w.db.prepare(q).run();
  // No row yet: dated from the earliest trace (a usage month counts from its 1st).
  await put("INSERT INTO usage (user_hash, month, task, units) VALUES ('old', '2026-06', 'autofill', 1), ('old', '2026-08', 'autofill', 2)");
  await put("INSERT INTO demand (user_hash, states, updated, seen) VALUES ('old', '[]', '2026-09-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z')");
  await put("INSERT INTO demand (user_hash, states, updated, seen) VALUES ('states', '[]', '2026-09-10T08:00:00.000Z', '2026-09-10T08:00:00.000Z')");
  // A row that invites' launch gave a too-late date: an earlier usage month proves it older.
  await put("INSERT INTO accounts (user_hash, first) VALUES ('back', '2026-09-24T12:00:00.000Z')");
  await put("INSERT INTO usage (user_hash, month, task, units) VALUES ('back', '2026-08', 'autofill', 1)");
  // A genuinely new account: usage in its own first month proves nothing, so its date stays.
  await put("INSERT INTO accounts (user_hash, first) VALUES ('new', '2026-09-24T12:00:00.000Z')");
  await put("INSERT INTO usage (user_hash, month, task, units) VALUES ('new', '2026-09', 'autofill', 1)");
  // Already earlier than anything in the other tables: left alone.
  await put("INSERT INTO accounts (user_hash, first) VALUES ('early', '2026-05-02T00:00:00.000Z')");
  await put("INSERT INTO usage (user_hash, month, task, units) VALUES ('early', '2026-07', 'autofill', 1)");
  const want = {
    back: "2026-08-01T00:00:00.000Z", early: "2026-05-02T00:00:00.000Z", new: "2026-09-24T12:00:00.000Z",
    old: "2026-06-01T00:00:00.000Z", states: "2026-09-10T08:00:00.000Z",
  };
  const firsts = () => Object.fromEntries(w.db.dump().accounts.map((r) => [r.user_hash, r.first]).sort());
  await redeploy(w);
  assert.deepEqual(firsts(), want);
  await redeploy(w);                                            // every deploy runs it again: no change
  assert.deepEqual(firsts(), want);
});

test("an existing .edu student the backfill dates to before invites can't claim as new", async () => {
  const w = await setup();
  const { code } = await invite(w, await w.token());
  const vet = await classmate(w, 5);
  await me(w, vet);                                             // after launch: first seen "now"
  const user = hashOf(w);
  // Their August usage from before invites existed.
  await w.db.prepare("INSERT INTO usage (user_hash, month, task, units) VALUES (?, '2026-08', 'autofill', 4)").bind(user).run();
  await redeploy(w);
  assert.equal(w.db.dump().accounts[0].first, "2026-08-01T00:00:00.000Z");
  const res = await claim(w, vet, code);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_new");
});

test("the schema backfill seeds each inviter's lifetime count from the rows that still name them", async () => {
  const w = await setup();
  const put = (q) => w.db.prepare(q).run();
  await put("INSERT INTO referrals (invitee, referrer, rewarded, claimed) VALUES " +
    "('a', 'r1', 1, 'x'), ('b', 'r1', 1, 'x'), ('c', 'r1', 0, 'x'), ('d', '', 1, 'x'), ('e', 'r2', 1, 'x'), ('f', 'r3', 1, 'x')");
  await put("INSERT INTO inviters (user_hash, rewarded) VALUES ('r2', 5)");     // already counted higher
  const counts = () => Object.fromEntries(w.db.dump().inviters.map((r) => [r.user_hash, r.rewarded]));
  await redeploy(w);
  assert.deepEqual(counts(), { r1: 2, r2: 5, r3: 1 });
  await redeploy(w);
  assert.deepEqual(counts(), { r1: 2, r2: 5, r3: 1 });
});

test("a claim whose grants fail leaves nothing behind, so the classmate can try again", async () => {
  const w = await setup();
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  const friend = await classmate(w);
  // D1 fails a statement inside the batch that records the claim and grants the runs.
  const real = w.db.prepare;
  let fail = true;
  w.db.prepare = (q) => {
    const s = real(q);
    if (!q.startsWith("INSERT INTO bonus")) return s;
    return { ...s, bind: (...p) => ({ ...s.bind(...p), run: async () => {
      if (fail) throw new Error("D1_ERROR: network connection lost");
      return s.bind(...p).run();
    } }) };
  };
  const res = await claim(w, friend, code);
  assert.equal(res.status, 500);
  const d = w.db.dump();
  assert.deepEqual([d.referrals.length, d.bonus.length, d.inviters.length], [0, 0, 0]);   // was: the referral row stayed
  fail = false;
  const retry = await claim(w, friend, code);
  assert.equal(retry.status, 200);                              // was: 409 already_claimed, with no runs
  assert.deepEqual(await retry.json(), { ok: true, bonus: { autofill: 3 }, inviter_rewarded: true });
  for (const t of [inviter, friend]) assert.equal((await me(w, t)).allowance.autofill.bonus, 3);
});

test("a claim that loses a race to a parallel one is refused as already claimed, with nothing granted twice", async () => {
  const w = await setup();
  const inviter = await w.token();
  const { code } = await invite(w, inviter);
  const friend = await classmate(w);
  await me(w, friend);
  const user = hashOf(w);
  // The parallel claim lands between this one's already-claimed check and its batch.
  const real = w.db.prepare;
  let raced = false;
  w.db.prepare = (q) => {
    if (!raced && q.startsWith("INSERT INTO referrals")) {
      raced = true;
      real("INSERT INTO referrals (invitee, referrer, rewarded, claimed) VALUES (?, 'someone', 0, 'x')").bind(user).run();
    }
    return real(q);
  };
  const res = await claim(w, friend, code);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "already_claimed");
  const d = w.db.dump();
  assert.deepEqual([d.bonus.length, d.inviters.length], [0, 0]);
});
