// All replies are synthetic. Native Request validates the actual workerd option contract.
import { expect, it } from "vitest";
import fixture from "../test/fixtures/follow-archive-python.json";
import { createFollowArchiveReader } from "../src/follow-archive-reader.js";
import { readTopupPaymentEvidence } from "../src/topup-payment-evidence.js";
import { readTopupReversalEvidence } from "../src/topup-reversal-evidence.js";
import { prepareTopupStripe } from "../src/topup-stripe.js";
import { env, callbacks, attempt, price, session, reply } from "../test-support/topup-stripe.js";
const indexUrl = "https://archive.example.test/data/follows/index.json";
const offer = {
  version: "topup-v1",
  priceId: "price_fixture",
  amount: 300,
  currency: "usd",
  units: 25,
  livemode: false,
};
const row = () => ({ ...attempt(), state: "open", checkout_id: "cs_fixture" });
const redirect = () =>
  new Response(null, { status: 302, headers: { Location: "https://example.invalid/never" } });
function native(replyTo, origin = "https://api.stripe.com") {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      const request = new Request(url, options);
      expect(request.redirect).toBe("manual");
      expect(new URL(request.url).origin).toBe(origin);
      expect(request.headers.get("Cookie")).toBeNull();
      expect(request.headers.get("Authorization")).toBe(
        origin === "https://api.stripe.com" ? "Bearer fixture-not-a-key" : null,
      );
      calls.push({
        url: request.url,
        method: request.method,
        key: request.headers.get("Idempotency-Key"),
      });
      return replyTo(request);
    },
  };
}
function archive(fetch) {
  return createFollowArchiveReader({
    indexUrl,
    fetch,
    clock: () => new Date("2028-01-03T00:00:00.000Z"),
    bounds: {
      maxManifestBytes: 3000,
      maxEntries: 5,
      maxArchiveBytes: 40000,
      maxEnqueueAgeMs: 86400000,
      publishMarginMs: 86400000,
      deadlineMs: 1000,
    },
    catalog: { companies: new Set(["fixture"]), fields: new Set(["swe"]), states: new Set(["MA"]) },
    limits: {
      maxBytes: 8000,
      maxRoles: 10,
      maxFollows: 10,
      maxMatches: 10,
      maxResultBytes: 8000,
      maxTextBytes: 2000,
      maxWindowMs: 3 * 86400000,
    },
  });
}
it("native archive requests stay on the configured origin and refuse redirects", async () => {
  const transport = native(
    (r) => new Response(fixture.files[new URL(r.url).pathname.slice(1)]),
    "https://archive.example.test",
  );
  expect(
    (await archive(transport.fetch).latest({ effectiveLower: "2028-01-01T00:00:00.000Z" })).status,
  ).toBe("ready");
  expect(transport.calls.length).toBe(2);
  const blocked = native(redirect, "https://archive.example.test");
  expect(
    (await archive(blocked.fetch).latest({ effectiveLower: "2028-01-01T00:00:00.000Z" })).status,
  ).toBe("unavailable");
  expect(blocked.calls.length).toBe(1);
});
it("native payment-evidence GET can verify expiry and a redirect yields no evidence", async () => {
  const transport = native(() =>
    reply({
      ...session(),
      status: "expired",
      payment_status: "unpaid",
      payment_intent: null,
      recovered_from: null,
    }),
  );
  expect((await readTopupPaymentEvidence(env, row(), offer, transport.fetch)).status).toBe(
    "expired_evidence",
  );
  expect(transport.calls).toEqual([
    {
      url: "https://api.stripe.com/v1/checkout/sessions/cs_fixture?expand[]=line_items",
      method: "GET",
      key: null,
    },
  ]);
  const blocked = native(redirect);
  expect(await readTopupPaymentEvidence(env, row(), offer, blocked.fetch)).toEqual({
    status: "pending",
  });
  expect(blocked.calls.length).toBe(1);
});
it("native reversal GETs preserve complete passes and reject a redirect", async () => {
  const payment = {
    status: "paid_evidence",
    paymentId: "pi_fixture",
    chargeId: "ch_fixture",
    checkoutId: "cs_fixture",
    capturedAmount: 327,
    currency: "usd",
    livemode: false,
  };
  const transport = native((r) => {
    const path = new URL(r.url).pathname;
    if (path === "/v1/charges/ch_fixture")
      return reply({
        object: "charge",
        id: "ch_fixture",
        payment_intent: "pi_fixture",
        currency: "usd",
        livemode: false,
        status: "succeeded",
        paid: true,
        captured: true,
        amount: 327,
        amount_captured: 327,
        amount_refunded: 0,
        refunded: false,
        disputed: false,
      });
    expect(["/v1/refunds", "/v1/disputes"]).toContain(path);
    return reply({ object: "list", url: path, has_more: false, data: [] });
  });
  expect((await readTopupReversalEvidence(env, payment, transport.fetch)).status).toBe(
    "reversal_evidence",
  );
  expect(transport.calls.length).toBe(6);
  expect(transport.calls.every((c) => c.method === "GET" && c.key === null)).toBe(true);
  const blocked = native(redirect);
  expect(await readTopupReversalEvidence(env, payment, blocked.fetch)).toEqual({
    status: "pending",
  });
  expect(blocked.calls.length).toBe(1);
});
it("native checkout price/create/open use one POST and redirects never produce an URL", async () => {
  let block = false;
  const transport = native((r) =>
    block ? redirect() : reply(r.url.includes("/prices/") ? price() : session()),
  );
  const adapter = await prepareTopupStripe(env, callbacks, transport.fetch);
  expect(adapter.enabled).toBe(true);
  expect((await adapter.create(attempt())).status).toBe("open");
  expect((await adapter.readOpen(row())).checkoutId).toBe("cs_fixture");
  expect(transport.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  expect(transport.calls[1].key).toBe(attempt().idempotencyKey);
  block = true;
  await expect(adapter.create(attempt())).rejects.toThrow("Top-up checkout is unavailable");
  expect(transport.calls.length).toBe(4);
  await expect(adapter.readOpen(row())).rejects.toThrow("Top-up checkout is unavailable");
  expect(transport.calls.length).toBe(5);
  expect(await prepareTopupStripe(env, callbacks, transport.fetch)).toEqual({ enabled: false });
  expect(transport.calls.length).toBe(6);
});
