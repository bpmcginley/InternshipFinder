import assert from "node:assert/strict";
import { createFollowLinkRuntime as create } from "../src/follow-link-runtime.js";
import { config, seed } from "./follow-link-dispatch.js";
const limits = { maxCandidates: 1, maxExpired: 2 };
const selected = (db) => {
  const c = config(db);
  return { sending: true, cap: c.cap, confirmation: c.confirmation, management: c.management };
};
function observe(
  db,
  after = async (_sql, result) => result,
  afterBatch = async (result) => result,
) {
  let count = 0;
  const wrap = (statement, sql) => ({
    raw: statement,
    sql,
    bind: (...args) => wrap(statement.bind(...args), sql),
    run: async () => {
      count++;
      return after(sql, await statement.run());
    },
    all: async () => {
      count++;
      return after(sql, await statement.all());
    },
    first: async (...args) => {
      count++;
      return after(sql, await statement.first(...args));
    },
  });
  return {
    count: () => count,
    db: {
      prepare: (sql) => wrap(db.prepare(sql), sql),
      batch: async (statements) => {
        count += statements.length;
        const result = await db.batch(statements.map((s) => s.raw));
        for (let i = 0; i < statements.length; i++)
          result[i] = await after(statements[i].sql, result[i]);
        return afterBatch(result);
      },
    },
  };
}
async function expired(db, n) {
  const id = await seed(db, "management", n);
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id=?",
    )
    .bind(id)
    .run();
}
export async function defaultClosedAndInvalidPolicyDoNoDatabaseWork() {
  let calls = 0;
  const db = {
      prepare() {
        calls++;
        throw Error();
      },
      batch() {
        calls++;
        throw Error();
      },
    },
    policy = () => {
      calls++;
      return { sending: false };
    },
    email = {
      send() {
        calls++;
        throw Error();
      },
    };
  for (const enabled of [undefined, false, "true", 1])
    assert.deepEqual(await create({ enabled, db, policy, email })(limits), { status: "disabled" });
  for (const invalid of [{ maxCandidates: 0 }, { maxCandidates: 65 }, { maxExpired: 0 }])
    assert.deepEqual(
      await create({ enabled: true, db, policy, email })({ ...limits, ...invalid }),
      { status: "unavailable" },
    );
  assert.equal(calls, 0);
  for (const invalid of [
    null,
    [],
    {
      get maxCandidates() {
        throw Error("private input");
      },
    },
  ])
    assert.deepEqual(await create({ enabled: true, db, policy, email })(invalid), {
      status: "unavailable",
    });
  for (const bad of [
    () => null,
    () => ({ sending: "true" }),
    async () => {
      throw Error("private policy");
    },
  ])
    assert.deepEqual(await create({ enabled: true, db, email, policy: bad })(limits), {
      status: "unavailable",
    });
  assert.deepEqual(await create({ enabled: true, db, policy: () => selected(db) })(limits), {
    status: "unavailable",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
}
export async function sendingOffStillPerformsOnlyBoundedManagementExpiry(db) {
  for (let n = 0; n < 3; n++) await expired(db, n);
  await seed(db, "management", 3);
  await seed(db, "confirmation");
  let reads = 0;
  const runtime = create({
    enabled: true,
    db,
    policy: () => ({ sending: false }),
    email: {
      get send() {
        reads++;
        throw Error();
      },
    },
  });
  assert.deepEqual(await runtime(limits), {
    status: "maintained",
    cleanup: { status: "maintained", removed: 2 },
  });
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM follow_management_outbox").first("n"), 2);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM follow_confirmation_outbox").first("n"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM follow_send_budget").first("n"), 0);
  assert.equal(reads, 0);
  assert.equal((await runtime(limits)).cleanup.removed, 1);
}
export async function continuationAlternatesKindsAndMeasuresRealStatementBudget(db) {
  for (const kind of ["confirmation", "management"])
    for (let n = 0; n < 2; n++) await seed(db, kind, n);
  const measured = observe(db),
    p = selected(db),
    sent = [];
  let bindingReads = 0;
  const runtime = create({
    enabled: true,
    db: measured.db,
    policy: () => p,
    email: {
      get send() {
        bindingReads++;
        return (e) => {
          sent.push(e.subject.startsWith("Manage") ? "management" : "confirmation");
          return Promise.resolve({ messageId: "synthetic" });
        };
      },
    },
  });
  let continuation;
  for (let n = 0; n < 4; n++) {
    const before = measured.count(),
      result = await runtime({ ...limits, continuation });
    assert.equal(result.status, "processed");
    assert.equal(result.dispatch.counts.accepted, 1);
    assert.equal(measured.count() - before, 17); // Expiry plus direct-count receipt, dispatch admission and exact claim/fence.
    continuation = result.dispatch.continuation;
  }
  assert.deepEqual(sent, ["confirmation", "management", "confirmation", "management"]);
  assert.equal(bindingReads, 1);
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 4);
}
export async function overlappingTicksDoNotQueueOrDuplicateWork(db) {
  await seed(db, "confirmation");
  let release, reached;
  const gate = new Promise((r) => {
      release = r;
    }),
    started = new Promise((r) => {
      reached = r;
    });
  const measured = observe(db, async (sql, result) => {
    if (sql.startsWith("DELETE FROM follow_management_outbox")) {
      reached();
      await gate;
    }
    return result;
  });
  let sends = 0;
  const p = selected(db),
    runtime = create({
      enabled: true,
      db: measured.db,
      policy: () => p,
      email: {
        send() {
          sends++;
          return Promise.resolve({ messageId: "synthetic" });
        },
      },
    });
  const first = runtime(limits);
  await started;
  const before = measured.count();
  assert.deepEqual(await runtime(limits), { status: "busy" });
  assert.equal(measured.count(), before);
  release();
  assert.equal((await first).dispatch.counts.accepted, 1);
  assert.equal(sends, 1);
}
export async function ambiguousCleanupStopsBeforeClaimAndNeverRetries(db) {
  await expired(db, 0);
  await seed(db, "confirmation");
  let writes = 0,
    sends = 0;
  const measured = observe(db, async (sql, result) => {
    if (sql.startsWith("DELETE FROM follow_management_outbox")) {
      writes++;
      throw Error("private lost receipt");
    }
    return result;
  });
  const p = selected(db),
    runtime = create({
      enabled: true,
      db: measured.db,
      policy: () => p,
      email: {
        send() {
          sends++;
          return Promise.resolve({ messageId: "synthetic" });
        },
      },
    });
  assert.deepEqual(await runtime(limits), { status: "unavailable" });
  assert.equal(writes, 1);
  assert.equal(sends, 0);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM follow_send_budget").first("n"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM follow_management_outbox").first("n"), 0);
}
export async function policyRevocationDuringCleanupOrClaimPreventsHandoff(db) {
  const id = await seed(db, "confirmation");
  for (const atClaim of [false, true]) {
    let p = selected(db),
      sends = 0;
    const measured = observe(
      db,
      async (sql, result) => {
        if (!atClaim && sql.startsWith("DELETE FROM follow_management_outbox"))
          p = { sending: false };
        return result;
      },
      async (result) => {
        if (atClaim && result.length === 8) p = { sending: false };
        return result;
      },
    );
    const runtime = create({
      enabled: true,
      db: measured.db,
      policy: () => p,
      email: {
        send() {
          sends++;
          return Promise.resolve({ messageId: "synthetic" });
        },
      },
    });
    assert.equal((await runtime(limits)).status, "unavailable");
    assert.equal(sends, 0);
    const claimed = await db
      .prepare("SELECT claim_id FROM follow_confirmation_outbox WHERE id=?")
      .bind(id)
      .first("claim_id");
    assert.equal(!!claimed, atClaim);
  }
}
export async function unresolvedHandoffLatchesSendingButAllowsMaintenance(db) {
  await seed(db, "confirmation");
  await seed(db, "management");
  let settle,
    sends = 0;
  let p = selected(db);
  const runtime = create({
    enabled: true,
    db,
    policy: () => p,
    transportTimeoutMs: 10,
    email: {
      send() {
        sends++;
        return new Promise((r) => {
          settle = r;
        });
      },
    },
  });
  const first = await runtime({ ...limits, maxCandidates: 2 });
  assert.equal(first.status, "uncertain");
  assert.equal(first.dispatch.counts.examined, 1);
  await expired(db, 4);
  assert.deepEqual(await runtime({ ...limits, continuation: first.dispatch.continuation }), {
    status: "held",
    cleanup: { status: "maintained", removed: 1 },
  });
  settle({ messageId: "late" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await runtime(limits)).status, "held");
  p = { sending: false };
  assert.equal((await runtime(limits)).status, "maintained");
  assert.equal(sends, 1);
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 1);
}

export async function capacityPausePreservesBlockedTurnAcrossTicks(db) {
  await seed(db, "confirmation");
  await seed(db, "management");
  const p = { ...selected(db), cap: 1 },
    sent = [];
  const runtime = create({
    enabled: true,
    db,
    policy: () => p,
    email: {
      send(e) {
        sent.push(e.subject);
        return Promise.resolve({ messageId: "synthetic" });
      },
    },
  });
  const first = await runtime({ ...limits, maxCandidates: 2 });
  assert.equal(first.status, "paused");
  assert.equal(first.dispatch.counts.accepted, 1);
  assert.equal(first.dispatch.continuation.nextKind, "management");
  assert.equal(first.dispatch.continuation.management, null);
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 1);
  p.cap = 2; // Explicit next-call synthetic policy change, not an automatic quota increase.
  const second = await runtime({ ...limits, continuation: first.dispatch.continuation });
  assert.equal(second.status, "processed");
  assert.equal(second.dispatch.counts.accepted, 1);
  assert.deepEqual(sent, ["Confirm your InternScout follows", "Manage your InternScout follows"]);
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 2);
}
