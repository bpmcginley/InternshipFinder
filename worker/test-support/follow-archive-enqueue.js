import {
  enqueueFollowArchiveBatch,
  enqueueFollowArchiveSubscriber,
} from "../src/follow-archive-enqueue.js";
import { followSnapshotDigest } from "../src/follow-matching.js";
import { confirmFollow, mintFollowToken, requestFollow } from "../src/follows.js";

const hour = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const catalog = {
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
const indexUrl = "https://archive.example.test/data/follows/index.json";

async function fixture(db, { match, mode = "ready" }) {
  const real = Date.now();
  const midnight = Date.parse(iso(real).slice(0, 10) + "T00:00:00.000Z");
  const age = mode === "db-rollover" ? 48 * hour : 3 * hour;
  const generated =
    mode === "db-rollover"
      ? midnight - hour
      : mode === "db-expired"
        ? real - age - 5000
        : real - 2 * hour;
  const deadline = generated + age;
  let current =
    mode === "db-rollover"
      ? midnight - 1
      : mode === "db-expired"
        ? deadline - 1
        : mode === "stale"
          ? deadline
          : real;
  const confirmed = new Date(generated - hour);
  async function subscribe(
    email,
    at = confirmed,
    scope = { kind: "company", company: "fixture" },
    active = true,
  ) {
    const { subscriberId, scopeKey } = await requestFollow(db, email, scope, catalog, at);
    if (active)
      await confirmFollow(
        db,
        await mintFollowToken(db, subscriberId, "confirm", { scopeKey }, at),
        at,
      );
    return subscriberId;
  }
  const subscriberId = await subscribe("fixture@example.test");

  const snapshot = JSON.stringify({
    version: 1,
    complete: true,
    generated_at: iso(generated),
    covers_after: iso(+confirmed + (mode === "gap" ? 1 : 0)),
    roles: match
      ? [
          {
            id: "a".repeat(16),
            company_key: "fixture",
            field_tags: ["swe"],
            states: ["MA"],
            first_seen: iso(generated - 1),
            status: "open",
            company_name: "Fixture",
            title: "Test role",
            location: "Boston, MA",
            apply_url: "https://jobs.example.test/role",
          },
        ]
      : [],
  });
  const bytes = new TextEncoder().encode(snapshot);
  const digest = await followSnapshotDigest(bytes);
  const manifest = JSON.stringify({
    checked_at: iso(generated),
    entries: [
      {
        bytes: bytes.length,
        enqueue_until: iso(deadline),
        generated_at: iso(generated),
        retain_until: iso(deadline + 49 * hour),
        sha256: digest,
      },
    ],
    high_water: iso(generated),
    latest: digest,
    version: 1,
  });
  const files = new Map([
    [indexUrl, manifest],
    [new URL(digest + ".json", indexUrl).href, snapshot],
  ]);
  let reads = 0,
    writes = 0,
    requests = 0,
    pageRowsRead;
  const database = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const isProgress = sql.startsWith("WITH bounded AS");
      const isPage = sql.startsWith("WITH RECURSIVE page");
      if (!isProgress && !isPage) return statement;
      return {
        bind(...params) {
          return {
            async all() {
              const result = await statement.bind(...params).all();
              if (isPage) pageRowsRead = result.meta?.rows_read;
              if (isProgress && ++reads === 2 && mode === "js-expired") current = deadline;
              return result;
            },
          };
        },
      };
    },
    async batch(statements) {
      writes++;
      const result = await db.batch(statements);
      if (writes === 1 && mode === "batch-expired") current = deadline;
      return result;
    },
  };
  const options = {
    catalog,
    limits,
    maxProgressBytes: 4000,
    maxPendingBytes: 4000,
    archive: {
      indexUrl,
      clock: () => new Date(current),
      fetch: async (url, { method }) => {
        requests++;
        if (!files.has(url) || method !== "GET") throw new Error("Unexpected fixture request");
        return new Response(files.get(url));
      },
      bounds: {
        maxManifestBytes: 3000,
        maxEntries: 2,
        maxArchiveBytes: 20000,
        maxEnqueueAgeMs: age,
        publishMarginMs: hour,
        deadlineMs: 5000,
      },
    },
  };
  return {
    run: () => enqueueFollowArchiveSubscriber(database, subscriberId, options),
    runBatch: (maxSubscribers, after = null, overrides = {}) =>
      enqueueFollowArchiveBatch(database, { ...options, maxSubscribers, after, ...overrides }),
    subscriberId,
    subscribe,
    requests: () => requests,
    pageRowsRead: () => pageRowsRead,
    writes: () => writes,
    digest,
    upper: iso(generated),
    lower: confirmed.toISOString(),
    rows: async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results,
  };
}

async function states(f) {
  return {
    watermark: (await f.rows("follow_scope_progress"))[0].watermark,
    jobs: await f.rows("follow_digest_outbox"),
    pending: await f.rows("follow_pending_progress"),
    markers: await f.rows("follow_digest_days"),
  };
}

export async function queued(db, equal) {
  const f = await fixture(db, { match: true });
  const result = await f.run();
  const { jobs, pending, markers, watermark } = await states(f);
  equal(result, { status: "queued", id: jobs[0]?.id });
  equal(watermark, f.lower);
  equal(
    pending.map((p) => [p.job_id, p.snapshot_digest, p.snapshot_at]),
    [[result.id, f.digest, f.upper]],
  );
  equal(markers, []);
  equal(await f.run(), result);
}

export async function empty(db, equal) {
  const f = await fixture(db, { match: false });
  equal(await f.run(), { status: "advanced" });
  equal(await states(f), { watermark: f.upper, jobs: [], pending: [], markers: [] });
}

async function fenced(db, equal, mode, match, expected, batches) {
  const f = await fixture(db, { match, mode });
  equal(await f.run(), expected);
  equal(f.writes(), batches);
  equal(await states(f), { watermark: f.lower, jobs: [], pending: [], markers: [] });
}

export async function stale(db, equal) {
  await fenced(db, equal, "stale", true, { status: "unavailable" }, 0);
}

export async function gap(db, equal) {
  await fenced(db, equal, "gap", false, { status: "gap" }, 0);
}

export async function queuedWorkerDeadline(db, equal) {
  await fenced(
    db,
    equal,
    "js-expired",
    true,
    { status: "invalid", reason: "archive_admission" },
    0,
  );
}

export async function emptyWorkerDeadline(db, equal) {
  await fenced(
    db,
    equal,
    "js-expired",
    false,
    { status: "invalid", reason: "archive_admission" },
    0,
  );
}

export async function queuedDatabaseDeadline(db, equal) {
  await fenced(db, equal, "db-expired", true, { status: "conflict" }, 1);
}

export async function emptyDatabaseDeadline(db, equal) {
  await fenced(db, equal, "db-expired", false, { status: "conflict" }, 1);
}

export async function queuedDatabaseRollover(db, equal) {
  await fenced(db, equal, "db-rollover", true, { status: "conflict" }, 1);
}

export async function emptyDatabaseRollover(db, equal) {
  await fenced(db, equal, "db-rollover", false, { status: "conflict" }, 1);
}

export async function paginatedBatch(db, equal) {
  const f = await fixture(db, { match: true });
  const ids = [
    f.subscriberId,
    await f.subscribe("second@example.test"),
    await f.subscribe("third@example.test"),
  ].sort();
  equal(
    await f.subscribe("fixture@example.test", undefined, {
      kind: "search",
      fields: ["swe"],
      states: [],
    }),
    f.subscriberId,
  );
  await f.subscribe("pending@example.test", undefined, undefined, false);
  const firstPage = { status: "processed", counts: { queued: 2 }, nextAfter: ids[1] };
  equal(await f.runBatch(2), firstPage);
  equal(f.requests(), 2);
  equal(await f.runBatch(2), firstPage);
  equal(await f.runBatch(2, ids[1]), {
    status: "processed",
    counts: { queued: 1 },
    nextAfter: null,
  });
  equal(f.requests(), 6);
  equal(await f.runBatch(2, ids[2]), { status: "processed", counts: {}, nextAfter: null });
  equal(f.requests(), 6);
  const jobs = await f.rows("follow_digest_outbox");
  equal(jobs.map((row) => row.subscriber_id).sort(), ids);
  const pins = await f.rows("follow_pending_progress");
  equal(
    pins.map((row) => [row.snapshot_digest, row.snapshot_at]),
    ids.map(() => [f.digest, f.upper]),
  );
}

export async function batchCoverageIsPerSubscriber(db, equal) {
  const f = await fixture(db, { match: false, mode: "gap" });
  const covered = await f.subscribe("covered@example.test", new Date(Date.parse(f.lower) + 10));
  const tooNew = await f.subscribe("new@example.test", new Date(Date.parse(f.upper) + 10));
  equal(await f.runBatch(3), {
    status: "processed",
    counts: { advanced: 1, invalid: 2 },
    nextAfter: null,
  });
  equal(f.requests(), 2);
  const progress = new Map(
    (await f.rows("follow_scope_progress")).map((r) => [r.subscriber_id, r.watermark]),
  );
  equal(progress.get(f.subscriberId), f.lower);
  equal(progress.get(covered), f.upper);
  equal(progress.get(tooNew), iso(Date.parse(f.upper) + 10));
  equal(await f.rows("follow_digest_outbox"), []);
}

export async function batchExpiryWithholdsCursor(db, equal) {
  const f = await fixture(db, { match: true, mode: "batch-expired" });
  await f.subscribe("second@example.test");
  await f.subscribe("third@example.test");
  equal(await f.runBatch(2), { status: "unavailable" });
  equal(f.requests(), 2);
  equal(f.writes(), 1);
  equal((await f.rows("follow_digest_outbox")).length, 1);
  equal(await f.runBatch(2), { status: "unavailable" });
  equal(f.writes(), 1);
}

export async function batchBoundsAndMalformedPage(db, equal) {
  const f = await fixture(db, { match: true });
  equal(await f.runBatch(0), { status: "invalid", reason: "batch_configuration" });
  equal(await f.runBatch(1, null, { maxPendingBytes: 32769 }), {
    status: "invalid",
    reason: "batch_configuration",
  });
  equal(await f.runBatch(1, f.subscriberId + "\n"), {
    status: "invalid",
    reason: "batch_configuration",
  });
  // A malformed lookahead must never masquerade as a valid end-of-page cursor.
  await db
    .prepare("INSERT INTO follow_subscribers (id,email,created) VALUES (?,?,?)")
    .bind("z", "bad@example.test", f.lower)
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions (subscriber_id,scope_key,created,confirmed_at) VALUES (?,?,?,?)",
    )
    .bind("z", "{}", f.lower, f.lower)
    .run();
  equal(await f.runBatch(1), { status: "invalid", reason: "subscriber_page" });
  equal(f.requests(), 0);
  equal(f.writes(), 0);
}

export async function batchSeeksPastExcessScopes(db, equal) {
  const f = await fixture(db, { match: true });
  const other = await f.subscribe("other@example.test");
  await db
    .prepare(
      "WITH RECURSIVE scopes(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM scopes WHERE n<1000) " +
        "INSERT INTO follow_subscriptions (subscriber_id,scope_key,created,confirmed_at) " +
        "SELECT ?, 'fixture-'||n, ?, ? FROM scopes",
    )
    .bind(f.subscriberId, f.lower, f.lower)
    .run();
  equal(await f.runBatch(2), {
    status: "processed",
    counts: { invalid: 1, queued: 1 },
    nextAfter: null,
  });
  equal(
    (await f.rows("follow_digest_outbox")).map((row) => row.subscriber_id),
    [other],
  );
  // Node's fake has no read count; local Workers exercises the actual D1 metadata.
  if (f.pageRowsRead() !== undefined) equal(f.pageRowsRead() < 30, true);
}
