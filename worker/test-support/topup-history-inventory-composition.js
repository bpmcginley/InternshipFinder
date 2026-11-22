import assert from "node:assert/strict";
import { inventoryTopupHistory } from "../src/topup-history-inventory.js";
import { createTopupHistoryPageReader } from "../src/topup-history-page.js";

const NOW = Date.parse("2026-11-12T12:00:00Z"),
  TO = NOW / 1000,
  FROM = TO - 60;
const REQUEST_VERSION = "2026-01-01",
  EVENT_VERSION = "2025-12-01";
const POLICY = Object.freeze({
  method: "GET",
  redirect: "manual",
  credentials: "omit",
  cache: "no-store",
});
const denied = { status: "unavailable" };
const event = (extra = {}) => ({
  object: "event",
  id: "evt_synthetic",
  created: FROM,
  livemode: false,
  api_version: EVENT_VERSION,
  type: "refund.created",
  data: { object: { object: "refund", metadata: { fixture: "never_return" } } },
  ...extra,
});
const page = (data = [], has_more = false) => ({
  object: "list",
  url: "/v1/events",
  data,
  has_more,
});
const reply = (url, value, init) => {
  const response = new Response(
    typeof value === "string" || value instanceof Uint8Array || value instanceof ReadableStream
      ? value
      : JSON.stringify(value),
    init,
  );
  Object.defineProperty(response, "url", { value: url });
  return response;
};

// Test-only authenticated transport composition. No real credential or fetch call.
function compose(
  transport,
  {
    enabled = true,
    clock = () => NOW,
    limits,
    policy = POLICY,
    requestVersion = REQUEST_VERSION,
    input = {},
  } = {},
) {
  return inventoryTopupHistory(
    { from: FROM, to: TO, livemode: false, apiVersions: [EVENT_VERSION], ...input },
    {
      enabled,
      clock,
      limits,
      requestPolicy: policy,
      readPage(query, signal, requestPolicy) {
        const reader = createTopupHistoryPageReader({
          enabled: true,
          requestVersion,
          request(url, init) {
            assert.equal(requestPolicy.method, init.method);
            assert.equal(requestPolicy.redirect, init.redirect);
            assert.ok(
              Object.isFrozen(query) &&
                Object.isFrozen(query.created) &&
                Object.isFrozen(requestPolicy),
            );
            assert.ok(Object.isFrozen(init) && Object.isFrozen(init.headers));
            return transport(url, {
              ...init,
              credentials: requestPolicy.credentials,
              cache: requestPolicy.cache,
              headers: { ...init.headers, Authorization: "Bearer synthetic_fixture_only" },
            });
          },
        });
        return reader(query, signal);
      },
    },
  );
}

export async function exactPolicyCursorAndHistoricalSchemaCompose() {
  const calls = [];
  let transportAssertion;
  const result = await compose(async (url, init) => {
    try {
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, "https://api.stripe.com/v1/events");
      assert.equal(parsed.searchParams.get("created[gte]"), String(FROM));
      assert.equal(parsed.searchParams.get("created[lt]"), String(TO));
      assert.equal(parsed.searchParams.get("limit"), "100");
      assert.equal(
        parsed.searchParams.get("starting_after"),
        calls.length ? "evt_synthetic" : null,
      );
      assert.equal([...parsed.searchParams].length, calls.length ? 4 : 3);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(init.cache, "no-store");
      assert.equal(init.credentials, "omit");
      assert.equal(init.body, undefined);
      assert.deepEqual(init.headers, {
        "Stripe-Version": REQUEST_VERSION,
        Authorization: "Bearer synthetic_fixture_only",
      });
      const native = new Request(url, init);
      assert.equal(native.method, "GET");
      assert.equal(native.redirect, "manual");
      if ("credentials" in native) assert.equal(native.credentials, "omit");
      assert.equal(native.cache, "no-store");
      assert.equal(init.signal.aborted, false);
      calls.push(init.signal);
      return reply(
        url,
        page(
          [event(calls.length === 1 ? {} : { id: "evt_next", api_version: REQUEST_VERSION })],
          calls.length === 1,
        ),
      );
    } catch (error) {
      transportAssertion = error;
      throw error;
    }
  });
  if (transportAssertion) throw transportAssertion;
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.deepEqual(result, {
    status: "observed_inventory",
    pages: 2,
    events: 2,
    families: { refund: 2, dispute: 0, charge: 0, other: 0 },
    schemas: [1],
    unknownSchema: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /evt_|fixture|2025|2026|Bearer/);
}

export async function disabledInvalidPolicyAndRequestVersionNeverInvokeTransport() {
  let calls = 0;
  const never = async () => {
    calls++;
    throw Error("must not call");
  };
  assert.deepEqual(await compose(never, { enabled: false }), { status: "disabled" });
  for (const change of [
    { policy: { ...POLICY, credentials: "include" } },
    { policy: { ...POLICY, redirect: "follow" } },
    { policy: { ...POLICY, cache: "default" } },
    { requestVersion: undefined },
    { requestVersion: "2026-02-30" },
    { input: { apiVersions: [] } },
    { input: { livemode: undefined } },
  ]) {
    // Explicit missing version must reach the adapter rather than fixture defaulting.
    if (Object.hasOwn(change, "requestVersion") && change.requestVersion === undefined)
      change.requestVersion = null;
    assert.deepEqual(await compose(never, change), denied);
  }
  assert.equal(calls, 0);
}

export async function knownSchemaSlotsDoNotCertifyModeAccountOrObject() {
  for (const extra of [
    { livemode: true },
    { account: "acct_synthetic" },
    { context: "ctx_synthetic" },
    { data: { object: { object: "customer" } } },
  ]) {
    let calls = 0;
    assert.deepEqual(
      await compose(async (url) => {
        calls++;
        return reply(url, page([event(extra)]));
      }),
      denied,
    );
    assert.equal(calls, 1);
  }
  const result = await compose(async (url) =>
    reply(url, page([event({ type: "unknown_sensitive.updated", api_version: "unknown_schema" })])),
  );
  assert.equal(result.families.other, 1);
  assert.equal(result.unknownSchema, 1);
  assert.doesNotMatch(JSON.stringify(result), /unknown_sensitive|unknown_schema/);
}

export async function exactResponseAndRedirectChecksDiscardBody() {
  for (const fault of ["status", "url", "redirect"]) {
    let canceled = 0,
      calls = 0;
    assert.deepEqual(
      await compose(async (url) => {
        calls++;
        const value = reply(
          fault === "url" ? url + "&changed=1" : url,
          new ReadableStream({
            cancel() {
              canceled++;
            },
          }),
          { status: fault === "status" ? 302 : 200 },
        );
        if (fault === "redirect") Object.defineProperty(value, "redirected", { value: true });
        return value;
      }),
      denied,
    );
    assert.equal(canceled, 1);
    assert.equal(calls, 1);
  }
}

export async function partialPagesNeverReturnCountsOrRetry() {
  for (const fault of ["invalid", "duplicate", "empty", "throw"]) {
    let calls = 0;
    assert.deepEqual(
      await compose(async (url) => {
        if (++calls === 1) return reply(url, page([event()], true));
        if (fault === "throw") throw Error("synthetic transport error");
        return reply(url, fault === "invalid" ? "{" : page(fault === "empty" ? [] : [event()]));
      }),
      denied,
    );
    assert.equal(calls, 2);
  }
}

export async function adapterAndInventoryKeepExactStreamBounds() {
  const raw = JSON.stringify(page([event()])),
    size = new TextEncoder().encode(raw).length;
  assert.equal(
    (
      await compose(async (url) => reply(url, raw), {
        limits: { bodyBytes: size, totalBytes: size },
      })
    ).events,
    1,
  );
  for (const limits of [{ bodyBytes: size - 1 }, { totalBytes: size - 1 }])
    assert.deepEqual(await compose(async (url) => reply(url, raw), { limits }), denied);
  for (const raw of [
    new Uint8Array([255]),
    '{"object":"list","object":"list","url":"/v1/events","data":[],"has_more":false}',
  ])
    assert.deepEqual(await compose(async (url) => reply(url, raw)), denied);
  let calls = 0;
  assert.deepEqual(
    await compose(async (url) => reply(url, page([event({ id: "evt_" + ++calls })], true)), {
      limits: { pages: 2 },
    }),
    denied,
  );
  assert.equal(calls, 2);
}

export async function elapsedDeadlineAfterTransportCancelsWithoutFollowup() {
  let time = NOW,
    calls = 0,
    canceled = 0;
  assert.deepEqual(
    await compose(
      async (url) => {
        calls++;
        time += 100;
        return reply(
          url,
          new ReadableStream({
            cancel() {
              canceled++;
            },
          }),
        );
      },
      { clock: () => time, limits: { timeoutMs: 50 } },
    ),
    denied,
  );
  assert.equal(calls, 1);
  assert.equal(canceled, 1);
}

export async function noncooperativeTransportLateResponseIsDiscarded() {
  let resolve,
    calls = 0,
    canceled = 0,
    captured;
  const pending = new Promise((r) => {
    resolve = r;
  });
  assert.deepEqual(
    await compose(
      async (url, init) => {
        calls++;
        captured = { url, signal: init.signal };
        return pending;
      },
      { limits: { timeoutMs: 10 } },
    ),
    denied,
  );
  assert.equal(captured.signal.aborted, true);
  resolve(
    reply(
      captured.url,
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(canceled, 1);
  assert.equal(calls, 1);
}

export async function noncooperativeBodyCancellationReleasesReader() {
  let reject,
    canceled = 0;
  const stream = new ReadableStream(
    {
      pull() {
        return new Promise((_, r) => {
          reject = r;
        });
      },
      cancel() {
        canceled++;
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(
    await compose(async (url) => reply(url, stream), { limits: { timeoutMs: 10 } }),
    denied,
  );
  assert.equal(canceled, 1);
  assert.equal(stream.locked, false);
  reject(Error("synthetic late read rejection"));
  await new Promise((r) => setTimeout(r, 0));
}

export async function emptyTerminalListIsOnlyObservedInventory() {
  const result = await compose(async (url) => reply(url, page()));
  assert.equal(result.status, "observed_inventory");
  assert.equal(result.events, 0);
  assert.deepEqual(Object.keys(result).sort(), [
    "events",
    "families",
    "pages",
    "schemas",
    "status",
    "unknownSchema",
  ]);
}
