import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.js";
import { prepareTopupStripe, TOPUP_CHECKOUT_BOUNDS as B } from "../src/topup-stripe.js";
import { env, callbacks, price, reply, attempt } from "../test-support/topup-stripe.js";
import {
  deferred,
  delayedBody,
  timeoutReservation,
} from "../test-support/topup-checkout-bounds.js";
const unavailable = { message: "Top-up checkout is unavailable" };
for (const mode of ["fetch", "body", "revoked"])
  test(`checkout timeout preserves unresolved reservation: ${mode}`, () =>
    timeoutReservation(fakeD1(), mode));
test("price timeout disables and cancels a late response without reading", async () => {
  const late = deferred();
  let signal,
    cancelled = 0;
  const waiting = prepareTopupStripe(
    env,
    callbacks,
    async (_, options) => {
      signal = options.signal;
      return late.promise;
    },
    10,
  );
  assert.deepEqual(await waiting, { enabled: false });
  late.resolve({
    ok: true,
    body: { cancel: async () => cancelled++, getReader: () => assert.fail("late read") },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, 1);
});
test("retrieval timeout rejects even when body and cancellation ignore abort", async () => {
  const late = deferred(),
    body = delayedBody(late);
  const cap = await prepareTopupStripe(
    env,
    callbacks,
    async (url) => (url.includes("/prices/") ? reply(price()) : body.response),
    20,
  );
  await assert.rejects(
    cap.readOpen({ ...attempt(), state: "open", checkout_id: "cs_fixture" }),
    unavailable,
  );
  assert.ok(body.cancelled() > 0);
  late.resolve({ done: true });
});
test("streamed byte boundary accepts exact UTF-8 limit and rejects one extra byte", async () => {
  const json = JSON.stringify({ ...price(), label: "�" }),
    prefix = new TextEncoder().encode(json);
  for (const extra of [0, 1]) {
    const all = new Uint8Array(B.bodyBytes + extra).fill(32);
    all.set(prefix);
    let offset = 0;
    const response = new Response(
      new ReadableStream({
        pull(c) {
          if (offset === all.length) return c.close();
          const end = Math.min(offset + 17, all.length);
          c.enqueue(all.slice(offset, end));
          offset = end;
        },
      }),
    );
    assert.equal(
      (await prepareTopupStripe(env, callbacks, async () => response)).enabled,
      extra === 0,
    );
  }
});
test("oversize/invalid declared lengths reject without reading; invalid JSON stays disabled", async () => {
  for (const length of [String(B.bodyBytes + 1), "-1", "bad"]) {
    let cancelled = 0;
    const cap = await prepareTopupStripe(env, callbacks, async () => ({
      ok: true,
      headers: { get: () => length },
      body: {
        cancel: async () => cancelled++,
        getReader: () => assert.fail("must not read"),
      },
    }));
    assert.equal(cap.enabled, false);
    assert.equal(cancelled, 1);
  }
  assert.equal(
    (await prepareTopupStripe(env, callbacks, async () => new Response("{"))).enabled,
    false,
  );
  for (const timeout of [0, -1, NaN, 1.5, B.timeoutMs + 1])
    assert.equal(
      (await prepareTopupStripe(env, callbacks, () => assert.fail("must not fetch"), timeout))
        .enabled,
      false,
    );
});
test("elapsed deadline rejects before timer fires after immediate fetch or body completion", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  for (const stage of ["fetch", "body"]) {
    clock = 0;
    let reads = 0,
      cancelled = 0;
    const cap = await prepareTopupStripe(env, callbacks, async () => {
      if (stage === "fetch") clock = 10000;
      return {
        ok: true,
        body: {
          cancel: async () => cancelled++,
          getReader: () => ({
            read: async () => {
              reads++;
              clock = 10000;
              return { done: false, value: new TextEncoder().encode(JSON.stringify(price())) };
            },
            cancel: async () => cancelled++,
            releaseLock() {},
          }),
        },
      };
    });
    assert.equal(cap.enabled, false);
    assert.equal(reads, stage === "fetch" ? 0 : 1);
    assert.ok(cancelled > 0);
  }
});
