// Referral credits: invite codes, who may claim one, and how the extra units are spent and given back.
import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal((await res.json()).error, "edu_only");

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
  assert.deepEqual([d.invite_codes.length, d.bonus.length, d.accounts.length], [0, 0, 0]);
  assert.deepEqual(d.referrals.map((r) => r.referrer), [""]);
  // Signing in again, the friend's account can't claim a second invite.
  const other = await w.token({ sub: "sub-9", email: "other@umass.edu" });
  const { code: code2 } = await invite(w, other);
  assert.equal((await (await claim(w, await classmate(w), code2)).json()).error, "already_claimed");
});
