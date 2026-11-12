import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.js";
import { createFollowManagementHttp } from "../src/follow-management-http.js";
import { cases, post, handler, fixture } from "../test-support/follow-management-http.js";
for (const [name, run] of cases) test(name, () => run(fakeD1()));
const token = "11111111-1111-4111-8111-111111111111." + "a".repeat(64);
const never = () => assert.fail("Unexpected database access");
const db = { prepare: never, batch: never };
test("management is default closed, body only, and rejects asynchronous Origin authority", async () => {
  assert.equal((await createFollowManagementHttp().list(post([token, null]))).status, 503);
  assert.equal(
    (await handler(db).list(new Request("https://api.example.test/manage"))).status,
    405,
  );
  for (const originAllowed of [
    async () => true,
    async () => {
      throw Error("private fixture");
    },
    () => ({
      then(_r, j) {
        j(Error("private fixture"));
      },
    }),
  ]) {
    const r = post([token, null]);
    assert.equal((await handler(db, { originAllowed }).list(r)).status, 403);
    assert.equal(r.bodyUsed, false);
  }
  for (const origin of ["", "null", "https://foreign.example.test"])
    assert.equal((await handler(db).list(post([token, null], { Origin: origin }))).status, 403);
  for (const suffix of ["?", "#", "?token=ignored"])
    assert.equal(
      (await handler(db).list(post([token, null], {}, "https://api.example.test/manage" + suffix)))
        .status,
      400,
    );
  await new Promise((r) => setImmediate(r));
});
test("strict tuples, credential shape, bytes and declared size fail before SQL", async () => {
  for (const value of [
    { token },
    [],
    [token],
    [[token], null],
    [token, null, 1],
    [token, {}],
    [token, "\ud800"],
    [token.toUpperCase(), null],
  ])
    assert.equal((await handler(db).list(post(value))).status, 400);
  for (const size of ["0", "1e3", "-1", "20000", "1"])
    assert.equal(
      (await handler(db).list(post([token, null], { "Content-Length": size }))).status,
      400,
    );
  assert.equal(
    (await handler(db).list(post([token, null], { "Content-Type": "text/plain" }))).status,
    415,
  );
  for (const body of ["\ufeff[]", new Uint8Array([255]), new Uint8Array(16385)]) {
    const r = new Request("https://api.example.test/manage", {
      method: "POST",
      body,
      duplex: "half",
      headers: { Origin: "https://example.test", "Content-Type": "application/json" },
    });
    assert.equal((await handler(db).list(r)).status, 400);
  }
});
test("four in-flight bodies share one limit and expired streams cancel without SQL", async () => {
  const deadlines = [],
    timers = {
      monotonicNow: () => 0,
      setTimeout: (fn) => (deadlines.push(fn), fn),
      clearTimeout: () => {},
    };
  const http = handler(db, { timers });
  let cancellations = 0;
  const requests = Array.from({ length: 4 }, () =>
    http.list(
      new Request("https://api.example.test/manage", {
        method: "POST",
        duplex: "half",
        body: new ReadableStream({
          cancel() {
            cancellations++;
          },
        }),
        headers: { Origin: "https://example.test", "Content-Type": "application/json" },
      }),
    ),
  );
  const full = await http.deleteAll(post([token]));
  assert.equal(full.status, 503);
  deadlines.forEach((fn) => fn());
  assert.deepEqual(
    (await Promise.all(requests)).map((r) => r.status),
    [503, 503, 503, 503],
  );
  assert.equal(cancellations, 4);
  assert.equal((await http.list(post([]))).status, 400);
});
test("malformed D1 page acknowledgements return a generic unavailable response", async () => {
  const real = fakeD1(),
    { token } = await fixture(real);
  for (const result of [[], new Array(2), [{ success: true, results: [] }]]) {
    const response = await handler({ prepare: real.prepare, batch: async () => result }).list(
      post([token, null]),
    );
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "");
  }
});
