import { enqueueFollowArchiveSubscriber } from "../src/follow-archive-enqueue.js";
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
  const { subscriberId, scopeKey } = await requestFollow(
    db,
    "fixture@example.test",
    { kind: "company", company: "fixture" },
    catalog,
    confirmed,
  );
  await confirmFollow(
    db,
    await mintFollowToken(db, subscriberId, "confirm", { scopeKey }, confirmed),
    confirmed,
  );

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
    writes = 0;
  const database = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith("WITH bounded AS")) return statement;
      return {
        bind(...params) {
          return {
            async all() {
              const result = await statement.bind(...params).all();
              if (++reads === 2 && mode === "js-expired") current = deadline;
              return result;
            },
          };
        },
      };
    },
    batch(statements) {
      writes++;
      return db.batch(statements);
    },
  };
  return {
    run: () =>
      enqueueFollowArchiveSubscriber(database, subscriberId, {
        catalog,
        limits,
        maxProgressBytes: 4000,
        maxPendingBytes: 4000,
        archive: {
          indexUrl,
          clock: () => new Date(current),
          fetch: async (url, { method }) => {
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
      }),
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
