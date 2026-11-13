import assert from "node:assert/strict";
import {
  expireFollowUnconfirmedPage,
  expireFollowOrphanPage,
} from "../src/follow-subscriber-expiry-page.js";
import { expireFollowPage } from "../src/follow-expiry-page.js";

const options = (cursor = null) => ({ enabled: true, maxRows: 1, maxChildren: 2, cursor });
const scopeOptions = (cursor = null) => ({ enabled: true, maxRows: 1, cursor });
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
const rows = async (db, table) =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
const wrap = (db, batch) => ({ prepare: (sql) => db.prepare(sql), batch });
async function subscriber(db, id = "first", row = null) {
  await db
    .prepare(
      "INSERT INTO follow_subscribers(rowid,id,email,created) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'))",
    )
    .bind(row, id, `${id}@example.test`)
    .run();
}
async function scope(db, id = "first", key = "company:a", age = "-8 days", confirmed = false) {
  await db
    .prepare(
      `INSERT INTO follow_subscriptions VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?),${confirmed ? "strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days')" : "NULL"},NULL)`,
    )
    .bind(id, key, age)
    .run();
}
async function children(db, id, size) {
  for (let i = 0; i < size; i++) {
    await db
      .prepare(
        "INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at) VALUES(?,?,'unsubscribe','','synthetic',NULL)",
      )
      .bind(`${id}-token-${i}`, id)
      .run();
    await db
      .prepare(
        "INSERT INTO follow_digest_outbox(id,subscriber_id,day,payload,created,expires_at,state,lease_token,lease_until) VALUES(?,?,?,'[]',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),'attempting','synthetic',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))",
      )
      .bind(`${id}-job-${i}`, id, String(i))
      .run();
    await db
      .prepare(
        "INSERT INTO follow_pending_progress VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)",
      )
      .bind(`${id}-job-${i}`, "a".repeat(64), "[{}]".padEnd(32768, " "))
      .run();
  }
}
async function ownerExists(db) {
  return !!(await db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='follow_delivery_owner'")
    .first());
}
async function owner(db, kind, id, expires, phase = "held") {
  if (!(await ownerExists(db))) return null;
  await db
    .prepare(`UPDATE follow_delivery_owner SET phase=?,${kind}_id=?,${kind}_expires_at=?`)
    .bind(phase, id, expires)
    .run();
  return (await rows(db, "follow_delivery_owner"))[0];
}

export async function subscriberExpiryDisabledMalformedAndEmpty(db) {
  let calls = 0;
  const never = {
    prepare() {
      calls++;
      throw Error();
    },
  };
  for (const fn of [expireFollowOrphanPage, expireFollowUnconfirmedPage])
    assert.deepEqual(await fn(never), { status: "disabled" });
  for (const patch of [
    { maxRows: 129 },
    { maxChildren: 0 },
    { maxChildren: 129 },
    { extra: 1 },
    { cursor: { kind: "orphans", after: "2", through: "1" } },
    { cursor: { kind: "orphans", after: null, through: "9223372036854775808" } },
  ])
    assert.deepEqual(await expireFollowOrphanPage(never, { ...options(), ...patch }), {
      status: "unavailable",
    });
  assert.deepEqual(
    await expireFollowUnconfirmedPage(
      never,
      scopeOptions({ kind: "unconfirmed", after: null, through: "1" }),
    ),
    { status: "unavailable" },
  );
  assert.equal(calls, 0);
  assert.deepEqual(await expireFollowUnconfirmedPage(db, scopeOptions()), {
    status: "maintained",
    examined: 0,
    removed: 0,
    complete: true,
    next: null,
  });
  assert.deepEqual(await expireFollowOrphanPage(db, options()), {
    status: "maintained",
    examined: 0,
    tokensRemoved: 0,
    digestsRemoved: 0,
    removed: 0,
    draining: false,
    complete: true,
    next: null,
  });
}

export async function unconfirmedExpiryRequiresTokenDrainAndExactOldCriteria(db) {
  await subscriber(db);
  await scope(db, "first", "stale", "-7 days");
  await scope(db, "first", "fresh", "-6 days");
  await scope(db, "first", "confirmed", "-8 days", true);
  await db
    .prepare(
      "INSERT INTO follow_tokens VALUES('confirm','first','confirm','stale','generation',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),NULL)",
    )
    .run();
  const run = () => expireFollowUnconfirmedPage(db, { enabled: true, maxRows: 128 });
  assert.equal((await run()).removed, 0);
  assert.equal(
    (await expireFollowPage(db, { enabled: true, kind: "tokens", maxRows: 128 })).removed,
    1,
  );
  assert.equal((await run()).removed, 1);
  assert.deepEqual(
    (await rows(db, "follow_subscriptions")).map((r) => r.scope_key),
    ["fresh", "confirmed"],
  );
  assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
}

export async function unconfirmedExpiryBoundedCascadesRedactExactOwnerOnly(db) {
  await subscriber(db);
  await scope(db);
  const id = "11111111-1111-1111-1111-111111111111";
  const expiry = await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') AS at")
    .first("at");
  await db
    .prepare(
      "INSERT INTO follow_scope_progress VALUES('first','company:a','generation',strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'))",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO follow_confirmation_outbox(id,subscriber_id,scope_key,queued_at,expires_at,claim_id) VALUES(?,'first','company:a',strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'claimed')",
    )
    .bind(id, expiry)
    .run();
  const before = await owner(db, "confirmation", id, expiry, "running");
  assert.equal((await expireFollowUnconfirmedPage(db, scopeOptions())).removed, 1);
  for (const table of [
    "follow_subscriptions",
    "follow_scope_progress",
    "follow_confirmation_outbox",
  ])
    assert.equal(await count(db, table), 0);
  if (before)
    assert.deepEqual((await rows(db, "follow_delivery_owner"))[0], {
      ...before,
      confirmation_id: null,
      confirmation_expires_at: null,
    });
  assert.equal(await count(db, "follow_subscribers"), 1);
}

export async function orphanExpiryDrainsChildrenPreservesBudgetAndOwnerGeneration(db) {
  await subscriber(db);
  await children(db, "first", 5);
  const id = "22222222-2222-2222-2222-222222222222";
  const expiry = await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') AS at")
    .first("at");
  await db
    .prepare(
      "INSERT INTO follow_management_outbox(id,subscriber_id,queued_at,expires_at,claim_id) VALUES(?,'first',strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'claimed')",
    )
    .bind(id, expiry)
    .run();
  const before = await owner(db, "management", id, expiry);
  await db.prepare("INSERT INTO follow_digest_days VALUES(?,?)").bind("a".repeat(64), expiry).run();
  await db
    .prepare("INSERT INTO follow_send_budget VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),7)")
    .run();
  const budget = await rows(db, "follow_send_budget"),
    days = await rows(db, "follow_digest_days");
  let result = await expireFollowOrphanPage(db, options());
  assert.equal(result.draining, true);
  assert.equal(result.removed, 0);
  assert.equal(result.tokensRemoved, 2);
  assert.equal(result.digestsRemoved, 2);
  assert.deepEqual(result.next, { kind: "orphans", after: null, through: "1" });
  assert.equal(await count(db, "follow_subscribers"), 1);
  if (before) assert.deepEqual((await rows(db, "follow_delivery_owner"))[0], before);
  result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(result.draining, true);
  result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(result.removed, 1);
  assert.equal(result.complete, true);
  for (const table of [
    "follow_subscribers",
    "follow_tokens",
    "follow_digest_outbox",
    "follow_pending_progress",
    "follow_management_outbox",
  ])
    assert.equal(await count(db, table), 0);
  if (before)
    assert.deepEqual((await rows(db, "follow_delivery_owner"))[0], {
      ...before,
      management_id: null,
      management_expires_at: null,
    });
  assert.deepEqual(await rows(db, "follow_send_budget"), budget);
  assert.deepEqual(await rows(db, "follow_digest_days"), days);
  assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
}

export async function orphanExpiryResumeHandlesRemovedCandidateAndNewScope(db) {
  await subscriber(db, "first", 1);
  await children(db, "first", 3);
  await subscriber(db, "second", 2);
  await children(db, "second", 3);
  let result = await expireFollowOrphanPage(db, options());
  assert.equal(result.draining, true);
  await db.prepare("DELETE FROM follow_subscribers WHERE id='first'").run();
  result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(result.draining, true);
  assert.equal(result.tokensRemoved, 2);
  await scope(db, "second");
  const tokens = await rows(db, "follow_tokens"),
    jobs = await rows(db, "follow_digest_outbox");
  result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(result.removed, 0);
  assert.equal(result.complete, true);
  assert.deepEqual(await rows(db, "follow_tokens"), tokens);
  assert.deepEqual(await rows(db, "follow_digest_outbox"), jobs);
  assert.equal(await count(db, "follow_subscribers"), 1);
  assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
}

export async function orphanExpiryRechecksScopeBeforeEveryMutation(db) {
  await subscriber(db);
  await children(db, "first", 3);
  const guarded = wrap(db, async (statements) => {
    // Interleave inside one synthetic batch after eligibility, before the first DELETE.
    const result = await db.batch([
      ...statements.slice(0, 3),
      db.prepare(
        "INSERT INTO follow_subscriptions VALUES('first','new',strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL)",
      ),
      ...statements.slice(3),
    ]);
    result.splice(3, 1);
    return result;
  });
  const result = await expireFollowOrphanPage(guarded, options());
  assert.equal(result.status, "maintained");
  assert.equal(result.draining, true);
  assert.equal(result.tokensRemoved, 0);
  assert.equal(result.digestsRemoved, 0);
  assert.equal(result.removed, 0);
  assert.equal(await count(db, "follow_tokens"), 3);
  assert.equal(await count(db, "follow_digest_outbox"), 3);
  assert.equal((await expireFollowOrphanPage(db, options(result.next))).complete, true);
}

export async function orphanExpiryResetSeesRecycledAndAppendedSignedRowids(db) {
  await subscriber(db, "first", "-9223372036854775808");
  await scope(db);
  await subscriber(db, "second", 0);
  await subscriber(db, "third", "9223372036854775807");
  let result = await expireFollowOrphanPage(db, options());
  assert.equal(result.next.after, "-9223372036854775808");
  await subscriber(db, "behind", -1);
  result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(result.removed, 1);
  // Reuse the removed key: it is intentionally behind this pass's cursor.
  await subscriber(db, "recycled", -1);
  while (!result.complete) result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(await count(db, "follow_subscribers"), 2);
  result = await expireFollowOrphanPage(db, options());
  while (!result.complete) result = await expireFollowOrphanPage(db, options(result.next));
  assert.deepEqual(
    (await rows(db, "follow_subscribers")).map((r) => r.id),
    ["first"],
  );
  // A newly appended key beyond a captured ceiling waits for an explicit reset.
  await subscriber(db, "last", 1);
  result = await expireFollowOrphanPage(db, options());
  await subscriber(db, "appended", 2);
  while (!result.complete) result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(await count(db, "follow_subscribers"), 2);
  result = await expireFollowOrphanPage(db, options());
  while (!result.complete) result = await expireFollowOrphanPage(db, options(result.next));
  assert.equal(await count(db, "follow_subscribers"), 1);
}

export async function orphanExpiryLostAcknowledgementAndRollbackNeverRetry(db) {
  await subscriber(db);
  await children(db, "first", 3);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_expiry_abort BEFORE DELETE ON follow_digest_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    )
    .run();
  assert.deepEqual(await expireFollowOrphanPage(db, options()), { status: "unavailable" });
  assert.equal(await count(db, "follow_tokens"), 3);
  assert.equal(await count(db, "follow_digest_outbox"), 3);
  await db.prepare("DROP TRIGGER synthetic_expiry_abort").run();
  let calls = 0;
  assert.deepEqual(
    await expireFollowOrphanPage(
      wrap(db, async (statements) => {
        calls++;
        await db.batch(statements);
        throw Error("synthetic lost acknowledgement");
      }),
      options(),
    ),
    { status: "unavailable" },
  );
  assert.equal(calls, 1);
  assert.equal(await count(db, "follow_tokens"), 1);
  assert.equal(await count(db, "follow_subscribers"), 1);
  assert.equal((await expireFollowOrphanPage(db, options())).removed, 1);
}

export async function subscriberExpiryRejectsMalformedAndUnstableReceipts(db) {
  await subscriber(db);
  await scope(db, "first", "keep", "-1 day");
  const faults = [
    (r) => {
      r[0].success = false;
    },
    (r) => {
      delete r[1];
    },
    (r) => {
      r[1].results[0].examined = 0;
      r[1].results[0].last = null;
    },
    (r) => {
      r[7].meta.changes = -1;
    },
    (r) => {
      Object.defineProperty(r[1].results[0], "last", {
        enumerable: true,
        get() {
          throw Error();
        },
      });
    },
  ];
  for (const fault of faults) {
    let calls = 0;
    assert.deepEqual(
      await expireFollowOrphanPage(
        wrap(db, async (statements) => {
          calls++;
          const r = await db.batch(statements);
          fault(r);
          return r;
        }),
        options(),
      ),
      { status: "unavailable" },
    );
    assert.equal(calls, 1);
  }
  const result = await expireFollowOrphanPage(
    wrap(db, async (statements) => {
      const r = await db.batch(statements),
        original = r[1].results[0];
      r[1].results[0] = new Proxy(original, {
        get(t, k) {
          return k === "last" ? "2" : Reflect.get(t, k);
        },
      });
      return r;
    }),
    options(),
  );
  assert.equal(result.status, "maintained");
  assert.equal(result.complete, true);
}

export async function orphanExpiryTwentyThousandUnrelatedRowsUseBoundedIndexes(db) {
  await subscriber(db, "first", 1);
  await children(db, "first", 7);
  await subscriber(db, "second", 2);
  await children(db, "second", 7);
  await subscriber(db, "unrelated", 3);
  await scope(db, "unrelated");
  await db
    .prepare(
      `WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20000)
    INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at)
    SELECT 'unrelated-'||v,'unrelated','unsubscribe','','synthetic',NULL FROM n`,
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20000)
    INSERT INTO follow_digest_outbox(id,subscriber_id,day,payload,created,expires_at,state)
    SELECT 'unrelated-'||v,'unrelated',CAST(v AS TEXT),'[]','2026-01-01','2027-01-01','queued' FROM n`,
    )
    .run();
  const metrics = [];
  const measured = wrap(db, async (statements) => {
    const r = await db.batch(statements);
    if (typeof r[0].meta.rows_read === "number")
      metrics.push({
        reads: r.reduce((n, v) => n + v.meta.rows_read, 0),
        writes: r.reduce((n, v) => n + v.meta.rows_written, 0),
        duration: r.reduce((n, v) => n + v.meta.duration, 0),
      });
    return r;
  });
  let result = await expireFollowOrphanPage(measured, { ...options(), maxChildren: 7 });
  assert.equal(result.removed, 1);
  result = await expireFollowOrphanPage(measured, { ...options(result.next), maxChildren: 7 });
  assert.equal(result.removed, 1);
  assert.ok(
    metrics.every((m) => m.reads < 500),
    JSON.stringify(metrics),
  );
  for (const [table, index, order] of [
    ["follow_tokens", "follow_tokens_subscriber", "purpose,scope_key,rowid"],
    ["follow_digest_outbox", "sqlite_autoindex_follow_digest_outbox_2", "day,rowid"],
  ]) {
    const plan = (
      await db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT rowid FROM ${table} INDEXED BY ${index} WHERE subscriber_id=? ORDER BY ${order} LIMIT 7`,
        )
        .bind("first")
        .all()
    ).results
      .map((r) => r.detail)
      .join("; ");
    assert.match(plan, /SEARCH .*COVERING INDEX/);
    assert.doesNotMatch(plan, /TEMP B-TREE|SCAN /);
    assert.equal(await count(db, table), 20000);
  }
  for (const seek of [
    "rowid<=(SELECT max(rowid) FROM follow_subscribers)",
    "rowid>1 AND rowid<=3",
  ]) {
    const plan = (
      await db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT rowid FROM follow_subscribers WHERE ${seek} AND NOT EXISTS(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=follow_subscribers.id) ORDER BY rowid LIMIT 1`,
        )
        .all()
    ).results
      .map((r) => r.detail)
      .join("; ");
    assert.match(plan, /INTEGER PRIMARY KEY/);
    assert.match(plan, /SEARCH s USING COVERING INDEX/);
    assert.doesNotMatch(plan, /TEMP B-TREE|SCAN /);
  }
  if (metrics.length)
    console.log("synthetic orphan retention native metrics", JSON.stringify(metrics));
  return metrics;
}

export async function orphanExpiryMaximumChildrenBoundsCascadeAndKeepsMismatchedOwner(db) {
  await subscriber(db);
  await children(db, "first", 129);
  await db
    .prepare(
      "INSERT INTO follow_request_deletions SELECT printf('%064x',rowid),token_hash FROM follow_tokens",
    )
    .run();
  const id = "33333333-3333-3333-3333-333333333333";
  await db
    .prepare(
      "INSERT INTO follow_management_outbox(id,subscriber_id,queued_at,expires_at,claim_id) VALUES(?,'first',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),'claimed')",
    )
    .bind(id)
    .run();
  const otherExpiry = await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 days') AS at")
    .first("at");
  const before = await owner(db, "management", id, otherExpiry);
  const metrics = [];
  const measured = wrap(db, async (statements) => {
    const r = await db.batch(statements);
    metrics.push(
      r.map((v) => ({
        reads: v.meta.rows_read,
        writes: v.meta.rows_written,
        changes: v.meta.changes,
        duration: v.meta.duration,
      })),
    );
    return r;
  });
  const start = performance.now();
  let result = await expireFollowOrphanPage(measured, { ...options(), maxChildren: 128 });
  assert.equal(result.status, "maintained");
  assert.equal(result.draining, true);
  assert.equal(result.tokensRemoved, 128);
  assert.equal(result.digestsRemoved, 128);
  for (const table of [
    "follow_subscribers",
    "follow_tokens",
    "follow_request_deletions",
    "follow_digest_outbox",
    "follow_pending_progress",
    "follow_management_outbox",
  ])
    assert.equal(await count(db, table), 1);
  result = await expireFollowOrphanPage(measured, { ...options(result.next), maxChildren: 128 });
  const elapsedMs = performance.now() - start;
  assert.equal(result.removed, 1);
  assert.equal(result.complete, true);
  for (const table of [
    "follow_subscribers",
    "follow_tokens",
    "follow_request_deletions",
    "follow_digest_outbox",
    "follow_pending_progress",
    "follow_management_outbox",
  ])
    assert.equal(await count(db, table), 0);
  if (before) assert.deepEqual((await rows(db, "follow_delivery_owner"))[0], before);
  if (typeof metrics[0][0].reads === "number") {
    assert.ok(metrics[0].reduce((n, m) => n + m.reads, 0) < 6000, JSON.stringify(metrics));
    console.log("synthetic maximum orphan retention", JSON.stringify({ metrics, elapsedMs }));
  }
  return { metrics, elapsedMs };
}

export async function unconfirmedExpiryMaximumPageBoundsCascadeAndIndexedWork(db) {
  await subscriber(db);
  await db
    .prepare(
      `WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20000)
    INSERT INTO follow_subscriptions SELECT 'first',CAST(v AS TEXT),strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'),NULL,NULL FROM n`,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO follow_scope_progress SELECT subscriber_id,scope_key,'generation-'||scope_key,created FROM follow_subscriptions WHERE rowid<=128",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO follow_confirmation_outbox(id,subscriber_id,scope_key,queued_at,expires_at,claim_id) SELECT printf('%036d',rowid),subscriber_id,scope_key,created,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),'claimed' FROM follow_subscriptions WHERE rowid<=128",
    )
    .run();
  const expiry = await db
    .prepare("SELECT expires_at FROM follow_confirmation_outbox WHERE id=?")
    .bind("1".padStart(36, "0"))
    .first("expires_at");
  const before = await owner(db, "confirmation", "1".padStart(36, "0"), expiry);
  const metrics = [];
  const measured = wrap(db, async (statements) => {
    const r = await db.batch(statements);
    if (typeof r[0].meta.rows_read === "number")
      metrics.push({
        reads: r.reduce((n, v) => n + v.meta.rows_read, 0),
        writes: r.reduce((n, v) => n + v.meta.rows_written, 0),
        duration: r.reduce((n, v) => n + v.meta.duration, 0),
      });
    return r;
  });
  let result = await expireFollowUnconfirmedPage(measured, { enabled: true, maxRows: 128 });
  assert.equal(result.removed, 128);
  assert.equal(result.complete, false);
  result = await expireFollowUnconfirmedPage(measured, {
    enabled: true,
    maxRows: 128,
    cursor: result.next,
  });
  assert.equal(result.removed, 128);
  assert.equal(await count(db, "follow_subscriptions"), 19744);
  assert.equal(await count(db, "follow_scope_progress"), 0);
  assert.equal(await count(db, "follow_confirmation_outbox"), 0);
  if (before)
    assert.deepEqual((await rows(db, "follow_delivery_owner"))[0], {
      ...before,
      confirmation_id: null,
      confirmation_expires_at: null,
    });
  assert.ok(
    metrics.every((m) => m.reads < 5000),
    JSON.stringify(metrics),
  );
  const plan = (
    await db
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM follow_subscriptions NOT INDEXED
    WHERE rowid IN(SELECT rowid FROM follow_subscriptions WHERE rowid>256 AND rowid<=20000 ORDER BY rowid LIMIT 128)
    AND confirmed_at IS NULL AND created<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
    AND NOT EXISTS(SELECT 1 FROM follow_tokens t WHERE t.subscriber_id=follow_subscriptions.subscriber_id AND t.purpose='confirm' AND t.scope_key=follow_subscriptions.scope_key)`,
      )
      .all()
  ).results
    .map((r) => r.detail)
    .join("; ");
  assert.match(plan, /INTEGER PRIMARY KEY/);
  assert.match(plan, /SEARCH t USING COVERING INDEX follow_tokens_subscriber/);
  assert.doesNotMatch(plan, /SCAN follow_|TEMP B-TREE/);
  if (metrics.length)
    console.log("synthetic maximum unconfirmed retention", JSON.stringify(metrics));
  return metrics;
}

async function lookaheadFixture(db, total = 20000) {
  await db
    .prepare(
      `WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO follow_subscribers(rowid,id,email,created) SELECT v,'scan-'||v,'scan-'||v||'@example.test','2026-01-01' FROM n`,
    )
    .bind(total)
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions SELECT id,'keep','2026-01-01','2026-01-01',NULL FROM follow_subscribers WHERE rowid NOT IN(300,400)",
    )
    .run();
}

export async function orphanLookaheadReachesLateCandidateWithoutSkippingNext(db) {
  await lookaheadFixture(db);
  const metrics = [],
    plans = [];
  const measured = {
    prepare(sql) {
      // Explain the exact scalar candidate used by all three mutations before execution.
      if (sql.includes("WITH scan AS MATERIALIZED")) plans.push(sql);
      return db.prepare(sql);
    },
    async batch(statements) {
      const r = await db.batch(statements);
      if (typeof r[0].meta.rows_read === "number")
        metrics.push({
          reads: r.reduce((n, v) => n + v.meta.rows_read, 0),
          writes: r.reduce((n, v) => n + v.meta.rows_written, 0),
          duration: r.reduce((n, v) => n + v.meta.duration, 0),
        });
      return r;
    },
  };
  const run = (cursor) => expireFollowOrphanPage(measured, { ...options(cursor), maxRows: 128 });
  let r = await run(null);
  assert.equal(r.examined, 128);
  assert.equal(r.removed, 0);
  assert.equal(r.next.after, "128");
  r = await run(r.next);
  assert.equal(r.next.after, "256");
  assert.equal(r.removed, 0);
  r = await run(r.next);
  assert.equal(r.examined, 128);
  assert.equal(r.removed, 1);
  assert.equal(r.next.after, "300");
  assert.equal(
    await db.prepare("SELECT count(*) AS n FROM follow_subscribers WHERE rowid=400").first("n"),
    1,
  );
  r = await run(r.next);
  assert.equal(r.removed, 1);
  assert.equal(r.next.after, "400");
  assert.equal(await count(db, "follow_subscribers"), 19998);
  assert.ok(
    metrics.every((m) => m.reads < 5000),
    JSON.stringify(metrics),
  );
  const summary = plans.find((sql) => sql.includes("AS eligible"));
  const plan = (
    await db
      .prepare("EXPLAIN QUERY PLAN " + summary)
      .bind(128)
      .all()
  ).results
    .map((r) => r.detail)
    .join("; ");
  assert.match(plan, /MATERIALIZE scan/);
  assert.match(plan, /INTEGER PRIMARY KEY/);
  assert.match(plan, /SEARCH s USING COVERING INDEX sqlite_autoindex_follow_subscriptions_1/);
  assert.doesNotMatch(plan, /SCAN follow_|TEMP B-TREE/);
  if (metrics.length) console.log("synthetic orphan lookahead", JSON.stringify(metrics));
  return metrics;
}

export async function orphanLookaheadRepeatsExactCandidateAfterPartialDrain(db) {
  await lookaheadFixture(db, 450);
  await children(db, "scan-300", 3);
  let cursor = { kind: "orphans", after: "256", through: "450" };
  let r = await expireFollowOrphanPage(db, { ...options(cursor), maxRows: 128 });
  assert.equal(r.draining, true);
  assert.equal(r.next.after, "256");
  assert.equal(r.next.through, "450");
  assert.equal(r.removed, 0);
  assert.equal(r.tokensRemoved, 2);
  assert.equal(r.digestsRemoved, 2);
  cursor = r.next;
  r = await expireFollowOrphanPage(db, { ...options(cursor), maxRows: 128 });
  assert.equal(r.removed, 1);
  assert.equal(r.next.after, "300");
  assert.equal(
    await db.prepare("SELECT count(*) AS n FROM follow_subscribers WHERE id='scan-400'").first("n"),
    1,
  );
  assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
}

export async function orphanLookaheadRemovedReaddedCandidateAndNewScopeRemainSafe(db) {
  await lookaheadFixture(db, 450);
  await children(db, "scan-300", 3);
  let r = await expireFollowOrphanPage(db, {
    ...options({ kind: "orphans", after: "256", through: "450" }),
    maxRows: 128,
  });
  assert.equal(r.next.after, "256");
  await db.prepare("DELETE FROM follow_subscribers WHERE id='scan-300'").run();
  await subscriber(db, "replacement", 300);
  await scope(db, "replacement");
  await children(db, "replacement", 1);
  r = await expireFollowOrphanPage(db, { ...options(r.next), maxRows: 128 });
  assert.equal(r.removed, 0);
  assert.equal(r.next.after, "384");
  r = await expireFollowOrphanPage(db, { ...options(r.next), maxRows: 128 });
  assert.equal(r.removed, 1);
  assert.equal(r.next.after, "400");
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM follow_subscribers WHERE id='replacement'")
      .first("n"),
    1,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM follow_tokens WHERE subscriber_id='replacement'")
      .first("n"),
    1,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM follow_digest_outbox WHERE subscriber_id='replacement'")
      .first("n"),
    1,
  );
  assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
}

export async function orphanLookaheadNoOrphanAndSignedEndpointReset(db) {
  await subscriber(db, "first", "-9223372036854775808");
  await scope(db);
  await subscriber(db, "second", 0);
  await scope(db, "second");
  let r = await expireFollowOrphanPage(db, { ...options(), maxRows: 2 });
  assert.equal(r.complete, true);
  assert.equal(r.removed, 0);
  await subscriber(db, "last", "9223372036854775807");
  await children(db, "last", 3);
  r = await expireFollowOrphanPage(db, { ...options(), maxRows: 128 });
  assert.equal(r.draining, true);
  assert.equal(r.next.after, null);
  assert.equal(r.next.through, "9223372036854775807");
  await db.prepare("DELETE FROM follow_subscribers WHERE id='first'").run();
  r = await expireFollowOrphanPage(db, { ...options(r.next), maxRows: 128 });
  assert.equal(r.removed, 1);
  assert.equal(r.complete, true);
  await subscriber(db, "reused", "-9223372036854775808");
  r = await expireFollowOrphanPage(db, { ...options(), maxRows: 128 });
  assert.equal(r.removed, 1);
  assert.equal(r.next.after, "-9223372036854775808");
  r = await expireFollowOrphanPage(db, { ...options(r.next), maxRows: 128 });
  assert.equal(r.complete, true);
  assert.equal(r.removed, 0);
}

export async function orphanLookaheadMalformedCandidateReceiptsNeverCertifyAdvance(db) {
  await lookaheadFixture(db, 450);
  const faults = [
    (r) => {
      r[2].results[0].candidate = "451";
    },
    (r) => {
      r[2].results[0].previous = "301";
    },
    (r) => {
      r[2].results[0].candidate = null;
    },
    (r) => {
      r[2].results[0].eligible = 0;
    },
    (r) => {
      delete r[2].results[0].previous;
    },
  ];
  for (const fault of faults) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO follow_subscribers(rowid,id,email,created) VALUES(300,'scan-300','scan-300@example.test','2026-01-01')",
      )
      .run();
    let calls = 0;
    const r = await expireFollowOrphanPage(
      wrap(db, async (statements) => {
        calls++;
        const result = await db.batch(statements);
        fault(result);
        return result;
      }),
      { ...options({ kind: "orphans", after: "256", through: "450" }), maxRows: 128 },
    );
    assert.deepEqual(r, { status: "unavailable" });
    assert.equal(calls, 1);
  }
  await db
    .prepare(
      "INSERT INTO follow_subscribers(rowid,id,email,created) VALUES(300,'scan-300','scan-300@example.test','2026-01-01')",
    )
    .run();
  await children(db, "scan-300", 3);
  const r = await expireFollowOrphanPage(
    wrap(db, async (statements) => {
      const result = await db.batch(statements);
      result[2].results[0] = new Proxy(result[2].results[0], {
        get(target, key) {
          return key === "previous" ? "399" : Reflect.get(target, key);
        },
      });
      return result;
    }),
    { ...options({ kind: "orphans", after: "256", through: "450" }), maxRows: 128 },
  );
  assert.equal(r.draining, true);
  assert.equal(r.next.after, "256");
}

export async function orphanLookaheadCommitLossReturnsNoCursorAndNoRetry(db) {
  await lookaheadFixture(db, 450);
  await children(db, "scan-300", 3);
  let calls = 0;
  const r = await expireFollowOrphanPage(
    wrap(db, async (statements) => {
      calls++;
      await db.batch(statements);
      throw Error("synthetic acknowledgement loss");
    }),
    { ...options({ kind: "orphans", after: "256", through: "450" }), maxRows: 128 },
  );
  assert.deepEqual(r, { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM follow_tokens WHERE subscriber_id='scan-300'")
      .first("n"),
    1,
  );
  assert.equal(
    await db.prepare("SELECT count(*) AS n FROM follow_subscribers WHERE id='scan-400'").first("n"),
    1,
  );
  const reset = await expireFollowOrphanPage(db, { ...options(), maxRows: 128 });
  assert.equal(reset.removed, 0);
  assert.equal(reset.next.after, "128");
}

export async function orphanLookaheadMaximumPageAndChildrenKeepFirstCandidate(db) {
  await lookaheadFixture(db, 450);
  await db.prepare("DELETE FROM follow_subscriptions WHERE subscriber_id='scan-1'").run();
  await children(db, "scan-1", 129);
  await db
    .prepare(
      "INSERT INTO follow_request_deletions SELECT printf('%064x',rowid),token_hash FROM follow_tokens",
    )
    .run();
  const metrics = [];
  const measured = wrap(db, async (statements) => {
    const r = await db.batch(statements);
    if (typeof r[0].meta.rows_read === "number")
      metrics.push({
        reads: r.reduce((n, v) => n + v.meta.rows_read, 0),
        writes: r.reduce((n, v) => n + v.meta.rows_written, 0),
        duration: r.reduce((n, v) => n + v.meta.duration, 0),
      });
    return r;
  });
  let r = await expireFollowOrphanPage(measured, { ...options(), maxRows: 128, maxChildren: 128 });
  assert.equal(r.draining, true);
  assert.equal(r.next.after, null);
  assert.equal(r.tokensRemoved, 128);
  assert.equal(r.digestsRemoved, 128);
  r = await expireFollowOrphanPage(measured, {
    ...options(r.next),
    maxRows: 128,
    maxChildren: 128,
  });
  assert.equal(r.removed, 1);
  assert.equal(r.next.after, "1");
  assert.equal(
    await db.prepare("SELECT count(*) AS n FROM follow_subscribers WHERE id='scan-300'").first("n"),
    1,
  );
  assert.ok(
    metrics.every((m) => m.reads < 5000),
    JSON.stringify(metrics),
  );
  if (metrics.length) console.log("synthetic maximum orphan lookahead", JSON.stringify(metrics));
  return metrics;
}

export async function orphanLookaheadBindsRemovedRootAgainstCandidateSubstitution(db) {
  await subscriber(db, "first", 100);
  await subscriber(db, "second", 200);
  let calls = 0;
  const r = await expireFollowOrphanPage(
    wrap(db, async (statements) => {
      calls++;
      const result = await db.batch(statements);
      assert.deepEqual(result[7].results, [{ removed_rowid: "100" }]);
      result[2].results[0].candidate = "200";
      result[2].results[0].previous = "100";
      return result;
    }),
    { ...options(), maxRows: 128 },
  );
  assert.deepEqual(r, { status: "unavailable" });
  assert.equal(calls, 1);
  assert.deepEqual(
    (await rows(db, "follow_subscribers")).map((r) => r.id),
    ["second"],
  );
}

export async function orphanLookaheadRejectsSurvivingRootAfterBothPrefixesDrained(db) {
  await subscriber(db, "first", 9);
  await scope(db);
  let calls = 0;
  const zero = await expireFollowOrphanPage(
    wrap(db, async (statements) => {
      calls++;
      const result = await db.batch(statements);
      result[2].results[0] = { eligible: 1, candidate: "9", previous: null };
      return result;
    }),
    { ...options(), maxRows: 128 },
  );
  assert.deepEqual(zero, { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal(await count(db, "follow_subscribers"), 1);
  await db.prepare("DELETE FROM follow_subscriptions").run();
  await children(db, "first", 1);
  calls = 0;
  const positive = await expireFollowOrphanPage(
    wrap(db, async (statements) => {
      calls++;
      const result = await db.batch(statements);
      assert.equal(result[4].results[0].changed, 1);
      assert.equal(result[6].results[0].changed, 1);
      assert.deepEqual(result[7].results, [{ removed_rowid: "9" }]);
      result[7] = { success: true, meta: { changes: 0 }, results: [] };
      result[8].results[0].changed = 0;
      return result;
    }),
    { ...options(), maxRows: 128 },
  );
  assert.deepEqual(positive, { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal(await count(db, "follow_subscribers"), 0);
}

export async function orphanLookaheadImpossibleCardinalityNeverAdvancesDrainage(db) {
  await subscriber(db, "first", 9);
  await children(db, "first", 6);
  await subscriber(db, "second", 10);
  await scope(db, "second");
  const faults = [
    (result) => {
      result[1].results[0].examined = 1;
    },
    (result) => {
      result[1].results[0].examined = 1;
      result[2].results[0].candidate = "10";
      result[2].results[0].previous = "9";
    },
    (result) => {
      result[2].results[0].candidate = "10";
    },
    (result) => {
      result[2].results[0].previous = "8";
    },
  ];
  for (const fault of faults) {
    let calls = 0;
    const r = await expireFollowOrphanPage(
      wrap(db, async (statements) => {
        calls++;
        const result = await db.batch(statements);
        fault(result);
        return result;
      }),
      { ...options(), maxRows: 128, maxChildren: 1 },
    );
    assert.deepEqual(r, { status: "unavailable" });
    assert.equal(calls, 1);
  }
  assert.equal(await count(db, "follow_subscribers"), 2);
  // Even a plausible substituted selector cannot move the draining cursor forward.
  const r = await expireFollowOrphanPage(
    wrap(db, async (statements) => {
      const result = await db.batch(statements);
      result[2].results[0].candidate = "10";
      result[2].results[0].previous = "9";
      return result;
    }),
    { ...options(), maxRows: 128, maxChildren: 1 },
  );
  assert.equal(r.draining, true);
  assert.equal(r.next.after, null);
  assert.equal(r.complete, false);
  assert.equal(await count(db, "follow_subscribers"), 2);
  const reset = await expireFollowOrphanPage(db, { ...options(), maxRows: 128 });
  assert.equal(reset.removed, 1);
  assert.equal(reset.next.after, "9");
  assert.deepEqual(
    (await rows(db, "follow_subscribers")).map((r) => r.id),
    ["second"],
  );
}
