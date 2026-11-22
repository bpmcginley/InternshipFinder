import assert from "node:assert/strict";
import { admitFollowSignup } from "../src/follow-signup-admission.js";
import { cleanup } from "../src/limits.js";
import {
  normalizeFollowEmail,
  requestFollowConfirmation,
  mintFollowToken,
  confirmFollow,
} from "../src/follows.js";

const start = new Date("2028-01-01T12:00:00.000Z");
const catalog = {
  companies: new Set(["fixture"]),
  fields: new Set(["biology"]),
  states: new Set(["MA"]),
};
const request = (email = "reader@example.test") => ({
  email,
  scope: { kind: "company", company: "fixture" },
  link: false,
});
const options = (more = {}) => ({
  enabled: true,
  dailyLimit: 10,
  catalog,
  clock: () => start,
  ...more,
});
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const count = async (db, table) => (await rows(db, table)).length;

export async function disabledAndInvalidNeverWrite(db) {
  let touched = 0;
  const forbidden = {
    prepare() {
      touched++;
      throw new Error("must not touch storage");
    },
    batch() {
      touched++;
      throw new Error("must not touch storage");
    },
  };
  assert.deepEqual(await admitFollowSignup(forbidden, request()), { status: "disabled" });
  assert.deepEqual(await admitFollowSignup(forbidden, request(), null), { status: "disabled" });
  for (const value of [
    null,
    [],
    {},
    { ...request(), extra: true },
    { ...request(), link: 1 },
    { ...request(), email: "not an email" },
    { ...request(), scope: { kind: "company", company: "unknown" } },
    { ...request(), scope: { kind: "search", fields: [], states: ["REMOTE"] } },
  ])
    assert.deepEqual(await admitFollowSignup(forbidden, value, options()), { status: "invalid" });
  for (const sessionProof of [
    undefined,
    null,
    {},
    { id: "bad", user: "b".repeat(64) },
    { id: "a".repeat(64), user: "B".repeat(64) },
    { id: "a".repeat(64), user: "b".repeat(64), extra: true },
  ]) {
    assert.deepEqual(
      await admitFollowSignup(forbidden, { ...request(), link: true }, options({ sessionProof })),
      { status: "unsupported" },
    );
  }
  assert.deepEqual(
    await admitFollowSignup(forbidden, { ...request(), link: true, sessionProof: {} }, options()),
    { status: "invalid" },
  );
  for (const dailyLimit of [0, -1, true, Infinity, 1.5, undefined])
    assert.deepEqual(await admitFollowSignup(forbidden, request(), options({ dailyLimit })), {
      status: "unavailable",
    });
  assert.equal(await count(db, "rate"), 0);
  assert.equal(await count(db, "follow_subscribers"), 0);
  assert.equal(touched, 0);
}

export async function duplicateReceiptAndOriginalExpiry(db) {
  const a = await admitFollowSignup(db, request(" READER@example.test "), options());
  const first = (await rows(db, "follow_confirmation_outbox"))[0];
  const b = await admitFollowSignup(
    db,
    request(),
    options({ clock: () => new Date(+start + 60_000) }),
  );
  assert.deepEqual(a, { status: "accepted" });
  assert.deepEqual(b, a);
  assert.deepEqual((await rows(db, "follow_confirmation_outbox"))[0], first);
  assert.equal(first.expires_at, "2028-01-08T12:00:00.000Z");
  assert.equal(await count(db, "follow_subscribers"), 1);
  assert.equal((await rows(db, "rate"))[0].calls, 2);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, null);
  const scope = (await rows(db, "follow_subscriptions"))[0];
  const token = await mintFollowToken(
    db,
    scope.subscriber_id,
    "confirm",
    { scopeKey: scope.scope_key },
    start,
  );
  assert.equal(await confirmFollow(db, token, start), true);
  assert.deepEqual(await admitFollowSignup(db, request(), options()), a);
  assert.equal(await count(db, "follow_confirmation_outbox"), 0);
  for (const email of [" Plus+Alias@example.test ", "Mixed.Case@example.test"])
    assert.equal(normalizeFollowEmail(email), email.trim().toLowerCase());
  for (const email of [
    null,
    "",
    "bad",
    "x<y@example.test",
    "x\ny@example.test",
    "a".repeat(250) + "@e.test",
  ]) {
    assert.throws(() => normalizeFollowEmail(email));
    await assert.rejects(requestFollowConfirmation(db, email, request().scope, catalog, start));
  }
}

export async function concurrentGlobalCapAndExistingCleanup(db) {
  const accepted = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      admitFollowSignup(db, request(`fixture${i}@example.test`), options({ dailyLimit: 3 })),
    ),
  );
  assert.equal(accepted.filter((r) => r.status === "accepted").length, 3);
  assert.equal(accepted.filter((r) => r.status === "unavailable").length, 9);
  assert.equal(await count(db, "follow_confirmation_outbox"), 3);
  assert.deepEqual(await rows(db, "rate"), [
    { user_hash: "*follow-signup", bucket: "d:2028-01-01", calls: 3 },
  ]);
  // Existing day-prefix cleanup erases the anonymous old bucket without a new policy/table.
  await cleanup(db, new Date("2028-01-04T12:00:00.000Z"));
  assert.equal(await count(db, "rate"), 0);
}

export async function ambiguousRateNeverQueues(db) {
  let calls = 0;
  const wrapped = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() {
              calls++;
              await db
                .prepare(sql)
                .bind(...params)
                .run();
              return { success: false, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    batch() {
      throw new Error("queue must not run");
    },
  };
  assert.deepEqual(await admitFollowSignup(wrapped, request(), options()), {
    status: "unavailable",
  });
  assert.equal(calls, 1);
  assert.equal((await rows(db, "rate"))[0].calls, 1);
  assert.equal(await count(db, "follow_subscribers"), 0);
}

export async function queueLostAcknowledgementDoesNotRefundOrRetry(db) {
  let batches = 0;
  const wrapped = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      batches++;
      await db.batch(statements);
      throw new Error("synthetic lost acknowledgement");
    },
  };
  assert.deepEqual(await admitFollowSignup(wrapped, request(), options()), {
    status: "unavailable",
  });
  assert.equal(batches, 1);
  assert.equal(await count(db, "follow_confirmation_outbox"), 1);
  assert.equal((await rows(db, "rate"))[0].calls, 1);
  assert.deepEqual(await admitFollowSignup(db, request(), options()), { status: "accepted" });
  assert.equal(await count(db, "follow_confirmation_outbox"), 1);
  assert.equal((await rows(db, "rate"))[0].calls, 2);
}

export async function explicitNonSuccessBatchCannotReturnReceipt(db) {
  const wrapped = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      const result = await db.batch(statements);
      result[0].success = false;
      return result;
    },
  };
  assert.deepEqual(await admitFollowSignup(wrapped, request(), options()), {
    status: "unavailable",
  });
  assert.equal(await count(db, "follow_confirmation_outbox"), 1);
  assert.equal((await rows(db, "rate"))[0].calls, 1);
}

export async function malformedCommittedAcknowledgementsFailClosed(db) {
  const changes = [
    (result) => {
      delete result.at(-1).results[0].job_id;
    },
    (result) => {
      result.at(-1).results.push(result.at(-1).results[0]);
    },
    (result) => {
      delete result[1];
    },
  ];
  let calls = 0;
  for (const [index, alter] of changes.entries()) {
    const wrapped = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        calls++;
        const result = await db.batch(statements);
        alter(result);
        return result;
      },
    };
    assert.deepEqual(
      await admitFollowSignup(wrapped, request(`malformed${index}@example.test`), options()),
      { status: "unavailable" },
    );
    assert.equal(calls, index + 1);
    assert.equal(await count(db, "follow_confirmation_outbox"), index + 1);
    assert.equal((await rows(db, "rate"))[0].calls, index + 1);
  }
}

export async function failedQueueBatchAndClockRolloverStayClosed(db) {
  await db
    .prepare(
      "CREATE TRIGGER fail_signup_queue BEFORE INSERT ON follow_confirmation_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    )
    .run();
  assert.deepEqual(await admitFollowSignup(db, request(), options()), { status: "unavailable" });
  assert.equal(await count(db, "follow_subscribers"), 0);
  assert.equal((await rows(db, "rate"))[0].calls, 1);
  await db.prepare("DROP TRIGGER fail_signup_queue").run();
  for (const after of [new Date(+start - 1), new Date("2028-01-02T00:00:00.000Z")]) {
    let samples = 0;
    const clock = () => (samples++ ? after : start);
    assert.deepEqual(await admitFollowSignup(db, request(), options({ clock })), {
      status: "unavailable",
    });
  }
  assert.equal(await count(db, "follow_subscribers"), 0);
  assert.equal((await rows(db, "rate"))[0].calls, 3);
}

const linked = (email) => ({ ...request(email), link: true });
const current = (more = {}) => options({ clock: () => new Date(), ...more });
const accepted = { status: "accepted" };
const unavailable = { status: "unavailable" };
async function session(db) {
  const randomHash = () => crypto.randomUUID().replaceAll("-", "").repeat(2);
  const proof = { id: randomHash(), user: randomHash() };
  await db
    .prepare(
      "INSERT INTO sessions(id,user_hash,tier,provider,created,last_used,expires) " +
        "VALUES(?,?,'free','google',datetime('now'),datetime('now'),datetime('now','+1 day'))",
    )
    .bind(proof.id, proof.user)
    .run();
  return proof;
}

export async function linkedAndAnonymousShareOneConcurrentCap(db) {
  const sessionProof = await session(db);
  const limit = current({ dailyLimit: 4, sessionProof });
  assert.deepEqual(await admitFollowSignup(db, request("anonymous@example.test"), limit), accepted);
  assert.deepEqual(await admitFollowSignup(db, linked("linked@example.test"), limit), accepted);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      admitFollowSignup(db, (i % 2 ? linked : request)(`combined${i}@example.test`), limit),
    ),
  );
  assert.equal(results.filter(({ status }) => status === "accepted").length, 2);
  assert.equal(results.filter(({ status }) => status === "unavailable").length, 6);
  const jobs = await rows(db, "follow_confirmation_outbox");
  assert.equal(jobs.length, 4);
  assert(jobs.some((row) => row.owner_user_hash === sessionProof.user));
  assert(jobs.some((row) => row.owner_user_hash === null));
  const rate = await rows(db, "rate");
  assert.equal(rate.length, 1);
  assert.equal(rate[0].user_hash, "*follow-signup");
  assert.equal(rate[0].calls, 4);
}

export async function linkedOutcomesDoNotRevealMailboxOrScopeState(db) {
  const sessionProof = await session(db);
  const other = await session(db);
  assert.deepEqual(await admitFollowSignup(db, request(), current()), accepted);
  const before = await rows(db, "follow_confirmation_outbox");
  assert.deepEqual(await admitFollowSignup(db, linked(), current({ sessionProof })), accepted);
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), before);
  const [subscription] = await rows(db, "follow_subscriptions");
  const token = await mintFollowToken(db, subscription.subscriber_id, "confirm", {
    scopeKey: subscription.scope_key,
  });
  assert.equal(await confirmFollow(db, token), true);
  const confirmed = await rows(db, "follow_subscriptions");
  const progress = await rows(db, "follow_scope_progress");
  assert.deepEqual(await admitFollowSignup(db, linked(), current({ sessionProof })), accepted);
  const pending = await rows(db, "follow_confirmation_outbox");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].owner_user_hash, sessionProof.user);
  assert.deepEqual(await rows(db, "follow_subscriptions"), confirmed);
  assert.deepEqual(await rows(db, "follow_scope_progress"), progress);
  assert.deepEqual(
    await admitFollowSignup(db, linked(), current({ sessionProof: other })),
    accepted,
  );
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), pending);
}

function afterRate(db, action) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith("INSERT INTO rate ")) return statement;
      return {
        bind(...params) {
          return {
            async run() {
              const receipt = await statement.bind(...params).run();
              await action();
              return receipt;
            },
          };
        },
      };
    },
    batch: db.batch.bind(db),
  };
}

export async function sessionSnapshotAndRevocationFenceHoldAcrossRateAwait(db) {
  const sessionProof = await session(db);
  const later = await session(db);
  const original = { ...sessionProof };
  const changing = afterRate(db, () => Object.assign(sessionProof, later));
  assert.deepEqual(
    await admitFollowSignup(changing, linked(), current({ sessionProof })),
    accepted,
  );
  const pending = await rows(db, "follow_confirmation_outbox");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].owner_user_hash, original.user);
  assert.equal(JSON.stringify(pending).includes(original.id), false);
  const revoked = afterRate(db, () =>
    db.prepare("DELETE FROM sessions WHERE id=?").bind(original.id).run(),
  );
  assert.deepEqual(
    await admitFollowSignup(
      revoked,
      linked("revoked@example.test"),
      current({ sessionProof: original }),
    ),
    accepted,
  );
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), pending);
  assert.equal(await count(db, "follow_subscribers"), 1);
  assert.equal((await rows(db, "rate"))[0].calls, 2);
}

export async function linkedMalformedAcknowledgementsStayUnavailable(db) {
  const sessionProof = await session(db);
  const changes = [
    (batch) => {
      batch.at(-1).results[0] = null;
    },
    (batch) => {
      delete batch.at(-1).results[0];
    },
    (batch) => {
      batch.at(-1).results[0].scopeKey = "wrong";
    },
    (batch) => {
      batch.at(-1).meta.changes = 1;
    },
    (batch) => {
      batch[0].success = false;
    },
    () => {
      throw new Error("synthetic lost acknowledgement");
    },
  ];
  let attempts = 0;
  for (const [index, alter] of changes.entries()) {
    const wrapped = {
      prepare: db.prepare.bind(db),
      async batch(statements) {
        attempts++;
        const result = await db.batch(statements);
        alter(result);
        return result;
      },
    };
    assert.deepEqual(
      await admitFollowSignup(
        wrapped,
        linked(`linked-fault${index}@example.test`),
        current({ sessionProof }),
      ),
      unavailable,
    );
    assert.equal(attempts, index + 1);
    assert.equal(await count(db, "follow_confirmation_outbox"), index + 1);
    assert.equal((await rows(db, "rate"))[0].calls, index + 1);
  }
}
