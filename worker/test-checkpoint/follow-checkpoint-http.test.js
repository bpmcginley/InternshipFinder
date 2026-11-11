import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

import { handleFollowCheckpoint } from "../src/follow-checkpoint-http.js";
import { credentials, OPERATOR, sha, WRITER } from "./worker.js";

const encoder = new TextEncoder();
const encode = (obj) => encoder.encode(JSON.stringify(obj));
const PREFIX = "/v1/checkpoint";
const BINARY = "application/octet-stream";
const BASE = "1".repeat(40);
const TREE = "2".repeat(40);
const NEXT = "3".repeat(40);
const HASH = "4".repeat(64);
const SEED = { checkpoint_sha256: null, commit: BASE, public_tree: TREE };
const wire = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
const auth = (secret = WRITER) => ({ Authorization: `Bearer ${secret}` });

function stageBytes(at, predecessor = SEED) {
  return encode({
    candidate_commit: "5".repeat(40),
    candidate_tree: "6".repeat(40),
    covers_after: wire(at - 10_000),
    index_sha256: HASH,
    predecessor,
    prepared_at: wire(at),
    public_tree: TREE,
    rows: [["0123456789abcdef", "2026-11-11T12:00:00", "verified_utc", wire(at - 5_000)]],
    shard_sha256: { MA: HASH },
    version: 1,
  });
}

function acceptedBytes(at) {
  return encode({
    accepted_at: wire(at),
    accepted_commit: NEXT,
    covers_after: wire(at - 100_000),
    index_sha256: HASH,
    public_tree: TREE,
    rows: [],
    shard_sha256: { MA: HASH },
    version: 1,
  });
}

function post(body, headers = {}) {
  return { method: "POST", body, headers: { "Content-Type": BINARY, ...auth(), ...headers } };
}

test("authorized HTTP roundtrip uses one real SQLite snapshot and exact generation", async () => {
  const endpoint = `https://roundtrip.local${PREFIX}`;
  const fetch = (suffix, options) => SELF.fetch(endpoint + suffix, options);
  const now = Date.now();
  const first = stageBytes(now - 60_000);
  let response = await fetch("", { headers: auth() });
  expect(response.headers.get("Follow-State")).toBe("never_seeded");
  expect(await fetch("/stage", post(first, auth(OPERATOR)))).toMatchObject({ status: 403 });
  response = await fetch("/stage", post(first));
  expect(await response.json()).toEqual({ status: "pending" });
  const headers = {
    ...auth(OPERATOR),
    "Follow-Pending-Generation": await sha(first),
    "Follow-Checked-At": wire(now - 1_000),
    "Follow-Predecessor": `${BASE}:${TREE}:-`,
  };
  const accepted = acceptedBytes(now - 30_000);
  response = await fetch("/promote", post(accepted, headers));
  expect(await response.json()).toEqual({ status: "promoted" });
  const newer = stageBytes(now - 1_000, {
    checkpoint_sha256: await sha(accepted), commit: NEXT, public_tree: TREE,
  });
  expect(await (await fetch("/stage", post(newer))).json()).toEqual({ status: "pending" });
  expect(await (await fetch("/promote", post(accepted, headers))).json()).toEqual({ status: "already_promoted" });

  response = await fetch("", { headers: auth(OPERATOR) });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(response.headers.get("Follow-State")).toBe("active");
  expect(response.headers.get("Follow-Accepted-Bytes")).toBe(String(accepted.byteLength));
  expect(response.headers.get("Follow-Pending-Bytes")).toBe(String(newer.byteLength));
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.slice(0, accepted.byteLength)).toEqual(accepted);
  expect(bytes.slice(accepted.byteLength)).toEqual(newer);

  const reject = (generation) => fetch("/reject", {
    method: "POST", headers: { ...auth(OPERATOR), "Follow-Pending-Generation": generation },
  });
  expect((await reject(headers["Follow-Pending-Generation"])).status).toBe(409);
  expect(await (await reject(await sha(newer))).json()).toEqual({ status: "rejected" });
});

test("unauthenticated and unauthorized requests do not read a body or open a store", async () => {
  let pulled = 0;
  const upload = () => new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(encoder.encode("sensitive fixture"));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const config = {
    ...await credentials(), maxBytes: 100, openStore: () => { throw new Error("must remain detached"); },
  };
  const handle = (headers, override = {}) => handleFollowCheckpoint(
    new Request(`https://local.test${PREFIX}/stage`, {
      ...post(upload(), headers), ...override,
    }), config);
  const wrong = await handle({ ...auth("C".repeat(43)), "Cf-Access-Jwt-Assertion": "synthetic" });
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).toBe("");
  expect((await handle(auth(OPERATOR))).status).toBe(403);
  expect(pulled).toBe(0);
});

test("canonical validation, streamed bounds and malformed headers fail before storage", async () => {
  const bytes = stageBytes(Date.now() - 30_000);
  const canonical = new TextDecoder().decode(bytes);
  let opened = 0;
  const config = {
    ...await credentials(), maxBytes: bytes.byteLength,
    openStore: () => { opened++; throw new Error("malformed input reached storage"); },
  };
  const run = (suffix, options) => handleFollowCheckpoint(
    new Request(`https://local.test${PREFIX}${suffix}`, options), config);
  expect((await run("/stage", post(" " + canonical))).status).toBe(413);
  expect((await run("/stage", post(canonical.replace(',"version":1', ',"version":0')))).status).toBe(400);
  expect((await run("/stage", post(canonical.replace('"version":1', '"version":1,"version":1')))).status).toBe(413);
  const room = { ...config, maxBytes: bytes.byteLength + 32 };
  const duplicate = new Request(`https://local.test${PREFIX}/stage`, post(
    canonical.replace('"version":1', '"version":1,"version":1')));
  expect((await handleFollowCheckpoint(duplicate, room)).status).toBe(400);
  expect((await run("/stage", post(bytes, { "Content-Length": "1" }))).status).toBe(400);
  expect((await run("/stage", post(bytes, { "Content-Length": "1,1" }))).status).toBe(400);
  expect((await run("/stage", post(bytes, { "Content-Encoding": "gzip" }))).status).toBe(400);
  expect((await run("/stage", post(bytes, { "Content-Type": "application/json" }))).status).toBe(415);
  expect((await run("/promote", post(bytes))).status).toBe(400);
  expect((await run("?slot=pending", { headers: auth() })).status).toBe(404);
  expect((await run("?", { headers: auth() })).status).toBe(404);
  expect((await run("", { headers: auth(), method: "HEAD" })).status).toBe(405);
  const insecure = new Request(`http://local.test${PREFIX}`, { headers: auth() });
  expect((await handleFollowCheckpoint(insecure, config)).status).toBe(404);
  expect(opened).toBe(0);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.enqueue(new Uint8Array([0]));
      controller.close();
    },
  });
  expect((await run("/stage", post(stream))).status).toBe(413);
  expect(opened).toBe(0);
});

test("unavailable configuration and ambiguous storage responses remain generic", async () => {
  const config = {
    ...await credentials(), maxBytes: 4096,
    openStore: () => ({ async reservePending() { throw new Error("private fixture detail"); } }),
  };
  const req = () => new Request(`https://local.test${PREFIX}/stage`, post(stageBytes(Date.now() - 1_000)));
  const broken = await handleFollowCheckpoint(req(), config);
  expect(broken.status).toBe(503);
  expect(await broken.text()).toBe("");
  const wrong = await handleFollowCheckpoint(req(), {
    ...config, openStore: () => ({ async reservePending() { return "promoted"; } }),
  });
  expect(wrong.status).toBe(503);
  const duplicate = await handleFollowCheckpoint(req(), { ...config, operator: config.writer });
  expect(duplicate.status).toBe(503);
});


test("measured-scale canonical checkpoint stays byte-exact through HTTP and SQLite", async () => {
  const endpoint = `https://scale.local${PREFIX}`;
  const now = Date.now() - 60_000;
  const record = JSON.parse(new TextDecoder().decode(stageBytes(now)));
  record.rows = Array.from({ length: 26_977 }, (_, index) => [
    index.toString(16).padStart(16, "0"),
    "2026-11-10T12:00:00",
    "observed_by",
    wire(now - 10_000),
  ]);
  const input = encode(record);
  expect(input.byteLength).toBeGreaterThan(2_000_000);
  expect(await (await SELF.fetch(endpoint + "/stage", post(input))).json()).toEqual({ status: "pending" });
  const response = await SELF.fetch(endpoint, { headers: auth(OPERATOR) });
  expect(response.headers.get("Follow-Accepted-Bytes")).toBe("0");
  expect(response.headers.get("Follow-Pending-Bytes")).toBe(String(input.byteLength));
  expect(await sha(await response.arrayBuffer())).toBe(await sha(input));
});
