// Native streams and synthetic GETs only, shared by Node and the actual Workers runtime.
import assert from "node:assert/strict";
import {
  readTopupPaymentEvidence as read,
  PAYMENT_EVIDENCE_BOUNDS as cap,
} from "../src/topup-payment-evidence.js";
import { recoverTopupAttempt } from "../src/topup-attempt-recovery.js";
import { attempt, session } from "./topup-stripe.js";
const env = { STRIPE_SECRET_KEY: "fixture-not-a-key" };
const offer = {
  version: "topup-v1",
  priceId: "price_fixture",
  amount: 300,
  currency: "usd",
  units: 25,
  livemode: false,
};
const a = { ...attempt(), state: "open", checkout_id: "cs_fixture" };
const pending = { status: "pending" };
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function objects() {
  const checkout = {
    ...session(a),
    status: "complete",
    payment_status: "paid",
    recovered_from: null,
    payment_intent: "pi_fixture",
  };
  return [
    checkout,
    {
      object: "payment_intent",
      id: "pi_fixture",
      status: "succeeded",
      currency: "usd",
      livemode: false,
      amount: 327,
      amount_received: 327,
      amount_capturable: 0,
      latest_charge: "ch_fixture",
      metadata: { ...checkout.metadata },
    },
    {
      object: "charge",
      id: "ch_fixture",
      payment_intent: "pi_fixture",
      status: "succeeded",
      amount: 327,
      amount_captured: 327,
      captured: true,
      paid: true,
      currency: "usd",
      livemode: false,
    },
  ];
}
function padded(value, size) {
  const copy = { ...value, padding: "" };
  copy.padding = "x".repeat(size - encode(copy).byteLength);
  return encode(copy);
}
function streamed(bytes, step = 16384, headers = {}) {
  let offset = 0;
  const state = { cancelled: 0 };
  state.response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(offset + step, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel() {
        state.cancelled++;
      },
    }),
    { headers },
  );
  return state;
}
function transport(values, decorate = (value) => new Response(encode(value))) {
  const state = { calls: 0, signals: [] };
  state.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    assert.match(
      url,
      /^https:\/\/api\.stripe\.com\/v1\/(checkout\/sessions|payment_intents|charges)\//,
    );
    state.signals.push(options.signal);
    const index = state.calls++;
    assert.ok(index < 3, "at most three GETs");
    return decorate(values[index], index, options);
  };
  state.read = (ms = cap.timeoutMs) => read(env, a, offer, state.fetch, a.checkout_id, ms);
  return state;
}

export async function paymentByteBoundaries() {
  const data = objects();
  for (const extra of [0, 1]) {
    const p = transport(
      data,
      (value, index) =>
        streamed(index === 0 ? padded(value, cap.bodyBytes + extra) : encode(value)).response,
    );
    assert.equal((await p.read()).status, extra ? "pending" : "paid_evidence");
    assert.equal(p.calls, extra ? 1 : 3);
  }
  for (const extra of [0, 1]) {
    const sizes = [cap.bodyBytes, cap.totalBytes - cap.bodyBytes - 1000 + extra, 1000];
    const p = transport(data, (value, index) => streamed(padded(value, sizes[index])).response);
    assert.equal((await p.read()).status, extra ? "pending" : "paid_evidence");
    assert.equal(p.calls, 3);
  }
  data[0].note = "split € character";
  assert.equal(
    (await transport(data, (value) => streamed(encode(value), 1).response).read()).status,
    "paid_evidence",
  );
  for (const bytes of [new Uint8Array([0xc3]), new Uint8Array([0xc3, 0x28])])
    assert.deepEqual(await transport(data, () => streamed(bytes, 1).response).read(), pending);
}

export async function paymentLengthAndBodyFailures() {
  for (const length of [String(cap.bodyBytes + 1), "-1", "unknown"]) {
    const s = streamed(encode(objects()[0]), 1, { "Content-Length": length });
    const p = transport(objects(), () => s.response);
    assert.deepEqual(await p.read(), pending);
    assert.equal(s.cancelled, 1);
    assert.equal(p.calls, 1);
  }
  // Leave unread chunks so cancellation is observable, rather than an already closed stream.
  const s = streamed(padded(objects()[0], cap.bodyBytes + 32769), 16384, { "Content-Length": "0" });
  assert.deepEqual(await transport(objects(), () => s.response).read(), pending);
  assert.equal(s.cancelled, 1);
  for (const response of [
    new Response(null),
    new Response("private", { status: 500 }),
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error("synthetic stream failure"));
        },
      }),
    ),
  ])
    assert.deepEqual(await transport(objects(), () => response).read(), pending);
  assert.deepEqual(await transport(objects()).read(cap.timeoutMs + 1), pending);
  assert.deepEqual(await transport(objects()).read(0), pending);
}

export async function paymentLateFetchIsFenced() {
  let release;
  const late = streamed(encode(objects()[0]));
  const p = transport(
    objects(),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  assert.deepEqual(await p.read(40), pending);
  assert.equal(p.signals[0].aborted, true);
  release(late.response);
  await tick();
  assert.equal(late.cancelled, 1);
  assert.equal(p.calls, 1);
  // A response arriving after timeout must not hang on a non-cooperative cancellation.
  let resolveLate;
  const q = transport(
    objects(),
    () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
  );
  assert.deepEqual(await q.read(40), pending);
  resolveLate(
    new Response(
      new ReadableStream({
        cancel() {
          return new Promise(() => {});
        },
      }),
    ),
  );
  await tick();
  assert.equal(q.calls, 1);
}

export async function paymentBodyDeadlineAndTotalDeadline() {
  let cancelled = 0;
  const p = transport(
    objects(),
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
  );
  assert.deepEqual(await p.read(40), pending);
  assert.equal(cancelled, 1);
  assert.equal(p.signals[0].aborted, true);
  assert.equal(p.calls, 1);
  let timer;
  const drip = transport(
    objects(),
    () =>
      new Response(
        new ReadableStream({
          pull(c) {
            return new Promise((resolve) => {
              timer = setTimeout(() => {
                c.enqueue(new Uint8Array([32]));
                resolve();
              }, 15);
            });
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
      ),
  );
  assert.deepEqual(await drip.read(55), pending);
  assert.equal(drip.calls, 1);
  const slow = transport(
    objects(),
    (value) => new Promise((resolve) => setTimeout(() => resolve(new Response(encode(value))), 40)),
  );
  assert.deepEqual(await slow.read(100), pending);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.ok(slow.calls <= 3);
  assert.ok(slow.signals.every((signal) => signal.aborted));
}

export async function paymentLateFinalEvidenceIsFenced() {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const data = objects(),
    final = streamed(encode(data[2]));
  const p = transport(data, (value, index) =>
    index < 2
      ? new Response(encode(value))
      : new Promise((resolve) => {
          release = resolve;
          started();
        }),
  );
  const result = p.read(200);
  await ready;
  assert.deepEqual(await result, pending);
  release(final.response);
  await tick();
  assert.equal(final.cancelled, 1);
  assert.equal(p.calls, 3);
}

export async function paymentBoundFailureCannotSettleOrExpire(db) {
  for (const status of ["complete", "expired"]) {
    await db.batch(
      [
        "topup_allocations",
        "topup_reconciliations",
        "topup_purchases",
        "topup_claims",
        "topup_attempt_revisions",
        "topup_checkout_attempts",
      ].map((t) => db.prepare(`DELETE FROM ${t}`)),
    );
    await db
      .prepare("INSERT INTO topup_checkout_attempts VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(
        a.id,
        a.user_hash,
        a.offer_version,
        a.amount,
        a.currency,
        a.units,
        "2026-11-10T00:00:00Z",
        a.checkout_id,
        a.state,
      )
      .run();
    const value = {
      ...objects()[0],
      status,
      payment_status: status === "expired" ? "unpaid" : "paid",
      payment_intent: status === "expired" ? null : "pi_fixture",
    };
    const response = streamed(padded(value, cap.bodyBytes + 1));
    assert.deepEqual(
      await recoverTopupAttempt(db, env, a.id, offer, async () => response.response),
      pending,
    );
    for (const table of ["topup_claims", "topup_purchases", "topup_reconciliations"])
      assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n, 0);
    assert.equal(
      (await db.prepare("SELECT state FROM topup_checkout_attempts").first()).state,
      "open",
    );
    assert.equal(
      (await db.prepare("SELECT revision FROM topup_attempt_revisions").first()).revision,
      1,
    );
  }
}
