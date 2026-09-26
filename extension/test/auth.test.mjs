// Staying signed in: the session token is preferred over the hourly ID token, expires on its date, and an
// older Worker without /session falls back to the ID token with the login hint kept across restarts.
import test from "node:test";
import assert from "node:assert/strict";

const store = (data) => ({
  async get(k) { return k == null ? { ...data } : Object.fromEntries([].concat(k).map((x) => [x, data[x]]).filter(([, v]) => v !== undefined)); },
  async set(o) { for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
  async remove(k) { for (const x of [].concat(k)) delete data[x]; },
});
const LOCAL = {}, SESSION = {};
let authReply = null;   // what launchWebAuthFlow hands back: (url) => redirect URL
globalThis.chrome = {
  storage: { local: store(LOCAL), session: store(SESSION) },
  identity: { getRedirectURL: () => "https://ext.chromiumapp.org/", launchWebAuthFlow: async ({ url }) => authReply(url) },
};
const calls = [];
let routes = {};        // "METHOD /path" → (init) => [status, body] ; missing → network error
globalThis.fetch = async (url, init = {}) => {
  const key = `${init.method || "GET"} ${new URL(url).pathname}`;
  calls.push({ key, auth: init.headers && init.headers.authorization });
  const h = routes[key];
  if (!h) throw new TypeError("fetch failed");
  const [status, body] = h(init);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const A = await import("../lib/auth.js");
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64url({ alg: "RS256" })}.${b64url(payload)}.sig`;
const HOUR = 3600e3, now = Date.now();
const idToken = (extra = {}) => jwt({ email: "sam@school.edu", exp: Math.floor((Date.now() + HOUR) / 1000), ...extra });
const sessionReply = { session: "iss_abc", account: "0123456789abcdef", email: "sam@school.edu", provider: "google", tier: "edu",
  expires: new Date(now + 365 * 864e5).toISOString() };
const CONFIG = { providers: [{ id: "google", client_id: "cid", authorize_url: "https://accounts.example/auth", scopes: ["openid", "email"] }] };
const reset = () => { for (const o of [LOCAL, SESSION]) for (const k of Object.keys(o)) delete o[k]; calls.length = 0; };
// The provider "signs in" by echoing the nonce it was sent in a fresh ID token.
const provider = () => { authReply = (url) => `https://ext.chromiumapp.org/#id_token=${idToken({ nonce: new URL(url).searchParams.get("nonce") })}`; };

test("pure: a live session wins over an ID token; expired ones don't count", () => {
  const live = { token: "iss_x", expires: new Date(now + 1000).toISOString() };
  const dead = { token: "iss_x", expires: new Date(now - 1000).toISOString() };
  const id = idToken(), oldId = jwt({ exp: Math.floor((now - HOUR) / 1000) });
  assert.equal(A.pickToken(live, id, now), "iss_x");
  assert.equal(A.pickToken(dead, id, now), id);
  assert.equal(A.pickToken(null, id, now), id);
  assert.equal(A.pickToken(dead, oldId, now), null);
  assert.equal(A.pickToken(null, null, now), null);
  assert.equal(A.sessionLive({ token: "eyJ.not.session", expires: live.expires }, now), false);
  assert.equal(A.sessionLive({ token: "iss_x", expires: "garbage" }, now), false);
});

test("pure: POST /session outcomes: session, fall back, or refused", () => {
  assert.equal(A.sessionOutcome(200, sessionReply), "session");
  assert.equal(A.sessionOutcome(200, { ok: true }), "legacy");   // a 200 that isn't a session
  for (const s of [0, 404, 500, 502, 503]) assert.equal(A.sessionOutcome(s, {}), "legacy", String(s));
  assert.equal(A.sessionOutcome(401, { error: "auth" }), "refused");
  assert.deepEqual(A.sessionRecord(sessionReply), { token: "iss_abc", account: "0123456789abcdef", email: "sam@school.edu",
    provider: "google", tier: "edu", expires: sessionReply.expires });
  assert.equal(A.sessionRecord({ ...sessionReply, session: "nope" }), null);
});

test("pure: the bridge reply for a session and for a legacy token", () => {
  const rec = A.sessionRecord(sessionReply);
  assert.deepEqual(A.bridgeReply(rec, "iss_abc"), { token: "iss_abc", email: "sam@school.edu", account: "0123456789abcdef", expires: Date.parse(sessionReply.expires) });
  assert.deepEqual(A.bridgeReply(null, "eyJ.id.tok"), { token: "eyJ.id.tok" });
  assert.deepEqual(A.bridgeReply(rec, "eyJ.id.tok"), { token: "eyJ.id.tok" });   // the session isn't the token in use
  assert.deepEqual(A.bridgeReply(null, null), { token: null });
});

test("sign-in creates a session kept in chrome.storage.local, and it survives a restart", async () => {
  reset(); provider();
  routes = { "GET /config": () => [200, CONFIG], "POST /session": () => [200, sessionReply] };
  const t = await A.signIn({ interactive: true, provider: "google" });
  assert.equal(t, "iss_abc");
  assert.equal(calls.find((c) => c.key === "POST /session").auth.startsWith("Bearer ey"), true);   // the ID token made it
  assert.equal(LOCAL["internscout.session"].token, "iss_abc");
  assert.deepEqual(LOCAL["internscout.signin"], { hint: "sam@school.edu", provider: "google" });
  assert.equal(SESSION["internscout.idtoken"], undefined);
  for (const k of Object.keys(SESSION)) delete SESSION[k];   // the browser closes
  assert.equal(await A.getToken(), "iss_abc");
  assert.equal(await A.ensureToken(), "iss_abc");
  const st = await A.authStatus();
  assert.equal(st.signedIn, true); assert.equal(st.email, "sam@school.edu"); assert.equal(st.provider, "google"); assert.equal(st.session, true);
  assert.equal(st.exp, Math.floor(Date.parse(sessionReply.expires) / 1000));
  assert.deepEqual(await A.authBridge(), { token: "iss_abc", email: "sam@school.edu", account: "0123456789abcdef", expires: Date.parse(sessionReply.expires) });
});

test("an older Worker without /session: the ID token is used and the hint outlives the browser", async () => {
  reset(); provider();
  routes = { "GET /config": () => [200, CONFIG], "POST /session": () => [404, { error: "not_found" }] };
  const t = await A.signIn({ interactive: true, provider: "google" });
  assert.ok(t.startsWith("ey"));
  assert.equal(LOCAL["internscout.session"], undefined);
  assert.deepEqual(SESSION["internscout.idtoken"], { token: t });
  assert.deepEqual(LOCAL["internscout.signin"], { hint: "sam@school.edu", provider: "google" });
  assert.deepEqual(await A.authBridge(), { token: t });
  // Restart: the ID token is gone with the session storage, but the silent refresh still knows who to ask for.
  for (const k of Object.keys(SESSION)) delete SESSION[k];
  assert.equal(await A.getToken(), null);
  let silentUrl = null;
  authReply = (url) => { silentUrl = new URL(url); return `https://ext.chromiumapp.org/#id_token=${idToken({ nonce: silentUrl.searchParams.get("nonce") })}`; };
  const again = await A.ensureToken();
  assert.ok(again && again.startsWith("ey"));
  assert.equal(silentUrl.searchParams.get("prompt"), "none");
  assert.equal(silentUrl.searchParams.get("login_hint"), "sam@school.edu");
  // A network failure on /session falls back the same way.
  routes["POST /session"] = undefined;
  assert.ok((await A.signIn({ interactive: true, provider: "google" })).startsWith("ey"));
});

test("a Worker that refuses the ID token fails the sign-in", async () => {
  reset(); provider();
  routes = { "GET /config": () => [200, CONFIG], "POST /session": () => [401, { error: "auth", message: "Bad token" }] };
  await assert.rejects(A.signIn({ interactive: true, provider: "google" }), /Sign-in failed: Bad token/);
  assert.equal(LOCAL["internscout.session"], undefined);
});

test("an expired session falls back to a valid ID token", async () => {
  reset();
  LOCAL["internscout.session"] = { ...A.sessionRecord(sessionReply), expires: new Date(Date.now() - 1000).toISOString() };
  const id = idToken();
  SESSION["internscout.idtoken"] = { token: id };
  assert.equal(await A.getToken(), id);
  assert.equal((await A.authStatus()).session, undefined);
});

test("a 401 on a session drops it (and the hint), so the extension shows Sign in", async () => {
  reset();
  LOCAL["internscout.session"] = A.sessionRecord(sessionReply);
  LOCAL["internscout.signin"] = { hint: "sam@school.edu", provider: "google" };
  routes = { "GET /me": () => [401, { error: "auth", message: "Sign-in expired; sign in again" }] };
  const me = await A.getMe();
  assert.equal(me.error, "auth");
  assert.equal(LOCAL["internscout.session"], undefined);
  assert.equal(LOCAL["internscout.signin"], undefined);
  assert.equal(await A.ensureToken(), null);   // no silent sign-in back
  assert.equal((await A.authStatus()).signedIn, false);
  // callWorker's refresh after a 401 on a session: dropped, nothing to retry with.
  LOCAL["internscout.session"] = A.sessionRecord(sessionReply);
  assert.equal(await A.refreshAfter401("iss_abc"), null);
  assert.equal(LOCAL["internscout.session"], undefined);
  // A 401 on a different token leaves the session alone.
  LOCAL["internscout.session"] = A.sessionRecord(sessionReply);
  await A.dropSession("iss_other");
  assert.equal(LOCAL["internscout.session"].token, "iss_abc");
});

test("sign out deletes the session on the Worker (best effort) and every local key", async () => {
  reset();
  LOCAL["internscout.session"] = A.sessionRecord(sessionReply);
  LOCAL["internscout.signin"] = { hint: "sam@school.edu", provider: "google" };
  SESSION["internscout.idtoken"] = { token: idToken() };
  routes = {};   // DELETE /session fails: sign-out still completes
  await A.signOut();
  assert.deepEqual(calls.map((c) => [c.key, c.auth]), [["DELETE /session", "Bearer iss_abc"]]);
  assert.deepEqual(LOCAL, {});
  assert.deepEqual(SESSION, {});
  assert.equal(await A.getToken(), null);
});
