import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import { prepareLeasedFollowDigest } from "../src/follow-digest-prepare.js";
import {
  confirmFollow,
  mintFollowToken,
  requestFollow,
  removeManagedFollow,
  unsubscribeFollows,
} from "../src/follows.js";
import {
  queueFollowDigest,
  expireFollowOutbox,
  leaseFollowDigest,
  beginFollowDigestAttempt,
  finishFollowDigestAttempt,
} from "../src/follow-outbox.js";

const start = new Date("2026-11-10T12:00:00.000Z"),
  now = new Date("2026-11-11T12:00:00.000Z");
const catalog = {
  companies: new Set(["alpha", "beta"]),
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
  maxWindowMs: 4 * 86400_000,
};
const options = {
  catalog,
  limits,
  upperBound: now.toISOString(),
  maxProgressBytes: 4000,
  maxPendingBytes: 4000,
};
const snapshot = (at = now.toISOString()) =>
  new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: at,
      covers_after: "2026-11-10T00:00:00.000Z",
      roles: ["alpha", "beta"].map((company_key, i) => ({
        id: String(i + 1).repeat(16),
        company_key,
        field_tags: ["biology"],
        states: ["MA"],
        first_seen: "2026-11-11T00:00:00.000Z",
        status: "open",
        company_name: "Fixture",
        title: "Fixture role",
        location: "Fixture town",
        apply_url: `https://example.test/${i}`,
      })),
    }),
  );
const encodeSnapshot = (value) => new TextEncoder().encode(JSON.stringify(value));
const emptySnapshot = (at = now.toISOString()) =>
  encodeSnapshot({ ...JSON.parse(new TextDecoder().decode(snapshot(at))), roles: [] });
const request = (db, company) =>
  requestFollow(db, "fixture@example.test", { kind: "company", company }, catalog, start);
async function confirm(db, company) {
  const follow = await request(db, company);
  await confirmFollow(
    db,
    await mintFollowToken(db, follow.subscriberId, "confirm", { scopeKey: follow.scopeKey }, start),
    start,
  );
  return follow;
}
const enqueue = (db, id, data = snapshot(), overrides = {}, at = now) =>
  enqueueFollowSnapshot(db, id, data, { ...options, ...overrides }, at);
const prepare = (db, id, lease, loadSnapshot, clock = () => now) =>
  prepareLeasedFollowDigest(db, id, lease, { catalog, limits, loadSnapshot, clock });
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const progress = (db) => rows(db, "follow_scope_progress");
const pending = (db) => rows(db, "follow_pending_progress");
const jobs = (db) => rows(db, "follow_digest_outbox");
const interceptBatch = (db, before, after) => ({
  prepare: (sql) => db.prepare(sql),
  batch: async (statements) => {
    if (before) await before();
    const result = await db.batch(statements);
    if (after) await after();
    return result;
  },
});

export async function activeLookupPlan(db, equal) {
  const a = await confirm(db, "alpha");
  // Retained terminal history must not become the active-job lookup's scan range.
  await db.batch(
    Array.from({ length: 100 }, (_, n) =>
      db
        .prepare(
          "INSERT INTO follow_digest_outbox (id,subscriber_id,day,payload,created,expires_at,state) VALUES (?,?,?,NULL,?,?,'accepted')",
        )
        .bind(
          crypto.randomUUID(),
          a.subscriberId,
          new Date(Date.UTC(2020, 0, n + 1)).toISOString().slice(0, 10),
          start.toISOString(),
          start.toISOString(),
        ),
    ),
  );
  equal((await enqueue(db, a.subscriberId)).status, "queued");
  const lookup =
    "SELECT 1 FROM follow_digest_outbox busy WHERE busy.subscriber_id=? " +
    "AND busy.state IN ('queued','leased','attempting') AND busy.expires_at>?";
  const plan = (
    await db
      .prepare("EXPLAIN QUERY PLAN " + lookup)
      .bind(a.subscriberId, now.toISOString())
      .all()
  ).results;
  equal(
    plan.some(
      (row) =>
        row.detail.includes("follow_active_expiry") &&
        row.detail.includes("subscriber_id=? AND expires_at>?"),
    ),
    true,
  );
  equal((await db.prepare(lookup).bind(a.subscriberId, now.toISOString()).all()).results.length, 1);
  equal(
    (
      await db
        .prepare(lookup)
        .bind(a.subscriberId, new Date(+now + 2 * 86400_000).toISOString())
        .all()
    ).results,
    [],
  );
}

export async function immutableEnqueue(db, equal, rejects) {
  const a = await confirm(db, "alpha");
  await confirm(db, "beta");
  const original = await progress(db);
  const first = await enqueue(db, a.subscriberId);
  equal(first.status, "queued");
  equal(await enqueue(db, a.subscriberId), first);
  const stored = (await pending(db))[0];
  equal(Object.keys(stored).sort(), ["advances", "job_id", "snapshot_at", "snapshot_digest"]);
  equal(stored.snapshot_at, options.upperBound);
  equal(/^[a-f0-9]{64}$/.test(stored.snapshot_digest), true);
  equal(
    JSON.parse(stored.advances).map((v) => Object.keys(v).sort()),
    [0, 1].map(() => ["confirmedAt", "from", "generation", "scopeKey", "to"]),
  );
  equal(await progress(db), original);
  const sameFactsOtherBytes = new TextEncoder().encode(" " + new TextDecoder().decode(snapshot()));
  equal(await enqueue(db, a.subscriberId, sameFactsOtherBytes), { status: "conflict" });
  const later = new Date(+now + 1);
  equal(
    await enqueue(
      db,
      a.subscriberId,
      snapshot(later.toISOString()),
      { upperBound: later.toISOString() },
      later,
    ),
    { status: "conflict" },
  );
  await rejects(() =>
    db.prepare("UPDATE follow_pending_progress SET snapshot_digest=?").bind("a".repeat(64)).run(),
  );
  equal((await pending(db))[0], stored);
  equal((await jobs(db)).length, 1);
}

export async function concurrentRetry(db, equal, rejects) {
  const a = await confirm(db, "alpha");
  const outcomes = await Promise.all([enqueue(db, a.subscriberId), enqueue(db, a.subscriberId)]);
  equal(outcomes[0], outcomes[1]);
  equal(outcomes[0].status, "queued");
  equal((await jobs(db)).length, 1);
  equal((await pending(db)).length, 1);
  // Simulate a committed D1 batch whose response is lost; retry must recognize the exact job.
  await db.prepare("DELETE FROM follow_subscribers").run();
  const fresh = await confirm(db, "alpha");
  await rejects(() =>
    enqueue(
      interceptBatch(db, null, () => {
        throw new Error("synthetic lost response");
      }),
      fresh.subscriberId,
    ),
  );
  const committed = (await jobs(db))[0];
  equal(await enqueue(db, fresh.subscriberId), { status: "queued", id: committed.id });
  equal((await jobs(db)).length, 1);
  equal((await pending(db)).length, 1);
}

export async function ownedSnapshotBytes(db, equal) {
  const a = await confirm(db, "alpha"),
    input = snapshot();
  const original = new Uint8Array(input);
  const mutableClock = new Date(+now);
  let reading = true;
  const changing = {
    batch: (list) => db.batch(list),
    prepare: (sql) => {
      if (!reading) return db.prepare(sql);
      reading = false;
      return {
        bind: (...args) => ({
          all: async () => {
            const result = await db
              .prepare(sql)
              .bind(...args)
              .all();
            input.fill(0); // Caller mutates its buffer while the progress read is in flight.
            mutableClock.setTime(+now + 7 * 86400_000);
            return result;
          },
        }),
      };
    },
  };
  const first = await enqueue(changing, a.subscriberId, input, {}, mutableClock);
  equal(first.status, "queued");
  equal(await enqueue(db, a.subscriberId, original), first);
  equal((await jobs(db))[0].created, now.toISOString());
  equal((await jobs(db))[0].expires_at, new Date(+now + 2 * 86400_000).toISOString());
}

export async function staleCapture(db, equal) {
  for (const change of ["generation", "added", "removed", "watermark", "subscriber"]) {
    await db.prepare("DELETE FROM follow_subscribers").run();
    const a = await confirm(db, "alpha");
    const b = change === "generation" || change === "removed" ? await confirm(db, "beta") : null;
    const original = await progress(db);
    const stale = interceptBatch(db, async () => {
      if (change === "added") await confirm(db, "beta");
      else if (change === "watermark")
        await db
          .prepare("UPDATE follow_scope_progress SET watermark=?")
          .bind(now.toISOString())
          .run();
      else if (change === "subscriber") {
        const token = await mintFollowToken(db, a.subscriberId, "unsubscribe", {}, now);
        await unsubscribeFollows(db, token, now);
      } else {
        const token = await mintFollowToken(db, a.subscriberId, "manage", {}, start);
        await removeManagedFollow(db, token, change === "removed" ? b.scopeKey : a.scopeKey, start);
        if (change === "generation") {
          await confirm(db, "alpha");
          const replacement = (await progress(db)).find((p) => p.scope_key === a.scopeKey);
          equal(replacement.watermark, original.find((p) => p.scope_key === a.scopeKey).watermark);
          equal(
            replacement.scope_generation ===
              original.find((p) => p.scope_key === a.scopeKey).scope_generation,
            false,
          );
        }
      }
    });
    equal(await enqueue(stale, a.subscriberId), { status: "conflict" });
    equal(await jobs(db), []);
    equal(await pending(db), []);
  }
}

export async function cancellationRecovery(db, equal) {
  const a = await confirm(db, "alpha"),
    b = await confirm(db, "beta");
  const first = await enqueue(db, a.subscriberId);
  const original = (await progress(db)).find((p) => p.scope_key === b.scopeKey);
  const tomorrow = new Date(+now + 86400_000);
  equal(
    await enqueue(
      db,
      b.subscriberId,
      snapshot(tomorrow.toISOString()),
      { upperBound: tomorrow.toISOString() },
      tomorrow,
    ),
    { status: "conflict" },
  );
  equal((await jobs(db)).length, 1);
  equal((await pending(db)).length, 1);
  const token = await mintFollowToken(db, a.subscriberId, "manage", {}, now);
  await removeManagedFollow(db, token, a.scopeKey, now);
  equal((await jobs(db))[0].state, "cancelled");
  equal(await pending(db), []);
  equal((await progress(db))[0], original);
  equal(await enqueue(db, b.subscriberId), { status: "conflict" });
  const next = await enqueue(
    db,
    b.subscriberId,
    snapshot(tomorrow.toISOString()),
    { upperBound: tomorrow.toISOString() },
    tomorrow,
  );
  equal(next.status, "queued");
  equal(next.id === first.id, false);
  equal(JSON.parse((await jobs(db)).find((j) => j.id === next.id).payload)[0].roles, [
    "2".repeat(16),
  ]);
  equal((await progress(db))[0], original);
  await unsubscribeFollows(
    db,
    await mintFollowToken(db, b.subscriberId, "unsubscribe", {}, tomorrow),
    tomorrow,
  );
  equal(await pending(db), []);
  equal(await jobs(db), []);
}

export async function enqueueRollback(db, equal, rejects) {
  const a = await confirm(db, "alpha"),
    original = await progress(db);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_pending_failure BEFORE INSERT ON follow_pending_progress BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END",
    )
    .run();
  try {
    await rejects(() => enqueue(db, a.subscriberId));
  } finally {
    await db.prepare("DROP TRIGGER synthetic_pending_failure").run();
  }
  equal(await jobs(db), []);
  equal(await pending(db), []);
  equal(await progress(db), original);
  equal((await enqueue(db, a.subscriberId)).status, "queued");
}

export async function pendingLifetime(db, equal) {
  const a = await confirm(db, "alpha"),
    original = await progress(db);
  const first = await enqueue(db, a.subscriberId);
  const lease = await leaseFollowDigest(db, first.id, now);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(9),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  equal(await beginFollowDigestAttempt(db, key, first.id, lease, () => now), true);
  equal((await pending(db)).length, 1);
  equal(await finishFollowDigestAttempt(db, first.id, lease, "uncertain", now), true);
  equal(await pending(db), []);
  original[0].watermark = now.toISOString(); // P-2.1k consumes an uncertain claimed window.
  equal(await progress(db), original);
  equal((await rows(db, "follow_digest_days")).length, 1);
  const tomorrow = new Date(+now + 86400_000);
  const freshSnapshot = JSON.parse(new TextDecoder().decode(snapshot(tomorrow.toISOString())));
  freshSnapshot.roles.forEach((role) => {
    role.first_seen = new Date(+now + 1).toISOString();
  });
  equal(
    (
      await enqueue(
        db,
        a.subscriberId,
        new TextEncoder().encode(JSON.stringify(freshSnapshot)),
        { upperBound: tomorrow.toISOString() },
        tomorrow,
      )
    ).status,
    "queued",
  );
  await expireFollowOutbox(db, new Date(+tomorrow + 2 * 86400_000));
  equal(await pending(db), []);
  equal(await progress(db), original);
  await expireFollowOutbox(db, new Date(+tomorrow + 7 * 86400_000));
  equal(await jobs(db), []);
}

export async function rejectionBoundaries(db, equal) {
  const a = await confirm(db, "alpha"),
    original = await progress(db);
  equal(await enqueue(db, a.subscriberId, snapshot(), { maxPendingBytes: 1 }), {
    status: "invalid",
    reason: "pending_bound",
  });
  equal(await enqueue(db, a.subscriberId, emptySnapshot(), { maxPendingBytes: 1 }), {
    status: "invalid",
    reason: "pending_bound",
  });
  const invalid = { ...JSON.parse(new TextDecoder().decode(emptySnapshot())), complete: false };
  equal(
    (await enqueue(db, a.subscriberId, new TextEncoder().encode(JSON.stringify(invalid)))).status,
    "invalid",
  );
  equal(await progress(db), original);
  equal(await jobs(db), []);
  equal(await pending(db), []);
  // An old API job has no immutable snapshot contract; never adopt or mutate it silently.
  await queueFollowDigest(
    db,
    a.subscriberId,
    [{ scopeKey: a.scopeKey, roles: ["1".repeat(16)] }],
    now,
  );
  equal(await enqueue(db, a.subscriberId), { status: "conflict" });
  equal(await pending(db), []);
}

export async function emptyWindowAdvance(db, equal, rejects) {
  const a = await confirm(db, "alpha");
  await confirm(db, "beta");
  const original = await progress(db);
  const lostResponse = interceptBatch(db, null, () => {
    throw new Error("synthetic lost empty-window response");
  });
  await rejects(() => enqueue(lostResponse, a.subscriberId, emptySnapshot()));
  equal(
    await progress(db),
    original.map((row) => ({ ...row, watermark: options.upperBound })),
  );
  equal(await enqueue(db, a.subscriberId, emptySnapshot()), { status: "empty" });
  equal(await jobs(db), []);
  equal(await pending(db), []);
  equal(await rows(db, "follow_digest_days"), []);

  // A later producer window no longer covers the old confirmation instant.
  const tomorrow = new Date(+now + 86400_000);
  const data = JSON.parse(new TextDecoder().decode(snapshot(tomorrow.toISOString())));
  data.covers_after = "2026-11-11T00:00:00.000Z";
  for (const role of data.roles) role.first_seen = "2026-11-12T00:00:00.000Z";
  const next = await enqueue(
    db,
    a.subscriberId,
    encodeSnapshot(data),
    { upperBound: tomorrow.toISOString() },
    tomorrow,
  );
  equal(next.status, "queued");
  equal(JSON.parse((await jobs(db))[0].payload).length, 2);
}

export async function emptyWindowFences(db, equal) {
  const a = await confirm(db, "alpha");
  const unrelated = JSON.parse(new TextDecoder().decode(snapshot()));
  unrelated.roles = unrelated.roles.filter((role) => role.company_key === "beta");
  const stale = interceptBatch(db, () => confirm(db, "beta"));
  equal(await enqueue(stale, a.subscriberId, encodeSnapshot(unrelated)), { status: "conflict" });
  const original = await progress(db);
  equal(
    original.map((row) => row.watermark),
    [start.toISOString(), start.toISOString()],
  );

  const first = await enqueue(db, a.subscriberId);
  equal(await enqueue(db, a.subscriberId, emptySnapshot()), { status: "conflict" });
  const lease = await leaseFollowDigest(db, first.id, now);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  equal(await beginFollowDigestAttempt(db, key, first.id, lease, () => now), true);
  const later = new Date(+now + 2 * 86400_000 + 1);
  const data = emptySnapshot(later.toISOString());
  const overrides = { upperBound: later.toISOString() };
  equal(await enqueue(db, a.subscriberId, data, overrides, later), { status: "conflict" });
  equal(await progress(db), original);

  await expireFollowOutbox(db, later);
  equal((await jobs(db))[0].state, "uncertain");
  equal(await enqueue(db, a.subscriberId, data, overrides, later), { status: "advanced" });
  equal(
    (await progress(db)).map((row) => row.watermark),
    [later.toISOString(), later.toISOString()],
  );
  equal(await pending(db), []);
}

export async function emptyWindowRollback(db, equal, rejects) {
  const a = await confirm(db, "alpha");
  await confirm(db, "beta");
  const original = await progress(db);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_empty_window_failure BEFORE UPDATE OF watermark ON follow_scope_progress " +
        "WHEN OLD.scope_key LIKE '%beta%' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END",
    )
    .run();
  try {
    await rejects(() => enqueue(db, a.subscriberId, emptySnapshot()));
  } finally {
    await db.prepare("DROP TRIGGER synthetic_empty_window_failure").run();
  }
  equal(await progress(db), original);
  equal(await jobs(db), []);
  let planQuery;
  const explaining = {
    batch: (statements) => db.batch(statements),
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes("UPDATE follow_scope_progress SET watermark=")) return statement;
      return {
        bind(...args) {
          planQuery = db.prepare("EXPLAIN QUERY PLAN " + sql).bind(...args);
          return statement.bind(...args);
        },
      };
    },
  };
  equal(await enqueue(explaining, a.subscriberId, emptySnapshot()), { status: "advanced" });
  const plan = (await planQuery.all()).results;
  equal(
    plan.some(
      ({ detail }) =>
        detail.includes("follow_attempting_subscriber") && detail.includes("subscriber_id=?"),
    ),
    true,
  );
  equal(
    (await progress(db)).map((row) => row.watermark),
    [options.upperBound, options.upperBound],
  );
}

export async function preparePinnedDigest(db, equal) {
  const a = await confirm(db, "alpha");
  const job = await enqueue(db, a.subscriberId);
  const pin = (await pending(db))[0];
  let loads = 0;
  const load = async (input) => {
    loads++;
    equal(input, {
      at: options.upperBound,
      digest: pin.snapshot_digest,
      maxBytes: limits.maxBytes,
    });
    return snapshot();
  };
  equal(await prepare(db, job.id, crypto.randomUUID(), load), { status: "unavailable" });
  equal(loads, 0);
  const lease = await leaseFollowDigest(db, job.id, now);
  const previous = await jobs(db);
  const [alpha] = JSON.parse(new TextDecoder().decode(snapshot())).roles;
  equal(await prepare(db, job.id, lease, load), {
    status: "ready",
    subscriberId: a.subscriberId,
    roles: [alpha],
  });
  equal(loads, 1);

  const changedBytes = new TextEncoder().encode(" " + new TextDecoder().decode(snapshot()));
  for (const data of [changedBytes, new Uint8Array(limits.maxBytes + 1), "not bytes"]) {
    equal(await prepare(db, job.id, lease, async () => data), { status: "unavailable" });
  }
  equal(await jobs(db), previous);
  equal(await pending(db), [pin]);
  equal(await rows(db, "follow_digest_days"), []);

  await db
    .prepare("UPDATE follow_digest_outbox SET payload=? WHERE id=?")
    .bind(JSON.stringify([{ scopeKey: a.scopeKey, roles: ["2".repeat(16)] }]), job.id)
    .run();
  equal(await prepare(db, job.id, lease, load), { status: "unavailable" });
}

export async function prepareLeaseFences(db, equal) {
  const a = await confirm(db, "alpha");
  await confirm(db, "beta");
  const job = await enqueue(db, a.subscriberId);
  const lease = await leaseFollowDigest(db, job.id, now);
  for (const offset of [-1, 5 * 60_000]) {
    let time = now;
    const delayed = async () => {
      time = new Date(+now + offset);
      return snapshot();
    };
    equal(await prepare(db, job.id, lease, delayed, () => time), { status: "unavailable" });
  }

  const token = await mintFollowToken(db, a.subscriberId, "manage", {}, now);
  const cancelled = async () => {
    await removeManagedFollow(db, token, a.scopeKey, now);
    return snapshot();
  };
  equal(await prepare(db, job.id, lease, cancelled), { status: "unavailable" });
  equal((await jobs(db))[0].state, "cancelled");
  equal(await pending(db), []);
  equal(await rows(db, "follow_digest_days"), []);
}

export async function prepareUnpinnedJob(db, equal) {
  const a = await confirm(db, "alpha");
  const jobId = await queueFollowDigest(
    db,
    a.subscriberId,
    [{ scopeKey: a.scopeKey, roles: ["1".repeat(16)] }],
    now,
  );
  const lease = await leaseFollowDigest(db, jobId, now);
  let loads = 0;
  equal(
    await prepare(db, jobId, lease, async () => {
      loads++;
      return snapshot();
    }),
    { status: "unavailable" },
  );
  equal(loads, 0);
}
