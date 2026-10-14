// "Stay signed in": POST/DELETE /session, session bearers on every route, the sliding year, the 20 cap.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NOW, setup } from "./helpers.js";
import { userHash } from "../src/auth.js";
import { MAX_SESSIONS, dropExpiredSessions } from "../src/session.js";
import { deleteUser } from "../src/limits.js";

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
  assert.equal((await (await me(w, gmail.session)).json()).allowance.resume_tailor.limit, 5);
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

// U8 (2026-10-14): the extension checks a session the dashboard offers it before keeping it.
test("GET /session says whose a live session is (no email), and refuses anything else", async () => {
  const w = await setup();
  const s = await start(w);
  let res = await w.api("GET", "/session", { token: s.session });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { account: s.account, provider: "google", tier: "edu", expires: s.expires });
  // A use on a later day slides the year forward, and the reply says so.
  const later = new Date("2026-09-20T08:00:00Z");
  w.setNow(later);
  res = await w.api("GET", "/session", { token: s.session });
  assert.equal((await res.json()).expires, new Date(later.getTime() + 365 * DAY).toISOString());
  // An ID token, an unknown session, a signed-out session and no token are all 401 auth.
  const id = await w.token();
  await w.api("DELETE", "/session", { token: s.session });
  for (const token of [id, "iss_" + "C".repeat(43), s.session, undefined]) {
    res = await w.api("GET", "/session", { token });
    assert.equal(res.status, 401, String(token).slice(0, 8));
    assert.equal((await res.json()).error, "auth");
  }
});

// The extension's own session from the dashboard's (2026-10-14): the two then sign out separately.
const copy = (w, token) => w.api("POST", "/session/copy", { token });

test("POST /session/copy makes a separate session for the same account; signing out of either leaves the other", async () => {
  const w = await setup();
  const dash = await start(w);
  const res = await copy(w, dash.session);
  assert.equal(res.status, 200);
  const ext = await res.json();
  assert.match(ext.session, /^iss_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ext.session, dash.session);
  assert.deepEqual({ ...ext, session: undefined }, { session: undefined, account: dash.account, provider: "google", tier: "edu", expires: dash.expires });
  assert.ok(!("email" in ext), "no email: the Worker never stores one");
  assert.deepEqual(w.db.dump().session_copies.map((r) => [r.source, r.copy]), [[sha(dash.session), sha(ext.session)]]);
  // The dashboard signs out: the extension stays signed in, as the same user.
  await w.api("DELETE", "/session", { token: dash.session });
  assert.equal((await me(w, dash.session)).status, 401);
  assert.equal((await me(w, ext.session)).status, 200);
  // And the other way round.
  const dash2 = await start(w);
  const ext2 = await (await copy(w, dash2.session)).json();
  await w.api("DELETE", "/session", { token: ext2.session });
  assert.equal((await me(w, dash2.session)).status, 200);
});

test("POST /session/copy: once per session, never from a copy, and only from a live session token", async () => {
  const w = await setup();
  const dash = await start(w);
  const ext = await (await copy(w, dash.session)).json();
  for (const token of [dash.session, ext.session]) {
    const res = await copy(w, token);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "copied");
  }
  const id = await w.token();
  const gone = await start(w);
  await w.api("DELETE", "/session", { token: gone.session });
  for (const token of [id, "iss_" + "C".repeat(43), gone.session, undefined]) {
    const res = await copy(w, token);
    assert.equal(res.status, 401, String(token).slice(0, 8));
    assert.equal((await res.json()).error, "auth");
  }
  assert.equal(rows(w).length, 2, "only the one copy was made");
  // Two at once still make one.
  const d2 = await start(w);
  const both = await Promise.all([copy(w, d2.session), copy(w, d2.session)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
});

test("copy records go with Delete my data, and with the daily cron once neither session is left", async () => {
  const w = await setup();
  const a = await start(w);
  await copy(w, a.session);
  const b = await start(w, await w.token({ sub: "someone-else" }));
  const bx = await (await copy(w, b.session)).json();
  await w.api("DELETE", "/session", { token: b.session });
  await dropExpiredSessions(w.db, NOW);
  assert.equal(w.db.dump().session_copies.length, 2, "one of b's sessions is still there");
  await w.api("DELETE", "/session", { token: bx.session });
  await dropExpiredSessions(w.db, NOW);
  assert.deepEqual(w.db.dump().session_copies.map((r) => r.source), [sha(a.session)]);
  const user = await userHash("google", { sub: "109876543210" }, { HASH_SALT: "test-salt" });
  await deleteUser(w.db, user, NOW);
  assert.deepEqual(w.db.dump().session_copies, []);
});
