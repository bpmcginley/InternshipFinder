import { describe, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/follow-archive-python.json";
import { createFollowArchiveReader } from "../src/follow-archive-reader.js";
import { followSnapshotDigest } from "../src/follow-matching.js";

const indexUrl = "https://archive.example.test/data/follows/index.json";
const index = JSON.parse(fixture.files["data/follows/index.json"]);
const older = index.entries[0];
const pin = { at: older.generated_at, digest: older.sha256, maxBytes: 8000 };
function config(fetch) {
  return {
    indexUrl,
    fetch,
    clock: () => new Date("2028-01-03T00:00:00.000Z"),
    bounds: {
      maxManifestBytes: 3000,
      maxEntries: 5,
      maxArchiveBytes: 40000,
      maxEnqueueAgeMs: 86400000,
      publishMarginMs: 86400000,
      deadlineMs: 100,
    },
    catalog: { companies: new Set(["fixture"]), fields: new Set(["swe"]), states: new Set(["MA"]) },
    limits: {
      maxBytes: 8000,
      maxRoles: 10,
      maxFollows: 10,
      maxMatches: 10,
      maxResultBytes: 8000,
      maxTextBytes: 2000,
      maxWindowMs: 3 * 86400000,
    },
  };
}

describe("dormant archive reader in local Workers runtime", () => {
  it("reads actual Python manifest/blob bytes with synthetic GET responses only", async () => {
    const calls = [];
    const reader = createFollowArchiveReader(
      config(async (url, init) => {
        calls.push({ url, method: init.method, redirect: init.redirect });
        return new Response(fixture.files[new URL(url).pathname.slice(1)]);
      }),
    );
    const bytes = await reader.loadSnapshot(pin);
    expect(new TextDecoder().decode(bytes)).toBe(
      fixture.files[`data/follows/${older.sha256}.json`],
    );
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (c) =>
          c.method === "GET" &&
          c.redirect === "manual" &&
          new URL(c.url).origin === "https://archive.example.test",
      ),
    ).toBe(true);
  });

  it("owns concurrent controllers and bounds a stalled response without poisoning another read", async () => {
    let count = 0,
      stalledSignal;
    const reader = createFollowArchiveReader(
      config(async (url, init) => {
        if (++count === 1) {
          stalledSignal = init.signal;
          return new Promise(() => {});
        }
        expect(init.signal).not.toBe(stalledSignal);
        return new Response(fixture.files[new URL(url).pathname.slice(1)]);
      }),
    );
    const stalled = reader.loadSnapshot(pin);
    expect(await reader.loadSnapshot(pin)).toBeInstanceOf(Uint8Array);
    expect(await stalled).toBeNull();
    expect(stalledSignal.aborted).toBe(true);
    expect(await reader.loadSnapshot(pin)).toBeInstanceOf(Uint8Array);
  });
});

const encode = (raw) => new TextEncoder().encode(raw);
const manifestPath = "data/follows/index.json";
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

it("pins a forward manifest while retaining the older queued snapshot exactly", async () => {
  const latest = index.entries.at(-1),
    snapshot = JSON.parse(fixture.files[`data/follows/${latest.sha256}.json`]);
  snapshot.generated_at = "2028-01-03T23:59:00.000Z";
  snapshot.covers_after = "2027-12-31T23:59:00.000Z";
  const body = JSON.stringify(snapshot),
    next = {
      ...latest,
      bytes: encode(body).length,
      generated_at: snapshot.generated_at,
      enqueue_until: "2028-01-04T23:59:00.000Z",
      retain_until: "2028-01-07T23:59:00.000Z",
      sha256: await followSnapshotDigest(encode(body)),
    };
  const raw = canonical({
    ...index,
    checked_at: next.generated_at,
    high_water: next.generated_at,
    latest: next.sha256,
    entries: [...index.entries, next],
  });
  const files = {
      ...fixture.files,
      [manifestPath]: raw,
      [`data/follows/${next.sha256}.json`]: body,
    },
    calls = [];
  const reader = createFollowArchiveReader({
    ...config(async (url) => {
      calls.push(url);
      return new Response(files[new URL(url).pathname.slice(1)]);
    }),
    indexSha256: await followSnapshotDigest(encode(raw)),
    clock: () => new Date("2028-01-04T00:00:00.000Z"),
  });
  expect((await reader.latestSnapshot()).digest).toBe(next.sha256);
  expect(new TextDecoder().decode(await reader.loadSnapshot(pin))).toBe(
    fixture.files[`data/follows/${older.sha256}.json`],
  );
  expect(calls).toHaveLength(4);
});

it("holds both selectors on a coherent rollback without a blob GET or fallback", async () => {
  const raw = canonical({
      ...index,
      entries: [older],
      high_water: older.generated_at,
      latest: older.sha256,
    }),
    calls = [];
  const reader = createFollowArchiveReader({
    ...config(async (url) => {
      calls.push(url);
      return new Response(raw);
    }),
    indexSha256: await followSnapshotDigest(encode(fixture.files[manifestPath])),
  });
  expect(await reader.latestSnapshot()).toEqual({ status: "unavailable" });
  expect(await reader.loadSnapshot(pin)).toBeNull();
  expect(calls).toEqual([indexUrl, indexUrl]);
});

it("rejects malformed or nonprimitive manifest pins before fetch", () => {
  let calls = 0;
  for (const indexSha256 of [
    null,
    false,
    {},
    new String("a".repeat(64)),
    "A".repeat(64),
    "a".repeat(63),
  ]) {
    expect(() =>
      createFollowArchiveReader({
        ...config(async () => {
          calls++;
        }),
        indexSha256,
      }),
    ).toThrow();
  }
  expect(calls).toBe(0);
});

it("stops a matching manifest digest that resolves exactly at the absolute deadline", async () => {
  const raw = fixture.files[manifestPath],
    indexSha256 = await followSnapshotDigest(encode(raw));
  let time = Date.parse("2028-01-03T00:00:00.000Z");
  const calls = [],
    digest = crypto.subtle.digest.bind(crypto.subtle);
  const mock = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    const result = await digest(...args);
    time += 100;
    return result;
  });
  try {
    const reader = createFollowArchiveReader({
      ...config(async (url) => {
        calls.push(url);
        return new Response(raw);
      }),
      indexSha256,
      clock: () => new Date(time),
    });
    expect(await reader.loadSnapshot(pin)).toBeNull();
    expect(calls).toEqual([indexUrl]);
  } finally {
    mock.mockRestore();
  }
});
