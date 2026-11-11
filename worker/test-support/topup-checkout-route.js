import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { createSession, endSession } from "../src/session.js";
import { attempt, env as stripeEnv, price, reply, session } from "./topup-stripe.js";

const at = new Date("2026-11-11T12:00:00Z");
const site = "https://internscout.org";
const legacy = "https://bpmcginley.github.io";
const checkoutPath = "/billing/topup/checkout";
const settings = { ...stripeEnv, SITE_URL: site };
const account = attempt().user_hash;
const login = (db) =>
  createSession(db, { user: account, tier: "edu", provider: "google" }, new Date(+at - 86400000));
const attempts = (db) => db.prepare("SELECT COUNT(*) AS n FROM topup_checkout_attempts").first("n");
const sessionTimes = (db) => db.prepare("SELECT last_used,expires FROM sessions").first();
const req = ({ origin = site, token, headers = {}, body, query = "", method = "POST" } = {}) =>
  new Request("https://local.invalid" + checkoutPath + query, {
    method,
    headers: {
      ...(origin && { Origin: origin }),
      ...(token && { Authorization: "Bearer " + token }),
      ...headers,
    },
    body,
  });

async function expect(response, code, data) {
  assert.equal(response.status, code);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), data);
}

export async function gatesPrecedeDatabaseAndProvider(db) {
  const { token } = await login(db);
  let fetches = 0;
  const noFetch = async () => {
    fetches++;
    throw new Error("Unexpected synthetic fetch");
  };
  const noDb = { prepare: () => assert.fail("Early route gate must precede D1") };
  const run = (request, config = settings, binding = db) =>
    handle(request, { ...config, DB: binding }, null, {
      now: () => new Date(at),
      fetch: noFetch,
    });
  for (const config of [
    {},
    { ...settings, TOPUPS_ENABLED: true },
    { ...settings, PAYMENTS_ENABLED: "0" },
    { ...settings, STRIPE_SECRET_KEY: "" },
  ]) {
    await expect(await run(req({ token }), config, noDb), 503, { status: "disabled" });
  }
  for (const origin of [
    null,
    "null",
    "https://foreign.invalid",
    "https://internscout.org:8443",
    "http://localhost:8000",
    "chrome-extension://synthetic",
  ]) {
    await expect(
      await run(req({ token, origin }), { ...settings, ALLOWED_ORIGINS: origin || site }, noDb),
      403,
      { status: "unavailable" },
    );
  }
  await expect(await run(req({ token }), { ...settings, ALLOWED_ORIGINS: legacy }, noDb), 403, {
    status: "unavailable",
  });
  for (const request of [
    req(),
    req({ token: "synthetic.provider.token" }),
    req({ token: "iss_invalid" }),
    req({ token: "iss_" + "z".repeat(43) }),
    req({ headers: { Cookie: "session=" + token }, query: "?token=" + token }),
  ]) {
    await expect(await run(request), 401, { status: "auth" });
  }
  for (const config of [
    { ...settings, SITE_URL: "https://foreign.invalid" },
    { ...settings, STRIPE_PRICE_TOPUP: "invalid" },
  ]) {
    await expect(await run(req({ token }), config), 503, { status: "disabled" });
  }
  await db.prepare("UPDATE sessions SET expires=?").bind(at.toISOString()).run();
  await expect(await run(req({ token })), 401, { status: "auth" });
  assert.equal((await run(req({ method: "GET", token }), settings, noDb)).status, 404);
  assert.equal((await run(req({ method: "OPTIONS" }), settings, noDb)).status, 204);
  assert.equal(fetches, 0);
  assert.equal(await attempts(db), 0);
}

export async function verifiedCheckoutAndReplay(db) {
  const { token } = await login(db);
  const before = await sessionTimes(db);
  const calls = [];
  let opened;
  const fetch = async (url, options) => {
    if (url.includes("/prices/")) {
      calls.push("price");
      return reply(price());
    }
    if (options.method === "POST") {
      calls.push("create");
      const form = new URLSearchParams(options.body);
      const id = form.get("metadata[attempt_id]");
      assert.equal(options.headers["Idempotency-Key"], "topup-checkout:" + id);
      assert.equal(form.get("line_items[0][price]"), settings.STRIPE_PRICE_TOPUP);
      assert.equal(form.get("metadata[user_hash]"), account);
      assert.equal(form.get("metadata[units]"), "25");
      assert.equal(form.get("success_url"), site + "/");
      assert.equal(form.get("cancel_url"), site + "/");
      opened = {
        ...session({ ...attempt(), id }),
        success_url: site + "/",
        cancel_url: site + "/",
      };
      return reply(opened);
    }
    calls.push("open");
    assert.match(url, /\/checkout\/sessions\/cs_fixture\?/);
    return reply(opened);
  };
  const run = (request) =>
    handle(request, { ...settings, DB: db }, null, { now: () => new Date(at), fetch });
  const request = req({
    token,
    query: "?return=https://foreign.invalid/",
    body: JSON.stringify({ amount: 1, units: 99, callback: "https://foreign.invalid" }),
  });
  const first = await run(request);
  assert.equal(first.headers.get("Access-Control-Allow-Origin"), site);
  await expect(first, 200, { status: "open", url: session().url });
  assert.equal(request.bodyUsed, false);
  const repeat = await run(req({ origin: legacy, token }));
  assert.equal(repeat.headers.get("Access-Control-Allow-Origin"), legacy);
  await expect(repeat, 200, { status: "open", url: session().url });
  assert.deepEqual(calls, ["price", "create", "open", "price", "open"]);
  assert.equal(await attempts(db), 1);
  assert.deepEqual(await sessionTimes(db), before);
}

export async function expiryDuringPricePreventsReservation(db) {
  const { token } = await login(db);
  const expires = new Date(+at + 50);
  await db.prepare("UPDATE sessions SET expires=?").bind(expires.toISOString()).run();
  const before = await sessionTimes(db);
  let now = at;
  const calls = [];
  const result = await handle(req({ token }), { ...settings, DB: db }, null, {
    now: () => now,
    fetch: async (url) => {
      calls.push(url.includes("/prices/") ? "price" : "unexpected");
      now = expires;
      return reply(price());
    },
  });
  await expect(result, 401, { status: "auth" });
  assert.deepEqual(calls, ["price"]);
  assert.equal(await attempts(db), 0);
  assert.deepEqual(await sessionTimes(db), before);
}

export async function revocationDuringPricePreventsReservation(db) {
  const { token } = await login(db);
  const calls = [];
  const result = await handle(req({ token }), { ...settings, DB: db }, null, {
    now: () => new Date(at),
    fetch: async (url) => {
      calls.push(url.includes("/prices/") ? "price" : "unexpected");
      await endSession(db, token);
      return reply(price());
    },
  });
  await expect(result, 401, { status: "auth" });
  assert.deepEqual(calls, ["price"]);
  assert.equal(await attempts(db), 0);
}
