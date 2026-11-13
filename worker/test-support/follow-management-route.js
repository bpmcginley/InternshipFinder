import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { fixture } from "./follow-management-http.js";

const origin = "https://internscout.org";
const root = "https://api.example.test/follows/manage/";
const enabled = { FOLLOW_MANAGEMENT_ENABLED: "1" };
const requestEnabled = {
  ...enabled,
  FOLLOW_MANAGEMENT_REQUEST_ENABLED: "1",
  FOLLOW_MANAGEMENT_REQUEST_TTL_MS: "60000",
  FOLLOW_MANAGEMENT_REQUEST_DAILY_CAP: "10",
};
const request = (operation, body, headers = {}) =>
  new Request(root + operation, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const email = { email: "reader@example.test" };
const fakeToken = "11111111-1111-4111-8111-111111111111." + "a".repeat(64);
const fixtures = {
  list: [fakeToken, null],
  remove: [fakeToken, "scope"],
  delete: [fakeToken],
  request: email,
};
const receipt = async (response, status) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await response.text(), "");
};
const fields = async (response, status = 200) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  return response.json();
};

export async function disabledAndUntrustedCallsDoNoBodyOrStorageWork() {
  let effects = 0;
  const unexpected = () => {
    effects++;
    throw new Error("Unexpected fixture effect");
  };
  const run = (r, values) =>
    handle(
      r,
      { ...values, DB: { prepare: unexpected, batch: unexpected }, EMAIL: { send: unexpected } },
      undefined,
      { fetch: unexpected },
    );
  for (const [operation, body] of Object.entries(fixtures)) {
    for (const values of [
      {},
      { FOLLOW_MANAGEMENT_ENABLED: 1 },
      { ...requestEnabled, FOLLOW_MANAGEMENT_ENABLED: "0" },
    ]) {
      const r = request(operation, body);
      const response = await run(r, values);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found", message: "No such endpoint" });
      assert.equal(r.bodyUsed, false);
    }
    for (const header of [
      "",
      "null",
      "https://bpmcginley.github.io",
      "https://internscout.org.evil.test",
      "https://internscout.org:443",
    ]) {
      const r = request(operation, body, {
        Origin: header,
        Cookie: "session=ignored",
        Authorization: "Bearer ignored",
      });
      await receipt(await run(r, requestEnabled), 403);
      assert.equal(r.bodyUsed, false);
    }
    await receipt(
      await run(request(operation, body), {
        ...requestEnabled,
        ALLOWED_ORIGINS: "https://other.example.test",
      }),
      403,
    );
    await receipt(await run(request(operation + "?token=unused", body), requestEnabled), 400);
    for (const method of ["GET", "HEAD"])
      assert.equal(
        (await run(new Request(root + operation, { method }), requestEnabled)).status,
        404,
      );
  }
  const requestOff = request("request", email);
  assert.equal((await run(requestOff, enabled)).status, 404);
  assert.equal(requestOff.bodyUsed, false);
  for (const policy of [
    { FOLLOW_MANAGEMENT_REQUEST_TTL_MS: undefined },
    { FOLLOW_MANAGEMENT_REQUEST_TTL_MS: "604800001" },
    { FOLLOW_MANAGEMENT_REQUEST_TTL_MS: "6e4" },
    { FOLLOW_MANAGEMENT_REQUEST_DAILY_CAP: 10 },
    { FOLLOW_MANAGEMENT_REQUEST_DAILY_CAP: "010" },
    { FOLLOW_MANAGEMENT_REQUEST_DAILY_CAP: "9007199254740992" },
  ]) {
    const r = request("request", email);
    const response = await run(r, { ...requestEnabled, ...policy });
    assert.equal(response.headers.get("Retry-After"), "60");
    await receipt(response, 503);
    assert.equal(r.bodyUsed, false);
  }
  assert.equal(effects, 0);
}

export async function currentDbAndPolicyAuthorizeOnlyTheRequestedAction(db) {
  const { a, token, now } = await fixture(db);
  const run = (operation, body, settings = enabled, binding = db) =>
    handle(request(operation, body), { ...settings, DB: binding });
  const listed = await fields(await run("list", [token, null]));
  assert.equal(listed.scopes.length, 2);
  assert.equal(listed.next, null);
  let otherBindingReads = 0;
  const unavailableBinding = {
    prepare() {
      otherBindingReads++;
      throw new Error("Synthetic unavailable binding");
    },
  };
  await receipt(await run("list", [token, null], enabled, unavailableBinding), 503);
  assert.equal(otherBindingReads, 1);
  assert.deepEqual(Object.keys(listed.scopes[0]).sort(), ["confirmed_at", "created", "scope_key"]);
  const stale = await handle(request("list", [token, null]), { ...enabled, DB: db }, undefined, {
    now: () => new Date(+now + 31 * 60_000),
  });
  await receipt(stale, 410);
  assert.deepEqual(await fields(await run("remove", [token, "unknown scope"])), { removed: false });
  await receipt(await run("request", email, requestEnabled), 202);
  await receipt(await run("request", { email: "unknown@example.test" }, requestEnabled), 202);
  await receipt(await run("request", email, requestEnabled), 202);
  const queued = await db
    .prepare("SELECT subscriber_id,queued_at,expires_at FROM follow_management_outbox")
    .first();
  assert.equal(queued.subscriber_id, a.subscriberId);
  assert.equal(Date.parse(queued.expires_at) - Date.parse(queued.queued_at), 60_000);
  await receipt(
    await run("request", email, { ...requestEnabled, FOLLOW_MANAGEMENT_REQUEST_DAILY_CAP: "1" }),
    503,
  );
  assert.deepEqual(await fields(await run("delete", [token])), { deleted: true });
  await receipt(await run("list", [token, null]), 410);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM follow_management_outbox").first("n"),
    0,
  );
}

export async function isolateSlotsSurviveChangingEnvAndDbWrappers(db) {
  const { token } = await fixture(db);
  for (const operation of ["list", "request"]) {
    let release,
      entered,
      batches = 0;
    const settled = new Promise((r) => (release = r));
    const ready = new Promise((r) => (entered = r));
    const makeBinding = () => ({
      prepare: (sql) => db.prepare(sql),
      async batch(statements) {
        if (++batches === 4) entered();
        await settled;
        return db.batch(statements);
      },
    });
    const body = operation === "list" ? [token, null] : email;
    const jobs = Array.from({ length: 4 }, () =>
      handle(request(operation, body), { ...requestEnabled, DB: makeBinding() }),
    );
    try {
      await Promise.race([
        ready,
        Promise.race(jobs).then(() => assert.fail("Slot released before D1")),
      ]);
      const fifth = request(
        operation === "list" ? "delete" : "request",
        operation === "list" ? [token] : body,
      );
      await receipt(await handle(fifth, { ...requestEnabled, DB: db }), 503);
      assert.equal(fifth.bodyUsed, false);
      const independent =
        operation === "list" ? request("request", email) : request("list", [token, null]);
      const other = await handle(independent, { ...requestEnabled, DB: db });
      assert.equal(other.status, operation === "list" ? 202 : 200);
    } finally {
      release();
      const complete = await Promise.all(jobs);
      for (const response of complete)
        assert.equal(response.status, operation === "list" ? 200 : 202);
    }
    assert.equal(
      (await handle(request(operation, body), { ...requestEnabled, DB: db })).status,
      operation === "list" ? 200 : 202,
    );
  }
}
