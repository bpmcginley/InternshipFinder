import assert from "node:assert/strict";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import { beginFollowSnapshotAttempt, leaseFollowDigest } from "../src/follow-outbox.js";
import { maintainFollowRetention } from "../src/follow-retention.js";
import { confirmFollow, mintFollowToken, requestFollow } from "../src/follows.js";

const CLOCK_SQL = "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at";
const day = 86_400_000;
const catalog = {
  companies: new Set(["fixture"]),
  fields: new Set(["biology"]),
  states: new Set(["MA"]),
};
const limits = {
  maxBytes: 8000,
  maxRoles: 5,
  maxFollows: 5,
  maxMatches: 5,
  maxResultBytes: 8000,
  maxTextBytes: 200,
  maxWindowMs: 2 * day,
};
const date = (ms) => new Date(ms);
const iso = (ms) => date(ms).toISOString();
const rows = async (db, table) =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
const actualClock = async (db) => +date((await db.prepare(CLOCK_SQL).first()).at);
const putBudget = (db, at, attempts) =>
  db
    .prepare("INSERT OR REPLACE INTO follow_send_budget VALUES (1,?,?)")
    .bind(iso(at), attempts)
    .run();

async function follow(db, name, created, confirmed = true) {
  const at = date(created);
  const result = await requestFollow(
    db,
    `${name}@example.test`,
    { kind: "company", company: "fixture" },
    catalog,
    at,
  );
  const token = await mintFollowToken(
    db,
    result.subscriberId,
    "confirm",
    { scopeKey: result.scopeKey },
    at,
  );
  if (confirmed) await confirmFollow(db, token, at);
  return result.subscriberId;
}

async function queue(db, subscriberId, at) {
  const stamp = iso(at);
  const input = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: stamp,
      covers_after: iso(at - day),
      roles: [
        {
          id: "1".repeat(16),
          company_key: "fixture",
          field_tags: ["biology"],
          states: ["MA"],
          first_seen: iso(at - 1),
          status: "open",
          company_name: "Fixture",
          title: "Test role",
          location: "Boston, MA",
          apply_url: "https://jobs.example.test/role",
        },
      ],
    }),
  );
  const result = await enqueueFollowSnapshot(
    db,
    subscriberId,
    input,
    {
      catalog,
      limits,
      upperBound: stamp,
      maxProgressBytes: 4000,
      maxPendingBytes: 4000,
    },
    date(at),
  );
  assert.equal(result.status, "queued");
  return result.id;
}

async function fixture(db) {
  const now = await actualClock(db);
  const queuedAt = now - 3 * day,
    confirmedAt = queuedAt - day;
  const pending = await follow(db, "pending", now - 8 * day, false);
  const active = await follow(db, "active", confirmedAt);
  const untouched = await follow(db, "untouched", confirmedAt);
  const attemptedJob = await queue(db, active, queuedAt);
  const queuedJob = await queue(db, untouched, queuedAt);
  const lease = await leaseFollowDigest(db, attemptedJob, date(queuedAt));
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  assert.equal(
    await beginFollowSnapshotAttempt(db, key, attemptedJob, lease, () => date(queuedAt)),
    true,
  );
  const old = iso(now - 8 * day);
  await db
    .prepare(
      "INSERT INTO follow_digest_outbox(id,subscriber_id,day,created,expires_at,state) VALUES (?,?,?,?,?,'accepted')",
    )
    .bind("fixture-old", active, old.slice(0, 10), old, iso(now - 6 * day))
    .run();
  const liveMarker = "e".repeat(64);
  await db
    .prepare("INSERT INTO follow_digest_days VALUES (?,?)")
    .bind(liveMarker, iso(now + day))
    .run();
  return {
    now,
    pending,
    active,
    untouched,
    attemptedJob,
    queuedJob,
    queuedAt,
    confirmedAt,
    liveMarker,
  };
}

export async function retentionAndUncertainProgress(db) {
  const f = await fixture(db);
  assert.equal((await rows(db, "follow_tokens")).length, 1);
  assert.equal((await rows(db, "follow_pending_progress")).length, 2);
  assert.equal((await rows(db, "follow_digest_days")).length, 2);
  assert.deepEqual(await maintainFollowRetention(db), {
    status: "maintained",
    budgetObserved: true,
  });
  assert.deepEqual(
    (await rows(db, "follow_subscribers")).map((r) => r.id).sort(),
    [f.active, f.untouched].sort(),
  );
  assert.equal((await rows(db, "follow_subscriptions")).length, 2);
  assert.deepEqual(await rows(db, "follow_tokens"), []);
  assert.deepEqual(
    (await rows(db, "follow_digest_outbox")).map(({ id, state, payload, lease_token }) => [
      id,
      state,
      payload,
      lease_token,
    ]),
    [
      [f.attemptedJob, "uncertain", null, null],
      [f.queuedJob, "cancelled", null, null],
    ].sort(),
  );
  assert.deepEqual(await rows(db, "follow_pending_progress"), []);
  assert.deepEqual(
    (await rows(db, "follow_digest_days")).map((r) => r.marker),
    [f.liveMarker],
  );
  assert.deepEqual(
    Object.fromEntries(
      (await rows(db, "follow_scope_progress")).map((r) => [r.subscriber_id, r.watermark]),
    ),
    { [f.active]: iso(f.queuedAt), [f.untouched]: iso(f.confirmedAt) },
  );
}

export async function utcBudgetAndNewerFence(db) {
  const now = await actualClock(db);
  const midnight = +date(iso(now).slice(0, 10) + "T00:00:00.000Z");
  await putBudget(db, midnight - 1, 4);
  assert.deepEqual(await maintainFollowRetention(db), {
    status: "maintained",
    budgetObserved: true,
  });
  const [reset] = await rows(db, "follow_send_budget");
  assert.equal(reset.attempts, 0);
  assert.ok(+date(reset.observed_at) >= now);

  await putBudget(db, +date(reset.observed_at), 3);
  assert.deepEqual(await maintainFollowRetention(db), {
    status: "maintained",
    budgetObserved: true,
  });
  const [next] = await rows(db, "follow_send_budget");
  assert.equal(
    next.attempts,
    next.observed_at.slice(0, 10) === reset.observed_at.slice(0, 10) ? 3 : 0,
  );

  const newer = now + day;
  const delayed = {
    prepare(sql) {
      if (sql !== CLOCK_SQL) return db.prepare(sql);
      return {
        all: async () => {
          const sample = await db.prepare(sql).all();
          await putBudget(db, newer, 7);
          return sample;
        },
      };
    },
    batch: (statements) => db.batch(statements),
  };
  assert.deepEqual(await maintainFollowRetention(delayed), {
    status: "maintained",
    budgetObserved: false,
  });
  assert.deepEqual(await rows(db, "follow_send_budget"), [
    { slot: 1, observed_at: iso(newer), attempts: 7 },
  ]);
}

export async function lateFailureRollsBackAllRetentionWrites(db) {
  const f = await fixture(db);
  await putBudget(db, f.now - day, 4);
  const tables = [
    "follow_subscribers",
    "follow_subscriptions",
    "follow_tokens",
    "follow_scope_progress",
    "follow_pending_progress",
    "follow_digest_days",
    "follow_digest_outbox",
    "follow_send_budget",
  ];
  const snapshot = () => Promise.all(tables.map((table) => rows(db, table)));
  const before = await snapshot();
  await db
    .prepare(
      "CREATE TRIGGER follow_retention_fixture_abort BEFORE INSERT ON follow_send_budget " +
        "BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    )
    .run();
  try {
    assert.deepEqual(await maintainFollowRetention(db), { status: "unavailable" });
    assert.deepEqual(await snapshot(), before);
  } finally {
    await db.prepare("DROP TRIGGER follow_retention_fixture_abort").run();
  }
}

export async function invalidSampleAndUnverifiedResult(db) {
  let batches = 0;
  const invalid = {
    prepare: () => ({
      all: async () => ({ success: true, results: [{ at: "2028-02-30T00:00:00.000Z" }] }),
    }),
    batch: () => {
      batches++;
    },
  };
  assert.deepEqual(await maintainFollowRetention(invalid), { status: "unavailable" });
  assert.equal(batches, 0);
  const ambiguous = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      batches++;
      const result = await db.batch(statements);
      return result.slice(1);
    },
  };
  assert.deepEqual(await maintainFollowRetention(ambiguous), { status: "unavailable" });
  assert.equal(batches, 1);
}
