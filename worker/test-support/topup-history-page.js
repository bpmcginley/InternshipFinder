import assert from "node:assert/strict";
import { createTopupHistoryPageReader as create } from "../src/topup-history-page.js";
import { validateTopupHistoryTraversal as traverse } from "../src/topup-history-traversal.js";
import {
  rotateTopupCoverage as rotate,
  captureTopupCoverage as capture,
} from "../src/topup-history-coverage.js";
const version = "2026-08-26.dahlia",
  denied = { name: "Error", message: "History page unavailable" };
const query = (extra = {}) =>
  Object.freeze({ created: Object.freeze({ gte: 10, lt: 20 }), limit: 100, ...extra });
const response = (
  url,
  text = '{"object":"list","url":"/v1/events","data":[],"has_more":false}',
  status = 200,
) => {
  const r = new Response(text, { status });
  Object.defineProperty(r, "url", { value: url });
  return r;
};
async function fixture(db) {
  await db.prepare("DELETE FROM topup_history_coverage").run();
  await rotate(db, { livemode: false, schemaKey: "synthetic", expected: null }, { enabled: true });
  const now = Date.parse(
    await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at"),
  );
  await db
    .prepare("UPDATE topup_history_coverage SET starts_at=?,covered_through=?,health='qualified'")
    .bind(new Date(now - 600000).toISOString(), new Date(now - 60000).toISOString())
    .run();
  return {
    now,
    input: {
      livemode: false,
      schemaKey: "synthetic",
      apiVersions: ["fixture-v1"],
      expected: (await capture(db, false, { enabled: true })).coverage,
      from: Math.floor(now / 1000) - 120,
      to: Math.floor(now / 1000) - 60,
    },
  };
}
export async function disabledMalformedQueriesAndAbortedSignalsNeverCallTransport() {
  let calls = 0,
    getters = 0;
  const request = async () => {
      calls++;
      throw Error();
    },
    controller = new AbortController();
  for (const opts of [
    {},
    { enabled: "true" },
    { enabled: true },
    { enabled: true, requestVersion: "2026-02-30" },
    { enabled: true, requestVersion: "2026-08-26\r\nprivate" },
  ])
    await assert.rejects(create({ request, ...opts })(query(), controller.signal), denied);
  const read = create({ enabled: true, requestVersion: version, request });
  const accessor = {
    created: Object.freeze({ gte: 10, lt: 20 }),
    get limit() {
      getters++;
      return 100;
    },
  };
  const extra = query({ [Symbol("extra")]: true });
  const proto = Object.freeze(
    JSON.parse('{"created":{"gte":10,"lt":20},"limit":100,"__proto__":{}}'),
  );
  for (const q of [
    null,
    {},
    { ...query() },
    query({ created: { gte: 10, lt: 20 } }),
    query({ limit: 99 }),
    query({ limit: "100" }),
    query({ created: Object.freeze({ gte: 20, lt: 10 }) }),
    query({ created: Object.freeze({ gte: -1, lt: 20 }) }),
    query({ type: "charge.updated" }),
    query({ delivery_success: true }),
    query({ ending_before: "evt_x" }),
    query({ starting_after: ["evt_x"] }),
    query({ starting_after: "evt_x&limit=1" }),
    Object.freeze(accessor),
    extra,
    proto,
  ])
    await assert.rejects(read(q, controller.signal), denied);
  await assert.rejects(read(query(), {}), denied);
  controller.abort();
  await assert.rejects(read(query(), controller.signal), denied);
  assert.equal(calls, 0);
  assert.equal(getters, 0);
}
export async function exactFixedGetPassesUntouchedResponseAndOriginalSignal() {
  const controller = new AbortController(),
    seen = [];
  let raw;
  const read = create({
    enabled: true,
    requestVersion: version,
    request: async (url, init) => {
      seen.push({ url, init });
      const actualRequest = new Request(url, init);
      assert.equal(actualRequest.method, "GET");
      assert.equal(actualRequest.redirect, "manual");
      assert.equal(actualRequest.body, null);
      assert.deepEqual([...actualRequest.headers], [["stripe-version", version]]);
      raw = response(url);
      for (const name of ["text", "json", "arrayBuffer", "clone"])
        raw[name] = () => {
          throw Error("must not buffer");
        };
      return raw;
    },
  });
  assert.equal(await read(query({ starting_after: "evt_a_9" }), controller.signal), raw);
  assert.equal(raw.bodyUsed, false);
  assert.equal(raw.body.locked, false);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    "https://api.stripe.com/v1/events?created%5Bgte%5D=10&created%5Blt%5D=20&limit=100&starting_after=evt_a_9",
  );
  assert.deepEqual(seen[0].init, {
    method: "GET",
    redirect: "manual",
    signal: controller.signal,
    headers: { "Stripe-Version": version },
  });
  assert.ok(Object.isFrozen(seen[0].init));
  assert.ok(Object.isFrozen(seen[0].init.headers));
  await raw.body.cancel();
}
export async function responseRejectionCancelsWithoutRedirectOrRetry() {
  for (const mode of [
    "status",
    "redirect",
    "followed",
    "wrong-url",
    "blank-url",
    "getter",
    "sync",
    "throw",
    "reject",
  ]) {
    let calls = 0,
      cancelled = 0;
    const read = create({
      enabled: true,
      requestVersion: version,
      request: (url) => {
        calls++;
        if (mode === "throw") throw Error("private provider");
        if (mode === "reject") return Promise.reject(Error("private provider"));
        const r = new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { status: mode === "status" ? 500 : mode === "redirect" ? 302 : 200 },
        );
        if (mode === "followed") Object.defineProperty(r, "redirected", { value: true });
        Object.defineProperty(
          r,
          "url",
          mode === "getter"
            ? {
                get() {
                  throw Error("private response");
                },
              }
            : {
                value:
                  mode === "wrong-url"
                    ? "https://other.example.test/"
                    : mode === "blank-url"
                      ? ""
                      : url,
              },
        );
        return mode === "sync" ? r : Promise.resolve(r);
      },
    });
    await assert.rejects(read(query(), new AbortController().signal), denied);
    assert.equal(calls, 1);
    assert.equal(cancelled, ["throw", "reject"].includes(mode) ? 0 : 1);
  }
}
export async function abortRejectsImmediatelyAndCancelsLateBody() {
  let finish,
    calls = 0,
    cancelled = 0;
  const controller = new AbortController();
  const read = create({
    enabled: true,
    requestVersion: version,
    request: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = read(query(), controller.signal);
  controller.abort();
  await assert.rejects(pending, denied);
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
  await assert.rejects(pending, denied);
}
export async function validComposedPageIsUnprovenAndNeverAdvancesEpoch(db) {
  const f = await fixture(db);
  let calls = 0;
  const readPage = create({
    enabled: true,
    requestVersion: version,
    request: async (url) => {
      calls++;
      return response(url);
    },
  });
  assert.deepEqual(await traverse(db, f.input, { enabled: true, clock: () => f.now, readPage }), {
    status: "unproven",
  });
  assert.equal(calls, 1);
  assert.deepEqual((await capture(db, false, { enabled: true })).coverage, f.input.expected);
}
async function closes(db, mode) {
  const f = await fixture(db);
  let calls = 0;
  const readPage = create({
    enabled: true,
    requestVersion: version,
    request: async (url) => {
      calls++;
      if (mode === "throw") throw Error("private provider");
      return response(
        url,
        mode === "duplicate"
          ? '{"object":"list","url":"/v1/events","data":[],"has_more":true,"has_more":false}'
          : "{}",
        mode === "duplicate" ? 200 : mode === "redirect" ? 302 : 500,
      );
    },
  });
  assert.deepEqual(await traverse(db, f.input, { enabled: true, clock: () => f.now, readPage }), {
    status: "closed",
  });
  assert.equal(calls, 1);
  assert.deepEqual((await capture(db, false, { enabled: true })).coverage, {
    ...f.input.expected,
    health: "closed",
    revision: 2,
  });
}
export const composedRedirectClosesExactEpoch = (db) => closes(db, "redirect");
export const composedStatusClosesExactEpoch = (db) => closes(db, "status");
export const composedUnknownClosesExactEpoch = (db) => closes(db, "throw");
export const composedDuplicateRemainsTraversalOwned = (db) => closes(db, "duplicate");
export async function traversalTimeoutCancelsLatePage(db) {
  const f = await fixture(db);
  let finish,
    cancelled = 0;
  const readPage = create({
    enabled: true,
    requestVersion: version,
    request: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  assert.deepEqual(
    await traverse(db, f.input, { enabled: true, clock: () => f.now, timeoutMs: 20, readPage }),
    { status: "closed" },
  );
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, 1);
  assert.deepEqual((await capture(db, false, { enabled: true })).coverage, {
    ...f.input.expected,
    health: "closed",
    revision: 2,
  });
}
export async function changedEpochIsNeverClosedByFailedPage(db) {
  const f = await fixture(db);
  let newer,
    calls = 0;
  const readPage = create({
    enabled: true,
    requestVersion: version,
    request: async (url) => {
      calls++;
      newer = (
        await rotate(
          db,
          { livemode: false, schemaKey: "next", expected: f.input.expected },
          { enabled: true },
        )
      ).coverage;
      return response(url, "{}", 500);
    },
  });
  assert.deepEqual(await traverse(db, f.input, { enabled: true, clock: () => f.now, readPage }), {
    status: "held",
  });
  assert.equal(calls, 1);
  assert.deepEqual((await capture(db, false, { enabled: true })).coverage, newer);
}

export async function synchronousMetadataAbortCancelsResponseExactlyOnce(db) {
  const f = await fixture(db),
    controller = new AbortController();
  let calls = 0,
    discards = 0,
    cancelled = 0;
  const read = create({
    enabled: true,
    requestVersion: version,
    request: async (url) => {
      calls++;
      const raw = new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      );
      const cancel = raw.body.cancel.bind(raw.body);
      raw.body.cancel = (...args) => {
        discards++;
        return cancel(...args);
      };
      Object.defineProperty(raw, "url", {
        get() {
          controller.abort();
          return url;
        },
      });
      return raw;
    },
  });
  // A real signal abort inside metadata validation, while the original traversal still awaits its page.
  const result = await traverse(db, f.input, {
    enabled: true,
    clock: () => f.now,
    readPage: (q, signal) => {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
      return read(q, controller.signal);
    },
  });
  assert.deepEqual(result, { status: "closed" });
  assert.equal(calls, 1);
  assert.equal(discards, 1);
  assert.equal(cancelled, 1);
  assert.deepEqual((await capture(db, false, { enabled: true })).coverage, {
    ...f.input.expected,
    health: "closed",
    revision: 2,
  });
}
