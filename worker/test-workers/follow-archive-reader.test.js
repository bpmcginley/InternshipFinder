import { describe, expect, it } from "vitest";
import fixture from "../test/fixtures/follow-archive-python.json";
import { createFollowArchiveReader } from "../src/follow-archive-reader.js";

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
          c.redirect === "error" &&
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
