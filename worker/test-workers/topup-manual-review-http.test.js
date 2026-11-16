import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { it } from "vitest";
import { handle } from "../src/index.js";
import { topupManualReviewHttp as review } from "../src/topup-manual-review-http.js";

const url = "https://worker.test/admin/topup-review";
const admin = "synthetic-worker-test-admin";
const access = { TOPUP_MANUAL_REVIEW_ENABLED: "1", ADMIN_TOKEN: admin };
const hash = (value) => value.toString(16).padStart(64, "0");

function request({
  address = url,
  method = "POST",
  body = "[null]",
  contentType = "application/json",
  auth = "Bearer " + admin,
  extra = {},
} = {}) {
  const headers = new Headers(extra);
  if (contentType) headers.set("Content-Type", contentType);
  if (auth) headers.set("Authorization", auth);
  return new Request(address, { method, body: method === "POST" ? body : null, headers });
}

async function assertEmpty(reply, status) {
  assert.equal(reply.status, status);
  assert.equal(reply.headers.get("Cache-Control"), "no-store");
  assert.equal(reply.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(reply.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(await reply.text(), "");
}

it("requires the exact opt-in and the terminal admin bearer before processing a request", async () => {
  let dbReads = 0;
  const run = (req, bindings) =>
    review({
      request: req,
      env: {
        ...bindings,
        get DB() {
          dbReads++;
          throw new Error("unexpected database access");
        },
      },
    });
  for (const value of [undefined, false, true, 1, "0", "true", "1 "]) {
    const req = request();
    await assertEmpty(await run(req, { ...access, TOPUP_MANUAL_REVIEW_ENABLED: value }), 404);
    assert.equal(req.bodyUsed, false);
  }
  await assertEmpty(await run(request(), { ...access, ADMIN_TOKEN: "" }), 404);
  for (const auth of ["", "Bearer different", admin, "Basic " + admin]) {
    const req = request({ auth, body: "malformed before auth" });
    await assertEmpty(await run(req, access), 401);
    assert.equal(req.bodyUsed, false);
  }
  for (const origin of ["", "null", "https://site.test"]) {
    const req = request({ extra: { Origin: origin } });
    await assertEmpty(await run(req, access), 403);
    assert.equal(req.bodyUsed, false);
  }
  assert.equal(dbReads, 0);
});

it("accepts only the exact POST path with no query and one bounded JSON cursor", async () => {
  let dbReads = 0;
  const run = (input) =>
    review({
      request: request(input),
      env: {
        ...access,
        get DB() {
          dbReads++;
          throw new Error("unexpected database access");
        },
      },
    });
  const wrongMethod = await run({ method: "GET" });
  assert.equal(wrongMethod.headers.get("Allow"), "POST");
  await assertEmpty(wrongMethod, 405);
  await assertEmpty(await run({ address: url + "/extra" }), 404);
  await assertEmpty(await run({ address: url + "/" }), 404);
  await assertEmpty(await run({ address: url + "?after=" + hash(1) }), 400);
  await assertEmpty(await run({ address: url + "?" }), 400);
  await assertEmpty(await run({ address: url + "#" + hash(1) }), 400);
  await assertEmpty(await run({ contentType: "text/plain" }), 415);
  await assertEmpty(await run({ contentType: "application/json; charset=latin1" }), 415);
  for (const body of [
    null,
    "",
    "null",
    "{}",
    '{"after":null,"after":null}',
    '["unrecognized"]',
    "[false]",
    "[null,null]",
    "[[null]]",
    "[]",
    JSON.stringify(["f".repeat(63)]),
    JSON.stringify(["F".repeat(64)]),
    JSON.stringify(["f".repeat(64) + "\n"]),
    new Uint8Array([0xff]),
    "\uFEFF[null]",
  ])
    await assertEmpty(await run({ body }), 400);
  for (const value of ["0", "3", "0006", "+6", "129", "6, 6"])
    await assertEmpty(await run({ extra: { "Content-Length": value } }), 400);
  let cancelled = false;
  const encoder = new TextEncoder();
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("[null]"));
      controller.enqueue(encoder.encode(" ".repeat(123)));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assertEmpty(await run({ body: oversized }), 400);
  assert.equal(cancelled, true);
  assert.equal(dbReads, 0);
});

it("stops an incomplete body at the shared absolute deadline", async () => {
  let cancelled = false;
  const incomplete = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x5b]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const bindings = Object.create(access, {
    DB: {
      get() {
        assert.fail("unexpected database access");
      },
    },
  });
  await assertEmpty(await review({ request: request({ body: incomplete }), env: bindings }), 503);
  assert.equal(cancelled, true);
}, 8000);

it("returns one fixed read-only D1 page with opaque continuation and the approved fields", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const sequence = "WITH RECURSIVE keys(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM keys WHERE i<65)";
  await env.DB.batch([
    env.DB.prepare(
      sequence +
        " INSERT INTO topup_claims SELECT printf('%064x',i),printf('%064x',i+512),'granted' FROM keys",
    ),
    env.DB.prepare(
      sequence +
        " INSERT INTO topup_purchases SELECT printf('%064x',i),'pi_fixture'||i,'cs_fixture'||i," +
        "printf('%064x',i+256),'topup-v1',300,'usd',25,(i<64),0,25-(i<64),0," +
        "'2020-01-02T00:00:00.000Z' FROM keys",
    ),
  ]);
  const snapshot = () =>
    env.DB.prepare("SELECT * FROM topup_purchases ORDER BY payment_hash").all();
  const before = (await snapshot()).results;
  const bindings = { ...access, DB: env.DB };
  const list = (body) =>
    review({
      env: bindings,
      request: request({ body, contentType: 'application/json; charset="utf-8"' }),
    });
  const first = await list("[null]");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  assert.equal(first.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(first.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(first.headers.get("Content-Type"), "application/json");
  const candidate = (n) => ({
    paymentHash: hash(n),
    revision: 0,
    age: "pending",
    evidence: "payment_pending",
  });
  assert.deepEqual(await first.json(), { candidates: [candidate(64)], next: hash(64) });
  assert.deepEqual(await (await list(JSON.stringify([hash(64)]))).json(), {
    candidates: [candidate(65)],
    next: null,
  });
  assert.deepEqual((await snapshot()).results, before);
});

it("returns a private empty failure when storage is unavailable", async () => {
  const req = request();
  const surrogate = {
    ...access,
    get DB() {
      throw new Error("synthetic private database detail " + hash(2));
    },
  };
  await assertEmpty(await review({ request: req, env: surrogate }), 503);
});

it("dispatches before generic preflight, CORS and database access", async () => {
  let databaseReads = 0;
  const bindings = {
    ...access,
    get DB() {
      databaseReads++;
      throw new Error("unexpected DB access");
    },
  };
  await assertEmpty(await handle(request(), {}, {}), 404);
  await assertEmpty(await handle(request({ auth: "" }), bindings, {}), 401);
  const extra = { Origin: "https://internscout.org" };
  await assertEmpty(await handle(request({ extra }), bindings, {}), 403);
  const preflight = request({ method: "OPTIONS", extra, auth: "" });
  await assertEmpty(await handle(preflight, bindings, {}), 403);
  await assertEmpty(await handle(request({ method: "GET" }), bindings, {}), 405);
  await assertEmpty(await handle(request({ address: url + "/" }), bindings, {}), 404);
  assert.equal(databaseReads, 0);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const ready = await handle(request(), { ...access, DB: env.DB }, {});
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await ready.json(), { candidates: [], next: null });
});
