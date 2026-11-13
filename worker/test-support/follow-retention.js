import assert from "node:assert/strict";
export * from "./follow-expiry-page.js";
export * from "./follow-digest-expiry-page.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import { beginFollowSnapshotAttempt, leaseFollowDigest } from "../src/follow-outbox.js";
import {
  maintainFollowRetention,
  expireFollowManagementRequests,
} from "../src/follow-retention.js";
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

export async function managementExpiryDisabledAndInvalidBoundsNeverAccessStorage() {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw new Error();
    },
  };
  assert.deepEqual(await expireFollowManagementRequests(db, null), { status: "disabled" });
  for (const enabled of [undefined, false, "true", 1])
    assert.deepEqual(await expireFollowManagementRequests(db, { enabled, maxRows: 1 }), {
      status: "disabled",
    });
  for (const maxRows of [undefined, null, "1", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.deepEqual(await expireFollowManagementRequests(db, { enabled: true, maxRows }), {
      status: "unavailable",
    });
  assert.equal(calls, 0);
}

async function managementJob(db, id, expires, claim = null) {
  await db
    .prepare("INSERT INTO follow_subscribers(id,email,created) VALUES(?,?,?)")
    .bind(id, id + "@example.test", iso(expires - day))
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions(subscriber_id,scope_key,created) VALUES(?,'public-scope',?)",
    )
    .bind(id, iso(expires - day))
    .run();
  await db
    .prepare(
      "INSERT INTO follow_management_outbox(id,subscriber_id,queued_at,expires_at,claim_id) VALUES(?,?,?,?,?)",
    )
    .bind(id, id, iso(expires - day), iso(expires), claim)
    .run();
}

export async function managementExpiryUsesSqlClockCapAndStableTies(db) {
  const now = await actualClock(db);
  await managementJob(db, "tie-first", now - 10000);
  await managementJob(db, "earliest", now - 20000, crypto.randomUUID());
  await managementJob(db, "tie-second", now - 10000, crypto.randomUUID());
  await managementJob(db, "live", now + day);
  await managementJob(db, "live-claimed", now + day, crypto.randomUUID());
  await mintFollowToken(db, "tie-first", "manage", {}, date(now));
  await mintFollowToken(db, "tie-second", "unsubscribe", {}, date(now));
  await putBudget(db, now, 7);
  const preserved = [
    "follow_subscribers",
    "follow_subscriptions",
    "follow_tokens",
    "follow_send_budget",
    "follow_digest_days",
    "rate",
  ];
  const before = await Promise.all(preserved.map((t) => rows(db, t)));
  const live = (await rows(db, "follow_management_outbox")).filter((r) => r.id.startsWith("live"));
  const options = { enabled: true, maxRows: 2 };
  assert.deepEqual(await expireFollowManagementRequests(db, options), {
    status: "maintained",
    removed: 2,
  });
  assert.deepEqual(
    (await rows(db, "follow_management_outbox")).map((r) => r.id),
    ["live", "live-claimed", "tie-second"],
  );
  assert.deepEqual(await expireFollowManagementRequests(db, options), {
    status: "maintained",
    removed: 1,
  });
  assert.deepEqual(await expireFollowManagementRequests(db, options), {
    status: "maintained",
    removed: 0,
  });
  assert.deepEqual(await rows(db, "follow_management_outbox"), live);
  assert.deepEqual(await Promise.all(preserved.map((t) => rows(db, t))), before);
}

export async function managementExpiryAcknowledgementsAndLostCommitNeverRetry(db) {
  let inflatedCalls = 0;
  assert.deepEqual(
    await expireFollowManagementRequests(
      {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => {
          inflatedCalls++;
          return [
            { success: true, results: [], meta: { changes: 99 } },
            { success: true, results: [{ removed: 1 }], meta: { changes: 0 } },
          ];
        },
      },
      { enabled: true, maxRows: 1 },
    ),
    { status: "unavailable" },
  );
  assert.equal(inflatedCalls, 1);
  for (const receipt of [
    null,
    {},
    { success: false },
    { success: true, meta: { changes: 0 } },
    { success: true, results: [], meta: { changes: 0 } },
    { success: true, results: [{ removed: 0 }], meta: { changes: 0 } },
    { success: true, results: [{ removed: -1 }], meta: { changes: 0 } },
    { success: true, results: [{ removed: 1.5 }], meta: { changes: 0 } },
    { success: true, results: [{ removed: 2 }], meta: { changes: 0 } },
    { success: true, results: [{ removed: 1 }], meta: { changes: 1 } },
    { success: true, results: [1], meta: { changes: 0 } },
  ]) {
    let calls = 0;
    const malformed = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        calls++;
        return [{ success: true, results: [], meta: { changes: 1 } }, receipt];
      },
    };
    assert.deepEqual(
      await expireFollowManagementRequests(malformed, { enabled: true, maxRows: 1 }),
      { status: "unavailable" },
    );
    assert.equal(calls, 1);
  }
  const now = await actualClock(db);
  await managementJob(db, "uncertain-first", now - 10000);
  await managementJob(db, "uncertain-second", now - 10000);
  let writes = 0;
  const lost = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      await db.batch(statements);
      writes++;
      throw new Error("synthetic lost reply");
    },
  };
  assert.deepEqual(await expireFollowManagementRequests(lost, { enabled: true, maxRows: 1 }), {
    status: "unavailable",
  });
  assert.equal(writes, 1);
  assert.deepEqual(
    (await rows(db, "follow_management_outbox")).map((r) => r.id),
    ["uncertain-second"],
  );
}

export async function managementExpiryFailureRollsBackWholeBoundedStatement(db) {
  const now = await actualClock(db);
  await managementJob(db, "rollback-first", now - 10000);
  await managementJob(db, "rollback-second", now - 10000, crypto.randomUUID());
  const before = await rows(db, "follow_management_outbox");
  await db
    .prepare(
      "CREATE TRIGGER management_expiry_abort BEFORE DELETE ON follow_management_outbox WHEN OLD.id='rollback-second' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    )
    .run();
  try {
    assert.deepEqual(await expireFollowManagementRequests(db, { enabled: true, maxRows: 2 }), {
      status: "unavailable",
    });
    assert.deepEqual(await rows(db, "follow_management_outbox"), before);
  } finally {
    await db.prepare("DROP TRIGGER management_expiry_abort").run();
  }
}

export async function managementExpiryIndexedSyntheticBacklog(db) {
  await db
    .prepare(
      "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20000) INSERT INTO follow_subscribers(id,email,created) SELECT printf('backlog-%05d',v),printf('backlog-%05d@example.test',v),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') FROM n",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO follow_management_outbox(id,subscriber_id,queued_at,expires_at) SELECT id,id,created,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') FROM follow_subscribers WHERE id LIKE 'backlog-%'",
    )
    .run();
  let sql, receipt;
  const measured = {
    prepare(query) {
      if (query.startsWith("DELETE")) sql = query;
      return db.prepare(query);
    },
    batch: async (statements) => {
      const result = await db.batch(statements);
      receipt = result[0];
      return result;
    },
  };
  assert.deepEqual(await expireFollowManagementRequests(measured, { enabled: true, maxRows: 7 }), {
    status: "maintained",
    removed: 7,
  });
  const plan = (
    await db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .bind(7)
      .all()
  ).results
    .map((r) => r.detail)
    .join("; ");
  assert.match(plan, /USING COVERING INDEX follow_management_outbox_expiry/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM follow_management_outbox").first("n"),
    19993,
  );
  return { rowsRead: receipt.meta.rows_read, rowsWritten: receipt.meta.rows_written, plan };
}
