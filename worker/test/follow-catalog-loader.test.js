import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadFollowCatalog } from "../src/follow-catalog-loader.js";

const bytes = readFileSync(new URL("./fixtures/follow-catalog-python.json", import.meta.url));
const wire = JSON.parse(bytes);
const hash = (body) => createHash("sha256").update(body).digest("hex");
const origin = "https://catalog.example.test";
const release = () => ({
  url: origin + "/qualified.json",
  sourceSha256: wire.source_sha256,
  catalogSha256: hash(bytes),
  notBefore: 1000,
  expiresAt: 2000,
});
const reply = (body, init) => {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: release().url, configurable: true });
  return response;
};
const prior = () => Object.fromEntries(Object.entries(wire.valid).map(([k, v]) => [k, new Set(v)]));
const options = (extra = {}) => ({
  enabled: true,
  origin,
  release: release(),
  previousValid: prior(),
  maxBytes: bytes.length,
  maxKeys: 100,
  deadlineMs: 100,
  now: () => 1100,
  fetch: async () => reply(bytes),
  ...extra,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// All URLs are synthetic. Every transport is injected; no global fetch/network is used.
test("catalog loader is off by default and rejects bad release/config before fetching", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return reply(bytes);
  };
  assert.deepEqual(await loadFollowCatalog(), { status: "disabled" });
  assert.deepEqual(await loadFollowCatalog(null), { status: "disabled" });
  for (const change of [
    { enabled: 1 },
    { origin: "http://catalog.example.test" },
    { origin: origin + "/" },
    { release: { ...release(), sourceSha256: undefined } },
    { release: { ...release(), catalogSha256: "bad" } },
    { release: { ...release(), expiresAt: 1100 } },
    { release: { ...release(), notBefore: 1200 } },
    { previousValid: {} },
    { previousValid: { ...prior(), fields: new Set(["not a field"]) } },
    { previousValid: { ...prior(), companies: new Set([" padded"]) } },
    { previousValid: { ...prior(), states: new Set(["REMOTE"]) } },
    { previousValid: { ...prior(), states: new Set([null]) } },

    { maxBytes: 0 },
    { deadlineMs: 2147483648 },
  ]) {
    const r = await loadFollowCatalog(options({ fetch, ...change }));
    assert.notEqual(r.status, "available");
  }
  assert.equal(calls, 0);
});

test("catalog loader rejects cross-origin and normalization aliases without a request", async () => {
  for (const url of [
    "https://other.example.test/qualified.json",
    origin + "/qualified.json?q=x",
    origin + "/qualified.json?",
    origin + "/qualified.json#",
    origin + "/qualified.json#x",
    "https://user@catalog.example.test/qualified.json",
    "https:///catalog.example.test/qualified.json",
    "https://%63atalog.example.test/qualified.json",
    origin + "/a/../qualified.json",
  ]) {
    const r = await loadFollowCatalog(
      options({ release: { ...release(), url }, fetch: () => assert.fail("request") }),
    );
    assert.deepEqual(r, { status: "unavailable" });
  }
});

test("exact response gives fresh private Sets with pinned continuity and constrained GET", async () => {
  let count = 0;
  const fetch = async (url, init) => {
    count++;
    assert.equal(url, release().url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.signal.aborted, false);
    return reply(bytes, { headers: { "content-length": String(bytes.length) } });
  };
  const first = await loadFollowCatalog(options({ fetch }));
  assert.equal(first.status, "available");
  assert.equal(first.catalog.signup.fields.size, 66);
  assert(first.catalog.valid.companies.has("company without roles"));
  first.catalog.signup.fields.clear();
  const second = await loadFollowCatalog(options({ fetch }));
  assert.equal(second.catalog.signup.fields.size, 66);
  assert.equal(count, 2); // no retained cache or shared return object
});

test("pins and previous sets are copied before fetch await", async () => {
  const wait = deferred(),
    config = options({ fetch: () => wait.promise });
  const pending = loadFollowCatalog(config);
  config.release.catalogSha256 = "0".repeat(64);
  config.release.expiresAt = 0;
  config.previousValid.companies.add("unknown changed while loading");
  wait.resolve(reply(bytes));
  assert.equal((await pending).status, "available");
});

test("redirects bad status mismatched URL and body length fail closed and cancel", async () => {
  for (const kind of [
    "redirect",
    "redirected",
    "blank",
    "url",
    "status",
    "declared",
    "short",
    "long",
    "empty",
    "chunk",
  ]) {
    let cancelled = 0;
    const body = new ReadableStream({
      start(c) {
        if (kind === "empty") c.close();
        else c.enqueue(kind === "chunk" ? "not bytes" : bytes);
      },
      cancel() {
        cancelled++;
      },
    });
    const response = reply(body, {
      status: kind === "redirect" ? 302 : kind === "status" ? 503 : 200,
      headers:
        kind === "declared"
          ? { "content-length": "invalid" }
          : kind === "long"
            ? { "content-length": String(bytes.length + 1) }
            : {},
    });
    if (kind === "redirected") Object.defineProperty(response, "redirected", { value: true });
    if (kind === "blank") Object.defineProperty(response, "url", { value: "" });
    if (kind === "url") Object.defineProperty(response, "url", { value: origin + "/other.json" });
    // Short/empty finish immediately; long/other rejection cancels without draining.
    const get =
      kind === "short"
        ? async () =>
            reply(bytes.subarray(1), { headers: { "content-length": String(bytes.length) } })
        : async () => response;
    const config = options({ fetch: get, maxBytes: bytes.length });
    assert.deepEqual(await loadFollowCatalog(config), { status: "unavailable" });
    if (!["short", "empty"].includes(kind)) assert.equal(cancelled, 1);
  }
});

test("bad payload pin source pin canonical shape UTF8 or continuity never becomes available", async () => {
  for (const kind of ["payload", "source", "shape", "utf8", "continuity"]) {
    const body =
      kind === "utf8" ? Buffer.from([255]) : kind === "shape" ? Buffer.from("{}") : bytes;
    const config = options({ maxBytes: bytes.length, fetch: async () => reply(body) });
    if (kind === "payload") config.release.catalogSha256 = "0".repeat(64);
    else config.release.catalogSha256 = hash(body);
    if (kind === "source") config.release.sourceSha256 = "0".repeat(64);
    if (kind === "continuity") config.previousValid.companies.add("missing required old company");
    assert.deepEqual(await loadFollowCatalog(config), { status: "unavailable" });
  }
});

test("one absolute deadline cancels stalled body and late fetch; later invocation works", async () => {
  for (const late of [false, true]) {
    let fire,
      signal,
      cancelled = 0;
    const wait = deferred();
    const response = reply(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    );
    const config = options({
      schedule: (cb) => {
        fire = cb;
        return 1;
      },
      cancel: () => {},
      fetch: async (_url, init) => {
        signal = init.signal;
        return late ? wait.promise : response;
      },
    });
    const task = loadFollowCatalog(config);
    await Promise.resolve();
    await Promise.resolve();
    fire();
    assert.deepEqual(await task, { status: "unavailable" });
    assert(signal.aborted);
    if (late) {
      wait.resolve(response);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    assert.equal(cancelled, 1);
    assert.equal(response.body.locked, false);
  }
  assert.equal((await loadFollowCatalog(options())).status, "available");
});

test("fresh clock rejects release expiry rollback and deadline even before timer callback", async () => {
  for (const next of [2000, 1099, 1200]) {
    let at = 1100;
    const result = await loadFollowCatalog(
      options({
        now: () => at,
        schedule: () => 1,
        cancel: () => {},
        fetch: async () => {
          at = next;
          return reply(bytes);
        },
      }),
    );
    assert.deepEqual(result, { status: "unavailable" });
  }
});

test("expiration during digest parsing is rechecked before availability", async () => {
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let at = 1100;
  const own = Object.getOwnPropertyDescriptor(crypto.subtle, "digest");
  Object.defineProperty(crypto.subtle, "digest", {
    configurable: true,
    value: async (...args) => {
      const result = await original(...args);
      at = 2000;
      return result;
    },
  });
  try {
    assert.deepEqual(await loadFollowCatalog(options({ now: () => at })), {
      status: "unavailable",
    });
  } finally {
    if (own) Object.defineProperty(crypto.subtle, "digest", own);
    else delete crypto.subtle.digest;
  }
});
test("stream byte cap and elapsed deadline hold without timer callback delivery", async () => {
  let cancelled = 0;
  const oversize = reply(
    new ReadableStream({
      start(c) {
        c.enqueue(bytes);
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  assert.deepEqual(
    await loadFollowCatalog(options({ maxBytes: bytes.length - 1, fetch: async () => oversize })),
    { status: "unavailable" },
  );
  assert.equal(cancelled, 1);
  let at = 1100;
  const stream = reply(
    new ReadableStream({
      pull(c) {
        at += 1;
        c.enqueue(new Uint8Array([32]));
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  assert.deepEqual(
    await loadFollowCatalog(
      options({
        now: () => at,
        deadlineMs: 3,
        schedule: () => 1,
        cancel: () => {},
        fetch: async () => stream,
      }),
    ),
    { status: "unavailable" },
  );
  assert.equal(cancelled, 2);
});

test("outer result fence rejects expiry queued immediately after inner parser check", async () => {
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const own = Object.getOwnPropertyDescriptor(crypto.subtle, "digest");
  let at = 1100,
    parsed = false,
    queued = false;
  Object.defineProperty(crypto.subtle, "digest", {
    configurable: true,
    value: async (...args) => {
      const result = await original(...args);
      parsed = true;
      return result;
    },
  });
  const now = () => {
    if (parsed && !queued) {
      queued = true;
      queueMicrotask(() => {
        at = 2000;
      });
    }
    return at;
  };
  try {
    assert.deepEqual(await loadFollowCatalog(options({ now })), { status: "unavailable" });
  } finally {
    if (own) Object.defineProperty(crypto.subtle, "digest", own);
    else delete crypto.subtle.digest;
  }
  assert(queued);
});
