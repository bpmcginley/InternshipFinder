import assert from "node:assert/strict";
import test from "node:test";
import { handleFollowUnsubscribe } from "../src/follow-unsubscribe.js";

const URL = "https://site.example.test/unsubscribe";
const TOKEN = `10000000-0000-4000-8000-000000000001.${"a".repeat(64)}`;
const FIELD = "List-Unsubscribe";
const VALUE = "One-Click";
const BODY = `${FIELD}=${VALUE}`;
const FORM_TYPE = "application/x-www-form-urlencoded";
const noDb = { prepare: () => assert.fail("Database must stay untouched") };
const form = (body = BODY, headers = { "Content-Type": FORM_TYPE }) =>
  new Request(URL, { method: "POST", headers, body });

test("unsubscribe GET and HEAD do not look up even a well-formed token", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await handleFollowUnsubscribe(new Request(URL, { method }), noDb, TOKEN);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "");
  }
});

test("unsubscribe rejects malformed forms and tokens before any database access", async () => {
  const file = new FormData();
  file.append(FIELD, new Blob([VALUE]), "part.txt");
  for (const request of [
    form(null),
    form(""),
    form(`${BODY}&${BODY}`),
    form(`${BODY}&other=1`),
    form(`?${BODY}`),
    form(`${FIELD}=one-click`),
    form(`${FIELD}=%ff`),
    form(BODY, { "Content-Type": "text/plain" }),
    form(BODY, { "Content-Type": "multipart/form-data" }),
    form(file, {}),
  ]) {
    const response = await handleFollowUnsubscribe(request, noDb, TOKEN);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "");
  }
  assert.equal((await handleFollowUnsubscribe(form(), noDb, "invalid")).status, 400);
});

test("unsubscribe bounds streaming bytes independently of Content-Length", async () => {
  const encoded = new TextEncoder();
  // Empty URL-encoded segments add bytes without adding form fields.
  const bodyOf = (size) => encoded.encode(BODY + "&".repeat(size - BODY.length));
  const headers = { "Content-Type": FORM_TYPE };
  const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }) };
  assert.equal((await handleFollowUnsubscribe(form(bodyOf(4096), headers), db, TOKEN)).status, 204);
  assert.equal(
    (await handleFollowUnsubscribe(form(bodyOf(4097), headers), noDb, TOKEN)).status,
    400,
  );

  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bodyOf(4096));
      controller.enqueue(encoded.encode("é"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(URL, {
    method: "POST",
    headers: { ...headers, "Content-Length": "1" },
    body: stream,
    duplex: "half",
  });
  assert.equal((await handleFollowUnsubscribe(request, noDb, TOKEN)).status, 400);
  assert.equal(cancelled, true);
  assert.equal(
    (
      await handleFollowUnsubscribe(
        form(BODY, {
          "Content-Type": FORM_TYPE,
          "Content-Length": "4097",
        }),
        noDb,
        TOKEN,
      )
    ).status,
    400,
  );
});

test("unsubscribe leaves database errors available to the HTTP caller", async () => {
  const unavailable = new Error("fixture database unavailable");
  const db = {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          throw unavailable;
        },
      }),
    }),
  };
  await assert.rejects(
    handleFollowUnsubscribe(form(), db, TOKEN),
    (error) => error === unavailable,
  );
});
