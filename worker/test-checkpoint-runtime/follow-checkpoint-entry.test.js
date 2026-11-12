import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

import entry from "../src/follow-checkpoint-entry.js";

const ORIGIN = "https://private-checkpoint.example.test";
const PATH = "/v1/checkpoint";
const writer = "Bearer " + "A".repeat(43);
const operator = "Bearer " + "B".repeat(43);
const timestamp = (ms) => new Date(ms).toISOString().replace("Z", "000Z");

function pending(now) {
  return JSON.stringify({
    candidate_commit: "1".repeat(40),
    candidate_tree: "2".repeat(40),
    covers_after: timestamp(now - 60_000),
    index_sha256: "3".repeat(64),
    predecessor: {
      checkpoint_sha256: null,
      commit: "4".repeat(40),
      public_tree: "5".repeat(40),
    },
    prepared_at: timestamp(now - 1_000),
    public_tree: "6".repeat(40),
    rows: [],
    shard_sha256: { MA: "7".repeat(64) },
    version: 1,
  });
}

test("real Wrangler config serves one local SQLite singleton only at the exact origin", async () => {
  const before = await SELF.fetch(ORIGIN + PATH, { headers: { Authorization: writer } });
  expect(before.status).toBe(200);
  expect(before.headers.get("Follow-State")).toBe("never_seeded");
  const body = pending(Date.now());
  const staged = await SELF.fetch(ORIGIN + PATH + "/stage", {
    method: "POST",
    headers: { Authorization: writer, "Content-Type": "application/octet-stream" },
    body,
  });
  expect(await staged.json()).toEqual({ status: "pending" });
  const loaded = await SELF.fetch(ORIGIN + PATH, { headers: { Authorization: operator } });
  expect(loaded.headers.get("Follow-Pending-Bytes")).toBe(String(new TextEncoder().encode(body).length));
  expect(new TextDecoder().decode(await loaded.arrayBuffer())).toBe(body);
  const singleton = await env.FOLLOW_CHECKPOINT.getByName("follow-checkpoint-v1").read(4096);
  expect(new TextDecoder().decode(singleton.pending)).toBe(body);

  const store = env.FOLLOW_CHECKPOINT.getByName("follow-checkpoint-v1");
  const storedBefore = await store.read(4096);
  for (const suffix of ["", "/stage", "/promote", "/reject"]) {
    const denied = await entry.fetch(new Request(ORIGIN + PATH + suffix, {
      method: suffix ? "POST" : "GET",
      headers: { Authorization: writer },
    }), { ...env, FOLLOW_CHECKPOINT_ENABLED: "0" });
    expect(denied.status).toBe(503);
  }
  const after = await store.read(4096);
  expect(after).toEqual(storedBefore);
  const reopened = await entry.fetch(new Request(ORIGIN + PATH, {
    headers: { Authorization: writer },
  }), { ...env, FOLLOW_CHECKPOINT_ENABLED: "1" });
  expect(reopened.status).toBe(200);
  expect(new TextDecoder().decode(await reopened.arrayBuffer())).toBe(body);

  for (const origin of ["https://alternate.example.test", "https://private-checkpoint.example.test:8443", ORIGIN.replace("https:", "http:")]) {
    const denied = await SELF.fetch(origin + PATH, {
      headers: {
        Authorization: writer, Host: new URL(ORIGIN).hostname, Origin: ORIGIN,
        "X-Forwarded-Host": new URL(ORIGIN).hostname,
      },
    });
    expect(denied.status).toBe(404);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(await denied.text()).toBe("");
  }
});

test("invalid configuration cannot pull a body or open the singleton", async () => {
  let reads = 0;
  let opened = 0;
  const valid = {
    FOLLOW_CHECKPOINT_ENABLED: "1",
    FOLLOW_CHECKPOINT_ORIGIN: ORIGIN,
    FOLLOW_CHECKPOINT_MAX_BYTES: "4096",
    FOLLOW_CHECKPOINT_WRITER_SHA256: env.FOLLOW_CHECKPOINT_WRITER_SHA256,
    FOLLOW_CHECKPOINT_OPERATOR_SHA256: env.FOLLOW_CHECKPOINT_OPERATOR_SHA256,
    FOLLOW_CHECKPOINT: { getByName() { opened++; throw new Error("unexpected namespace access"); } },
  };
  const invalid = [
    { FOLLOW_CHECKPOINT_ORIGIN: undefined },
    { FOLLOW_CHECKPOINT_ORIGIN: ORIGIN + "/" },
    { FOLLOW_CHECKPOINT_ORIGIN: ORIGIN + ":443" },
    { FOLLOW_CHECKPOINT_ORIGIN: ORIGIN + "?scope=checkpoint" },
    { FOLLOW_CHECKPOINT_ORIGIN: "https://user@private-checkpoint.example.test" },
    { FOLLOW_CHECKPOINT_ORIGIN: "https://alias.internscout.workers.dev" },
    { FOLLOW_CHECKPOINT_ORIGIN: "https://127.0.0.1" },
    { FOLLOW_CHECKPOINT_MAX_BYTES: "04096" },
    { FOLLOW_CHECKPOINT_MAX_BYTES: "8000001" },
    { FOLLOW_CHECKPOINT_MAX_BYTES: 4096 },
    { FOLLOW_CHECKPOINT_WRITER_SHA256: "invalid" },
    { FOLLOW_CHECKPOINT_OPERATOR_SHA256: valid.FOLLOW_CHECKPOINT_WRITER_SHA256 },
    { FOLLOW_CHECKPOINT: undefined },
  ];
  function request(url, authorization) {
    return new Request(url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/octet-stream" },
      body: new ReadableStream({
        pull(controller) {
          reads++;
          controller.close();
        },
      }, { highWaterMark: 0 }),
    });
  }

  for (const values of invalid) {
    const denied = await entry.fetch(request(ORIGIN + PATH + "/stage", writer), { ...valid, ...values });
    expect(denied.status).toBe(503);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(await denied.text()).toBe("");
  }
  expect((await entry.fetch(request(ORIGIN + PATH + "/stage", "Bearer " + "C".repeat(43)), valid)).status).toBe(401);
  expect((await entry.fetch(request(ORIGIN + PATH + "/stage", operator), valid)).status).toBe(403);
  expect(reads).toBe(0);
  expect(opened).toBe(0);
});


test("fully configured admission stays closed without the exact literal opt-in", async () => {
  let reads = 0;
  let opened = 0;
  const configured = {
    ...env,
    FOLLOW_CHECKPOINT: { getByName() { opened++; throw new Error("unexpected namespace access"); } },
  };
  const values = [undefined, null, "", "0", "false", "true", "on", "01", " 1", "1 ", 1, true, ["1"], { toString: () => "1" }];
  for (const value of values) {
    for (const suffix of ["", "/stage", "/promote", "/reject"]) {
      const body = suffix === "/stage" || suffix === "/promote"
        ? new ReadableStream({ pull(controller) { reads++; controller.close(); } }, { highWaterMark: 0 })
        : undefined;
      const request = new Request(ORIGIN + PATH + suffix, {
        method: suffix ? "POST" : "GET",
        headers: { Authorization: writer, "Content-Type": "application/octet-stream" },
        body,
      });
      const denied = await entry.fetch(request, { ...configured, FOLLOW_CHECKPOINT_ENABLED: value });
      expect(denied.status).toBe(503);
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
      expect(denied.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await denied.text()).toBe("");
    }
  }
  expect(reads).toBe(0);
  expect(opened).toBe(0);
  const untouched = new Proxy({}, { get(_target, key) {
    if (key === "FOLLOW_CHECKPOINT_ENABLED") return undefined;
    throw new Error("disabled admission inspected configuration");
  } });
  expect((await entry.fetch(new Request(ORIGIN + PATH), untouched)).status).toBe(503);
});
