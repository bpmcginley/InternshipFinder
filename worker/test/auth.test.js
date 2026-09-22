import test from "node:test";
import assert from "node:assert/strict";
import { CAPPED_DEEP_DIVE, CLIENT, MS_CLIENT, NOW, googleClaims, makeKeys, setup, signJwt, aiBody } from "./helpers.js";
import { tierOf, userHash } from "../src/auth.js";

const errorOf = async (res) => (await res.json()).error;
const me = async (w, token) => {
  const res = await w.api("GET", "/me", { token });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.json().catch(() => ({})) };
};
const CONSUMER = "9188040d-6c67-4c5b-b112-36a304b66dad";

test("missing or malformed token -> 401", async () => {
  const w = await setup();
  let res = await w.api("GET", "/me");
  assert.equal(res.status, 401);
  assert.equal(await errorOf(res), "auth");
  res = await w.api("GET", "/me", { token: "not.a.jwt" });
  assert.equal(res.status, 401);
});

test("verified .edu Google account -> edu tier, full allowance", async () => {
  const w = await setup();
  const { status, body } = await me(w, await w.token());
  assert.equal(status, 200);
  assert.equal(body.month, "2026-09");
  assert.equal(body.tier, "edu");
  assert.deepEqual(body.allowance.deep_dive, { used: 0, limit: null });   // uncapped since 2026-09-18
  assert.deepEqual(body.allowance.resume_tailor, { used: 0, limit: 10 });
});

test("personal Gmail signs in with the general tier (half, min 1)", async () => {
  const w = await setup();
  const { status, body } = await me(w, await w.token({ hd: undefined, email: "someone@gmail.com" }));
  assert.equal(status, 200);
  assert.equal(body.tier, "general");
  assert.equal(body.allowance.resume_tailor.limit, 5);
  assert.equal(body.allowance.autofill.limit, 10);
  assert.equal(body.allowance.deep_dive.limit, null);
  assert.equal(body.allowance.field_match.limit, 130);
});

test("unverified .edu email is general, not edu", async () => {
  const w = await setup();
  assert.equal((await me(w, await w.token({ email_verified: false }))).body.tier, "general");
});

test("EDU_EXTRA_DOMAINS counts non-.edu schools, including subdomains", async () => {
  const w = await setup({ env: { EDU_EXTRA_DOMAINS: "ox.ac.uk, utoronto.ca" } });
  assert.equal((await me(w, await w.token({ email: "a@cs.ox.ac.uk" }))).body.tier, "edu");
  assert.equal((await me(w, await w.token({ email: "b@utoronto.ca" }))).body.tier, "edu");
  assert.equal((await me(w, await w.token({ email: "c@notox.ac.uk" }))).body.tier, "general");
});

test("general tier is enforced on /ai", async () => {
  const w = await setup({ config: CAPPED_DEEP_DIVE });   // general gets half of 2: one Deep Dive
  const token = await w.token({ email: "someone@gmail.com" });
  assert.equal((await w.api("POST", "/ai", { token, body: aiBody("deep_dive", crypto.randomUUID()) })).status, 200);
  const res = await w.api("POST", "/ai", { token, body: aiBody("deep_dive", crypto.randomUUID()) });
  assert.equal(res.status, 429);
  assert.equal(await errorOf(res), "cap");
});

test("Microsoft: any tenant signs in; edu needs a work/school tenant that owns the .edu domain", async () => {
  const w = await setup();
  const ms = (over) => w.token(over, "microsoft");
  assert.equal((await me(w, await ms())).body.tier, "edu");
  assert.equal((await me(w, await ms({ xms_edov: undefined }))).body.tier, "general");
  const personal = { tid: CONSUMER, iss: `https://login.microsoftonline.com/${CONSUMER}/v2.0` };
  const r = await me(w, await ms({ ...personal, email: "x@umass.edu" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.tier, "general");
  const other = { tid: "other-tenant", iss: "https://login.microsoftonline.com/other-tenant/v2.0", email: "x@acme.com" };
  assert.equal((await me(w, await ms(other))).body.tier, "general");
  const jwks = w.fetch.calls.filter((c) => c.url.includes("/common/discovery/v2.0/keys"));
  assert.equal(jwks.length, 1, "JWKS is cached");
});

test("Microsoft: issuer must match the token's own tenant, audience must be MS_CLIENT_ID", async () => {
  const w = await setup();
  assert.equal((await me(w, await w.token({ tid: "other-tenant" }, "microsoft"))).status, 401);
  assert.equal((await me(w, await w.token({ aud: CLIENT }, "microsoft"))).status, 401);
});

test("a provider with no client ID is off", async () => {
  const w = await setup({ env: { MS_CLIENT_ID: "" } });
  assert.equal((await me(w, await w.token({}, "microsoft"))).status, 401);
  const c = await (await w.api("GET", "/config")).json();
  assert.deepEqual(c.providers.map((p) => p.id), ["google"]);
});

test("wrong aud -> 401", async () => {
  const w = await setup();
  const res = await w.api("GET", "/me", { token: await w.token({ aud: "someone-else", azp: "someone-else" }) });
  assert.equal(res.status, 401);
  assert.equal(await errorOf(res), "auth");
  assert.equal((await me(w, await w.token({ aud: MS_CLIENT }))).status, 401);
});

test("expired -> 401, inside 60 s leeway -> 200", async () => {
  const w = await setup();
  const t = Math.floor(NOW.getTime() / 1000);
  assert.equal((await w.api("GET", "/me", { token: await w.token({ exp: t - 120 }) })).status, 401);
  assert.equal((await w.api("GET", "/me", { token: await w.token({ exp: t - 30 }) })).status, 200);
});

test("wrong issuer or bad signature -> 401", async () => {
  const w = await setup();
  assert.equal((await w.api("GET", "/me", { token: await w.token({ iss: "https://evil.example" }) })).status, 401);
  const other = await makeKeys("k1");
  const forged = await signJwt(googleClaims(NOW), other.privateKey);
  assert.equal((await w.api("GET", "/me", { token: forged })).status, 401);
});

test("GET /config needs no sign-in and lists both providers and both allowance tables", async () => {
  const w = await setup();
  const res = await w.api("GET", "/config");
  assert.equal(res.status, 200);
  const c = await res.json();
  assert.deepEqual(c.providers.map((p) => p.id), ["google", "microsoft"]);
  const [g, m] = c.providers;
  assert.equal(g.client_id, CLIENT);
  assert.equal(g.authorize_url, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(m.client_id, MS_CLIENT);
  assert.equal(m.authorize_url, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.deepEqual(g.scopes, ["openid", "email", "profile"]);
  assert.equal(c.allowance.edu.resume_tailor, 10);
  assert.equal(c.allowance.general.resume_tailor, 5);
  // Every paid tier gets its own table, so the dashboard can say what the money buys.
  assert.equal(c.allowance.supporter.autofill, 50);
  assert.equal(c.allowance.pro.autofill, 120);
  assert.equal(c.paused, false);
});

test("tierOf: GENERAL_ALLOWANCE_PCT-independent edge cases", () => {
  assert.equal(tierOf("google", { email: "noatsign", email_verified: true }, {}), "general");
  assert.equal(tierOf("google", { email: "a@edu", email_verified: true }, {}), "general");
  assert.equal(tierOf("google", { email: "A@Mail.UMass.EDU", email_verified: "true" }, {}), "edu");
});

test("user_hash is per provider and hides the subject", async () => {
  const env = { HASH_SALT: "s" };
  const a = await userHash("google", { sub: "123" }, env);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, await userHash("google", { sub: "124" }, env));
  assert.notEqual(a, await userHash("microsoft", { sub: "123" }, env));
});

test("missing HASH_SALT -> 500, not a silent unsalted hash", async () => {
  const w = await setup({ env: { HASH_SALT: "" } });
  const res = await w.api("GET", "/me", { token: await w.token() });
  assert.equal(res.status, 500);
});

test("CORS: allowed origins and extensions only", async () => {
  const w = await setup();
  const origin = (o) => w.api("GET", "/config", { headers: { Origin: o } })
    .then((r) => r.headers.get("Access-Control-Allow-Origin"));
  assert.equal(await origin("https://internscout.org"), "https://internscout.org");
  // Kept through the domain switch, for tabs opened on the old address before it.
  assert.equal(await origin("https://bpmcginley.github.io"), "https://bpmcginley.github.io");
  assert.equal(await origin("chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag"), "chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag");
  // The Web Store copy has its own ID; without it, every AI call from a store install fails CORS.
  assert.equal(await origin("chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi"), "chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi");
  // Only InternScout's own ID: any other extension could otherwise call the API from a student's browser
  assert.equal(await origin("chrome-extension://abcdefg"), null);
  assert.equal(await origin("https://evil.example"), null);
  // wrangler.toml sets ALLOWED_ORIGINS, but a deploy that loses the var falls back to the built-in list,
  // which must carry both extension IDs as well.
  const bare = await setup({ env: { ALLOWED_ORIGINS: undefined } });
  const fallback = (o) => bare.api("GET", "/config", { headers: { Origin: o } })
    .then((r) => r.headers.get("Access-Control-Allow-Origin"));
  for (const id of ["jmjjgnckddhjbohfpbekodkpbpbmfjag", "hpnbbpmalfjijnmpoihhjgjolhabjpgi"]) {
    assert.equal(await fallback("chrome-extension://" + id), "chrome-extension://" + id);
  }
  // ...and the site's own domain, or the dashboard's sign-in and upgrade calls would all fail.
  assert.equal(await fallback("https://internscout.org"), "https://internscout.org");
  const pre = await w.api("OPTIONS", "/ai", { headers: { Origin: "http://localhost:8000" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.match(pre.headers.get("Access-Control-Expose-Headers"), /X-InternScout-Remaining/);
});
