// Sign-in in docs/js/core.js: the Worker session that keeps the dashboard signed in, the ID token it
// falls back to, and IS.authInfo, the one reader for both. Loaded the same way core.test.mjs loads
// core.js (evaluated against a stand-in `window`), with the browser globals sign-in needs added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CORE = readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8");
const WORKER = "https://worker.test";
const DAY = 864e5;

// A fresh core.js per test. `fetch` is answered by the test; returns { IS, ctx } so a test can look
// at what was stored.
function loadCore(fetchImpl, { hash = "" } = {}) {
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
  const ctx = {
    CONFIG: { dataUrl: "./data/", workerUrl: WORKER },
    fetch: fetchImpl, localStorage: store(), sessionStorage: store(),
    addEventListener() {}, postMessage() {}, setTimeout, clearTimeout,
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash },
    history: { replaceState() { ctx.location.hash = ""; } },
    document: { documentElement: { dataset: {} } },
    TextDecoder, atob, URLSearchParams, AbortController, console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  return { IS: ctx.IS, ctx };
}

const b64url = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = claims => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);
const idToken = (extra = {}) => jwt({ sub: "g-123", email: "sam@umass.edu", iat: nowS(), exp: nowS() + 3600, nonce: "N", ...extra });
const SESSION = "iss_" + "A".repeat(35) + "tail1234";
const sessionReply = (extra = {}) => ({ session: SESSION, account: "0123456789abcdef", email: "sam@umass.edu", provider: "google", tier: "edu", expires: new Date(Date.now() + 365 * DAY).toISOString(), ...extra });
const answer = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const stored = (ctx, k = "internscout.session") => { const v = ctx.localStorage.getItem(k); return v == null ? null : JSON.parse(v); };

// Sets up the state/nonce startSignIn would have left, and the provider's redirect hash.
function redirected(fetchImpl, token = idToken()) {
  const r = loadCore(fetchImpl, { hash: "#" + new URLSearchParams({ id_token: token, state: "S" }) });
  r.ctx.sessionStorage.setItem("internscout.auth.state", "S");
  r.ctx.sessionStorage.setItem("internscout.auth.nonce", "N");
  return { ...r, token };
}

// ---------- IS.authInfo ----------

test("authInfo reads a legacy ID token: email, sub, exp in ms, iat as the sign-in marker", () => {
  const { IS } = loadCore(() => answer(404, {}));
  const t = idToken({ iat: 1000, exp: 2000 });
  const i = IS.authInfo(t);
  assert.equal(i.token, t);
  assert.equal(i.email, "sam@umass.edu");
  assert.equal(i.sub, "g-123");
  assert.equal(i.exp, 2000 * 1000);
  assert.equal(i.signin, "1000");
  assert.equal(i.session, false);
  // The old extension bridge reply, { token }, reads the same.
  assert.equal(IS.authInfo({ token: t }).sub, "g-123");
  assert.equal(IS.authInfo("not a token"), null);
  assert.equal(IS.authInfo(null), null);
});

test("authInfo reads a session record: account stands in for sub, expires for exp", () => {
  const { IS } = loadCore(() => answer(404, {}));
  const exp = Date.now() + 100 * DAY;
  // As the page stores it (expires ISO) ...
  const page = IS.authInfo({ token: SESSION, account: "0123456789abcdef", email: "sam@umass.edu", provider: "google", tier: "edu", expires: new Date(exp).toISOString() });
  assert.equal(page.token, SESSION);
  assert.equal(page.sub, "0123456789abcdef");
  assert.equal(page.email, "sam@umass.edu");
  assert.equal(page.exp, exp);
  assert.equal(page.session, true);
  assert.ok(page.signin && page.signin !== SESSION, "a marker per sign-in, not the whole code");
  // ... and as the extension's bridge sends it (expires in ms).
  const bridge = IS.authInfo({ token: SESSION, email: "sam@umass.edu", account: "0123456789abcdef", expires: exp });
  assert.deepEqual({ sub: bridge.sub, exp: bridge.exp, email: bridge.email }, { sub: page.sub, exp, email: page.email });
  // Its own result reads back unchanged.
  assert.deepEqual({ ...IS.authInfo(bridge) }, { ...bridge });
});

test("authInfo looks a bare session code up in the stored record, and knows nothing about other codes", () => {
  const { IS, ctx } = loadCore(() => answer(404, {}));
  assert.equal(IS.authInfo(SESSION), null);
  ctx.localStorage.setItem("internscout.session", JSON.stringify({ token: SESSION, account: "abc", email: "a@b.edu", expires: new Date(Date.now() + DAY).toISOString() }));
  assert.equal(IS.authInfo(SESSION).sub, "abc");
  assert.equal(IS.authInfo("iss_someoneelse"), null);
});

test("authOk: good for more than a minute, for both kinds", () => {
  const { IS } = loadCore(() => answer(404, {}));
  assert.equal(IS.authOk(idToken()), true);
  assert.equal(IS.authOk(idToken({ exp: nowS() + 30 })), false);
  assert.equal(IS.authOk({ token: SESSION, account: "a", expires: Date.now() + DAY }), true);
  assert.equal(IS.authOk({ token: SESSION, account: "a", expires: new Date(Date.now() - 1000).toISOString() }), false);
  assert.equal(IS.authOk({ token: SESSION, account: "a" }), false, "no expiry reads as expired");
  assert.equal(IS.tokenOk, IS.authOk, "the old name understands sessions too");
});

// ---------- storedToken ----------

test("storedToken returns the session code while it hasn't expired, ahead of this tab's ID token", () => {
  const { IS, ctx } = loadCore(() => answer(404, {}));
  const t = idToken();
  ctx.sessionStorage.setItem("internscout.idtoken", t);
  ctx.localStorage.setItem("internscout.session", JSON.stringify({ token: SESSION, account: "a", expires: new Date(Date.now() + DAY).toISOString() }));
  assert.equal(IS.storedToken(), SESSION);
});

test("storedToken drops an expired session and falls back to the ID token, then drops that when it expires", () => {
  const { IS, ctx } = loadCore(() => answer(404, {}));
  const t = idToken();
  ctx.sessionStorage.setItem("internscout.idtoken", t);
  ctx.localStorage.setItem("internscout.session", JSON.stringify({ token: SESSION, account: "a", expires: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(IS.storedToken(), t);
  assert.equal(stored(ctx), null, "expired record removed");
  ctx.sessionStorage.setItem("internscout.idtoken", idToken({ exp: nowS() - 10 }));
  assert.equal(IS.storedToken(), null);
  assert.equal(ctx.sessionStorage.getItem("internscout.idtoken"), null);
});

// ---------- redirect → POST /session ----------

test("after the provider redirect, the ID token is traded for a session that is kept in localStorage", async () => {
  const calls = [];
  const { IS, ctx, token } = redirected((url, init) => { calls.push({ url, init }); return answer(200, sessionReply()); });
  const r = await IS.handleRedirect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WORKER + "/session");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer " + token, "only the ID token can make a session");
  assert.equal(r.token, SESSION);
  const rec = stored(ctx);
  assert.deepEqual(Object.keys(rec).sort(), ["account", "email", "expires", "provider", "tier", "token"]);
  assert.equal(rec.token, SESSION);
  assert.equal(rec.account, "0123456789abcdef");
  assert.equal(ctx.sessionStorage.getItem("internscout.idtoken"), null, "the ID token isn't kept once there is a session");
  assert.equal(ctx.location.hash, "", "the token is taken out of the address");
  assert.equal(IS.storedToken(), SESSION);
  assert.equal(IS.authInfo(r.session).sub, "0123456789abcdef");
});

for (const [name, impl] of [
  ["404 (a Worker without sessions)", () => answer(404, { error: "not_found" })],
  ["503", () => answer(503, {})],
  ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ["a 200 without a session in it", () => answer(200, { ok: true })],
]) {
  test(`after the redirect, ${name} falls back to keeping the ID token for this tab`, async () => {
    const { IS, ctx, token } = redirected(impl);
    const r = await IS.handleRedirect();
    assert.equal(r.token, token);
    assert.equal(r.session, null);
    assert.equal(ctx.sessionStorage.getItem("internscout.idtoken"), token);
    assert.equal(stored(ctx), null);
    assert.equal(IS.storedToken(), token);
    assert.equal(IS.authInfo(IS.storedToken()).sub, "g-123");
  });
}

test("a 401 from POST /session is a failed sign-in, and nothing is kept", async () => {
  const { IS, ctx } = redirected(() => answer(401, { error: "auth", message: "Unknown signing key; sign in again" }));
  const r = await IS.handleRedirect();
  assert.match(r.error, /sign in again/);
  assert.equal(stored(ctx), null);
  assert.equal(ctx.sessionStorage.getItem("internscout.idtoken"), null);
});

test("a redirect whose state doesn't match never reaches the Worker", async () => {
  let asked = 0;
  const { IS, ctx } = redirected(() => { asked++; return answer(200, sessionReply()); });
  ctx.sessionStorage.setItem("internscout.auth.state", "other");
  const r = await IS.handleRedirect();
  assert.match(r.error, /state/);
  assert.equal(asked, 0);
});

test("no sign-in in the address resolves to null", async () => {
  const { IS } = loadCore(() => answer(200, sessionReply()));
  assert.equal(await IS.handleRedirect(), null);
});

// ---------- sign-out, 401s, sliding expiry, dedupe keys ----------

function signedInCore(fetchImpl) {
  const r = loadCore(fetchImpl);
  r.ctx.localStorage.setItem("internscout.session", JSON.stringify({ token: SESSION, account: "0123456789abcdef", email: "sam@umass.edu", provider: "google", tier: "edu", expires: new Date(Date.now() + 200 * DAY).toISOString() }));
  return r;
}

test("Sign out ends the session on the Worker (DELETE /session) and removes the record", () => {
  const calls = [];
  const { IS, ctx } = signedInCore((url, init) => { calls.push({ url, init }); return answer(200, { ok: true }); });
  IS.signOut(true);
  assert.equal(stored(ctx), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WORKER + "/session");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers.Authorization, "Bearer " + SESSION);
});

test("Sign out still signs out here when the Worker can't be reached", () => {
  const { IS, ctx } = signedInCore(() => Promise.reject(new TypeError("offline")));
  IS.signOut(true);
  assert.equal(stored(ctx), null);
  assert.equal(IS.storedToken(), null);
});

test("signOut() without `everywhere` (an expiry) removes the record and calls nothing", () => {
  let asked = 0;
  const { IS, ctx } = signedInCore(() => { asked++; return answer(200, {}); });
  IS.signOut();
  assert.equal(stored(ctx), null);
  assert.equal(asked, 0);
});

test("a 401 for the session clears it, and authOk says signed out", async () => {
  const { IS, ctx } = signedInCore(() => answer(401, { error: "auth", message: "Sign-in expired; sign in again" }));
  const who = IS.authInfo(IS.storedToken());
  assert.equal(await IS.fetchMe(SESSION), null);
  assert.equal(stored(ctx), null);
  assert.equal(IS.authOk(who), false, "even the copy the page already holds");
});

test("a 401 for another token (the extension's) leaves the page's own session alone", async () => {
  const { IS, ctx } = signedInCore(() => answer(401, {}));
  await IS.fetchMe("iss_theextensions");
  assert.equal(stored(ctx).token, SESSION);
});

test("a successful call moves the stored expiry forward, the way the Worker slides it", async () => {
  const { IS, ctx } = signedInCore(() => answer(200, { tier: "edu", allowance: {} }));
  const before = Date.parse(stored(ctx).expires);
  assert.ok(await IS.fetchMe(SESSION));
  const after = Date.parse(stored(ctx).expires);
  assert.ok(after > before + 100 * DAY, "about a year from now");
  assert.ok(after <= Date.now() + 365 * DAY, "never past what the Worker allows");
});

test("the demand dedupe key uses the session's account in place of the sub", async () => {
  const { IS, ctx } = signedInCore(() => answer(200, { ok: true }));
  assert.equal(await IS.postDemand(SESSION, { states: ["MA"], remote: false }), true);
  assert.match(ctx.localStorage.getItem("internscout.demand.sent"), /^"0123456789abcdef\|/);
});

test("Delete my data removes the session record too", async () => {
  const { IS, ctx } = signedInCore(() => answer(200, { ok: true }));
  const r = await IS.deleteMyData(SESSION);
  assert.equal(r.server, true);
  assert.equal(stored(ctx), null);
});
