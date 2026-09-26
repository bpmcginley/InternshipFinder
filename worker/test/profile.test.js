// "Save the Deep Dive to your account": GET/PUT/DELETE /profile, encryption at rest, the stale rule,
// DELETE /me, /config flags and CORS for PUT/DELETE.
import test from "node:test";
import assert from "node:assert/strict";
import { NOW, setup } from "./helpers.js";
import { userHash } from "../src/auth.js";
import { DEMOGRAPHICS, unseal } from "../src/profile.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const sync = (env = {}) => setup({ env: { PROFILE_KEY: KEY, ...env } });
const USER = () => userHash("google", { sub: "109876543210" }, { HASH_SALT: "test-salt" });
const iso = (min) => new Date(NOW.getTime() + min * 60e3).toISOString();
const PROFILE = {
  facts: { majors: ["Computer Science"], class_year: 2028, gender: "woman", race: ["asian"], hispanic: "no",
           veteran: "no", disability: "no", lgbtq: "prefer_not" },
  skills: ["Python", "SQL"], story: "Built a club website",
};
const put = (w, token, profile, updated) => w.api("PUT", "/profile", { token, body: { profile, updated } });
const get = async (w, token) => {
  const res = await w.api("GET", "/profile", { token });
  assert.equal(res.status, 200);
  return res.json();
};

test("PUT then GET round-trips the profile, minus the six demographic answers", async () => {
  const w = await sync();
  const token = await w.token();
  assert.deepEqual(await get(w, token), { profile: null, updated: null });
  const res = await put(w, token, PROFILE, iso(0));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, updated: iso(0) });
  const back = await get(w, token);
  assert.equal(back.updated, iso(0));
  assert.deepEqual(back.profile, { ...PROFILE, facts: { majors: ["Computer Science"], class_year: 2028 } });
  for (const k of DEMOGRAPHICS) assert.ok(!(k in back.profile.facts), k);
  const [row] = w.db.dump().profiles;
  assert.equal(row.bytes, Buffer.byteLength(JSON.stringify(back.profile)));
  // A session token works the same way
  const { session } = await (await w.api("POST", "/session", { token })).json();
  assert.deepEqual(await get(w, session), back);
});

test("the stored row is AES-GCM ciphertext with a fresh IV, and only this account's key opens it", async () => {
  const w = await sync();
  const token = await w.token();
  await put(w, token, PROFILE, iso(0));
  const first = w.db.dump().profiles[0].data;
  const raw = Buffer.from(first, "base64");
  assert.equal(raw.toString("base64"), first, "base64");
  assert.ok(raw.length >= 12 + 16 + 10, "IV, tag and ciphertext");
  const everything = JSON.stringify(w.db.dump());
  for (const s of ["Computer Science", "Python", "club website", "majors", "woman"]) assert.ok(!everything.includes(s), s);
  // Same profile, same time: a new IV, so a different row
  await put(w, token, PROFILE, iso(0));
  const second = w.db.dump().profiles[0].data;
  assert.notEqual(second, first);
  assert.notDeepEqual(raw.subarray(0, 12), Buffer.from(second, "base64").subarray(0, 12));
  // The key is derived per user_hash: this account's opens it, another account's or another secret's can't
  const user = await USER();
  assert.equal(JSON.parse(await unseal({ PROFILE_KEY: KEY }, user, second)).skills[0], "Python");
  const other = await userHash("google", { sub: "someone-else" }, { HASH_SALT: "test-salt" });
  await assert.rejects(unseal({ PROFILE_KEY: KEY }, other, second));
  await assert.rejects(unseal({ PROFILE_KEY: OTHER_KEY }, user, second));
  // And one account never sees another's copy
  assert.deepEqual(await get(w, await w.token({ sub: "someone-else" })), { profile: null, updated: null });
});

test("an older save than the stored copy is 409 stale with the stored copy; equal or newer saves win", async () => {
  const w = await sync();
  const token = await w.token();
  assert.equal((await put(w, token, { skills: ["v2"] }, iso(10))).status, 200);
  const res = await put(w, token, { skills: ["v1"] }, iso(5));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "stale");
  assert.deepEqual([body.profile, body.updated], [{ skills: ["v2"] }, iso(10)]);
  assert.deepEqual((await get(w, token)).profile, { skills: ["v2"] }, "nothing overwritten");
  // The same time again (a retried save) goes through, and so does a newer one
  assert.equal((await put(w, token, { skills: ["v2b"] }, iso(10))).status, 200);
  const newer = await put(w, token, { skills: ["v3"] }, "2026-09-14T10:25:30.000+00:00");
  assert.deepEqual(await newer.json(), { ok: true, updated: iso(20) }, "stored as a normal ISO time");
  assert.deepEqual(await get(w, token), { profile: { skills: ["v3"] }, updated: iso(20) });
});

test("PUT /profile refuses a body over 256 KB or without a profile object and an ISO time", async () => {
  const w = await sync();
  const token = await w.token();
  const big = { story: "x".repeat(256 * 1024) };
  let res = await put(w, token, big, iso(0));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "bad_request");
  // Just under the cap is fine
  assert.equal((await put(w, token, { story: "x".repeat(250 * 1024) }, iso(0))).status, 200);
  for (const body of [{ updated: iso(1) }, { profile: [], updated: iso(1) }, { profile: "text", updated: iso(1) },
                      { profile: {} }, { profile: {}, updated: "yesterday" }, { profile: {}, updated: 12345 }]) {
    res = await w.api("PUT", "/profile", { token, body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(w.db.dump().profiles.length, 1);
});

test("DELETE /profile removes the saved copy (the switch turned off)", async () => {
  const w = await sync();
  const token = await w.token();
  await put(w, token, PROFILE, iso(0));
  const res = await w.api("DELETE", "/profile", { token });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(w.db.dump().profiles.length, 0);
  assert.deepEqual(await get(w, token), { profile: null, updated: null });
  assert.equal((await w.api("DELETE", "/profile", { token })).status, 200, "again is fine");
});

test("without PROFILE_KEY the profile routes answer 503 sync_off, and /config says sync is off", async () => {
  const w = await setup();
  const token = await w.token();
  for (const [method, body] of [["GET"], ["PUT", { profile: {}, updated: iso(0) }], ["DELETE"]]) {
    const res = await w.api(method, "/profile", { token, body });
    assert.equal(res.status, 503, method);
    assert.deepEqual(await res.json(), { error: "sync_off", message: "Saving profiles isn't turned on yet." });
  }
  const c = await (await w.api("GET", "/config")).json();
  assert.deepEqual([c.sessions, c.sync], [true, false]);
  const on = await (await (await sync()).api("GET", "/config")).json();
  assert.deepEqual([on.sessions, on.sync], [true, true]);
});

test("the profile routes need a sign-in", async () => {
  const w = await sync();
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await w.api(method, "/profile", { body: method === "PUT" ? { profile: {}, updated: iso(0) } : undefined });
    assert.equal(res.status, 401, method);
  }
});

test("a replaced PROFILE_KEY reads as no copy, and the next save replaces it; a malformed one is a 500", async () => {
  const w = await sync();
  const token = await w.token();
  await put(w, token, PROFILE, iso(30));
  w.env.PROFILE_KEY = OTHER_KEY;
  assert.deepEqual(await get(w, token), { profile: null, updated: null });
  assert.equal((await put(w, token, { skills: ["new"] }, iso(0))).status, 200, "an older time still replaces a dead row");
  assert.deepEqual(await get(w, token), { profile: { skills: ["new"] }, updated: iso(0) });
  w.env.PROFILE_KEY = "too-short";
  assert.equal((await w.api("GET", "/profile", { token })).status, 500);
});

test("DELETE /me also removes the saved Deep Dive and every session of that account, and nobody else's", async () => {
  const w = await sync();
  const id = await w.token();
  const a = (await (await w.api("POST", "/session", { token: id })).json()).session;
  const b = (await (await w.api("POST", "/session", { token: id })).json()).session;
  await put(w, a, PROFILE, iso(0));
  const otherId = await w.token({ sub: "someone-else" });
  const other = (await (await w.api("POST", "/session", { token: otherId })).json()).session;
  await put(w, other, { skills: ["theirs"] }, iso(0));

  const res = await w.api("DELETE", "/me", { token: a });
  assert.equal(res.status, 200);
  for (const s of [a, b]) assert.equal((await w.api("GET", "/me", { token: s })).status, 401);
  const dump = w.db.dump();
  const user = await USER();
  assert.ok(!dump.sessions.some((r) => r.user_hash === user));
  assert.ok(!dump.profiles.some((r) => r.user_hash === user));
  assert.equal(dump.sessions.length, 1);
  assert.deepEqual((await get(w, other)).profile, { skills: ["theirs"] });
  // The ID token still signs in (to a now-empty account)
  assert.deepEqual(await get(w, id), { profile: null, updated: null });
});

test("DELETE /me still refuses while a paid plan is live, and then removes nothing", async () => {
  const w = await sync();
  const id = await w.token();
  const { session } = await (await w.api("POST", "/session", { token: id })).json();
  await put(w, session, PROFILE, iso(0));
  await w.db.prepare("INSERT INTO plans (user_hash, plan, status, customer, subscription, period_end, updated) VALUES (?, 'supporter', 'active', 'cus_1', 'sub_1', NULL, ?)")
    .bind(await USER(), NOW.toISOString()).run();
  const res = await w.api("DELETE", "/me", { token: session });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "subscribed");
  assert.equal(w.db.dump().sessions.length, 1);
  assert.equal(w.db.dump().profiles.length, 1);
  assert.equal((await w.api("GET", "/me", { token: session })).status, 200);
});

test("CORS: PUT and DELETE preflights pass for the site and the extension, and not for anyone else", async () => {
  const w = await sync();
  for (const origin of ["https://internscout.org", "chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi", "chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag"]) {
    for (const [path, method] of [["/profile", "PUT"], ["/profile", "DELETE"], ["/session", "DELETE"], ["/session", "POST"]]) {
      const pre = await w.api("OPTIONS", path, {
        headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization, content-type" },
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("Access-Control-Allow-Origin"), origin);
      const methods = pre.headers.get("Access-Control-Allow-Methods").split(",").map((s) => s.trim());
      assert.ok(methods.includes(method), `${method} ${path} from ${origin}`);
      assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
      assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Content-Type/);
    }
  }
  const evil = await w.api("OPTIONS", "/profile", { headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "PUT" } });
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(evil.headers.get("Access-Control-Allow-Methods"), null);
  // The real responses carry the origin too
  const token = await w.token();
  const res = await w.api("PUT", "/profile", { token, body: { profile: {}, updated: iso(0) }, headers: { Origin: "https://internscout.org" } });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://internscout.org");
  const del = await w.api("DELETE", "/session", { token, headers: { Origin: "https://internscout.org" } });
  assert.equal(del.headers.get("Access-Control-Allow-Origin"), "https://internscout.org");
});
