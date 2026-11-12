import assert from "node:assert/strict";
import { claimFollowManagementRequest as claim } from "../src/follow-management-claim.js";
import { enqueueFollowManagementRequest as enqueue } from "../src/follow-management-request.js";
import { mintFollowToken, inspectFollowToken } from "../src/follows.js";
import { reserveFollowSendAttempt } from "../src/follow-send-budget.js";
const options = { enabled: true, cap: 5 };
const now = (db) => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') at").first("at");
const all = async (db, table) =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
const reset = (db) =>
  db.batch(
    ["follow_subscribers", "follow_send_budget", "rate"].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
async function seed(db, id = "fixture") {
  const email = id + "@example.test",
    at = await now(db);
  await db
    .prepare("INSERT INTO follow_subscribers(id,email,created) VALUES(?,?,?)")
    .bind(id, email, at)
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions(subscriber_id,scope_key,created,confirmed_at) VALUES(?,?,?,?)",
    )
    .bind(id, "scope", at, at)
    .run();
  const old = await mintFollowToken(db, id, "manage", {}, new Date(at));
  const unsub = await mintFollowToken(db, id, "unsubscribe", {}, new Date(at));
  assert.equal(
    (await enqueue(db, { email }, { enabled: true, ttlMs: 60000, dailyLimit: 100 })).status,
    "accepted",
  );
  const job = await db
    .prepare("SELECT * FROM follow_management_outbox WHERE subscriber_id=?")
    .bind(id)
    .first();
  return { job, old, unsub, email };
}
export async function disabledAndInvalidDoNoIO() {
  const db = {
    prepare() {
      throw Error("unexpected");
    },
    batch() {
      throw Error("unexpected");
    },
  };
  assert.deepEqual(await claim(db, "invalid"), { status: "disabled" });
  assert.deepEqual(await claim(db, "invalid", null), { status: "disabled" });
  for (const cap of [undefined, 0, -1, 1.5, "5", Infinity])
    assert.deepEqual(await claim(db, crypto.randomUUID(), { enabled: true, cap }), {
      status: "unavailable",
    });
  assert.deepEqual(await claim(db, ["invalid"], options), { status: "unavailable" });
}
export async function atomicIssuanceReplacesOnlyManagementAndReplaysNoCredit(db) {
  const { job, old, unsub, email } = await seed(db),
    before = await now(db);
  const result = await claim(db, job.id, options),
    after = await now(db);
  assert.equal(result.status, "claimed");
  assert.equal(result.email, email);
  const token = await inspectFollowToken(db, result.management, "manage");
  assert.equal(token.subscriber_id, "fixture");
  assert.equal(token.scope_key, "");
  assert.ok(Date.parse(result.expiresAt) >= Date.parse(before) + 1800000);
  assert.ok(Date.parse(result.expiresAt) <= Date.parse(after) + 1800000);
  assert.equal(await inspectFollowToken(db, old, "manage"), null);
  assert.ok(await inspectFollowToken(db, unsub, "unsubscribe"));
  assert.ok(await inspectFollowToken(db, result.unsubscribe, "unsubscribe"));
  const q = (await all(db, "follow_management_outbox"))[0];
  assert.equal(q.claim_id, result.claimId);
  assert.equal(q.expires_at, job.expires_at);
  assert.equal((await all(db, "follow_send_budget"))[0].attempts, 1);
  const tokens = await all(db, "follow_tokens");
  assert.equal(tokens.length, 3);
  assert.ok(
    tokens.every((t) => t.token_hash !== result.management && t.token_hash !== result.unsubscribe),
  );
  assert.deepEqual(await claim(db, job.id, options), { status: "unavailable" });
  assert.deepEqual(await all(db, "follow_tokens"), tokens);
  assert.equal((await all(db, "follow_send_budget"))[0].attempts, 1);
}
export async function concurrentClaimsAndSharedCapAreAtomic(db) {
  const a = await seed(db, "first"),
    b = await seed(db, "second");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => claim(db, a.job.id, { enabled: true, cap: 1 })),
  );
  assert.equal(results.filter((r) => r.status === "claimed").length, 1);
  assert.equal((await all(db, "follow_send_budget"))[0].attempts, 1);
  assert.deepEqual(await claim(db, b.job.id, { enabled: true, cap: 1 }), { status: "unavailable" });
  assert.ok(await inspectFollowToken(db, b.old, "manage"));
  assert.equal(
    (
      await db
        .prepare("SELECT claim_id FROM follow_management_outbox WHERE id=?")
        .bind(b.job.id)
        .first()
    ).claim_id,
    null,
  );
}
export async function exhaustedExistingBudgetPreservesOldToken(db) {
  const { job, old } = await seed(db);
  assert.equal(await reserveFollowSendAttempt(db, 1, new Date(await now(db))), true);
  assert.deepEqual(await claim(db, job.id, { enabled: true, cap: 1 }), { status: "unavailable" });
  assert.ok(await inspectFollowToken(db, old, "manage"));
  assert.equal((await all(db, "follow_management_outbox"))[0].claim_id, null);
}
export async function expiredOrDeletedAfterReadNeverClaims(db) {
  for (const deleted of [false, true]) {
    await reset(db);
    const { job, old } = await seed(db);
    let calls = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        const r = await db.batch(s);
        if (++calls === 1) {
          if (deleted) await db.prepare("DELETE FROM follow_subscribers").run();
          else
            await db
              .prepare(
                "UPDATE follow_management_outbox SET queued_at='2020-01-01T00:00:00.000Z',expires_at='2020-01-01T00:00:01.000Z'",
              )
              .run();
        }
        return r;
      },
    };
    assert.deepEqual(await claim(wrapped, job.id, options), { status: "unavailable" });
    assert.equal((await all(db, "follow_send_budget"))[0].attempts, 0);
    if (!deleted) {
      assert.ok(await inspectFollowToken(db, old, "manage"));
      assert.equal((await all(db, "follow_management_outbox"))[0].claim_id, null);
    } else {
      assert.deepEqual(await all(db, "follow_tokens"), []);
      assert.deepEqual(await all(db, "follow_management_outbox"), []);
    }
  }
}
export async function credentialFailureRollsBackClaimCapAndOldToken(db) {
  const { job, old } = await seed(db),
    tokens = await all(db, "follow_tokens");
  await db
    .prepare(
      "CREATE TRIGGER fixture_claim_failure BEFORE INSERT ON follow_tokens WHEN NEW.purpose='unsubscribe' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  try {
    assert.deepEqual(await claim(db, job.id, options), { status: "unavailable" });
    assert.deepEqual(await all(db, "follow_tokens"), tokens);
    assert.ok(await inspectFollowToken(db, old, "manage"));
    assert.equal((await all(db, "follow_management_outbox"))[0].claim_id, null);
    assert.deepEqual(await all(db, "follow_send_budget"), []);
  } finally {
    await db.prepare("DROP TRIGGER fixture_claim_failure").run();
  }
}
export async function uncertainCommittedReceiptNeverReturnsRawOrRetries(db) {
  for (const fault of ["false", "hole", "short", "count", "rows", "clock", "expiry"]) {
    await reset(db);
    const { job } = await seed(db);
    let calls = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        const r = await db.batch(s);
        if (++calls === 3) {
          if (fault === "false") r[4].success = false;
          if (fault === "hole") delete r[3];
          if (fault === "short") r.pop();
          if (fault === "count") r[2].meta.changes = "1";
          if (fault === "rows") r[0].results = [{}];
          if (fault === "clock") r[0].meta.changes = 2;
          if (fault === "expiry") r[6].results[0].expires_at = "invalid";
        }
        return r;
      },
    };
    assert.deepEqual(await claim(wrapped, job.id, options), { status: "unavailable" });
    assert.equal(calls, 3);
    assert.equal((await all(db, "follow_send_budget"))[0].attempts, 1);
    assert.ok((await all(db, "follow_management_outbox"))[0].claim_id);
    assert.deepEqual(await claim(db, job.id, options), { status: "unavailable" });
    assert.equal((await all(db, "follow_send_budget"))[0].attempts, 1);
  }
}
export async function expiredNewRequestCanReplaceSpentJobWithoutInvalidatingOldToken(db) {
  const { job, email } = await seed(db),
    first = await claim(db, job.id, options);
  assert.equal(first.status, "claimed");
  await enqueue(db, { email }, { enabled: true, ttlMs: 120000, dailyLimit: 100 });
  assert.equal((await all(db, "follow_management_outbox"))[0].claim_id, first.claimId);
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at='2020-01-01T00:00:00.000Z',expires_at='2020-01-01T00:00:01.000Z'",
    )
    .run();
  await enqueue(db, { email }, { enabled: true, ttlMs: 60000, dailyLimit: 100 });
  const second = (await all(db, "follow_management_outbox"))[0];
  assert.notEqual(second.id, job.id);
  assert.equal(second.claim_id, null);
  assert.ok(await inspectFollowToken(db, first.management, "manage"));
  assert.equal((await claim(db, second.id, options)).status, "claimed");
  assert.equal(await inspectFollowToken(db, first.management, "manage"), null);
  await db.prepare("DELETE FROM follow_subscribers").run();
  assert.deepEqual(await all(db, "follow_tokens"), []);
  assert.deepEqual(await all(db, "follow_management_outbox"), []);
  assert.equal((await all(db, "follow_send_budget"))[0].attempts, 2);
}
export async function malformedClockAndChangedSnapshotFailClosed(db) {
  for (const fault of ["clock", "email", "queued"]) {
    await reset(db);
    const { job, old } = await seed(db);
    let calls = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        const r = await db.batch(s);
        calls++;
        if (calls === 2) {
          if (fault === "clock") r[0].results[0].at = "2020-01-01T00:00:00.000Z";
          if (fault === "email")
            await db.prepare("UPDATE follow_subscribers SET email='changed@example.test'").run();
          if (fault === "queued")
            await db
              .prepare(
                "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ',queued_at,'-1 second')",
              )
              .run();
        }
        return r;
      },
    };
    assert.deepEqual(await claim(wrapped, job.id, options), { status: "unavailable" });
    assert.ok(await inspectFollowToken(db, old, "manage"));
    assert.equal((await all(db, "follow_management_outbox"))[0].claim_id, null);
  }
}
