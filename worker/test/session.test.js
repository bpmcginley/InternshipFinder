// "Stay signed in": POST/DELETE /session, session bearers on every route, the sliding year, the 20 cap.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NOW, setup } from "./helpers.js";
import { userHash } from "../src/auth.js";
import { MAX_SESSIONS, dropExpiredSessions } from "../src/session.js";

const DAY = 86400e3;
const at = (ms) => new Date(NOW.getTime() + ms);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const start = async (w, token) => {
  const res = await w.api("POST", "/session", { token: token || (await w.token()) });
  assert.equal(res.status, 200);
  return res.json();
};
const me = (w, token) => w.api("GET", "/me", { token });
const rows = (w) => w.db.dump().sessions;

test("POST /session trades an ID token for an opaque session; only its sha256 is stored, never the email", async () => {
  const w = await setup();
  const id = await w.token();
  const s = await start(w, id);
  assert.match(s.session, /^iss_[A-Za-z0-9_-]{43}$/);
  const user = await userHash("google", { sub: "109876543210" }, { HASH_SALT: "test-salt" });
  assert.deepEqual({ ...s, session: undefined }, {
    session: undefined, account: user.slice(0, 16), email: "student@umass.edu", provider: "google", tier: "edu",
    expires: at(365 * DAY).toISOString(),
  });
  assert.deepEqual(rows(w), [{
    id: sha(s.session), user_hash: user, tier: "edu", provider: "google",
    created: NOW.toISOString(), last_used: NOW.toISOString(), expires: at(365 * DAY).toISOString(),
  }]);
  const everything = JSON.stringify(w.db.dump());
  assert.ok(!everything.includes(s.session), "the token itself is not stored");
  assert.ok(!everything.includes("student@umass.edu"), "the email is not stored");
  assert.ok(!everything.includes(id), "the ID token is not stored");
  // Two sign-ins, two different tokens
  assert.notEqual((await start(w, id)).session, s.session);
});

test("a session signs in on every route, as the same user and tier as the ID token it came from", async () => {
  const w = await setup();
  const id = await w.token();
  const { session } = await start(w, id);
  const viaSession = await me(w, session);
  assert.equal(viaSession.status, 200);
  assert.equal((await viaSession.json()).tier, "edu");
  // Same account: states set with the session show up for the ID token's user_hash, and /invite matches
  assert.equal((await w.api("POST", "/demand", { token: session, body: { states: ["MA"] } })).status, 200);
  const user = await userHash("google", { sub: "109876543210" }, { HASH_SALT: "test-salt" });
  assert.equal(w.db.dump().demand[0].user_hash, user);
  const a = await (await w.api("GET", "/invite", { token: session })).json();
  const b = await (await w.api("GET", "/invite", { token: id })).json();
  assert.equal(a.code, b.code);
  // ID tokens still work exactly as before, with sessions around
  assert.equal((await me(w, id)).status, 200);
});

test("the tier is carried in the session: general stays general, and a Microsoft session says microsoft", async () => {
  const w = await setup();
  const gmail = await start(w, await w.token({ sub: "g-1", email: "someone@gmail.com", hd: undefined }));
  assert.equal(gmail.tier, "general");
  assert.equal((await (await me(w, gmail.session)).json()).tier, "general");
  assert.equal((await (await me(w, gmail.session)).json()).allowance.resume_tailor.limit, 7);   // was 5
  const ms = await start(w, await w.token({}, "microsoft"));
  assert.deepEqual([ms.provider, ms.tier, ms.email], ["microsoft", "edu", "student@umass.edu"]);
  assert.equal((await (await me(w, ms.session)).json()).tier, "edu");
  // A Microsoft token without the optional email claim still gets something to show
  const bare = await start(w, await w.token({ sub: "ms-2", email: undefined, xms_edov: undefined }, "microsoft"));
  assert.deepEqual([bare.email, bare.tier], ["student@umass.edu", "general"]);
});

test("use moves the year forward at most once per UTC day", async () => {
  const w = await setup();
  const { session } = await start(w);
  const row = () => rows(w)[0];
  w.setNow(at(3 * 3600e3));   // same UTC day (10:05 -> 13:05)
  assert.equal((await me(w, session)).status, 200);
  assert.equal(row().last_used, NOW.toISOString(), "no write on the day it was made");
  const tomorrow = new Date("2026-09-15T00:00:05Z");
  w.setNow(tomorrow);
  assert.equal((await me(w, session)).status, 200);
  assert.equal(row().last_used, tomorrow.toISOString());
  assert.equal(row().expires, new Date(tomorrow.getTime() + 365 * DAY).toISOString());
  w.setNow(new Date("2026-09-15T23:59:00Z"));
  assert.equal((await me(w, session)).status, 200);
  assert.equal(row().last_used, tomorrow.toISOString(), "a second use that day doesn't write");
  assert.equal(row().created, NOW.toISOString());
});

test("a session unused for a year expires; one used just in time lives another year", async () => {
  const w = await setup();
  const kept = await start(w, await w.token({ sub: "kept" }));
  const lapsed = await start(w, await w.token({ sub: "lapsed" }));
  w.setNow(at(364 * DAY));
  assert.equal((await me(w, kept.session)).status, 200);
  w.setNow(at(365 * DAY));
  const res = await me(w, lapsed.session);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "auth", message: "Sign-in expired; sign in again" });
  w.setNow(at(700 * DAY));
  assert.equal((await me(w, kept.session)).status, 200, "364 + 365 days, still in its year");
  // The daily cron clears the dead row and leaves the live one
  await dropExpiredSessions(w.db, at(700 * DAY));
  assert.deepEqual(rows(w).map((r) => r.id), [sha(kept.session)]);
});

test("unknown, malformed or deleted sessions are 401 auth", async () => {
  const w = await setup();
  for (const token of ["iss_" + "A".repeat(43), "iss_short", "iss_" + "A".repeat(42) + "!"]) {
    const res = await me(w, token);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "auth", message: "Sign-in expired; sign in again" });
  }
});

test("DELETE /session signs that device out; it is idempotent and ignores ID tokens", async () => {
  const w = await setup();
  const id = await w.token();
  const one = await start(w, id);
  const two = await start(w, id);
  let res = await w.api("DELETE", "/session", { token: one.session });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await me(w, one.session)).status, 401);
  assert.equal((await me(w, two.session)).status, 200, "the other device stays signed in");
  // Again, with an ID token, with an unknown session, with nothing: all fine, nothing else removed
  for (const token of [one.session, id, "iss_" + "B".repeat(43), undefined]) {
    res = await w.api("DELETE", "/session", { token });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.deepEqual(rows(w).map((r) => r.id), [sha(two.session)]);
});

test("only a valid ID token can start a session", async () => {
  const w = await setup();
  const { session } = await start(w);
  for (const token of [session, undefined, "not.a.jwt", await w.token({ aud: "someone-else" })]) {
    const res = await w.api("POST", "/session", { token });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "auth");
  }
  const t = Math.floor(NOW.getTime() / 1000);
  assert.equal((await w.api("POST", "/session", { token: await w.token({ exp: t - 120 }) })).status, 401);
  assert.equal(rows(w).length, 1);
});

test("at most 20 sessions per account: the 21st pushes out the least recently used", async () => {
  const w = await setup();
  const made = [];
  for (let i = 0; i < MAX_SESSIONS; i++) {
    w.setNow(at(i * 60e3));
    made.push((await start(w)).session);
  }
  // Another account's sessions are never counted or touched
  const other = await start(w, await w.token({ sub: "someone-else" }));
  // The first session is used on a later day, so the second is now the least recently used
  w.setNow(at(DAY));
  assert.equal((await me(w, made[0])).status, 200);
  const newest = (await start(w)).session;
  const user = await userHash("google", { sub: "109876543210" }, { HASH_SALT: "test-salt" });
  assert.equal(rows(w).filter((r) => r.user_hash === user).length, MAX_SESSIONS);
  assert.equal((await me(w, made[1])).status, 401, "least recently used went");
  for (const s of [made[0], ...made.slice(2), newest, other.session]) assert.equal((await me(w, s)).status, 200);
  // Several at the very same moment still keep the one just made
  for (let i = 0; i < 3; i++) {
    const s = (await start(w)).session;
    assert.equal((await me(w, s)).status, 200);
  }
  assert.equal(rows(w).length, MAX_SESSIONS + 1);
});
