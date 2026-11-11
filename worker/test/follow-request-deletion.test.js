import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deleteFollowRequest, mintFollowRequestDeletion } from "../src/follow-request-deletion.js";
import { deleteLastPendingScope } from "../test-support/follow-request-deletion.js";
import { fakeD1 } from "./helpers.js";

test("deleting the final pending scope removes a historically confirmed subscriber", async () => {
  await deleteLastPendingScope(fakeD1(), assert.deepEqual);
});

test("request deletion and confirmation credentials are not interchangeable", async () => {
  const noDb = {
    prepare: () => assert.fail("should not read D1"),
    batch: () => assert.fail("should not write D1"),
  };
  const confirmation = `12345678-1234-4000-8000-123456789abc.${"a".repeat(64)}`;
  assert.equal(await mintFollowRequestDeletion(noDb, `fd_${confirmation}`), null);
  for (const value of [confirmation, undefined, `fd_${confirmation}x`]) {
    assert.equal(await deleteFollowRequest(noDb, value), false);
  }
});

test("the new migration is mirrored in the legacy schema and its helper is unwired", () => {
  const read = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.ok(read("../schema.sql").includes(read("../migrations/0007_follow_request_deletion.sql")));
  assert.doesNotMatch(read("../src/index.js"), /follow-request-deletion/);
  assert.doesNotMatch(read("../src/follow-mail.js"), /follow-request-deletion/);
});
