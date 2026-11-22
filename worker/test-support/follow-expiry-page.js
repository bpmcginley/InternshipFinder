import assert from "node:assert/strict";
import { expireFollowPage } from "../src/follow-expiry-page.js";
import {
  acquireFollowDeliveryOwner,
  finishFollowDeliveryOwner,
} from "../src/follow-delivery-owner.js";
const stamp = (offset) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','${offset}')`;
const opts = (kind, maxRows = 2, cursor = null) => ({
  enabled: true,
  kind,
  maxRows,
  cursor: typeof cursor === "string" ? { kind, after: cursor, through: "20000" } : cursor,
});
const total = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).first("n");
async function seed(db, id = "fixture") {
  await db
    .prepare(`INSERT INTO follow_subscribers(id,email,created) VALUES(?,?,${stamp("-9 days")})`)
    .bind(id, `${id}@example.test`)
    .run();
  await db
    .prepare(
      `INSERT INTO follow_subscriptions(subscriber_id,scope_key,created) VALUES(?,'company:fixture',${stamp("-9 days")})`,
    )
    .bind(id)
    .run();
}
async function job(db, id, row, expires = "-1 second", claim = null, subscriber = "fixture") {
  await db
    .prepare(
      `INSERT INTO follow_confirmation_outbox(rowid,id,subscriber_id,scope_key,queued_at,expires_at,claim_id,owner_user_hash)
    VALUES(?,?,?,'company:fixture',${stamp("-2 days")},${stamp(expires)},?,?)`,
    )
    .bind(row, id, subscriber, claim, "a".repeat(64))
    .run();
}
async function token(db, purpose = "confirm", expires = "-1 second", id = "token") {
  await db
    .prepare(
      `INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at,owner_user_hash)
    VALUES(?,'fixture',?,?,'generation',${expires === null ? "NULL" : stamp(expires)},?)`,
    )
    .bind(
      id,
      purpose,
      purpose === "confirm" ? "company:fixture" : "",
      purpose === "confirm" ? "a".repeat(64) : null,
    )
    .run();
}
async function setOwner(db, phase, id, expiry) {
  await db
    .prepare("UPDATE follow_delivery_owner SET phase=?,confirmation_id=?,confirmation_expires_at=?")
    .bind(phase, id, expiry)
    .run();
}

export async function expiryPageDisabledAndInvalidNeverRead(db) {
  let io = 0;
  const forbidden = {
    prepare() {
      io++;
      throw Error();
    },
  };
  assert.deepEqual(await expireFollowPage(forbidden), { status: "disabled" });
  for (const patch of [
    { kind: "__proto__" },
    { maxRows: 0 },
    { maxRows: 129 },
    { cursor: { kind: "tokens", after: "01", through: "2" } },
    { cursor: { kind: "tokens", after: "0", through: "9223372036854775808" } },
    { cursor: { kind: "tokens", after: 1, through: "2" } },
    { cursor: { kind: "confirmation", after: "0", through: "2" } },
  ]) {
    assert.deepEqual(await expireFollowPage(forbidden, { ...opts("tokens"), ...patch }), {
      status: "unavailable",
    });
  }
  assert.equal(io, 0);
  assert.deepEqual(await expireFollowPage(db, opts("tokens")), {
    status: "maintained",
    examined: 0,
    removed: 0,
    complete: true,
    next: null,
  });
}

export async function expiryPageNativeSeekAndBacklog(db) {
  await db
    .prepare(
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20000)
    INSERT INTO follow_subscribers(id,email,created) SELECT printf('page-%05d',v),printf('page-%05d@example.test',v),${stamp("-1 day")} FROM n`,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions(subscriber_id,scope_key,created) SELECT id,'company:fixture',created FROM follow_subscribers",
    )
    .run();
  await db
    .prepare(
      `INSERT INTO follow_confirmation_outbox(id,subscriber_id,scope_key,queued_at,expires_at,claim_id)
    SELECT u.id,s.subscriber_id,s.scope_key,s.created,${stamp("-1 second")},'claimed' FROM follow_subscriptions s JOIN follow_subscribers u ON u.id=s.subscriber_id`,
    )
    .run();
  const queries = [],
    receipts = [];
  const measured = {
    prepare(sql) {
      queries.push(sql);
      return db.prepare(sql);
    },
    async batch(s) {
      const r = await db.batch(s);
      receipts.push(r);
      return r;
    },
  };
  const result = await expireFollowPage(measured, opts("confirmation", 7, "10000"));
  assert.deepEqual(result, {
    status: "maintained",
    examined: 7,
    removed: 7,
    complete: false,
    next: { kind: "confirmation", after: "10007", through: "20000" },
  });
  for (const sql of queries.slice(1, 3)) {
    const plan = (
      await db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .bind("10000", "20000", 7)
        .all()
    ).results
      .map((r) => r.detail)
      .join("; ");
    assert.match(plan, /INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    assert.doesNotMatch(plan, /SCAN follow_confirmation_outbox|TEMP B-TREE/);
  }
  assert.equal(await total(db, "follow_confirmation_outbox"), 19993);
  if (receipts[0][2].meta.rows_read !== undefined) assert.ok(receipts[0][2].meta.rows_read < 100);
  assert.ok(receipts[0][2].meta.changes <= 14);
  await db
    .prepare(
      `INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at)
    SELECT id,id,'confirm','company:fixture','fixture',${stamp("+1 day")} FROM follow_subscribers`,
    )
    .run();
  for (const kind of ["confirmation", "tokens"]) {
    for (const after of [null, "10007"]) {
      queries.length = receipts.length = 0;
      const r = await expireFollowPage(measured, opts(kind, 7, after));
      assert.equal(r.examined, 7);
      assert.equal(r.removed, kind === "tokens" ? 0 : 7);
      const args = after === null ? [7] : [after, "20000", 7];
      for (const sql of queries.slice(1, 3)) {
        const plan = (
          await db
            .prepare("EXPLAIN QUERY PLAN " + sql)
            .bind(...args)
            .all()
        ).results
          .map((v) => v.detail)
          .join("; ");
        assert.doesNotMatch(plan, /TEMP B-TREE/);
        if (after !== null) assert.match(plan, /INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
        if (kind === "tokens" && sql.startsWith("DELETE")) {
          assert.match(plan, /SEARCH s USING INDEX sqlite_autoindex_follow_subscriptions_1/);
          assert.doesNotMatch(plan, /SCAN s\b/);
        }
      }
      if (after === null && receipts[0][0].meta.rows_read !== undefined)
        assert.ok(receipts[0][0].meta.rows_read <= 2);
      for (const receipt of receipts[0])
        if (receipt.meta.rows_read !== undefined) {
          assert.ok(receipt.meta.rows_read < 100, `${kind}: ${receipt.meta.rows_read}`);
        }
    }
  }
}

export async function expiryPageResetsAndRevisitsRowsInsertedBehindCursor(db) {
  await seed(db);
  await job(db, "live", 4, "+1 day");
  await seed(db, "tail");
  await job(db, "tail", 6, "+1 day", null, "tail");
  const first = await expireFollowPage(db, opts("confirmation", 1));
  assert.deepEqual(first.next, { kind: "confirmation", after: "4", through: "6" });
  await db.prepare("DELETE FROM follow_confirmation_outbox").run();
  await job(db, "replacement", 2);
  await job(db, "appended", 8, "-1 second", null, "tail");
  assert.deepEqual(await expireFollowPage(db, opts("confirmation", 1, first.next)), {
    status: "maintained",
    examined: 0,
    removed: 0,
    complete: true,
    next: null,
  });
  assert.equal(await total(db, "follow_confirmation_outbox"), 2);
  const reset = await expireFollowPage(db, opts("confirmation", 2));
  assert.equal(reset.removed, 2);
  assert.equal(reset.complete, true);
  assert.equal(await total(db, "follow_subscribers"), 2);
}

export async function expiryPageTokenCascadesPreserveHeldOwnerAndOtherState(db) {
  await seed(db);
  const id = crypto.randomUUID();
  await job(db, id, 1, "-1 second", "in-flight");
  const q = await db.prepare("SELECT * FROM follow_confirmation_outbox").first();
  await token(db);
  // Exact expiry association is required by the existing consumed-link trigger.
  await db
    .prepare("UPDATE follow_tokens SET expires_at=? WHERE token_hash='token'")
    .bind(q.expires_at)
    .run();
  await db
    .prepare("INSERT INTO follow_request_deletions VALUES(?, 'token')")
    .bind("b".repeat(64))
    .run();
  await token(db, "unsubscribe", null, "unsub");
  await token(db, "manage", "+1 day", "manage");
  await setOwner(db, "held", id, q.expires_at);
  const before = await db.prepare("SELECT * FROM follow_delivery_owner").first();
  let receipt;
  const measured = {
    prepare: (s) => db.prepare(s),
    async batch(s) {
      const r = await db.batch(s);
      receipt = r;
      return r;
    },
  };
  const result = await expireFollowPage(measured, opts("tokens", 4));
  assert.equal(result.removed, 1);
  assert.equal(receipt[2].meta.changes, receipt[2].meta.rows_written === undefined ? 1 : 4);
  assert.equal(await total(db, "follow_request_deletions"), 0);
  assert.equal(await total(db, "follow_confirmation_outbox"), 0);
  assert.equal(await total(db, "follow_tokens"), 2);
  assert.deepEqual(await db.prepare("SELECT * FROM follow_delivery_owner").first(), {
    ...before,
    confirmation_id: null,
    confirmation_expires_at: null,
  });
  assert.equal(await total(db, "follow_subscriptions"), 1);
  assert.equal(await total(db, "follow_send_budget"), 0);
}

export async function expiryPageOriginalSevenDayRuleAndReplacedCursor(db) {
  await seed(db);
  await token(db, "confirm", "+2 days");
  const id = crypto.randomUUID();
  await job(db, id, 1, "+1 day", "in-flight");
  const expiry = await db
    .prepare("SELECT expires_at FROM follow_confirmation_outbox")
    .first("expires_at");
  await setOwner(db, "running", id, expiry);
  const before = await db.prepare("SELECT * FROM follow_delivery_owner").first();
  assert.equal((await expireFollowPage(db, opts("tokens"))).removed, 1);
  // Different token/job expiry must not erase the live replacement or its owner reference.
  assert.equal(await total(db, "follow_confirmation_outbox"), 1);
  assert.deepEqual(await db.prepare("SELECT * FROM follow_delivery_owner").first(), before);
  await db.prepare(`UPDATE follow_confirmation_outbox SET expires_at=${stamp("-1 second")}`).run();
  const newExpiry = await db
    .prepare("SELECT expires_at FROM follow_confirmation_outbox")
    .first("expires_at");
  await setOwner(db, "running", id, newExpiry);
  const running = await db.prepare("SELECT * FROM follow_delivery_owner").first();
  assert.equal((await expireFollowPage(db, opts("confirmation"))).removed, 1);
  assert.deepEqual(await db.prepare("SELECT * FROM follow_delivery_owner").first(), {
    ...running,
    confirmation_id: null,
    confirmation_expires_at: null,
  });
}

export async function expiryPageRollbackAndUnknownAcknowledgement(db) {
  await seed(db);
  await token(db, "manage");
  await db
    .prepare(
      "CREATE TRIGGER expiry_page_abort BEFORE DELETE ON follow_tokens BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    )
    .run();
  try {
    assert.deepEqual(await expireFollowPage(db, opts("tokens")), { status: "unavailable" });
    assert.equal(await total(db, "follow_tokens"), 1);
  } finally {
    await db.prepare("DROP TRIGGER expiry_page_abort").run();
  }
  let calls = 0;
  const lost = {
    prepare: (s) => db.prepare(s),
    async batch(s) {
      calls++;
      await db.batch(s);
      throw Error();
    },
  };
  assert.deepEqual(await expireFollowPage(lost, opts("tokens")), { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal(await total(db, "follow_tokens"), 0);
  for (const mutate of [
    (r) => {
      delete r[1];
    },
    (r) => {
      r[2].success = false;
    },
    (r) => {
      r[1].results = new Array(1);
    },
    (r) => {
      r[1].results = [];
    },
  ]) {
    const bad = {
      prepare: (s) => db.prepare(s),
      async batch(s) {
        const r = await db.batch(s);
        mutate(r);
        return r;
      },
    };
    assert.deepEqual(await expireFollowPage(bad, opts("tokens")), { status: "unavailable" });
  }
}

export async function expiryPageReceiptValuesAreCapturedOnce(db) {
  const wrapped = {
    prepare: (s) => db.prepare(s),
    async batch(s) {
      const r = await db.batch(s);
      // Descriptor snapshots are authoritative; ordinary reads from this exotic port lie.
      r[2] = new Proxy(r[2], {
        get(target, key) {
          if (key === "success") throw Error();
          return target[key];
        },
      });
      return r;
    },
  };
  assert.equal((await expireFollowPage(wrapped, opts("tokens"))).status, "maintained");
  let getter = 0;
  const bad = {
    prepare: (s) => db.prepare(s),
    async batch(s) {
      const r = await db.batch(s);
      Object.defineProperty(r[2], "success", {
        enumerable: true,
        get() {
          getter++;
          return true;
        },
      });
      return r;
    },
  };
  assert.deepEqual(await expireFollowPage(bad, opts("tokens")), { status: "unavailable" });
  assert.equal(getter, 0);
}

export async function expiryPageRedactionCannotBeRestoredByOwnerCompletion(db) {
  await seed(db);
  const id = crypto.randomUUID();
  await job(db, id, 1, "-1 second", "in-flight");
  const expires_at = await db
    .prepare("SELECT expires_at FROM follow_confirmation_outbox")
    .first("expires_at");
  await setOwner(db, "ready", id, expires_at);
  const acquired = await acquireFollowDeliveryOwner(db);
  assert.equal(acquired.status, "acquired");
  const before = await db.prepare("SELECT * FROM follow_delivery_owner").first();
  assert.equal((await expireFollowPage(db, opts("confirmation"))).removed, 1);
  assert.deepEqual(await db.prepare("SELECT * FROM follow_delivery_owner").first(), {
    ...before,
    confirmation_id: null,
    confirmation_expires_at: null,
  });
  const result = {
    status: "processed",
    cleanup: { status: "maintained", removed: 0 },
    dispatch: {
      status: "processed",
      counts: { examined: 1, accepted: 0, uncertain: 0, unavailable: 0, skipped: 1 },
      continuation: { confirmation: { id, expires_at }, management: null, nextKind: "management" },
    },
  };
  assert.equal(
    (await finishFollowDeliveryOwner(acquired.ticket, result, { maxCandidates: 1, maxExpired: 1 }))
      .status,
    "ready",
  );
  const after = await db.prepare("SELECT * FROM follow_delivery_owner").first();
  assert.equal(after.confirmation_id, null);
  assert.equal(after.generation, before.generation);
}

export async function expiryPageSignedInt64KeysAndCapturedCeiling(db) {
  const keys = ["-9223372036854775808", "-1", "0", "9223372036854775807"];
  for (let i = 0; i < keys.length; i++) {
    const id = `extreme-${i}`;
    await seed(db, id);
    await job(db, id, keys[i], "-1 second", null, id);
  }
  const first = await expireFollowPage(db, opts("confirmation", 2));
  assert.deepEqual(first, {
    status: "maintained",
    examined: 2,
    removed: 2,
    complete: false,
    next: { kind: "confirmation", after: "-1", through: "9223372036854775807" },
  });
  const last = await expireFollowPage(db, opts("confirmation", 2, first.next));
  assert.deepEqual(last, {
    status: "maintained",
    examined: 2,
    removed: 2,
    complete: true,
    next: null,
  });
  assert.equal(await total(db, "follow_confirmation_outbox"), 0);
}

export async function expiryPageCannotReturnAnUnvalidatedCursor(db) {
  await seed(db);
  await seed(db, "tail");
  await job(db, "first", 1);
  await seed(db, "middle");
  await job(db, "middle", 2, "-1 second", null, "middle");
  await job(db, "last", 3, "-1 second", null, "tail");
  let reads = 0;
  const changed = {
    prepare: (s) => db.prepare(s),
    async batch(s) {
      const r = await db.batch(s);
      r[1].results[0] = new Proxy(r[1].results[0], {
        get(target, key) {
          if (key === "last") {
            reads++;
            return "2";
          }
          return target[key];
        },
      });
      return r;
    },
  };
  assert.deepEqual((await expireFollowPage(changed, opts("confirmation", 1))).next, {
    kind: "confirmation",
    after: "1",
    through: "3",
  });
  assert.equal(reads, 0);
  const resumed = await expireFollowPage(
    db,
    opts("confirmation", 2, { kind: "confirmation", after: "1", through: "3" }),
  );
  assert.equal(resumed.removed, 2);
  assert.equal(await total(db, "follow_confirmation_outbox"), 0);
  await job(db, "live", 4, "+1 day");
  const impossible = {
    prepare: (s) => db.prepare(s),
    async batch(s) {
      const r = await db.batch(s);
      r[1].results = [{ examined: 0, last: null }];
      return r;
    },
  };
  assert.deepEqual(await expireFollowPage(impossible, opts("confirmation", 1)), {
    status: "unavailable",
  });
  assert.equal(await total(db, "follow_confirmation_outbox"), 1);
}
