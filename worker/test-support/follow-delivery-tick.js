import assert from "node:assert/strict";
import { runFollowDeliveryTick } from "../src/follow-delivery-tick.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import { reserveFollowSendAttempt } from "../src/follow-send-budget.js";
const catalog = {
  companies: new Set(["alpha"]),
  fields: new Set(["biology"]),
  states: new Set(["MA"]),
};
const limits = {
  maxBytes: 20000,
  maxRoles: 10,
  maxFollows: 10,
  maxMatches: 10,
  maxResultBytes: 20000,
  maxTextBytes: 200,
  maxWindowMs: 4 * 86400000,
};
async function fixture(db, n = 3) {
  const at = new Date(
    await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at"),
  );
  const confirmed = new Date(+at - 86400000),
    ids = [];
  const role = {
    id: "1".repeat(16),
    company_key: "alpha",
    field_tags: ["biology"],
    states: ["MA"],
    first_seen: new Date(+at - 3600000).toISOString(),
    status: "open",
    company_name: "Fixture",
    title: "Role",
    location: "Town",
    apply_url: "https://example.test/job",
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: at.toISOString(),
      covers_after: new Date(+confirmed - 3600000).toISOString(),
      roles: [role],
    }),
  );
  for (let i = 0; i < n; i++) {
    const sub = await requestFollow(
      db,
      `fixture${i}@example.test`,
      { kind: "company", company: "alpha" },
      catalog,
      confirmed,
    );
    const raw = await mintFollowToken(
      db,
      sub.subscriberId,
      "confirm",
      { scopeKey: sub.scopeKey },
      confirmed,
    );
    await confirmFollow(db, raw, confirmed);
    const queued = await enqueueFollowSnapshot(
      db,
      sub.subscriberId,
      bytes,
      {
        catalog,
        limits,
        upperBound: at.toISOString(),
        maxProgressBytes: 4000,
        maxPendingBytes: 4000,
      },
      at,
    );
    assert.equal(queued.status, "queued");
    ids.push(queued.id);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  let now = +at,
    calls = 0,
    inflight = 0,
    peak = 0;
  const options = {
    db,
    maxCandidates: 2,
    clock: () => new Date(now),
    cap: 20,
    key,
    catalog,
    limits,
    loadSnapshot: async () => bytes,
    present: async () => ({
      from: "sender@example.test",
      postalAddress: "1 Synthetic Avenue",
      origins: ["https://example.test"],
      links: {
        management: "https://example.test/manage",
        unsubscribe: "https://example.test/unsubscribe",
        matchingPage: "https://example.test/matches",
        publicShare: "https://example.test/share",
      },
    }),
    transport: async () => {
      calls++;
      inflight++;
      peak = Math.max(peak, inflight);
      await Promise.resolve();
      inflight--;
    },
  };
  return {
    at,
    ids,
    options,
    run: (overrides) => runFollowDeliveryTick({ ...options, ...overrides }),
    calls: () => calls,
    peak: () => peak,
    setNow: (value) => (now = value),
  };
}
function wrap(db, { all, batch } = {}) {
  const originals = new WeakMap();
  return {
    batch: async (statements) => {
      const run = () => db.batch(statements.map((s) => originals.get(s) || s));
      return batch ? batch(statements, run) : run();
    },
    prepare(sql) {
      function bound(statement) {
        const proxy = {
          bind: (...args) => bound(statement.bind(...args)),
          first: (...args) => statement.first(...args),
          run: () => statement.run(),
          all: async () => (all ? all(sql, () => statement.all()) : statement.all()),
        };
        originals.set(proxy, statement);
        return proxy;
      }
      return bound(db.prepare(sql));
    },
  };
}
export async function boundedSequential(db) {
  const f = await fixture(db);
  assert.deepEqual(await f.run(), { status: "processed", counts: { accepted: 2 } });
  assert.equal(f.calls(), 2);
  assert.equal(f.peak(), 1);
  assert.deepEqual(await f.run(), { status: "processed", counts: { accepted: 1 } });
  assert.equal(f.calls(), 3);
  assert.deepEqual(await f.run(), { status: "processed", counts: {} });
}
export async function competingTicks(db) {
  const f = await fixture(db, 1);
  const out = await Promise.all([f.run(), f.run()]);
  assert.equal(f.calls(), 1);
  assert.equal(
    out.reduce((n, x) => n + (x.counts.accepted || 0), 0),
    1,
  );
}
export async function expiredCandidate(db) {
  const f = await fixture(db, 1);
  await db
    .prepare("UPDATE follow_digest_outbox SET expires_at=?")
    .bind(new Date(+f.at - 1).toISOString())
    .run();
  assert.deepEqual(await f.run(), { status: "unavailable", counts: {} });
  assert.equal(f.calls(), 0);
  assert.equal(
    (await db.prepare("SELECT state FROM follow_digest_outbox").first()).state,
    "queued",
  );
}
export async function reclaimExpiredLease(db) {
  const f = await fixture(db, 1);
  await db
    .prepare("UPDATE follow_digest_outbox SET state='leased',lease_token=?,lease_until=?")
    .bind(crypto.randomUUID(), new Date(+f.at - 1).toISOString())
    .run();
  assert.deepEqual(await f.run(), { status: "processed", counts: { accepted: 1 } });
}
export async function pausedStops(db) {
  const f = await fixture(db);
  await reserveFollowSendAttempt(db, 1, f.at);
  assert.deepEqual(await f.run({ cap: 1 }), { status: "paused", counts: { paused: 1 } });
  assert.equal(f.calls(), 0);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM follow_digest_outbox WHERE state='queued'").first())
      .n,
    2,
  );
}
export async function ambiguousStops(db) {
  const f = await fixture(db);
  const database = wrap(db, {
    batch: async (s, run) => {
      const r = await run();
      if (s.length === 7) throw new Error("Synthetic lost claim response");
      return r;
    },
  });
  assert.deepEqual(await f.run({ db: database }), {
    status: "unavailable",
    counts: { unavailable: 1 },
  });
  assert.equal(f.calls(), 0);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM follow_digest_outbox WHERE state='attempting'")
        .first()
    ).n,
    1,
  );
}
export async function partialWorkerRollover(db) {
  const f = await fixture(db);
  const database = wrap(db, {
    batch: async (s, run) => {
      const r = await run();
      if (s.length === 2) f.setNow(+f.at + 86400000);
      return r;
    },
  });
  assert.deepEqual(await f.run({ db: database }), {
    status: "unavailable",
    counts: { accepted: 1 },
  });
  assert.equal(f.calls(), 1);
}
export async function partialDatabaseRollover(db) {
  const f = await fixture(db);
  let ended = false;
  const database = wrap(db, {
    batch: async (s, run) => {
      const r = await run();
      if (s.length === 2) ended = true;
      return r;
    },
    all: async (sql, run) => {
      const r = await run();
      if (ended && sql.startsWith("SELECT strftime"))
        r.results[0].at = new Date(+f.at + 86400000).toISOString();
      return r;
    },
  });
  assert.deepEqual(await f.run({ db: database }), {
    status: "unavailable",
    counts: { accepted: 1 },
  });
  assert.equal(f.calls(), 1);
}
export async function badClockOrPage(db) {
  const f = await fixture(db);
  assert.deepEqual(await f.run({ clock: () => new Date(+f.at + 86400000) }), {
    status: "unavailable",
    counts: {},
  });
  assert.deepEqual(await f.run({ maxCandidates: 0 }), { status: "unavailable", counts: {} });
  const database = wrap(db, {
    all: async (sql, run) => {
      const r = await run();
      if (sql.includes("UNION ALL")) r.success = false;
      return r;
    },
  });
  assert.deepEqual(await f.run({ db: database }), { status: "unavailable", counts: {} });
  assert.equal(f.calls(), 0);
}
export async function measureCandidateReads(db) {
  const samples = [];
  for (const size of [8, 10000]) {
    await db.prepare("DELETE FROM follow_subscribers").run();
    await db
      .prepare(
        "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT INTO follow_subscribers(id,email,created) SELECT printf('00000000-0000-4000-8000-%012d',n),printf('fixture%d@example.test',n),'2026-01-01T00:00:00.000Z' FROM seq",
      )
      .bind(size)
      .run();
    await db
      .prepare(
        "INSERT INTO follow_digest_outbox(id,subscriber_id,day,payload,created,expires_at,state) SELECT id,id,'2026-01-01','[]','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z','queued' FROM follow_subscribers",
      )
      .run();
    for (const band of ["queued", "leased", "mixed"]) {
      if (band !== "queued") {
        await db
          .prepare(
            "UPDATE follow_digest_outbox SET state='leased',lease_token=id,lease_until='2026-01-02T00:00:00.000Z'",
          )
          .run();
        if (band === "mixed")
          await db
            .prepare(
              "UPDATE follow_digest_outbox SET state='queued',lease_token=NULL,lease_until=NULL WHERE id<='00000000-0000-4000-8000-000000000002'",
            )
            .run();
      }
      const at = new Date(
        await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at"),
      );
      let reads;
      const database = wrap(db, {
        all: async (sql, run) => {
          const r = await run();
          if (sql.includes("UNION ALL")) {
            reads = r.meta.rows_read;
            assert.equal(r.meta.rows_written, 0);
            assert.equal(r.results.length, 5);
          }
          return r;
        },
      });
      assert.deepEqual(
        await runFollowDeliveryTick({
          db: database,
          maxCandidates: 5,
          clock: () => at,
          cap: 1,
          loadSnapshot: async () => {},
          present: async () => {},
          transport: async () => {
            throw new Error("must not send");
          },
        }),
        { status: "unavailable", counts: {} },
      );
      samples.push(reads);
    }
  }
  assert.deepEqual(samples, [5, 5, 5, 5, 5, 5]);
  return samples;
}
