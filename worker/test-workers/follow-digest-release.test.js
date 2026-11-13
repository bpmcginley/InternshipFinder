import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { runFollowDigestRelease as run } from "../src/follow-digest-release.js";
import { followSnapshotDigest } from "../src/follow-matching.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import { acquireFollowDeliveryOwner } from "../src/follow-delivery-owner.js";
import { createOwnedFollowDigestRuntime } from "../src/follow-owned-digest-runtime.js";

const origin = "https://internscout.org",
  hour = 3600000;
const encode = (s) => new TextEncoder().encode(s),
  sha = (s) => followSnapshotDigest(encode(s));
const iso = (n) => new Date(n).toISOString();
const key = (length = 32, hash = "SHA-256", extractable = false, usages = ["sign"]) =>
  crypto.subtle.importKey(
    "raw",
    new Uint8Array(length).fill(7),
    { name: "HMAC", hash },
    extractable,
    usages,
  );
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["follow_subscribers", "follow_send_budget", "follow_digest_days"])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO follow_delivery_owner(singleton,version,generation,phase,next_kind) VALUES(1,1,lower(hex(randomblob(16))),'ready','confirmation')",
  ).run();
});
const owner = () => env.DB.prepare("SELECT * FROM follow_delivery_owner").first();

async function fixture(genesis = false) {
  const time = Date.now(),
    confirmed = time - 27 * hour;
  const sets = {
    companies: new Set(["fixture"]),
    fields: new Set(["swe"]),
    states: new Set(["MA"]),
  };
  const limits = {
    maxBytes: 8000,
    maxRoles: 10,
    maxFollows: 10,
    maxMatches: 10,
    maxResultBytes: 8000,
    maxTextBytes: 2000,
    maxWindowMs: 48 * hour,
  };
  const snapshot = (n) =>
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: iso(time - (n === 2 ? 26 : 1) * hour),
      covers_after: iso(confirmed),
      roles: [
        {
          id: String(n).repeat(16),
          company_key: "fixture",
          field_tags: ["swe"],
          states: ["MA"],
          first_seen: iso(time - (n === 2 ? 26 : 1) * hour - 1),
          status: "open",
          company_name: "Fixture",
          title: n === 2 ? "Queued older role" : "Must not select latest",
          location: "MA",
          apply_url: `https://jobs.example.test/${n}`,
        },
      ],
    });
  const old = snapshot(2),
    latest = snapshot(1),
    oldHash = await sha(old),
    latestHash = await sha(latest);
  const catalog = (source) =>
    JSON.stringify({
      version: 1,
      source_sha256: source.repeat(64),
      signup: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
      valid: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
      aliases: [["Fixture", "fixture"]],
    });
  const currentUrl = `${origin}/data/follow-current.json`,
    priorUrl = `${origin}/data/follow-prior.json`;
  const indexUrl = `${origin}/data/follows/index.json`;
  const entries = await Promise.all(
    [old, latest].map(async (s) => {
      const generated = Date.parse(JSON.parse(s).generated_at);
      return {
        bytes: encode(s).length,
        enqueue_until: iso(generated + 3 * hour),
        generated_at: iso(generated),
        retain_until: iso(generated + 52 * hour),
        sha256: await sha(s),
      };
    }),
  );
  const manifest = JSON.stringify({
    checked_at: iso(time - hour),
    entries,
    high_water: iso(time - hour),
    latest: latestHash,
    version: 1,
  });
  const files = new Map([
    [currentUrl, catalog("a")],
    [priorUrl, catalog("b")],
    [indexUrl, manifest],
    [`${origin}/data/follows/${oldHash}.json`, old],
    [`${origin}/data/follows/${latestHash}.json`, latest],
  ]);
  const sub = await requestFollow(
    env.DB,
    "fixture@example.test",
    { kind: "company", company: "fixture" },
    sets,
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
        encode(old),
        {
          catalog: sets,
          limits,
          upperBound: iso(time - 26 * hour),
          maxProgressBytes: 4000,
          maxPendingBytes: 4000,
        },
        new Date(time),
      )
    ).status,
  ).toBe("queued");
  const messages = [],
    gets = [];
  let wall = time,
    mono = 0;
  const policy = {
    sending: true,
    cap: 2,
    present: () => ({
      from: "sender@example.test",
      postalAddress: "1 Fixture Lane",
      origins: [origin],
      links: { matchingPage: `${origin}/`, publicShare: `${origin}/` },
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
      send: async (m) => {
        messages.push(m);
        return { messageId: "synthetic" };
      },
    },
    key: await key(),
    policy: () => policy,
    now: () => wall,
    monotonicNow: () => mono,
    deadlineMs: 10000,
    transportTimeoutMs: 1000,
    limits,
    catalog: {
      version: 1,
      origin,
      release: {
        url: currentUrl,
        sourceSha256: "a".repeat(64),
        catalogSha256: await sha(catalog("a")),
        notBefore: time - hour,
        expiresAt: time + hour,
      },
      predecessor: genesis
        ? { genesis: true }
        : { url: priorUrl, sourceSha256: "b".repeat(64), catalogSha256: await sha(catalog("b")) },
      maxBytes: 4000,
      maxKeys: 10,
      deadlineMs: 10000,
    },
    archive: {
      indexUrl,
      indexSha256: await sha(manifest),
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
      expect(init.redirect).toBe("manual");
      expect(init.method).toBe("GET");
      if (!files.has(url)) throw Error("Unexpected synthetic URL");
      return Object.defineProperty(new Response(files.get(url)), "url", { value: url });
    },
  };
  return {
    options,
    policy,
    files,
    gets,
    messages,
    oldHash,
    latestHash,
    currentUrl,
    priorUrl,
    indexUrl,
    move: (w, m) => {
      wall += w;
      mono += m;
    },
  };
}

it("off inspects no authority or binding", async () => {
  let calls = 0;
  const options = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "enabled") return false;
        calls++;
        throw Error();
      },
    },
  );
  expect(await run(options)).toEqual({ status: "disabled" });
  expect(calls).toBe(0);
});
it("only own enabled data admits, never reading accessors or other ports", async () => {
  const before = await owner();
  let inspected = 0;
  for (const [options, status] of [
    [{}, "disabled"],
    [{ enabled: false }, "disabled"],
    [Object.create({ enabled: true }), "disabled"],
    [
      Object.defineProperty({}, "enabled", {
        get() {
          inspected++;
          throw Error("enabled getter");
        },
      }),
      "unavailable",
    ],
  ]) {
    for (const name of [
      "db",
      "email",
      "key",
      "policy",
      "fetch",
      "catalog",
      "archive",
      "now",
      "monotonicNow",
    ])
      Object.defineProperty(options, name, {
        get() {
          inspected++;
          throw Error("port getter");
        },
      });
    expect(await run(options)).toEqual({ status });
  }
  expect(
    await run(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error("descriptor");
          },
        },
      ),
    ),
  ).toEqual({ status: "unavailable" });
  expect(inspected).toBe(0);
  expect(await owner()).toEqual(before);
  expect(await env.DB.prepare("SELECT count(*) n FROM follow_send_budget").first("n")).toBe(0);
});
it.each([false, true])(
  "uses exact older retained job, never newer latest (genesis=%s)",
  async (genesis) => {
    const f = await fixture(genesis);
    expect(await run(f.options)).toEqual({ status: "processed", counts: { accepted: 1 } });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].text).toContain("Queued older role");
    expect(f.messages[0].text).not.toContain("Must not select latest");
    expect(f.gets).toEqual([
      ...(genesis ? [] : [f.priorUrl]),
      f.currentUrl,
      f.indexUrl,
      `${origin}/data/follows/${f.oldHash}.json`,
    ]);
    expect((await owner()).phase).toBe("ready");
  },
);
it("rejects malformed keys and bindings before any fetch or owner", async () => {
  const f = await fixture(),
    before = await owner();
  const invalid = [
    null,
    {},
    Object.create(CryptoKey.prototype),
    await key(16),
    await key(32, "SHA-512"),
    await key(32, "SHA-256", true),
    await key(32, "SHA-256", false, ["verify"]),
  ];
  for (const bad of invalid)
    expect(await run({ ...f.options, key: bad })).toEqual({ status: "unavailable" });
  for (const change of [{ email: {} }, { db: {} }, { fetch: null }, { policy: null }])
    expect(await run({ ...f.options, ...change })).toEqual({ status: "unavailable" });
  expect(f.gets).toHaveLength(0);
  expect(f.messages).toHaveLength(0);
  expect(await owner()).toEqual(before);
});
it("malformed catalog/pins or crossed bytes never acquire owner", async () => {
  const f = await fixture(),
    before = await owner();
  expect(await run({ ...f.options, catalog: { ...f.options.catalog, predecessor: {} } })).toEqual({
    status: "unavailable",
  });
  expect(
    await run({ ...f.options, archive: { ...f.options.archive, indexSha256: "A".repeat(64) } }),
  ).toEqual({ status: "unavailable" });
  expect(f.gets).toHaveLength(0);
  expect(
    await run({
      ...f.options,
      catalog: {
        ...f.options.catalog,
        release: { ...f.options.catalog.release, url: `${origin}/data/follows/%69ndex.json` },
      },
    }),
  ).toEqual({ status: "unavailable" });
  expect(f.gets).toHaveLength(0);
  f.files.set(f.currentUrl, f.files.get(f.priorUrl));
  expect(await run(f.options)).toEqual({ status: "unavailable" });
  expect(await owner()).toEqual(before);
  expect(f.messages).toHaveLength(0);
});
it("native sign rejects forged identity and wrong actual hash despite displayed metadata", async () => {
  const f = await fixture(),
    before = await owner();
  const forged = Object.assign(Object.create(CryptoKey.prototype), {
    algorithm: { name: "HMAC", hash: { name: "SHA-256" }, length: 256 },
    type: "secret",
    extractable: false,
    usages: ["sign"],
  });
  const wrong = await key(32, "SHA-512");
  wrong.algorithm.hash.name = "SHA-256";
  for (const candidate of [forged, wrong])
    expect(await run({ ...f.options, key: candidate })).toEqual({ status: "unavailable" });
  expect(f.gets).toHaveLength(0);
  expect(await owner()).toEqual(before);
});
it("mismatched manifest pin cannot fall back to latest or send", async () => {
  const f = await fixture();
  f.options.archive.indexSha256 = "0".repeat(64);
  expect(await run(f.options)).toEqual({ status: "held" });
  expect(f.gets).toEqual([f.priorUrl, f.currentUrl, f.indexUrl]);
  expect(f.messages).toHaveLength(0);
  expect((await owner()).phase).toBe("held");
});
it("catalog continuity cannot drop retained keys", async () => {
  const f = await fixture(),
    before = await owner();
  const prior = JSON.parse(f.files.get(f.priorUrl));
  prior.valid.companies.push("retired");
  prior.valid.companies.sort();
  const raw = JSON.stringify(prior);
  f.files.set(f.priorUrl, raw);
  f.options.catalog.predecessor.catalogSha256 = await sha(raw);
  expect(await run(f.options)).toEqual({ status: "unavailable" });
  expect(await owner()).toEqual(before);
  expect(f.messages).toHaveLength(0);
});
it.each(["wall", "mono"])(
  "one original %s deadline spans predecessor and current",
  async (clock) => {
    const f = await fixture(),
      before = await owner(),
      get = f.options.fetch;
    f.options.fetch = async (...args) => {
      const result = await get(...args);
      f.move(clock === "wall" ? 10000 : 0, clock === "mono" ? 10000 : 0);
      return result;
    };
    expect(await run(f.options)).toEqual({ status: "unavailable" });
    expect(f.gets).toEqual([f.priorUrl]);
    expect(await owner()).toEqual(before);
    expect(f.messages).toHaveLength(0);
  },
);
it("late pinned archive fails closed after ownership without fallback or send", async () => {
  const f = await fixture(),
    get = f.options.fetch;
  f.options.fetch = async (...args) => {
    const result = await get(...args);
    if (args[0] === f.indexUrl) f.move(0, 10000);
    return result;
  };
  expect(await run(f.options)).toEqual({ status: "unavailable" });
  expect(f.messages).toHaveLength(0);
  expect(f.gets).not.toContain(`${origin}/data/follows/${f.latestHash}.json`);
  expect((await owner()).phase).toBe("held");
});
it("closed policy remains delegated before owner after catalog acquisition", async () => {
  const f = await fixture(),
    before = await owner();
  f.policy.sending = false;
  expect(await run(f.options)).toEqual({ status: "disabled" });
  expect(f.gets).toEqual([f.priorUrl, f.currentUrl]);
  expect(await owner()).toEqual(before);
});
it.each(["wall", "mono"])("late owner read cannot admit acquisition (%s)", async (clock) => {
  const f = await fixture();
  const before = await owner();
  const queueBefore = await env.DB.prepare("SELECT * FROM follow_digest_outbox").all();
  let ownerReads = 0,
    ownerBatches = 0;
  const wrapped = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (sql !== "SELECT * FROM follow_delivery_owner WHERE singleton=1") return statement;
      return {
        async first() {
          ownerReads++;
          const row = await statement.first();
          f.move(clock === "wall" ? 10000 : 0, clock === "mono" ? 10000 : 0);
          return row;
        },
      };
    },
    batch(statements) {
      ownerBatches++;
      return env.DB.batch(statements);
    },
  };
  expect(await run({ ...f.options, db: wrapped })).toEqual({ status: "unavailable" });
  expect(ownerReads).toBe(1);
  expect(f.messages).toHaveLength(0);
  expect(f.gets).toEqual([f.priorUrl, f.currentUrl]);
  expect(ownerBatches).toBe(0);
  expect(await owner()).toEqual(before);
  expect((await env.DB.prepare("SELECT * FROM follow_digest_outbox").all()).results).toEqual(
    queueBefore.results,
  );
  expect(await env.DB.prepare("SELECT count(*) AS n FROM follow_send_budget").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT state FROM follow_digest_outbox").first("state")).toBe(
    "queued",
  );
});

it("deadline crossing during final handoff policy read cannot send", async () => {
  const f = await fixture();
  let finalRead = false,
    postReadPolicySamples = 0,
    tokensAtFence;
  const originals = new WeakMap();
  function statement(raw, sql) {
    const wrapped = {
      bind: (...args) => statement(raw.bind(...args), sql),
      first: (...args) => raw.first(...args),
      all: (...args) => raw.all(...args),
      run: (...args) => raw.run(...args),
    };
    originals.set(wrapped, { raw, sql });
    return wrapped;
  }
  const db = {
    prepare(sql) {
      return statement(env.DB.prepare(sql), sql);
    },
    async batch(statements) {
      const owned = statements.map((s) => originals.get(s));
      const rows = await env.DB.batch(owned.map((s) => s.raw));
      if (
        owned.some((s) =>
          s.sql.startsWith(
            "SELECT follow_digest_outbox.lease_until,follow_digest_outbox.expires_at",
          ),
        )
      ) {
        expect(rows).toHaveLength(1);
        expect(rows[0].results).toHaveLength(1);
        tokensAtFence = (
          await env.DB.prepare("SELECT * FROM follow_tokens ORDER BY token_hash").all()
        ).results;
        finalRead = true;
      }
      return rows;
    },
  };
  const policy = () => {
    if (finalRead && ++postReadPolicySamples === 2) f.move(0, 10000);
    return f.policy;
  };
  expect(await run({ ...f.options, db, policy })).toEqual({ status: "unavailable" });
  expect(finalRead).toBe(true);
  expect(postReadPolicySamples).toBeGreaterThanOrEqual(2);
  expect(tokensAtFence.length).toBeGreaterThan(0);
  expect(
    (await env.DB.prepare("SELECT * FROM follow_tokens ORDER BY token_hash").all()).results,
  ).toEqual(tokensAtFence);
  expect(await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts")).toBe(1);
  expect(await env.DB.prepare("SELECT state FROM follow_digest_outbox").first("state")).toBe(
    "attempting",
  );
  expect((await owner()).phase).toBe("held");
  expect(f.messages).toHaveLength(0);
});

it("owner admission requires literal synchronous true without mutating on refusal", async () => {
  const before = await owner();
  let batches = 0;
  const db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: (statements) => {
      batches++;
      return env.DB.batch(statements);
    },
  };
  for (const guard of [
    () => false,
    () => undefined,
    () => {
      throw Error("closed");
    },
    async () => true,
    async () => {
      throw Error("closed");
    },
  ])
    expect(await acquireFollowDeliveryOwner(db, guard)).toEqual({ status: "unavailable" });
  expect(batches).toBe(0);
  expect(await owner()).toEqual(before);
});
const DB_NOW_MS = "CAST(round((julianday('now')-2440587.5)*86400000) AS INTEGER)";
const OWNER_UPDATE =
  "UPDATE follow_delivery_owner SET phase='running',generation=? WHERE singleton=1 AND version=1 AND phase='ready' AND generation=?";
function tracedDatabase(onBatch) {
  const values = new WeakMap();
  const wrap = (sql, args = []) => {
    const raw = env.DB.prepare(sql).bind(...args);
    const statement = {
      bind: (...bound) => wrap(sql, bound),
      first: (...a) => raw.first(...a),
      all: (...a) => raw.all(...a),
      run: (...a) => raw.run(...a),
    };
    values.set(statement, { raw, sql, args });
    return statement;
  };
  return {
    prepare: (sql) => wrap(sql),
    batch: (statements) => onBatch(statements.map((s) => values.get(s))),
  };
}

it("timely submitted owner batch arriving after SQLite cutoff leaves all state unchanged", async () => {
  const f = await fixture(true),
    before = await owner();
  const queue = (await env.DB.prepare("SELECT * FROM follow_digest_outbox").all()).results;
  f.options.now = Date.now;
  const cutoff = Date.now() + 3000;
  f.options.catalog.release.expiresAt = cutoff;
  let calls = 0;
  f.options.db = tracedDatabase(async (statements) => {
    calls++;
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toBe(`${OWNER_UPDATE} AND ?>${DB_NOW_MS}`);
    expect(statements[0].args[2]).toBe(cutoff);
    expect(Date.now()).toBeLessThan(cutoff);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, cutoff + 50 - Date.now())));
    expect(await env.DB.prepare(`SELECT ${DB_NOW_MS} AS now`).first("now")).toBeGreaterThanOrEqual(
      cutoff,
    );
    const rows = await env.DB.batch(statements.map((s) => s.raw));
    expect(rows[0].meta.changes).toBe(0);
    expect(rows[1].results).toEqual([]);
    return rows;
  });
  expect(await run(f.options)).toEqual({ status: "unavailable" });
  expect(calls).toBe(1);
  expect(await owner()).toEqual(before);
  expect((await env.DB.prepare("SELECT * FROM follow_digest_outbox").all()).results).toEqual(queue);
  expect(await env.DB.prepare("SELECT count(*) n FROM follow_send_budget").first("n")).toBe(0);
  expect(f.messages).toHaveLength(0);
}, 15000);

it.each(["lost", "late"])(
  "already admitted owner retains %s acknowledgement uncertainty",
  async (ack) => {
    const f = await fixture(true),
      before = await owner();
    const queue = (await env.DB.prepare("SELECT * FROM follow_digest_outbox").all()).results;
    let calls = 0;
    f.options.db = tracedDatabase(async (statements) => {
      calls++;
      const rows = await env.DB.batch(statements.map((s) => s.raw));
      expect(rows[0].meta.changes).toBe(1);
      if (ack === "lost") throw Error("synthetic lost acknowledgement");
      f.move(0, 10000);
      return rows;
    });
    expect(await run(f.options)).toEqual({ status: "unavailable" });
    expect(calls).toBe(1);
    const after = await owner();
    expect(after.generation).not.toBe(before.generation);
    expect(after.phase).toBe(ack === "lost" ? "running" : "held");
    expect((await env.DB.prepare("SELECT * FROM follow_digest_outbox").all()).results).toEqual(
      queue,
    );
    expect(await env.DB.prepare("SELECT count(*) n FROM follow_send_budget").first("n")).toBe(0);
    expect(f.messages).toHaveLength(0);
  },
);

it("fixed cutoff accounts for input and catalog monotonic delay without extension", async () => {
  const f = await fixture(true),
    start = f.options.now(),
    originalKey = f.options.key;
  Object.defineProperty(f.options, "key", {
    get() {
      f.move(0, 4000);
      return originalKey;
    },
  });
  const fetch = f.options.fetch;
  f.options.fetch = async (...a) => {
    const response = await fetch(...a);
    if (a[0] === f.currentUrl) f.move(0, 4000.5);
    return response;
  };
  let cutoff;
  f.options.db = tracedDatabase(async (statements) => {
    if (statements[0].sql.startsWith(OWNER_UPDATE)) cutoff = statements[0].args[2];
    return env.DB.batch(statements.map((s) => s.raw));
  });
  expect(await run(f.options)).toEqual({ status: "processed", counts: { accepted: 1 } });
  expect(cutoff).toBe(start + 1999);
  expect(f.messages).toHaveLength(1);
  expect((await owner()).phase).toBe("ready");
});

it("same-statement SQLite equality refuses acquisition; omitted cutoff keeps exact query", async () => {
  const before = await owner();
  let calls = 0;
  const cutoff = Date.now() + 10000;
  const db = tracedDatabase(async (statements) => {
    calls++;
    expect(statements[0].sql).toBe(`${OWNER_UPDATE} AND ?>${DB_NOW_MS}`);
    expect(statements[0].args[2]).toBe(cutoff);
    // Substitute only the bound cutoff with the same native UTC expression. Both
    // now evaluations are in one SQLite step, proving equality without timer races.
    const equal = env.DB.prepare(statements[0].sql.replace("AND ?>", `AND ${DB_NOW_MS}>`)).bind(
      ...statements[0].args.slice(0, 2),
    );
    const rows = await env.DB.batch([equal, statements[1].raw]);
    expect(rows[0].meta.changes).toBe(0);
    return rows;
  });
  expect(await acquireFollowDeliveryOwner(db, undefined, cutoff)).toEqual({
    status: "unavailable",
  });
  expect(calls).toBe(1);
  expect(await owner()).toEqual(before);
  const legacy = tracedDatabase(async (statements) => {
    expect(statements[0].sql).toBe(OWNER_UPDATE);
    expect(statements[0].args).toHaveLength(2);
    return env.DB.batch(statements.map((s) => s.raw));
  });
  expect((await acquireFollowDeliveryOwner(legacy)).status).toBe("acquired");
});

it("malformed optional cutoff fails before D1", async () => {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw Error();
    },
    batch() {
      calls++;
      throw Error();
    },
  };
  for (const value of [
    null,
    false,
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    {},
    () => 1,
  ])
    expect(await acquireFollowDeliveryOwner(db, undefined, value)).toEqual({
      status: "unavailable",
    });
  expect(calls).toBe(0);
});

it("runtime cutoff is own data, captured after disabled and sending gates", async () => {
  const f = await fixture();
  let reads = 0,
    calls = 0;
  const options = {
    ...f.options,
    db: {
      prepare() {
        calls++;
        throw Error();
      },
      batch() {
        calls++;
        throw Error();
      },
    },
    loadSnapshot: async () => {
      throw Error();
    },
  };
  Object.defineProperty(options, "ownerExpiresAtMs", {
    enumerable: true,
    get() {
      reads++;
      throw Error();
    },
  });
  options.enabled = false;
  expect(await createOwnedFollowDigestRuntime(options)()).toEqual({ status: "disabled" });
  options.enabled = true;
  f.policy.sending = false;
  expect(await createOwnedFollowDigestRuntime(options)()).toEqual({ status: "disabled" });
  f.policy.sending = true;
  expect(await createOwnedFollowDigestRuntime(options)()).toEqual({ status: "unavailable" });
  const inherited = Object.assign(Object.create({ ownerExpiresAtMs: Date.now() + 10000 }), {
    ...f.options,
    db: options.db,
    loadSnapshot: options.loadSnapshot,
  });
  expect(await createOwnedFollowDigestRuntime(inherited)()).toEqual({ status: "unavailable" });
  expect(reads).toBe(0);
  expect(calls).toBe(0);
});
