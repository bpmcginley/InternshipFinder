import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker, { handleScheduled } from "../src/index.js";
import { followSnapshotDigest } from "../src/follow-matching.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";

const cron = "31 3 * * *",
  origin = "https://internscout.org",
  hour = 3600000;
const encode = (v) => new TextEncoder().encode(JSON.stringify(v));
const iso = (n) => new Date(n).toISOString();
const owner = () => env.DB.prepare("SELECT * FROM follow_delivery_owner").first();
const budget = () => env.DB.prepare("SELECT count(*) n FROM follow_send_budget").first("n");
const queue = async () =>
  (await env.DB.prepare("SELECT * FROM follow_digest_outbox").all()).results;
function invoke(selection, bindings = {}, eventCron = cron, run = handleScheduled) {
  const jobs = [];
  run({ cron: eventCron }, bindings, { waitUntil: (p) => jobs.push(p) }, selection);
  return jobs;
}
const selected = (supply, extra = {}) => ({
  followDigest: { cron, enabled: true, supply, ...extra },
});
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["follow_subscribers", "follow_send_budget", "follow_digest_days"])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO follow_delivery_owner(singleton,version,generation,phase,next_kind) VALUES(1,1,lower(hex(randomblob(16))),'ready','confirmation')",
  ).run();
});

async function fixture() {
  const now = Date.now(),
    confirmed = now - 2 * hour,
    generated = now - hour;
  const valid = { companies: ["fixture"], fields: ["swe"], states: ["MA"] };
  const catalog = Object.fromEntries(Object.entries(valid).map(([k, v]) => [k, new Set(v)]));
  const limits = {
    maxBytes: 8000,
    maxRoles: 10,
    maxFollows: 10,
    maxMatches: 10,
    maxResultBytes: 8000,
    maxTextBytes: 2000,
    maxWindowMs: 48 * hour,
  };
  const snapshot = encode({
    version: 1,
    complete: true,
    generated_at: iso(generated),
    covers_after: iso(confirmed),
    roles: [
      {
        id: "a".repeat(16),
        company_key: "fixture",
        field_tags: ["swe"],
        states: ["MA"],
        first_seen: iso(generated - 1),
        status: "open",
        company_name: "Fixture",
        title: "Synthetic role",
        location: "MA",
        apply_url: "https://jobs.example.test/role",
      },
    ],
  });
  const digest = await followSnapshotDigest(snapshot);
  const manifest = encode({
    checked_at: iso(generated),
    entries: [
      {
        bytes: snapshot.length,
        enqueue_until: iso(generated + 3 * hour),
        generated_at: iso(generated),
        retain_until: iso(generated + 52 * hour),
        sha256: digest,
      },
    ],
    high_water: iso(generated),
    latest: digest,
    version: 1,
  });
  const rawCatalog = encode({
    version: 1,
    source_sha256: "a".repeat(64),
    signup: valid,
    valid,
    aliases: [["Fixture", "fixture"]],
  });
  const indexUrl = `${origin}/data/follows/index.json`,
    currentUrl = `${origin}/data/follow-current.json`;
  const sub = await requestFollow(
    env.DB,
    "synthetic@example.test",
    { kind: "company", company: "fixture" },
    catalog,
    new Date(confirmed),
  );
  await confirmFollow(
    env.DB,
    await mintFollowToken(
      env.DB,
      sub.subscriberId,
      "confirm",
      { scopeKey: sub.scopeKey },
      new Date(confirmed),
    ),
    new Date(confirmed),
  );
  expect(
    (
      await enqueueFollowSnapshot(
        env.DB,
        sub.subscriberId,
        snapshot,
        {
          catalog,
          limits,
          upperBound: iso(generated),
          maxProgressBytes: 4000,
          maxPendingBytes: 4000,
        },
        new Date(now),
      )
    ).status,
  ).toBe("queued");
  const files = new Map([
    [currentUrl, rawCatalog],
    [indexUrl, manifest],
    [new URL(digest + ".json", indexUrl).href, snapshot],
  ]);
  const gets = [],
    messages = [];
  const policy = {
    sending: true,
    cap: 2,
    present: () => ({
      from: "sender@example.test",
      postalAddress: "Synthetic address",
      origins: [origin],
      links: { matchingPage: origin + "/", publicShare: origin + "/" },
    }),
    buildLinks: ({ management, unsubscribe }) => ({
      management: `${origin}/follows/manage.html#token=${management}`,
      unsubscribe: `${origin}/follows/unsubscribe?token=${unsubscribe}`,
    }),
  };
  const options = {
    enabled: true,
    db: env.DB,
    email: {
      send: async (message) => {
        messages.push(message);
        return { messageId: "synthetic" };
      },
    },
    key: await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(7),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    policy: () => policy,
    now: () => now,
    monotonicNow: () => performance.now(),
    deadlineMs: 10000,
    transportTimeoutMs: 1000,
    limits,
    catalog: {
      version: 1,
      origin,
      predecessor: { genesis: true },
      release: {
        url: currentUrl,
        sourceSha256: "a".repeat(64),
        catalogSha256: await followSnapshotDigest(rawCatalog),
        notBefore: now - hour,
        expiresAt: now + hour,
      },
      maxBytes: 4000,
      maxKeys: 10,
      deadlineMs: 10000,
    },
    archive: {
      indexUrl,
      indexSha256: await followSnapshotDigest(manifest),
      bounds: {
        maxManifestBytes: 4000,
        maxEntries: 3,
        maxArchiveBytes: 20000,
        maxEnqueueAgeMs: 3 * hour,
        publishMarginMs: hour,
        deadlineMs: 10000,
      },
    },
    fetch: async (url, init) => {
      gets.push(url);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      if (!files.has(url)) throw Error("unexpected synthetic GET");
      return Object.defineProperty(new Response(files.get(url)), "url", { value: url });
    },
  };
  return { options, gets, messages };
}

it("same handler used by default delegates one pinned digest under shared ownership", async () => {
  const f = await fixture(),
    supply = vi.fn(() => f.options);
  const jobs = invoke(selected(supply));
  expect(jobs).toHaveLength(1);
  expect(await jobs[0]).toEqual({ status: "processed", counts: { accepted: 1 } });
  expect(supply).toHaveBeenCalledOnce();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0].text).toContain("Synthetic role");
  expect(f.gets).toHaveLength(3);
  expect((await owner()).phase).toBe("ready");
  expect(await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts")).toBe(1);
});

it("actual default ignores apparent armed env and never reads digest dependencies", async () => {
  const read = vi.fn(() => {
    throw Error("closed");
  });
  const bindings = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        "FOLLOW_DIGEST_ENABLED",
        "FOLLOW_DIGEST_CRON",
        "FOLLOW_DIGEST_RELEASE",
        "DB",
        "EMAIL",
        "key",
      ].map((k) => [k, { get: read }]),
    ),
  );
  expect(invoke(selected(read), bindings, cron, worker.scheduled)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it("absent, off, unrelated and malformed selectors never inspect supplier or bindings", async () => {
  const read = vi.fn(() => {
    throw Error("closed");
  });
  const withSupplier = (value) =>
    Object.defineProperty(value, "supply", { enumerable: true, get: read });
  const cases = [
    undefined,
    {},
    Object.create(selected(read)),
    { followDigest: null },
    { followDigest: withSupplier({ cron, enabled: false }) },
    { followDigest: withSupplier({ cron: "32 3 * * *", enabled: true }) },
    ...[null, 1, "", "not a cron", "1".repeat(129)].map((value) => ({
      followDigest: withSupplier({ cron: value, enabled: true }),
    })),
    { followDigest: withSupplier({ cron, enabled: true }) },
    { followDigest: Object.assign(Object.create({ enabled: true }), { cron, supply: read }) },
    { followDigest: { cron, enabled: true, supply: read, extra: true } },
    Object.defineProperty({}, "followDigest", { get: read }),
  ];
  const bindings = Object.defineProperties({}, { DB: { get: read }, EMAIL: { get: read } });
  for (const value of cases) expect(invoke(value, bindings)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it("invalid and rejecting synchronous supplier outputs enqueue nothing and inspect no then getter", async () => {
  const read = vi.fn(() => {
    throw Error("private");
  });
  const bad = Object.defineProperty({}, "then", { get: read });
  for (const supply of [
    () => null,
    () => ({}),
    () => bad,
    () => Object.defineProperty({}, "key", { enumerable: true, get: read }),
    () => new Proxy({}, { get: read }),
    () => {
      throw Error("private");
    },
    async () => {
      throw Error("private");
    },
    () => ({ then: read }),
  ])
    expect(invoke(selected(supply))).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(read).not.toHaveBeenCalled();
  expect(await budget()).toBe(0);
});

it("all earlier cron branches and disabled archive matches retain priority", async () => {
  vi.stubGlobal("fetch", () => {
    throw Error("unexpected outbound request");
  });
  const read = vi.fn(() => {
    throw Error("digest must remain untouched");
  });
  const db = {
    prepare: () => ({
      bind() {
        return this;
      },
      first: async () => null,
      all: async () => ({ success: true, results: [] }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    }),
    batch: async () => [],
  };
  for (const eventCron of [
    "4,34 * * * *",
    "27 7 * * *",
    "47 7 * * *",
    "17 7 * * *",
    "13 2 * * *",
    "11 3 * * *",
    "21 3 * * *",
  ]) {
    const bindings = {
      DB: db,
      FOLLOW_MAINTENANCE_CRON: "13 2 * * *",
      FOLLOW_LINKS_CRON: "11 3 * * *",
      FOLLOW_ARCHIVE_CRON: "21 3 * * *",
    };
    const baseline = invoke(undefined, bindings, eventCron, worker.scheduled);
    const injected = invoke(
      Object.defineProperty({}, "followDigest", { get: read }),
      bindings,
      eventCron,
    );
    expect(injected.length).toBe(baseline.length);
    await Promise.all([...baseline, ...injected].map((p) => Promise.resolve(p).catch(() => {})));
  }
  expect(read).not.toHaveBeenCalled();
});

it("native owner batch arriving after release cutoff cannot acquire or send", async () => {
  const f = await fixture(),
    before = await owner(),
    queued = await queue();
  f.options.now = Date.now;
  const cutoff = Date.now() + 3000;
  f.options.catalog.release.expiresAt = cutoff;
  let batches = 0;
  f.options.db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      batches++;
      expect(Date.now()).toBeLessThan(cutoff);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, cutoff + 30 - Date.now())));
      const rows = await env.DB.batch(statements);
      expect(rows[0].meta.changes).toBe(0);
      return rows;
    },
  };
  const jobs = invoke(selected(() => f.options));
  expect(jobs).toHaveLength(1);
  expect(await jobs[0]).toEqual({ status: "unavailable" });
  expect(batches).toBe(1);
  expect(await owner()).toEqual(before);
  expect(await queue()).toEqual(queued);
  expect(await budget()).toBe(0);
  expect(f.messages).toHaveLength(0);
}, 15000);
