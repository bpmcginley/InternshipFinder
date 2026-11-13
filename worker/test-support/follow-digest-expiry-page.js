import assert from "node:assert/strict";
import { expireFollowDigestPage } from "../src/follow-digest-expiry-page.js";
import { expireFollowPage } from "../src/follow-expiry-page.js";

const opts = (cursor = null) => ({ enabled: true, maxRows: 1, cursor });
const day = 86400000;
const rows = async (db, table) =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
async function fixture(db) {
  const at = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at");
  const time = (offset) => new Date(Date.parse(at) + offset).toISOString();
  await db
    .prepare(
      "INSERT INTO follow_subscribers(id,email,created) VALUES('digest-fixture','digest@example.test',?)",
    )
    .bind(time(-10 * day))
    .run();
  return { at, time };
}
async function job(db, f, id, state, { row = null, old = false, live = false } = {}) {
  const leased = ["leased", "attempting"].includes(state),
    active = ["queued", "leased", "attempting"].includes(state);
  await db
    .prepare(
      `INSERT INTO follow_digest_outbox(rowid,id,subscriber_id,day,payload,created,expires_at,state,lease_token,lease_until,attempted_at)
    VALUES(?,?,'digest-fixture',?,?,?,?,?,?,?,?)`,
    )
    .bind(
      row,
      id,
      id,
      active ? "[]" : null,
      f.time((old ? -8 : -1) * day),
      f.time(live ? day : -1000),
      state,
      leased ? "synthetic-lease" : null,
      leased ? f.time(live ? day : -1000) : null,
      state === "attempting" ? f.time((old ? -8 : -1) * day + 1000) : null,
    )
    .run();
}
async function pending(db, f, id, size = 1, old = false, pad = false) {
  const from = f.time(-10 * day),
    to = f.time((old ? -9 : -2) * day),
    advances = [];
  const statements = [];
  for (let i = 0; i < size; i++) {
    const key = i.toString(36),
      generation = `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`;
    advances.push({ scopeKey: key, generation, confirmedAt: from, from, to });
    statements.push(
      db
        .prepare("INSERT INTO follow_subscriptions VALUES('digest-fixture',?,?,?,NULL)")
        .bind(key, from, from),
      db
        .prepare("INSERT INTO follow_scope_progress VALUES('digest-fixture',?,?,?)")
        .bind(key, generation, from),
    );
  }
  await db.batch(statements);
  let json = JSON.stringify(advances);
  assert.ok(json.length <= 32768);
  if (pad) json = json.padEnd(32768, " ");
  await db
    .prepare("INSERT INTO follow_pending_progress VALUES(?,?,?,?)")
    .bind(id, "a".repeat(64), to, json)
    .run();
  return { from, to, bytes: json.length };
}
const intercept = (db, batch) => ({ prepare: (sql) => db.prepare(sql), batch });

export async function digestExpiryDisabledInvalidAndEmptyAreBounded(db) {
  let calls = 0;
  const never = {
    prepare() {
      calls++;
      throw Error();
    },
  };
  assert.deepEqual(await expireFollowDigestPage(never), { status: "disabled" });
  for (const patch of [
    { maxRows: 0 },
    { maxRows: 2 },
    { extra: true },
    { cursor: { kind: "tokens", after: "1", through: "2" } },
    { cursor: { kind: "digest", after: "01", through: "2" } },
    { cursor: { kind: "digest", after: "2", through: "1" } },
    { cursor: { kind: "digest", after: "0", through: "9223372036854775808" } },
  ])
    assert.deepEqual(await expireFollowDigestPage(never, { ...opts(), ...patch }), {
      status: "unavailable",
    });
  assert.equal(calls, 0);
  assert.deepEqual(await expireFollowDigestPage(db, opts()), {
    status: "maintained",
    examined: 0,
    uncertain: 0,
    cancelled: 0,
    removed: 0,
    complete: true,
    next: null,
  });
}

export async function digestExpiryPreservesTheTwoUpdateBandsAndSevenDayRule(db) {
  const f = await fixture(db);
  for (const [id, state, settings] of [
    ["queued", "queued", {}],
    ["leased", "leased", {}],
    ["attempt", "attempting", {}],
    ["live", "attempting", { live: true }],
    ["old-live", "attempting", { live: true, old: true }],
    ["old-queued", "queued", { old: true }],
    ["accepted", "accepted", { old: true }],
  ])
    await job(db, f, id, state, settings);
  await db.prepare("UPDATE follow_delivery_owner SET phase='held'").run();
  const owner = await rows(db, "follow_delivery_owner");
  let cursor = null;
  const results = [];
  do {
    const result = await expireFollowDigestPage(db, opts(cursor));
    assert.equal(result.status, "maintained");
    results.push(result);
    cursor = result.next;
  } while (cursor);
  assert.equal(results.length, 7);
  assert.deepEqual(
    results.map((r) => [r.uncertain, r.cancelled, r.removed]),
    [
      [0, 1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 0, 1],
    ],
  );
  assert.deepEqual(
    (await rows(db, "follow_digest_outbox")).map((r) => [r.id, r.state]),
    [
      ["queued", "cancelled"],
      ["leased", "cancelled"],
      ["attempt", "uncertain"],
      ["live", "attempting"],
    ],
  );
  assert.deepEqual(await rows(db, "follow_delivery_owner"), owner);
}

export async function digestExpiryFinalizesBeforeDeletingAndKeepsInvalidProgressClosed(db) {
  const f = await fixture(db);
  await job(db, f, "old", "attempting", { old: true });
  const p = await pending(db, f, "old", 3, true);
  assert.deepEqual(await expireFollowDigestPage(db, opts()), {
    status: "maintained",
    examined: 1,
    uncertain: 1,
    cancelled: 0,
    removed: 1,
    complete: true,
    next: null,
  });
  assert.equal((await rows(db, "follow_pending_progress")).length, 0);
  assert.deepEqual(
    (await rows(db, "follow_scope_progress")).map((r) => r.watermark),
    Array(3).fill(p.to),
  );
  await job(db, f, "invalid", "attempting");
  await db
    .prepare("INSERT INTO follow_pending_progress VALUES('invalid',?,?,?)")
    .bind("b".repeat(64), p.to, "[true]")
    .run();
  assert.equal((await expireFollowDigestPage(db, opts())).uncertain, 1);
  assert.equal((await rows(db, "follow_pending_progress")).length, 0);
  assert.deepEqual(
    (await rows(db, "follow_scope_progress")).map((r) => r.watermark),
    Array(3).fill(p.to),
  );
}

export async function digestExpiryRollbackUndoesEarlierFinalization(db) {
  const f = await fixture(db);
  await job(db, f, "rollback", "attempting", { old: true });
  await pending(db, f, "rollback", 2, true);
  const before = await Promise.all(
    [
      "follow_digest_outbox",
      "follow_pending_progress",
      "follow_scope_progress",
      "follow_delivery_owner",
    ].map((t) => rows(db, t)),
  );
  await db
    .prepare(
      "CREATE TRIGGER digest_expiry_test_failure BEFORE DELETE ON follow_digest_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    )
    .run();
  try {
    assert.deepEqual(await expireFollowDigestPage(db, opts()), { status: "unavailable" });
    assert.deepEqual(
      await Promise.all(
        [
          "follow_digest_outbox",
          "follow_pending_progress",
          "follow_scope_progress",
          "follow_delivery_owner",
        ].map((t) => rows(db, t)),
      ),
      before,
    );
  } finally {
    await db.prepare("DROP TRIGGER digest_expiry_test_failure").run();
  }
}

export async function digestExpiryLostCommitAcknowledgementDoesNotRetryOrCertifyCursor(db) {
  const f = await fixture(db);
  await job(db, f, "lost", "attempting");
  await pending(db, f, "lost");
  let calls = 0;
  const wrapped = intercept(db, async (statements) => {
    calls++;
    await db.batch(statements);
    throw Error("Synthetic lost acknowledgement");
  });
  assert.deepEqual(await expireFollowDigestPage(wrapped, opts()), { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal((await rows(db, "follow_digest_outbox"))[0].state, "uncertain");
  assert.equal((await rows(db, "follow_pending_progress")).length, 0);
  const restarted = await expireFollowDigestPage(db, opts());
  assert.equal(restarted.status, "maintained");
  assert.equal(restarted.uncertain, 0);
}

export async function digestExpiryRechecksProgressAndConcurrentMaintenance(db) {
  const f = await fixture(db);
  await job(db, f, "race", "attempting");
  const p = await pending(db, f, "race");
  await db.prepare("UPDATE follow_delivery_owner SET phase='running'").run();
  const owner = await rows(db, "follow_delivery_owner");
  const wrapped = intercept(db, async (statements) => {
    await db
      .prepare("UPDATE follow_scope_progress SET scope_generation=?")
      .bind(crypto.randomUUID())
      .run();
    return db.batch(statements);
  });
  const result = await expireFollowDigestPage(wrapped, opts());
  assert.equal(result.uncertain, 1);
  assert.equal((await rows(db, "follow_scope_progress"))[0].watermark, p.from);
  assert.equal((await rows(db, "follow_pending_progress")).length, 0);
  const concurrent = await Promise.all([
    expireFollowDigestPage(db, opts()),
    expireFollowDigestPage(db, opts()),
  ]);
  assert.deepEqual(
    concurrent.map((r) => r.uncertain),
    [0, 0],
  );
  assert.deepEqual(await rows(db, "follow_delivery_owner"), owner);
}

export async function digestExpiryRejectsPartialOrContradictoryReceipts(db) {
  const f = await fixture(db);
  await job(db, f, "receipts", "queued", { live: true });
  for (const corrupt of [
    (r) => {
      delete r[4];
    },
    (r) => {
      r[2].success = false;
    },
    (r) => {
      r[1].results = [{ examined: 0, last: null }];
    },
    (r) => {
      r[3].results[0].changed = 1;
    },
    (r) => {
      r[2].meta.changes = 1;
    },
    (r) => {
      r[5].results[0] = {
        get changed() {
          throw Error();
        },
      };
    },
  ]) {
    let calls = 0;
    const wrapped = intercept(db, async (statements) => {
      calls++;
      const result = structuredClone(await db.batch(statements));
      corrupt(result);
      return result;
    });
    assert.deepEqual(await expireFollowDigestPage(wrapped, opts()), { status: "unavailable" });
    assert.equal(calls, 1);
  }
  assert.equal((await rows(db, "follow_digest_outbox"))[0].state, "queued");
}

export async function digestExpiryCursorResetSeesBehindAndAppendedRows(db) {
  const f = await fixture(db);
  await job(db, f, "a", "accepted", { row: -1, old: true });
  await job(db, f, "b", "accepted", { row: 0, old: true });
  await job(db, f, "c", "accepted", { row: 1, old: true });
  const first = await expireFollowDigestPage(db, opts());
  assert.deepEqual(first.next, { kind: "digest", after: "-1", through: "1" });
  await job(db, f, "reused", "accepted", { row: -1, old: true });
  await job(db, f, "behind", "accepted", { row: -2, old: true });
  await job(db, f, "appended", "accepted", { row: 2, old: true });
  const second = await expireFollowDigestPage(db, opts(first.next));
  const third = await expireFollowDigestPage(db, opts(second.next));
  assert.equal(third.complete, true);
  assert.equal((await rows(db, "follow_digest_outbox")).length, 3);
  let cursor = null,
    removed = 0;
  do {
    const r = await expireFollowDigestPage(db, opts(cursor));
    removed += r.removed;
    cursor = r.next;
  } while (cursor);
  assert.equal(removed, 3);
  for (const value of ["-9223372036854775808", "9223372036854775807"]) {
    await job(db, f, value, "accepted", { row: value, old: true });
  }
  const low = await expireFollowDigestPage(db, opts());
  assert.equal(low.next.after, "-9223372036854775808");
  assert.equal((await expireFollowDigestPage(db, opts(low.next))).complete, true);
}

export async function digestExpiryNativePlansAndBacklogStayBounded(db) {
  const f = await fixture(db);
  await db
    .prepare(
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20000)
    INSERT INTO follow_digest_outbox(id,subscriber_id,day,payload,created,expires_at,state)
    SELECT printf('backlog-%05d',v),'digest-fixture',CAST(v AS TEXT),'[]',?,?, 'queued' FROM n`,
    )
    .bind(f.at, f.time(day))
    .run();
  let native = false;
  const measuredReads = [];
  const wrapped = intercept(db, async (statements) => {
    const result = await db.batch(statements);
    if (typeof result[0].meta.rows_read === "number") {
      native = true;
      const read = result.reduce((n, r) => n + r.meta.rows_read, 0);
      measuredReads.push(read);
    }
    return result;
  });
  const first = await expireFollowDigestPage(wrapped, opts());
  const continuation = await expireFollowDigestPage(
    wrapped,
    opts({ kind: "digest", after: "10000", through: "20000" }),
  );
  assert.ok(
    measuredReads.every((n) => n <= 40),
    `bounded native page reads: ${JSON.stringify(measuredReads)}`,
  );
  assert.equal(first.examined, 1);
  assert.equal(continuation.examined, 1);
  assert.equal(first.cancelled, 0);
  assert.equal(continuation.cancelled, 0);
  for (const seek of [
    "rowid<=(SELECT max(rowid) FROM follow_digest_outbox)",
    "rowid>10000 AND rowid<=20000",
  ]) {
    const plan = (
      await db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT rowid FROM follow_digest_outbox WHERE ${seek} ORDER BY rowid LIMIT 1`,
        )
        .all()
    ).results
      .map((r) => r.detail)
      .join("\n");
    assert.match(plan, /INTEGER PRIMARY KEY/);
    assert.doesNotMatch(plan, /SCAN |TEMP B-TREE/);
  }
  if (native)
    console.log("synthetic digest page: 20,000 rows, first/continuation <=40 native reads");
  return measuredReads;
}

export async function digestExpiryNearMaximumPendingFinalizesWithoutOwnerMutation(db) {
  const f = await fixture(db);
  await job(db, f, "maximum", "attempting");
  // 185 compact unique advances fit; a 186th with this encoding exceeds the bound.
  // Pad to the exact schema byte ceiling without changing the valid JSON array.
  const p = await pending(db, f, "maximum", 185, false, true);
  assert.equal(p.bytes, 32768);
  await db.prepare("UPDATE follow_delivery_owner SET phase='held'").run();
  const owner = await rows(db, "follow_delivery_owner");
  let metrics;
  const wrapped = intercept(db, async (statements) => {
    const result = await db.batch(statements);
    metrics = result.map((r) => ({
      read: r.meta.rows_read,
      written: r.meta.rows_written,
      duration: r.meta.duration,
      changes: r.meta.changes,
    }));
    return result;
  });
  const start = performance.now();
  const result = await expireFollowDigestPage(wrapped, opts());
  const elapsed = performance.now() - start;
  assert.equal(result.status, "maintained");
  assert.equal(result.uncertain, 1);
  assert.equal((await rows(db, "follow_pending_progress")).length, 0);
  assert.deepEqual(
    (await rows(db, "follow_scope_progress")).map((r) => r.watermark),
    Array(185).fill(p.to),
  );
  assert.deepEqual(await rows(db, "follow_delivery_owner"), owner);
  if (typeof metrics[0].read === "number")
    console.log(
      "synthetic maximum digest expiry",
      JSON.stringify({ bytes: p.bytes, advances: 185, elapsedMs: elapsed, metrics }),
    );
  return { bytes: p.bytes, advances: 185, elapsedMs: elapsed, metrics };
}

export async function digestDayExpiryUsesBoundedScanAndReset(db) {
  await db
    .prepare(
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20000)
    INSERT INTO follow_digest_days(marker,expires_at) SELECT printf('%064x',v),
    strftime('%Y-%m-%dT%H:%M:%fZ','now',CASE WHEN v IN (1,10001) THEN '-1 day' ELSE '+1 day' END) FROM n`,
    )
    .run();
  const metrics = [];
  const wrapped = intercept(db, async (statements) => {
    const result = await db.batch(statements);
    if (typeof result[0].meta.rows_read === "number")
      metrics.push({
        reads: result.reduce((n, r) => n + r.meta.rows_read, 0),
        writes: result.reduce((n, r) => n + r.meta.rows_written, 0),
        duration: result.reduce((n, r) => n + r.meta.duration, 0),
      });
    return result;
  });
  const run = (cursor) =>
    expireFollowPage(wrapped, { enabled: true, kind: "digest-days", maxRows: 128, cursor });
  const first = await run(null);
  assert.equal(first.removed, 1);
  assert.equal(first.examined, 128);
  const middle = await run({ kind: "digest-days", after: "10000", through: "20000" });
  assert.equal(middle.removed, 1);
  assert.equal(middle.examined, 128);
  await db
    .prepare(
      "INSERT INTO follow_digest_days(rowid,marker,expires_at) VALUES(1,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))",
    )
    .bind("f".repeat(64))
    .run();
  assert.equal((await run(first.next)).removed, 0);
  assert.equal((await run(null)).removed, 1);
  await db
    .prepare(
      "UPDATE follow_digest_days SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE rowid<=129",
    )
    .run();
  assert.equal((await run(null)).removed, 128);
  // Candidate aggregate, selection, row lookup and deletion each have bounded row work.
  assert.ok(
    metrics.every((r) => r.reads <= 5 * 128 + 8 && r.writes <= 128),
    JSON.stringify(metrics),
  );
  const plan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT rowid FROM follow_digest_days WHERE rowid>10000 AND rowid<=20000 ORDER BY rowid LIMIT 128",
      )
      .all()
  ).results
    .map((r) => r.detail)
    .join("\n");
  assert.match(plan, /INTEGER PRIMARY KEY/);
  assert.doesNotMatch(plan, /SCAN |TEMP B-TREE/);
  return metrics;
}

export async function digestDayLostAcknowledgementNeverReturnsContinuation(db) {
  await db
    .prepare(
      "INSERT INTO follow_digest_days VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))",
    )
    .bind("a".repeat(64))
    .run();
  let calls = 0;
  const wrapped = intercept(db, async (statements) => {
    calls++;
    await db.batch(statements);
    throw Error("Synthetic loss");
  });
  assert.deepEqual(
    await expireFollowPage(wrapped, { enabled: true, kind: "digest-days", maxRows: 1 }),
    { status: "unavailable" },
  );
  assert.equal(calls, 1);
  assert.equal((await rows(db, "follow_digest_days")).length, 0);
}
