import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFollowArchiveReader } from "../src/follow-archive-reader.js";
import { followSnapshotDigest, matchFollowSnapshot } from "../src/follow-matching.js";
import { prepareLeasedFollowDigest } from "../src/follow-digest-prepare.js";
import { payloadOf } from "../src/follow-outbox.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/follow-archive-python.json", import.meta.url)),
);
const indexUrl = "https://archive.example.test/data/follows/index.json";
const indexPath = "data/follows/index.json";
const enc = new TextEncoder();
const bounds = {
  maxManifestBytes: 3000,
  maxEntries: 5,
  maxArchiveBytes: 40000,
  maxEnqueueAgeMs: 86400000,
  publishMarginMs: 86400000,
  deadlineMs: 500,
};
const limits = {
  maxBytes: 8000,
  maxRoles: 10,
  maxFollows: 10,
  maxMatches: 10,
  maxResultBytes: 8000,
  maxTextBytes: 2000,
  maxWindowMs: 3 * 86400000,
};
const catalog = {
  companies: new Set(["fixture"]),
  fields: new Set(["swe"]),
  states: new Set(["MA"]),
};
const canonical = (value) =>
  JSON.stringify(value, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const initial = JSON.parse(fixture.files[indexPath]);
const older = initial.entries[0],
  latest = initial.entries[1];
const pin = (entry) => ({ at: entry.generated_at, digest: entry.sha256, maxBytes: 8000 });
const lower = "2028-01-01T00:00:00.000Z";
function setup(options = {}) {
  const files = { ...fixture.files },
    calls = [];
  let time = "2028-01-03T00:00:00.000Z";
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const body = files[new URL(url).pathname.slice(1)];
    return new Response(body ?? "Missing", { status: body === undefined ? 404 : 200 });
  };
  const reader = createFollowArchiveReader({
    indexUrl,
    fetch,
    clock: () => new Date(time),
    bounds,
    catalog,
    limits,
    ...options,
  });
  return {
    files,
    calls,
    reader,
    at: (value) => {
      time = value;
    },
    manifest: (edit) => {
      const m = JSON.parse(files[indexPath]);
      edit(m);
      files[indexPath] = canonical(m);
    },
  };
}

test("exact #327 Python bytes work for latest and independent older pin without side effects", async () => {
  assert.equal(fixture.python_ref, "8290ecedcb640c1180091941732f36cadda45d7c");
  const s = setup(),
    result = await s.reader.latest({ effectiveLower: lower });
  assert.equal(result.status, "ready");
  assert.equal(result.digest, latest.sha256);
  const bytes = await s.reader.loadSnapshot(pin(older));
  assert.equal(await followSnapshotDigest(bytes), older.sha256);
  assert.equal(new TextDecoder().decode(bytes), fixture.files[`data/follows/${older.sha256}.json`]);
  assert.equal(
    matchFollowSnapshot(bytes, [], { catalog, limits, upperBound: older.generated_at }).status,
    "matched",
  );
  for (const call of s.calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.redirect, "error");
    assert.equal(new URL(call.url).origin, new URL(indexUrl).origin);
    assert(call.signal instanceof AbortSignal);
  }
  assert.equal(s.calls.length, 4);
});

test("latest exact freshness and coverage boundaries never fall back to an older generation", async () => {
  for (const effectiveLower of ["2027-12-30T23:58:59.999Z", "2028-01-03T00:00:00.000Z"]) {
    const s = setup();
    assert.deepEqual(await s.reader.latest({ effectiveLower }), {
      status: effectiveLower < latest.generated_at ? "gap" : "unavailable",
    });
    assert.equal(s.calls.length, 2);
  }
  const s = setup();
  assert.equal(
    (await s.reader.latest({ effectiveLower: "2027-12-30T23:59:00.000Z" })).status,
    "ready",
  );
  assert.equal((await s.reader.latest({ effectiveLower: latest.generated_at })).status, "ready");
  s.at(latest.enqueue_until);
  assert.deepEqual(await s.reader.latest({ effectiveLower: lower }), { status: "unavailable" });
  assert(
    await s.reader.loadSnapshot(pin(older)),
    "stale latest does not invalidate unexpired older pin",
  );
  s.at(older.retain_until);
  assert.equal(await s.reader.loadSnapshot(pin(older)), null);
});

test("missing pin, wrong date, caller byte cap and invalid input never return latest instead", async () => {
  for (const value of [
    { ...pin(older), digest: "f".repeat(64) },
    { ...pin(older), at: latest.generated_at },
    { ...pin(older), maxBytes: older.bytes - 1 },
    { ...pin(older), at: "yesterday" },
    { ...pin(older), maxBytes: 0 },
  ]) {
    const s = setup();
    assert.equal(await s.reader.loadSnapshot(value), null);
    assert(s.calls.length <= 1);
  }
});

test("canonical manifest rejects duplicate keys, whitespace, unknown keys and wrong pointer", async () => {
  for (const change of [
    (raw) => raw.replace('"version":1', '"version":1,"version":1'),
    (raw) => raw + "\n",
    (raw) => raw.replace('"version":1', '"extra":null,"version":1'),
  ]) {
    const s = setup();
    s.files[indexPath] = change(s.files[indexPath]);
    assert.equal(await s.reader.loadSnapshot(pin(older)), null);
    assert.equal(s.calls.length, 1);
  }
  const s = setup();
  s.manifest((m) => {
    m.latest = older.sha256;
  });
  assert.equal(await s.reader.loadSnapshot(pin(older)), null);
});

test("manifest metadata fails closed for duplicate day/digest, order, deadlines, bounds and future clocks", async () => {
  const edits = [
    (m) => m.entries.reverse(),
    (m) => m.entries.push(m.entries[1]),
    (m) => {
      m.entries[0].sha256 = latest.sha256;
    },
    (m) => {
      m.entries[0].bytes = 0;
    },
    (m) => {
      m.entries[0].bytes = 8001;
    },
    (m) => {
      m.entries[0].enqueue_until = m.entries[0].retain_until;
    },
    (m) => {
      m.entries[0].retain_until = latest.retain_until;
    },
    (m) => {
      m.high_water = older.generated_at;
    },
    (m) => {
      m.checked_at = "2028-01-04T00:00:00.000Z";
    },
    (m) => {
      m.checked_at = "2028-02-30T00:00:00.000Z";
    },
  ];
  for (const edit of edits) {
    const s = setup();
    s.manifest(edit);
    assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  }
  for (const b of [{ maxEntries: 1 }, { maxManifestBytes: 100 }, { maxArchiveBytes: 1000 }]) {
    const s = setup({ bounds: { ...bounds, ...b } });
    assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  }
});

test("pruned-empty archive is valid but unavailable; no guessing from its high-water", async () => {
  const s = setup();
  s.manifest((m) => {
    m.entries = [];
    m.latest = null;
  });
  assert.deepEqual(await s.reader.latest({ effectiveLower: lower }), { status: "unavailable" });
  assert.equal(await s.reader.loadSnapshot(pin(older)), null);
});

test("tampered, truncated and malformed UTF-8 blob bytes cannot satisfy a pin", async () => {
  for (const value of [
    "changed",
    fixture.files[`data/follows/${older.sha256}.json`].slice(0, -1),
    new Uint8Array([255]),
  ]) {
    const s = setup();
    s.files[`data/follows/${older.sha256}.json`] = value;
    assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  }
});

test("matching validation also rejects a digest-consistent invalid role or duplicate JSON key", async () => {
  for (const transform of [
    (raw) => raw.replace('"status":"open"', '"status":"closed"'),
    (raw) => raw.replace('"version":1', '"version":1,"version":1'),
    (raw) => raw.replace('"company_key":"fixture"', '"company_key":"unknown"'),
  ]) {
    const s = setup(),
      body = transform(s.files[`data/follows/${older.sha256}.json`]);
    const hash = await followSnapshotDigest(enc.encode(body));
    s.manifest((m) => {
      m.entries[0].sha256 = hash;
      m.entries[0].bytes = enc.encode(body).length;
    });
    s.files[`data/follows/${hash}.json`] = body;
    assert.equal(await s.reader.loadSnapshot({ ...pin(older), digest: hash }), null);
  }
});

test("missing responses, redirects and foreign response URLs fail closed", async () => {
  for (const response of [
    new Response("", { status: 404 }),
    new Response("", { status: 302 }),
    Object.defineProperty(new Response(fixture.files[indexPath]), "redirected", { value: true }),
    Object.defineProperty(new Response(fixture.files[indexPath]), "url", {
      value: "https://other.example.test/index.json",
    }),
  ]) {
    const s = setup({ fetch: async () => response });
    assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  }
});

test("stream and declared byte bounds cancel rather than accepting a partial document", async () => {
  for (const header of [null, "9000", "3", "wat"]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(3001));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: header === null ? {} : { "content-length": header } },
    );
    const s = setup({ fetch: async () => response });
    assert.equal(await s.reader.loadSnapshot(pin(older)), null);
    assert(cancelled);
  }
});

test("deadline bounds stalled fetch, late response cleanup and stalled stream; retry is independent", async () => {
  let resolve,
    cancelled = false,
    firstSignal;
  const s = setup({
    bounds: { ...bounds, deadlineMs: 15 },
    fetch: (_url, init) => {
      firstSignal = init.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  assert(firstSignal.aborted);
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert(cancelled);
  const stalled = setup({
    bounds: { ...bounds, deadlineMs: 15 },
    fetch: async () => new Response(new ReadableStream()),
  });
  assert.equal(await stalled.reader.loadSnapshot(pin(older)), null);
  assert(await setup().reader.loadSnapshot(pin(older)));
});

test("one reader operation cannot cancel another concurrent request", async () => {
  let count = 0,
    firstSignal,
    secondSignal;
  const s = setup({
    bounds: { ...bounds, deadlineMs: 30 },
    fetch: async (url, init) => {
      count++;
      if (count === 1) {
        firstSignal = init.signal;
        return new Promise(() => {});
      }
      secondSignal = init.signal;
      return new Response(fixture.files[new URL(url).pathname.slice(1)]);
    },
  });
  const first = s.reader.loadSnapshot(pin(older));
  assert(await s.reader.loadSnapshot(pin(latest)));
  assert.notEqual(firstSignal, secondSignal);
  assert.equal(await first, null);
});

test("clock regression, invalid time and expiry during loading return no bytes", async () => {
  const s = setup();
  assert(await s.reader.loadSnapshot(pin(older)));
  s.at("2028-01-02T00:00:00.000Z");
  assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  s.at("invalid");
  assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  let time = new Date("2028-01-03T00:00:00.000Z");
  const ending = setup({
    clock: () => time,
    fetch: async (url) => {
      if (!url.endsWith("index.json")) time = new Date(older.retain_until);
      return new Response(fixture.files[new URL(url).pathname.slice(1)]);
    },
  });
  assert.equal(await ending.reader.loadSnapshot(pin(older)), null);
});

test("configuration is explicit, same-origin and insulated from caller mutation", async () => {
  for (const override of [
    { indexUrl: undefined },
    { indexUrl: "https://user:pass@archive.example.test/data/follows/index.json" },
    { indexUrl: indexUrl + "?x=1" },
    { fetch: undefined },
    { clock: undefined },
    { bounds: {} },
    { limits: {} },
    { catalog: {} },
  ]) {
    assert.throws(() => setup(override));
  }
  const configured = { ...bounds },
    selected = { ...catalog, companies: new Set(["fixture"]) };
  const s = setup({ bounds: configured, catalog: selected });
  configured.maxEntries = 0;
  selected.companies.clear();
  assert(await s.reader.loadSnapshot(pin(older)));
});

test("#298 preparation accepts the injected pin loader without receiving recipient data", async () => {
  const s = setup(),
    scopeKey = '{"kind":"company","company":"fixture"}';
  const row = {
    subscriber_id: "synthetic",
    payload: payloadOf([{ scopeKey, roles: ["1".repeat(16)] }]),
    lease_until: "2028-01-03T01:00:00.000Z",
    expires_at: "2028-01-04T00:00:00.000Z",
    snapshot_at: older.generated_at,
    snapshot_digest: older.sha256,
    advances: JSON.stringify([
      { scopeKey, confirmedAt: lower, from: lower, to: older.generated_at },
    ]),
  };
  let reads = 0;
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          reads++;
          return row;
        },
      }),
    }),
  };
  const result = await prepareLeasedFollowDigest(
    db,
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    {
      catalog,
      limits,
      clock: () => new Date("2028-01-03T00:00:00.000Z"),
      loadSnapshot: async (value) => {
        assert.deepEqual(value, pin(older));
        return s.reader.loadSnapshot(value);
      },
    },
  );
  assert.equal(result.status, "ready");
  assert.equal(result.roles[0].title, "Synthetic café role");
  assert.equal(reads, 2);
});

test("empty stream chunks are rejected without an unbounded zero-byte loop", async () => {
  let cancelled = false;
  const s = setup({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array());
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal(await s.reader.loadSnapshot(pin(older)), null);
  assert(cancelled);
});

test("absolute deadline rejects immediate responses after clock advance before timer can fire", async () => {
  for (const delayedCall of [1, 2]) {
    let calls = 0,
      time = Date.parse("2028-01-03T00:00:00.000Z");
    const s = setup({
      clock: () => new Date(time),
      fetch: async (url) => {
        if (++calls === delayedCall) time += bounds.deadlineMs;
        return new Response(fixture.files[new URL(url).pathname.slice(1)]);
      },
    });
    assert.equal(await s.reader.loadSnapshot(pin(older)), null);
    assert.equal(calls, delayedCall);
  }
});
