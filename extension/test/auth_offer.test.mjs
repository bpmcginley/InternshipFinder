// U8 (2026-10-14 UX audit): the extension can take the sign-in the student already did on the dashboard,
// without trusting the page: right origin only, session-shaped tokens only, checked with the Worker,
// never over an existing sign-in, and used only when the student presses the button.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const local = {}, session = {};
const area = (d) => ({
  async get(k) { return typeof k === "string" ? { [k]: d[k] } : Object.fromEntries([].concat(k).map((x) => [x, d[x]])); },
  async set(o) { for (const [k, v] of Object.entries(o)) d[k] = JSON.parse(JSON.stringify(v)); },
  async remove(k) { for (const x of [].concat(k)) delete d[x]; },
});
globalThis.chrome = { runtime: {}, storage: { local: area(local), session: area(session) } };
const clear = () => { for (const d of [local, session]) for (const k of Object.keys(d)) delete d[k]; };

const auth = await import("../lib/auth.js");
const { WORKER_URL } = await import("../lib/config.js");
const index = readFileSync(new URL("../background/index.js", import.meta.url), "utf8");

const NOW = Date.UTC(2026, 9, 14, 12);
const TOKEN = "iss_" + "a".repeat(43);
const REPLY = { account: "3f2a9c0d1e5b7a64", provider: "google", tier: "edu", expires: "2027-10-14T12:00:00.000Z" };
// A fake Worker: GET /session answers `reply` with `status`, and every call is recorded.
function worker(status = 200, reply = REPLY) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url, method: init.method || "GET", auth: init.headers && init.headers.authorization }); return { status, json: async () => reply }; };
  f.calls = calls;
  return f;
}

test("only a token shaped like a Worker session is considered", () => {
  assert.equal(auth.offerTokenOk(TOKEN), true);
  for (const t of [null, 42, "", "iss_short", "iss_" + "a".repeat(44), "eyJhbGciOi.x.y", TOKEN + "\n", "iss_" + "a".repeat(42) + "!"]) assert.equal(auth.offerTokenOk(t), false, String(t));
});

test("the record comes from the Worker's reply alone, with no email", () => {
  assert.deepEqual(auth.offeredRecord(TOKEN, { ...REPLY, email: "attacker@example.com" }, NOW),
    { token: TOKEN, account: REPLY.account, email: "", provider: "google", tier: "edu", expires: REPLY.expires });
  assert.equal(auth.offeredRecord(TOKEN, { ...REPLY, expires: "2026-10-01T00:00:00Z" }, NOW), null, "already expired");
  assert.equal(auth.offeredRecord(TOKEN, { ...REPLY, account: "<script>" }, NOW), null);
  assert.equal(auth.offeredRecord(TOKEN, null, NOW), null);
  assert.equal(auth.offeredRecord(TOKEN, { ...REPLY, provider: "evil", tier: "pro" }, NOW).provider, null);
});

test("checkSession asks GET /session on the Worker with the token, and anything but 200 is no", async () => {
  const ok = worker();
  assert.equal((await auth.checkSession(TOKEN, ok, NOW)).account, REPLY.account);
  assert.deepEqual(ok.calls, [{ url: `${WORKER_URL}/session`, method: "GET", auth: `Bearer ${TOKEN}` }]);
  for (const status of [401, 404, 500]) assert.equal(await auth.checkSession(TOKEN, worker(status), NOW), null, String(status));
  assert.equal(await auth.checkSession(TOKEN, async () => { throw new Error("offline"); }, NOW), null);
  const never = worker();
  assert.equal(await auth.checkSession("not-a-session", never, NOW), null);
  assert.equal(never.calls.length, 0, "a token of the wrong shape never leaves the extension");
});

test("an offer is kept aside only when the Worker says it is live and the extension is signed out", async () => {
  clear();
  assert.equal(await auth.holdOffer(TOKEN, worker(401), NOW), false);
  assert.equal(session[auth.OFFER_KEY], undefined);
  assert.equal(await auth.holdOffer(TOKEN, worker(), NOW), true);
  assert.deepEqual(session[auth.OFFER_KEY], { token: TOKEN, at: NOW });
  assert.equal(local[auth.SESSION_KEY], undefined, "holding an offer signs nothing in");
  assert.equal(await auth.offerWaiting(NOW + 60e3), true);
  assert.equal(await auth.offerWaiting(NOW + auth.OFFER_TTL_MS), false, "ten minutes, then it is gone");
  // Signed in already: never replaced, and the Worker isn't even asked.
  clear();
  local[auth.SESSION_KEY] = { token: "iss_" + "b".repeat(43), account: "1111111111111111", email: "me@umass.edu", expires: "2027-10-01T00:00:00Z" };
  const w = worker();
  assert.equal(await auth.holdOffer(TOKEN, w, Date.now()), false);
  assert.equal(w.calls.length, 0);
  assert.equal(await auth.offerWaiting(), false);
  assert.equal(local[auth.SESSION_KEY].email, "me@umass.edu", "the existing sign-in is untouched");
});

const OWN = "iss_" + "c".repeat(43);
const COPY = { ...REPLY, session: OWN };

test("copySessionFrom asks POST /session/copy and keeps only the new session", async () => {
  const ok = worker(200, COPY);
  assert.deepEqual(await auth.copySessionFrom(TOKEN, ok, NOW), { token: OWN, account: REPLY.account, email: "", provider: "google", tier: "edu", expires: REPLY.expires });
  assert.deepEqual(ok.calls, [{ url: `${WORKER_URL}/session/copy`, method: "POST", auth: `Bearer ${TOKEN}` }]);
  for (const status of [401, 404, 409, 500]) assert.equal(await auth.copySessionFrom(TOKEN, worker(status, COPY), NOW), null, String(status));
  assert.equal(await auth.copySessionFrom(TOKEN, worker(200, { ...REPLY, session: TOKEN }), NOW), null, "the same token back is not a copy");
  assert.equal(await auth.copySessionFrom(TOKEN, worker(200, { ...REPLY, session: "nope" }), NOW), null);
  assert.equal(await auth.copySessionFrom(TOKEN, async () => { throw new Error("offline"); }, NOW), null);
});

test("accepting trades the offer for the extension's own session, keeps the Worker's record, and works once", async () => {
  clear();
  const now = Date.now();
  await auth.holdOffer(TOKEN, worker(), now);
  const w = worker(200, COPY);
  assert.deepEqual(await auth.acceptOffer(w, now + 1000), { ok: true });
  assert.deepEqual(w.calls.map((c) => [c.method, c.url]), [["POST", `${WORKER_URL}/session/copy`]], "traded at the moment of use");
  assert.deepEqual(local[auth.SESSION_KEY], { token: OWN, account: REPLY.account, email: "", provider: "google", tier: "edu", expires: REPLY.expires });
  assert.equal(await auth.getToken(), OWN, "never the dashboard's token");
  assert.equal(session[auth.OFFER_KEY], undefined, "used up");
  // Signed out on the dashboard between the offer and the press: refused, nothing kept.
  clear();
  await auth.holdOffer(TOKEN, worker(), now);
  const r = await auth.acceptOffer(worker(401), now + 1000);
  assert.match(r.error, /Sign in with Google or Microsoft instead/);
  assert.equal(local[auth.SESSION_KEY], undefined);
  // Nothing waiting, or too old.
  clear();
  assert.ok((await auth.acceptOffer(worker(), now)).error);
  session[auth.OFFER_KEY] = { token: TOKEN, at: now - auth.OFFER_TTL_MS };
  assert.ok((await auth.acceptOffer(worker(), now)).error);
  assert.equal(local[auth.SESSION_KEY], undefined);
});

test("the background takes an offer only from the real dashboard, and accepting is for extension pages only", () => {
  const allowed = index.slice(index.indexOf("const PAGE_ALLOWED"), index.indexOf("]);", index.indexOf("const PAGE_ALLOWED")));
  assert.ok(allowed.includes('"auth:offer"'));
  assert.ok(!allowed.includes('"auth:accept_offer"') && !allowed.includes('"auth:offer_status"'));
  const offer = index.slice(index.indexOf('case "auth:offer":'), index.indexOf('case "auth:offer_status":'));
  assert.match(offer, /if \(!fromPage \|\| !trustedDashboard\(sender, !chrome\.runtime\.getManifest\(\)\.update_url\)\) return \{ ok: false \};/);
  assert.match(offer, /return \{ ok: await holdOffer\(/);
  assert.doesNotMatch(offer, /token:|email|authBridge/, "the reply carries nothing back to the page");
});

test("trustedDashboard: internscout.org only, and a local copy only on an unpacked build", () => {
  assert.equal(auth.trustedDashboard({ origin: "https://internscout.org" }, false), true);
  assert.equal(auth.trustedDashboard({ origin: "https://internscout.org.evil.com" }, false), false);
  assert.equal(auth.trustedDashboard({ origin: "https://bpmcginley.github.io" }, false), false);
  assert.equal(auth.trustedDashboard({ origin: "http://localhost:8000" }, false), false);
  assert.equal(auth.trustedDashboard({ origin: "http://localhost:8000" }, true), true);
});

test("the setup page shows 'Use my dashboard sign-in' only for a waiting offer, and accepting is a press", () => {
  const onb = readFileSync(new URL("../onboarding/onboarding.js", import.meta.url), "utf8");
  assert.match(onb, /\$\{dashOffer \? `<button class="btn primary" data-signin="dashboard">Use my dashboard sign-in<\/button>` : ""\}/);
  assert.match(onb, /type: "auth:offer_status"/);
  assert.match(onb, /dash \? \{ type: "auth:accept_offer" \} : \{ type: "auth:signin", provider: b\.dataset\.signin \}/);
  assert.equal(onb.split('type: "auth:accept_offer"').length, 2, "from that button only");
});
