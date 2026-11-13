import assert from "node:assert/strict";
import { prepareTopupStripe } from "../src/topup-stripe.js";
import { reserveTopupCheckout, reserveSessionTopupCheckout } from "../src/topup-checkout.js";
import { createSession, forgetSessions } from "../src/session.js";
import { env, callbacks, price, reply, session, attempt } from "./topup-stripe.js";
export const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
// Late bodies deliberately ignore abort/cancel, unlike native streams.
export function delayedBody(late) {
  let reads = 0,
    cancelled = 0;
  return {
    response: {
      ok: true,
      body: {
        getReader: () => ({
          read: () => (++reads === 1 ? late.promise : Promise.resolve({ done: true })),
          cancel: () => {
            cancelled++;
            return new Promise(() => {});
          },
          releaseLock() {},
        }),
      },
    },
    cancelled: () => cancelled,
  };
}
export async function timeoutReservation(db, mode) {
  const started = deferred(),
    late = deferred(),
    user = "a".repeat(64);
  const now = new Date("2026-11-11T12:00:00Z");
  const source =
    mode === "revoked"
      ? await createSession(db, { user, tier: "edu", provider: "google" }, now)
      : null;
  let posts = 0,
    signal,
    current;
  const body = delayedBody(late);
  const adapter = await prepareTopupStripe(
    env,
    callbacks,
    async (url, options) => {
      if (url.includes("/prices/")) return reply(price());
      posts++;
      assert.equal(options.method, "POST");
      signal = options.signal;
      const id = new URLSearchParams(options.body).get("metadata[attempt_id]");
      current = session({ ...attempt(), id });
      if (source) await forgetSessions(db, user).run();
      started.resolve();
      return mode === "fetch" ? late.promise : body.response;
    },
    150,
  );
  assert.equal(adapter.enabled, true);
  const first = source
    ? reserveSessionTopupCheckout(db, user, source.token, adapter, () => new Date(now))
    : reserveTopupCheckout(db, user, adapter, now);
  await started.promise;
  if (!source) assert.equal((await reserveTopupCheckout(db, user, adapter, now)).status, "pending");
  const result = await first;
  assert.equal(result.status, source ? "auth" : "pending");
  if (source) assert.equal(result.attempt, null);
  assert.equal(signal.aborted, true);
  late.resolve(
    mode === "fetch"
      ? reply(current)
      : { done: false, value: new TextEncoder().encode(JSON.stringify(current)) },
  );
  await new Promise((r) => setTimeout(r, 0));
  const stored = await db.prepare("SELECT * FROM topup_checkout_attempts").first();
  assert.equal(stored.state, "creating");
  assert.equal(stored.checkout_id, null);
  assert.equal(JSON.stringify(stored).includes("ephemeral-fixture"), false);
  assert.equal((await reserveTopupCheckout(db, user, adapter, now)).status, "pending");
  assert.equal(posts, 1);
  if (mode !== "fetch") assert.ok(body.cancelled() > 0);
}
