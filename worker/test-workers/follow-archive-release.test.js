import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { runFollowArchiveRelease } from "../src/follow-archive-release.js";
import { followSnapshotDigest } from "../src/follow-matching.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";

const hour = 3600000,
  iso = (n) => new Date(n).toISOString();
const origin = "https://internscout.org",
  indexUrl = `${origin}/data/follows/index.json`;
const encode = (s) => new TextEncoder().encode(s);
const sets = () => ({
  companies: new Set(["fixture"]),
  fields: new Set(["swe"]),
  states: new Set(["MA"]),
});
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
  await env.DB.prepare("DELETE FROM follow_digest_days").run();
});
async function fixture(count = 3) {
  const time = Date.now(),
    generated = time - hour,
    confirmed = generated - hour;
  const ids = [];
  for (let i = 0; i < count; i++) {
    const { subscriberId, scopeKey } = await requestFollow(
      env.DB,
      `fixture${i}@example.test`,
      { kind: "company", company: "fixture" },
      sets(),
      new Date(confirmed),
    );
    await confirmFollow(
      env.DB,
      await mintFollowToken(env.DB, subscriberId, "confirm", { scopeKey }, new Date(confirmed)),
      new Date(confirmed),
    );
    ids.push(subscriberId);
  }
  ids.sort();
  const snapshot = JSON.stringify({
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
        title: "Test role",
        location: "Boston",
        apply_url: "https://jobs.example.test/role",
      },
    ],
  });
  const hash = await followSnapshotDigest(encode(snapshot));
  const manifest = JSON.stringify({
    checked_at: iso(generated),
    entries: [
      {
        bytes: encode(snapshot).length,
        enqueue_until: iso(generated + 3 * hour),
        generated_at: iso(generated),
        retain_until: iso(generated + 52 * hour),
        sha256: hash,
      },
    ],
    high_water: iso(generated),
    latest: hash,
    version: 1,
  });
  const wire = JSON.stringify({
    version: 1,
    source_sha256: "a".repeat(64),
    signup: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
    valid: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
    aliases: [["Fixture", "fixture"]],
  });
  const files = new Map([
    [`${origin}/data/follows/catalog.json`, wire],
    [indexUrl, manifest],
    [`${origin}/data/follows/${hash}.json`, snapshot],
  ]);
  const gets = [],
    calls = [];
  let wall = time,
    monotonic = 0;
  const options = {
    enabled: true,
    db: env.DB,
    now: () => wall,
    monotonicNow: () => monotonic,
    fetch: async (url, init) => {
      gets.push(url);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      if (!files.has(url)) throw Error("Unexpected local fixture URL");
      const response = new Response(files.get(url));
      Object.defineProperty(response, "url", { value: url });
      return response;
    },
    budget: {
      maxPages: 4,
      pageSize: 1,
      maxSubscribers: 4,
      maxD1Calls: 48,
      maxStatements: 100,
      maxFetches: 9,
      deadlineMs: 10000,
    },
    catalog: {
      origin,
      release: {
        url: `${origin}/data/follows/catalog.json`,
        sourceSha256: "a".repeat(64),
        catalogSha256: await followSnapshotDigest(encode(wire)),
        notBefore: time - hour,
        expiresAt: time + hour,
      },
      previousValid: sets(),
      maxBytes: 4000,
      maxKeys: 10,
      deadlineMs: 10000,
    },
    archive: {
      indexUrl,
      indexSha256: await followSnapshotDigest(encode(manifest)),
      bounds: {
        maxManifestBytes: 4000,
        maxEntries: 3,
        maxArchiveBytes: 16000,
        maxEnqueueAgeMs: 3 * hour,
        publishMarginMs: hour,
        deadlineMs: 10000,
      },
    },
    limits: {
      maxBytes: 8000,
      maxRoles: 10,
      maxFollows: 10,
      maxMatches: 10,
      maxResultBytes: 8000,
      maxTextBytes: 2000,
      maxWindowMs: 48 * hour,
    },
    maxProgressBytes: 4000,
    maxPendingBytes: 4000,
  };
  return {
    options,
    ids,
    files,
    gets,
    calls,
    hash,
    expire: () => {
      wall = options.catalog.release.expiresAt;
    },
    setMonotonic: (n) => {
      monotonic = n;
    },
    expireMonotonic: () => {
      monotonic = options.budget.deadlineMs;
    },
    jobs: async () =>
      (
        await env.DB.prepare(
          "SELECT subscriber_id FROM follow_digest_outbox ORDER BY subscriber_id",
        ).all()
      ).results.map((r) => r.subscriber_id),
  };
}

it("is disabled without inspecting bindings or release", async () => {
  expect(
    await runFollowArchiveRelease({
      get db() {
        throw Error("Unexpected");
      },
    }),
  ).toEqual({ status: "disabled" });
});
it("completes a qualified multi-page native backlog with one immutable selection", async () => {
  const f = await fixture();
  const r = await runFollowArchiveRelease(f.options);
  expect(r).toMatchObject({
    status: "pass-complete",
    pages: 3,
    subscribers: 3,
    counts: { queued: 3 },
    fetchCalls: 7,
    d1Calls: 12,
    statements: 21,
  });
  expect(await f.jobs()).toEqual(f.ids);
  const pins = await env.DB.prepare("SELECT snapshot_digest FROM follow_pending_progress").all();
  expect(pins.results.map((p) => p.snapshot_digest)).toEqual([f.hash, f.hash, f.hash]);
  expect(JSON.stringify(r)).not.toContain(f.ids[0]);
});
it("demonstrates finite partial reset repeats the first page and does not claim fairness", async () => {
  const f = await fixture();
  f.options.budget.maxPages = 1;
  expect((await runFollowArchiveRelease(f.options)).status).toBe("partial");
  expect((await runFollowArchiveRelease(f.options)).status).toBe("partial");
  expect(await f.jobs()).toEqual([f.ids[0]]);
  f.options.budget.maxPages = 4;
  expect((await runFollowArchiveRelease(f.options)).status).toBe("pass-complete");
  expect(await f.jobs()).toEqual(f.ids);
});
it("stops before a second page when the pinned mutable index changes", async () => {
  const f = await fixture();
  const get = f.options.fetch;
  let indexes = 0;
  f.options.fetch = async (url, init) => {
    if (url === indexUrl && ++indexes === 2) f.files.set(indexUrl, f.files.get(indexUrl) + " ");
    return get(url, init);
  };
  expect((await runFollowArchiveRelease(f.options)).status).toBe("unavailable");
  expect(await f.jobs()).toEqual([f.ids[0]]);
});
it("does not continue or retry a committed batch with lost acknowledgement", async () => {
  const f = await fixture();
  let writes = 0;
  f.options.db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (list) => {
      writes++;
      await env.DB.batch(list);
      throw Error("Unknown commit");
    },
  };
  const r = await runFollowArchiveRelease(f.options);
  expect(r).toMatchObject({ status: "unavailable", pages: 0, subscribers: 0 });
  expect(writes).toBe(1);
  expect(await f.jobs()).toEqual([f.ids[0]]);
});
it.each(["wall", "monotonic"])(
  "stops after admitted commit when %s deadline passes",
  async (kind) => {
    const f = await fixture();
    let writes = 0;
    f.options.db = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (list) => {
        writes++;
        const r = await env.DB.batch(list);
        if (kind === "wall") f.expire();
        else f.expireMonotonic();
        return r;
      },
    };
    expect((await runFollowArchiveRelease(f.options)).status).toBe("unavailable");
    expect(writes).toBe(1);
    expect((await f.jobs()).length).toBe(1);
  },
);
it("reserves D1 statement and call budgets before admitting any page", async () => {
  for (const key of ["maxStatements", "maxD1Calls"]) {
    const f = await fixture(1);
    f.options.budget[key] = 2;
    const r = await runFollowArchiveRelease(f.options);
    expect(r.status).toBe("partial");
    expect(r.d1Calls).toBe(0);
    expect(r.statements).toBe(0);
    expect(await f.jobs()).toEqual([]);
    await env.DB.prepare("DELETE FROM follow_subscribers").run();
  }
});
it("rejects malformed release before IO and prior valid-key loss before D1", async () => {
  const f = await fixture();
  delete f.options.archive.indexSha256;
  expect((await runFollowArchiveRelease(f.options)).status).toBe("unavailable");
  expect(f.gets).toHaveLength(0);
  f.options.archive.indexSha256 = "f".repeat(64);
  f.options.catalog.previousValid.companies.add("retained");
  const r = await runFollowArchiveRelease(f.options);
  expect(r).toMatchObject({ status: "unavailable", d1Calls: 0 });
  expect(f.gets).toHaveLength(1);
});
it("rejects unknown batch receipts after commit without continuing", async () => {
  const f = await fixture();
  f.options.db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (list) => {
      const r = await env.DB.batch(list);
      r[0].success = false;
      return r;
    },
  };
  expect((await runFollowArchiveRelease(f.options)).status).toBe("unavailable");
  expect((await f.jobs()).length).toBe(1);
});
it("clips page and subscriber work to exact remaining statement/call budgets", async () => {
  const f = await fixture();
  f.options.budget.maxD1Calls = 8;
  f.options.budget.maxStatements = 14;
  const r = await runFollowArchiveRelease(f.options);
  expect(r).toMatchObject({
    status: "partial",
    pages: 2,
    subscribers: 2,
    d1Calls: 8,
    statements: 14,
    fetchCalls: 5,
  });
  expect(await f.jobs()).toEqual(f.ids.slice(0, 2));
});
it("shares the monotonic deadline across catalog and archive, cancelling late bytes before writes", async () => {
  const f = await fixture();
  const get = f.options.fetch;
  let cancelled = 0;
  f.options.fetch = async (url, init) => {
    if (url !== indexUrl) {
      f.setMonotonic(9999);
      return get(url, init);
    }
    f.setMonotonic(10000);
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    );
  };
  const r = await runFollowArchiveRelease(f.options);
  expect(r).toMatchObject({ status: "unavailable", fetchCalls: 2, d1Calls: 1 });
  expect(cancelled).toBe(1);
  expect(await f.jobs()).toEqual([]);
});
it("snapshots release pins, budgets and DB methods before the first read", async () => {
  const f = await fixture();
  const get = f.options.fetch;
  const db = { prepare: (sql) => env.DB.prepare(sql), batch: (list) => env.DB.batch(list) };
  f.options.db = db;
  f.options.fetch = (url, init) => {
    f.options.archive.indexSha256 = "f".repeat(64);
    f.options.catalog.release.catalogSha256 = "f".repeat(64);
    f.options.budget.maxPages = 1;
    db.batch = () => {
      throw Error("Replacement not authorized");
    };
    return get(url, init);
  };
  expect((await runFollowArchiveRelease(f.options)).status).toBe("pass-complete");
  expect(await f.jobs()).toEqual(f.ids);
});
it("deletion between catalog admission and enumeration cannot create an orphan job", async () => {
  const f = await fixture();
  const get = f.options.fetch;
  f.options.fetch = async (url, init) => {
    if (url.endsWith("catalog.json"))
      await env.DB.prepare("DELETE FROM follow_subscribers WHERE id=?").bind(f.ids[1]).run();
    return get(url, init);
  };
  const r = await runFollowArchiveRelease(f.options);
  expect(r).toMatchObject({ status: "pass-complete", subscribers: 2 });
  expect(await f.jobs()).toEqual([f.ids[0], f.ids[2]]);
});
it("keeps empty enumeration bounded and reports no subscriber completion on bad page receipt", async () => {
  const f = await fixture(0);
  expect(await runFollowArchiveRelease(f.options)).toMatchObject({
    status: "pass-complete",
    pages: 1,
    subscribers: 0,
    d1Calls: 1,
    fetchCalls: 1,
  });
  f.options.db = {
    batch: (list) => env.DB.batch(list),
    prepare(sql) {
      const raw = env.DB.prepare(sql);
      return {
        bind(...args) {
          return {
            async all() {
              const r = await raw.bind(...args).all();
              r.success = false;
              return r;
            },
          };
        },
      };
    },
  };
  expect(await runFollowArchiveRelease(f.options)).toMatchObject({
    status: "unavailable",
    pages: 0,
    subscribers: 0,
  });
});
it("the native first guard aborts a batch delayed until after catalog expiry", async () => {
  const f = await fixture(1);
  f.options.catalog.release.expiresAt = Date.now() + 500;
  let writes = 0;
  f.options.db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (list) => {
      writes++;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, f.options.catalog.release.expiresAt - Date.now() + 30)),
      );
      return env.DB.batch(list);
    },
  };
  expect((await runFollowArchiveRelease(f.options)).status).toBe("unavailable");
  expect(writes).toBe(1);
  expect(await f.jobs()).toEqual([]);
  expect(
    (await env.DB.prepare("SELECT count(*) AS n FROM follow_pending_progress").first()).n,
  ).toBe(0);
});
it("missing native guard rejects the atomic batch without enqueue", async () => {
  const f = await fixture(1);
  const definitions = (
    await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name IN ('follow_catalog_admissions','follow_catalog_admit') ORDER BY type DESC",
    ).all()
  ).results;
  await env.DB.prepare("DROP VIEW follow_catalog_admissions").run();
  try {
    expect((await runFollowArchiveRelease(f.options)).status).toBe("unavailable");
    expect(await f.jobs()).toEqual([]);
  } finally {
    for (const row of definitions) await env.DB.prepare(row.sql).run();
  }
});
it("a contradictory guard acknowledgement after genuine commit cannot certify continuation", async () => {
  const f = await fixture();
  let writes = 0;
  f.options.db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (list) => {
      writes++;
      const r = await env.DB.batch(list);
      r[0].meta.changes = 1;
      return r;
    },
  };
  const r = await runFollowArchiveRelease(f.options);
  expect(r).toMatchObject({ status: "unavailable", pages: 0, subscribers: 0 });
  expect(writes).toBe(1);
  expect((await f.jobs()).length).toBe(1);
});
it("matches retained valid scopes even when current signup removes that company", async () => {
  const f = await fixture(1),
    url = f.options.catalog.release.url;
  const value = JSON.parse(f.files.get(url));
  value.signup.companies = [];
  value.aliases = [];
  const wire = JSON.stringify(value);
  f.files.set(url, wire);
  f.options.catalog.release.catalogSha256 = await followSnapshotDigest(encode(wire));
  expect((await runFollowArchiveRelease(f.options)).status).toBe("pass-complete");
  expect(await f.jobs()).toEqual(f.ids);
});
it("reports partial on an uncovered scope without advancing its watermark", async () => {
  const f = await fixture(1);
  const old = await env.DB.prepare(
    "SELECT watermark FROM follow_scope_progress WHERE subscriber_id=?",
  )
    .bind(f.ids[0])
    .first("watermark");
  const earlier = iso(Date.parse(old) - 1);
  await env.DB.prepare("UPDATE follow_subscriptions SET confirmed_at=? WHERE subscriber_id=?")
    .bind(earlier, f.ids[0])
    .run();
  await env.DB.prepare("UPDATE follow_scope_progress SET watermark=? WHERE subscriber_id=?")
    .bind(earlier, f.ids[0])
    .run();
  expect((await runFollowArchiveRelease(f.options)).status).toBe("partial");
  expect(await f.jobs()).toEqual([]);
  expect(
    await env.DB.prepare("SELECT watermark FROM follow_scope_progress WHERE subscriber_id=?")
      .bind(f.ids[0])
      .first("watermark"),
  ).toBe(earlier);
});
async function emptySnapshot(f) {
  const manifest = JSON.parse(f.files.get(indexUrl));
  const prior = `${origin}/data/follows/${manifest.latest}.json`;
  const snapshot = JSON.parse(f.files.get(prior));
  snapshot.roles = [];
  const wire = JSON.stringify(snapshot),
    digest = await followSnapshotDigest(encode(wire));
  manifest.latest = digest;
  manifest.entries[0].sha256 = digest;
  manifest.entries[0].bytes = encode(wire).length;
  f.files.set(`${origin}/data/follows/${digest}.json`, wire);
  const index = JSON.stringify(manifest);
  f.files.set(indexUrl, index);
  f.options.archive.indexSha256 = await followSnapshotDigest(encode(index));
}
it("distinguishes acknowledged empty-window advancement from a later empty result", async () => {
  const f = await fixture(1);
  await emptySnapshot(f);
  expect(await runFollowArchiveRelease(f.options)).toMatchObject({
    status: "pass-complete",
    counts: { advanced: 1 },
    statements: 5,
  });
  expect(await f.jobs()).toEqual([]);
  expect(await runFollowArchiveRelease(f.options)).toMatchObject({
    status: "pass-complete",
    counts: { empty: 1 },
  });
});
it.each([false, true])(
  "keeps confirmed zero-row queued/empty CAS partial (empty=%s)",
  async (empty) => {
    const f = await fixture(1);
    if (empty) await emptySnapshot(f);
    f.options.db = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (list) => {
        await env.DB.prepare("DELETE FROM follow_subscriptions WHERE subscriber_id=?")
          .bind(f.ids[0])
          .run();
        return env.DB.batch(list);
      },
    };
    expect(await runFollowArchiveRelease(f.options)).toMatchObject({
      status: "partial",
      pages: 1,
      counts: { conflict: 1 },
    });
    expect(await f.jobs()).toEqual([]);
  },
);
it.each(["malformed", "substituted", "sparse", "changes", "empty"])(
  "withholds acknowledgement for %s downstream queue receipt",
  async (kind) => {
    const f = await fixture();
    let writes = 0;
    f.options.db = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (list) => {
        writes++;
        const rows = await env.DB.batch(list);
        if (kind === "malformed") rows[3].results = [{ id: 1 }];
        if (kind === "substituted")
          rows[3].results = [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }];
        if (kind === "sparse") delete rows[2];
        if (kind === "changes") rows[2].meta.changes = 0;
        if (kind === "empty") rows[3].results = [];
        return rows;
      },
    };
    expect(await runFollowArchiveRelease(f.options)).toMatchObject({
      status: "unavailable",
      pages: 0,
      subscribers: 0,
    });
    expect(writes).toBe(1);
    expect((await f.jobs()).length).toBe(1);
  },
);
it("withholds ambiguous no-match progress receipt after an actual advance", async () => {
  const f = await fixture(1);
  await emptySnapshot(f);
  f.options.db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (list) => {
      const rows = await env.DB.batch(list);
      rows[1].success = false;
      return rows;
    },
  };
  expect(await runFollowArchiveRelease(f.options)).toMatchObject({
    status: "unavailable",
    pages: 0,
    subscribers: 0,
  });
  expect(await f.jobs()).toEqual([]);
  const manifest = JSON.parse(f.files.get(indexUrl));
  expect(
    await env.DB.prepare("SELECT watermark FROM follow_scope_progress WHERE subscriber_id=?")
      .bind(f.ids[0])
      .first("watermark"),
  ).toBe(manifest.high_water);
});
