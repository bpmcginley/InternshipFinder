import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { createSession, endSession } from "../src/session.js";
import { attempt, env as stripeEnv, price, reply, session } from "./topup-stripe.js";

const at = new Date("2026-11-11T12:00:00Z");
const site = "https://internscout.org";
const legacy = "https://bpmcginley.github.io";
const checkoutPath = "/billing/topup/checkout";
const offerPath = "/billing/topup/offer";
const settings = {
  ...stripeEnv,
  SITE_URL: site,
  FUNDED_RUNS_MODE: "create",
  FUNDED_PURCHASES: "1",
  FUNDED_RESPONSE_MAX_BYTES: "16384",
  FUNDED_RESPONSE_EVENT_BYTES: "8192",
  FUNDED_RESPONSE_DEADLINE_MS: "5000",
};
const account = attempt().user_hash;
const login = (db) =>
  createSession(db, { user: account, tier: "edu", provider: "google" }, new Date(+at - 86400000));
const attempts = (db) => db.prepare("SELECT COUNT(*) AS n FROM topup_checkout_attempts").first("n");
const sessionTimes = (db) => db.prepare("SELECT last_used,expires FROM sessions").first();
const req = ({
  origin = site,
  token,
  headers = {},
  body,
  query = "",
  method = "POST",
  path = checkoutPath,
} = {}) =>
  new Request("https://local.invalid" + path + query, {
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

const offerRequest = (options = {}) => req({ path: offerPath, method: "GET", ...options });

export async function offerIsVerifiedAndContainsOnlyDisplayTerms(db) {
  const { token } = await login(db);
  const before = await sessionTimes(db);
  let priceReads = 0;
  const run = (request, config = settings) =>
    handle(request, { ...config, DB: db }, null, {
      now: () => at,
      fetch: async (url, options) => {
        assert.match(url, /^https:\/\/api\.stripe\.com\/v1\/prices\//);
        assert.equal(options.method, "GET");
        priceReads++;
        return reply(price());
      },
    });
  const config = req({ method: "GET", path: "/config" });
  const off = await (await run(config, {})).json();
  assert.equal(Object.hasOwn(off, "topups"), false);
  const hinted = await (await run(config)).json();
  assert.equal(hinted.topups, true);
  assert.equal(JSON.stringify(hinted).includes(settings.STRIPE_PRICE_TOPUP), false);
  assert.equal(priceReads, 0);

  const display = { enabled: true, offer: { amount: 300, currency: "usd", units: 25 } };
  for (const origin of [site, legacy]) {
    const response = await run(offerRequest({ token, origin, query: "?amount=1&units=99" }));
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    await expect(response, 200, display);
  }
  assert.equal(priceReads, 2);
  assert.equal(await attempts(db), 0);
  assert.deepEqual(await sessionTimes(db), before);
}

export async function offerGatesRejectBeforeAnyPriceRead(db) {
  const { token } = await login(db);
  let providerCalls = 0;
  const noDb = { prepare: () => assert.fail("Early offer gate must precede D1") };
  const run = (request, config = settings, binding = db) =>
    handle(request, { ...config, DB: binding }, null, {
      now: () => at,
      fetch: async () => {
        providerCalls++;
        return reply(price());
      },
    });
  for (const config of [{}, { ...settings, STRIPE_PRICE_TOPUP: "invalid" }])
    await expect(await run(offerRequest({ token }), config, noDb), 503, { status: "disabled" });
  for (const origin of [null, "https://foreign.invalid"])
    await expect(await run(offerRequest({ token, origin }), settings, noDb), 403, {
      status: "unavailable",
    });
  for (const request of [
    offerRequest({ token: "synthetic.provider.token" }),
    offerRequest({ headers: { Cookie: "session=" + token }, query: "?token=" + token }),
  ])
    await expect(await run(request, settings, noDb), 401, { status: "auth" });
  for (const config of [
    { ...settings, MONTHLY_BUDGET_CENTS: "0" },
    { ...settings, GLOBAL_RPM: "0" },
  ]) {
    await expect(await run(offerRequest({ token }), config), 503, { status: "disabled" });
    await expect(await run(req({ token }), config), 503, { status: "disabled" });
  }
  assert.equal(providerCalls, 0);
  assert.equal(await attempts(db), 0);
}

export async function offerRefusesUnverifiedOrRevokedPriceResults(db) {
  const { token } = await login(db);
  const expires = new Date(+at + 50);
  await db.prepare("UPDATE sessions SET expires=?").bind(expires.toISOString()).run();
  let now = at;
  const run = (fetch) =>
    handle(offerRequest({ token }), { ...settings, DB: db }, null, {
      now: () => now,
      fetch,
    });
  await expect(await run(async () => reply({ ...price(), active: false })), 503, {
    status: "disabled",
  });
  await expect(
    await run(async () => {
      now = expires;
      return reply(price());
    }),
    401,
    { status: "auth" },
  );
  now = at;
  await expect(
    await run(async () => {
      await endSession(db, token);
      return reply(price());
    }),
    401,
    { status: "auth" },
  );
  assert.equal(await attempts(db), 0);
}

export async function pauseDuringPriceBlocksOfferAndCheckout(db) {
  const { token } = await login(db);
  const env = { ...settings, DAILY_BUDGET_CENTS: "1", DB: db };
  const day = at.toISOString().slice(0, 10);
  let priceReads = 0;
  for (const request of [offerRequest({ token }), req({ token })]) {
    const response = await handle(request, env, null, {
      now: () => at,
      fetch: async (url, options) => {
        assert.match(url, /\/prices\//);
        assert.equal(options.method, "GET");
        priceReads++;
        await db
          .prepare("INSERT INTO spend (user_hash,month,cents) VALUES ('*',?,1)")
          .bind(day)
          .run();
        return reply(price());
      },
    });
    await expect(response, 503, { status: "disabled" });
    await db.prepare("DELETE FROM spend WHERE user_hash='*' AND month=?").bind(day).run();
  }
  assert.equal(priceReads, 2);
  assert.equal(await attempts(db), 0);
}

export async function unusableFundedConfigurationClosesEverySalesSurface(db) {
  const { token } = await login(db);
  const before = await sessionTimes(db);
  let providerCalls = 0;
  const run = (request, patch) =>
    handle(request, { ...settings, ...patch, DB: db }, null, {
      now: () => at,
      fetch: async () => {
        providerCalls++;
        throw new Error("Synthetic provider must not be reached");
      },
    });
  for (const patch of [
    { FUNDED_RUNS_MODE: undefined },
    { FUNDED_RUNS_MODE: "legacy" },
    { FUNDED_RUNS_MODE: "drain" },
    { FUNDED_RUNS_MODE: "unknown" },
    { FUNDED_PURCHASES: undefined },
    { FUNDED_PURCHASES: "0" },
    { FUNDED_PURCHASES: 1 },
    { FUNDED_RESPONSE_MAX_BYTES: undefined },
    { FUNDED_RESPONSE_MAX_BYTES: "9007199254740992" },
    { FUNDED_RESPONSE_EVENT_BYTES: "0" },
    { FUNDED_RESPONSE_EVENT_BYTES: "16385" },
    { FUNDED_RESPONSE_DEADLINE_MS: "05" },
    { FUNDED_RESPONSE_DEADLINE_MS: "2147483648" },
  ]) {
    const config = await run(req({ method: "GET", path: "/config" }), patch);
    assert.equal(config.status, 200);
    assert.equal(Object.hasOwn(await config.json(), "topups"), false, JSON.stringify(patch));
    await expect(await run(offerRequest({ token }), patch), 503, { status: "disabled" });
    await expect(await run(req({ token }), patch), 503, { status: "disabled" });
  }
  assert.equal(providerCalls, 0);
  assert.equal(await attempts(db), 0);
  assert.deepEqual(await sessionTimes(db), before);
}

export async function fundedConfigurationClosedDuringPriceRefusesTheOfferAndCheckout(db) {
  const { token } = await login(db);
  const before = await sessionTimes(db);
  const calls = [];
  for (const patch of [
    { FUNDED_RUNS_MODE: "legacy" },
    { FUNDED_RUNS_MODE: "drain" },
    { FUNDED_PURCHASES: "0" },
    { FUNDED_RESPONSE_EVENT_BYTES: "16385" },
  ]) {
    for (const request of [offerRequest({ token }), req({ token })]) {
      const env = { ...settings, DB: db };
      const response = await handle(request, env, null, {
        now: () => at,
        fetch: async (url, options) => {
          calls.push(options.method);
          assert.match(url, /\/prices\//);
          Object.assign(env, patch);
          return reply(price());
        },
      });
      await expect(response, 503, { status: "disabled" });
    }
  }
  assert.deepEqual(calls, Array(8).fill("GET"));
  assert.equal(await attempts(db), 0);
  assert.deepEqual(await sessionTimes(db), before);
}

export async function fundedConfigurationRecheckedAfterAccountReads(db) {
  const { token } = await login(db);
  for (const stopAfter of [1, 2]) {
    const env = { ...settings };
    let planReads = 0;
    let priceReads = 0;
    env.DB = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!/\bFROM plans\b/.test(sql)) return statement;
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              async first(...args) {
                const result = await bound.first(...args);
                if (++planReads === stopAfter) env.FUNDED_PURCHASES = "0";
                return result;
              },
            };
          },
        };
      },
    };
    const response = await handle(req({ token }), env, null, {
      now: () => at,
      fetch: async (url, options) => {
        assert.match(url, /\/prices\//);
        assert.equal(options.method, "GET");
        priceReads++;
        return reply(price());
      },
    });
    await expect(response, 503, { status: "disabled" });
    assert.equal(planReads, stopAfter);
    assert.equal(priceReads, stopAfter - 1);
  }
  assert.equal(await attempts(db), 0);
}
