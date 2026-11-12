import assert from "node:assert/strict";
import test from "node:test";
import { createFollowSignupHttp } from "../src/follow-signup-http.js";

const API = "https://api.example.test/follows/request";
const SITE = "https://example.test";
const input = {
  email: "person@example.test",
  link: false,
  scope: { kind: "company", company: "acme" },
};
const json = JSON.stringify(input);
const originAllowed = (request) => request.headers.get("Origin") === SITE;
const request = (body = json, headers = {}, url = API) =>
  new Request(url, {
    method: "POST",
    body,
    duplex: "half",
    headers: { Origin: SITE, "Content-Type": "application/json", ...headers },
  });
const never = () => assert.fail("Unexpected admission");

async function expectResponse(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.has("Set-Cookie"), false);
  assert.equal(response.headers.has("Location"), false);
  assert.equal(await response.text(), "");
}

test("signup is disabled without explicit wiring and validates method and first-party origin before reading", async () => {
  const off = createFollowSignupHttp({ originAllowed: never, admit: never });
  await expectResponse(await off(request()), 503);
  await expectResponse(await createFollowSignupHttp({ enabled: true })(request()), 503);
  const endpoint = createFollowSignupHttp({ enabled: true, originAllowed, admit: never });
  const method = await endpoint(new Request(API));
  assert.equal(method.headers.get("Allow"), "POST");
  await expectResponse(method, 405);
  for (const origin of ["", "null", "https://foreign.example.test"]) {
    const foreign = request(json, { Origin: origin });
    await expectResponse(await endpoint(foreign), 403);
    assert.equal(foreign.bodyUsed, false);
  }
  const queried = request(json, {}, API + "?email=unread");
  await expectResponse(await endpoint(queried), 400);
  assert.equal(queried.bodyUsed, false);
});

test("only bounded, exact-shape UTF-8 JSON reaches signup admission", async () => {
  const endpoint = createFollowSignupHttp({ enabled: true, originAllowed, admit: never });
  for (const type of [
    "text/plain",
    "application/json; charset=iso-8859-1",
    "application/json, application/json",
  ]) {
    const post = request(json, { "Content-Type": type });
    await expectResponse(await endpoint(post), 415);
    assert.equal(post.bodyUsed, false);
  }
  for (const length of ["0", "-1", "1e2", "20000", "12"]) {
    await expectResponse(await endpoint(request(json, { "Content-Length": length })), 400);
  }
  for (const body of [
    null,
    "",
    "\uFEFF" + json,
    new Uint8Array([0xff]),
    "[]",
    "null",
    "{}",
    JSON.stringify({ ...input, link: "yes" }),
    JSON.stringify({ ...input, scope: {}, account: "untrusted" }),
  ]) {
    await expectResponse(await endpoint(request(body)), 400);
  }

  let cancelled = 0;
  const oversize = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 + 1));
    },
    cancel() {
      cancelled += 1;
      return new Promise(() => {});
    },
  });
  await expectResponse(await endpoint(request(oversize)), 400);
  assert.equal(cancelled, 1);
});

test("accepted signup returns an empty acknowledgement and keeps linked intent exact", async () => {
  const linked = { ...input, link: true };
  const exact = JSON.stringify(linked);
  let calls = 0;
  const post = request(exact, {
    "Content-Length": String(new TextEncoder().encode(exact).length),
    "Content-Type": 'Application/JSON; charset="utf-8"',
  });
  const endpoint = createFollowSignupHttp({
    enabled: true,
    originAllowed,
    admit(value, incoming) {
      calls += 1;
      assert.deepEqual(value, linked);
      assert.equal(incoming, post);
      return { status: "accepted", subscriberId: "synthetic-secret", scopeKey: "private" };
    },
  });
  await expectResponse(await endpoint(post), 202);
  assert.equal(calls, 1);
});

test("downstream statuses and errors never expose account or database details", async () => {
  const cases = [
    [{ status: "invalid" }, 400],
    [{ status: "unsupported" }, 503],
    [{ status: "disabled" }, 503],
    [{ status: "unavailable" }, 503],
    [null, 503],
  ];
  for (const [outcome, status] of cases) {
    const endpoint = createFollowSignupHttp({ enabled: true, originAllowed, admit: () => outcome });
    await expectResponse(await endpoint(request()), status);
  }
  let attempts = 0;
  const endpoint = createFollowSignupHttp({
    enabled: true,
    originAllowed,
    admit() {
      attempts += 1;
      throw new Error("synthetic database details");
    },
  });
  const failed = await endpoint(request());
  assert.equal(failed.headers.get("Retry-After"), "60");
  await expectResponse(failed, 503);
  assert.equal(attempts, 1);
});

test("signup shares an absolute body deadline and holds capacity through admission", async () => {
  const timers = new Map();
  const held = Promise.withResolvers();
  const allStarted = Promise.withResolvers();
  let count = 0;
  let cancelled = 0;
  const endpoint = createFollowSignupHttp({
    enabled: true,
    originAllowed,
    timers: {
      monotonicNow: () => 0,
      setTimeout(callback, ms) {
        assert.equal(ms, 5000);
        const id = Symbol();
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    async admit() {
      count += 1;
      if (count === 4) allStarted.resolve();
      await held.promise;
      return { status: "accepted" };
    },
  });
  const slow = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(json));
    },
    cancel() {
      cancelled += 1;
      return new Promise(() => {});
    },
  });
  const timed = endpoint(request(slow));
  assert.equal(timers.size, 1);
  for (const callback of timers.values()) callback();
  await expectResponse(await timed, 503);
  assert.equal(cancelled, 1);
  assert.equal(count, 0);
  assert.equal(timers.size, 0);

  const inFlight = Array.from({ length: 4 }, () => endpoint(request()));
  await allStarted.promise;
  assert.equal(timers.size, 0);
  const busy = request();
  await expectResponse(await endpoint(busy), 503);
  assert.equal(busy.bodyUsed, false);
  held.resolve();
  for (const response of await Promise.all(inFlight)) await expectResponse(response, 202);
  await expectResponse(await endpoint(request()), 202);
});
