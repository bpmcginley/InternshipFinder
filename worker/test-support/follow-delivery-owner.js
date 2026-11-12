import assert from "node:assert/strict";
import {
  acquireFollowDeliveryOwner as acquire,
  finishFollowDeliveryOwner as finish,
} from "../src/follow-delivery-owner.js";
import { createOwnedFollowLinkRuntime as create } from "../src/follow-owned-runtime.js";
import { expireFollowManagementRequests } from "../src/follow-retention.js";
import { enqueueFollowManagementRequest } from "../src/follow-management-request.js";
import { config, seed } from "./follow-link-dispatch.js";
const limits = { maxCandidates: 1, maxExpired: 1 };
const empty = () => ({ confirmation: null, management: null, nextKind: "confirmation" });
const clean = (continuation = empty()) => ({
  status: "processed",
  cleanup: { status: "maintained", removed: 0 },
  dispatch: {
    status: "processed",
    counts: { examined: 0, accepted: 0, uncertain: 0, unavailable: 0, skipped: 0 },
    continuation,
  },
});
const row = (db) => db.prepare("SELECT * FROM follow_delivery_owner").first();
const policy = (db) => {
  const c = config(db);
  return { sending: true, cap: c.cap, confirmation: c.confirmation, management: c.management };
};
const email = (send = async () => ({ messageId: "synthetic" })) => ({ send });
async function reference(db, kind, id) {
  const value = await db
    .prepare(`SELECT id,expires_at FROM follow_${kind}_outbox WHERE id=?`)
    .bind(id)
    .first();
  await db
    .prepare(`UPDATE follow_delivery_owner SET ${kind}_id=?,${kind}_expires_at=?`)
    .bind(value.id, value.expires_at)
    .run();
  return value;
}
function observe(db, after = async (_sql, r) => r, afterBatch = async (_sql, r) => r) {
  const wrap = (s, sql) => ({
    raw: s,
    sql,
    bind: (...v) => wrap(s.bind(...v), sql),
    first: async (...v) => after(sql, await s.first(...v)),
    all: async () => after(sql, await s.all()),
    run: async () => after(sql, await s.run()),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (list) =>
      afterBatch(
        list.map((s) => s.sql),
        await db.batch(list.map((s) => s.raw)),
      ),
  };
}
export async function defaultAndInvalidBoundsHaveNoIo() {
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
  };
  for (const enabled of [undefined, false, 1, "true"])
    assert.equal((await create({ enabled, db })(limits)).status, "disabled");
  for (const input of [
    null,
    {},
    { ...limits, continuation: empty() },
    { ...limits, maxCandidates: 65 },
    { ...limits, maxExpired: 0 },
  ])
    assert.equal((await create({ enabled: true, db })(input)).status, "unavailable");
  assert.equal(calls, 0);
}
export async function independentInstancesShareOneTransportOwner(db) {
  await seed(db, "confirmation");
  let release, started;
  const gate = new Promise((r) => {
    release = r;
  });
  const reached = new Promise((r) => {
    started = r;
  });
  let sends = 0;
  const options = {
    enabled: true,
    db,
    policy: () => policy(db),
    email: email(async () => {
      sends++;
      started();
      await gate;
      return { messageId: "synthetic" };
    }),
  };
  // Keep presentation function identity stable for the runtime's policy fence.
  const p = policy(db);
  options.policy = () => p;
  const first = create(options)(limits);
  await reached;
  assert.equal((await create(options)(limits)).status, "held");
  assert.equal((await row(db)).phase, "running");
  release();
  assert.equal((await first).dispatch.counts.accepted, 1);
  assert.equal(sends, 1);
  assert.equal((await row(db)).phase, "ready");
}

export async function optionAccessorsCannotSplitOwnershipFromDispatch(db) {
  await seed(db, "confirmation");
  const reads = {},
    p = policy(db);
  let forbidden = 0,
    sends = 0;
  const differentDb = {
    prepare() {
      forbidden++;
      throw Error("wrong database");
    },
    batch() {
      forbidden++;
      throw Error("wrong database");
    },
  };
  const values = {
    enabled: true,
    db,
    email: email(async () => {
      sends++;
      return { messageId: "synthetic" };
    }),
    policy: () => p,
    clock: () => new Date(),
    transportTimeoutMs: 10000,
  };
  const options = {};
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(options, key, {
      enumerable: true,
      get() {
        reads[key] = (reads[key] || 0) + 1;
        return key === "db" && reads[key] > 1 ? differentDb : value;
      },
    });
  const result = await create(options)(limits);
  assert.equal(result.status, "processed");
  assert.equal(result.dispatch.counts.accepted, 1);
  assert.equal(sends, 1);
  assert.equal(forbidden, 0);
  assert.deepEqual(reads, Object.fromEntries(Object.keys(values).map((key) => [key, 1])));
  assert.equal((await row(db)).phase, "ready");
}
export async function concurrentCasAcknowledgesOnlyOneGeneration(db) {
  const results = await Promise.all([acquire(db), acquire(db)]);
  assert.equal(results.filter((r) => r.status === "acquired").length, 1);
  assert.equal((await row(db)).phase, "running");
}
export async function lostAcquisitionAckNeverInvokesAndStaysClosed(db) {
  await seed(db, "confirmation");
  let sends = 0;
  const wrapped = observe(db, undefined, async () => {
    throw Error("lost synthetic acknowledgement");
  });
  const p = policy(db);
  assert.equal(
    (
      await create({
        enabled: true,
        db: wrapped,
        policy: () => p,
        email: email(() => {
          sends++;
        }),
      })(limits)
    ).status,
    "unavailable",
  );
  assert.equal((await row(db)).phase, "running");
  assert.equal((await acquire(db)).status, "held");
  assert.equal(sends, 0);
}

export async function acquiredReceiptMustStillReportRunning(db) {
  for (const phase of ["ready", "held"]) {
    await db
      .prepare(
        "UPDATE follow_delivery_owner SET phase='ready',generation=lower(hex(randomblob(16)))",
      )
      .run();
    const wrapped = observe(db, undefined, async (_sql, results) => {
      results[1].results[0].phase = phase;
      return results;
    });
    assert.equal((await acquire(wrapped)).status, "unavailable");
    assert.equal((await row(db)).phase, "running");
  }
}
export async function lostReadyAckCannotHoldOrReplaySuccessor(db) {
  let lose = false;
  const wrapped = observe(db, async (sql, value) => {
    if (lose && sql.includes("SET phase='ready'")) throw Error("lost clean ack");
    return value;
  });
  const a = await acquire(wrapped);
  lose = true;
  assert.equal((await finish(a.ticket, clean(), limits)).status, "unavailable");
  assert.equal((await row(db)).phase, "ready");
  const b = await acquire(db),
    generation = (await row(db)).generation;
  assert.equal(b.status, "acquired");
  assert.equal((await finish(a.ticket, clean(), limits)).status, "unavailable");
  assert.equal((await row(db)).generation, generation);
  assert.equal((await row(db)).phase, "running");
}
export async function lostHoldAckCannotRelease(db) {
  const wrapped = observe(db, async (sql, value) => {
    if (sql.includes("SET phase='held'")) throw Error();
    return value;
  });
  const a = await acquire(wrapped);
  assert.equal((await finish(a.ticket, { status: "unavailable" }, limits)).status, "held");
  assert.equal((await row(db)).phase, "held");
  assert.equal((await acquire(db)).status, "held");
}
export async function processedUnavailableAndMalformedCountsStayHeld(db) {
  const a = await acquire(db),
    result = clean();
  result.dispatch.counts.examined = 1;
  result.dispatch.counts.unavailable = 1;
  assert.equal((await finish(a.ticket, result, limits)).status, "held");
  assert.equal((await row(db)).phase, "held");
}
export async function malformedReceiptCannotRelease(db) {
  const a = await acquire(db),
    result = clean();
  result.cleanup.removed = 2;
  assert.equal((await finish(a.ticket, result, limits)).status, "held");
  assert.equal((await row(db)).phase, "held");
}
export async function validMaintainedPolicyFlipPreservesRedactions(db) {
  const id = await seed(db, "management");
  await reference(db, "management", id);
  await db.prepare("UPDATE follow_delivery_owner SET next_kind='management'").run();
  const a = await acquire(db);
  await db.prepare("DELETE FROM follow_management_outbox WHERE id=?").bind(id).run();
  assert.equal(
    (
      await finish(
        a.ticket,
        { status: "maintained", cleanup: { status: "maintained", removed: 1 } },
        limits,
      )
    ).status,
    "ready",
  );
  const value = await row(db);
  assert.equal(value.management_id, null);
  assert.equal(value.next_kind, "management");
}
export async function actualSendingOffPassReleasesOnlyFreshOwner(db) {
  const options = { enabled: true, db, policy: () => ({ sending: false }) };
  assert.equal((await create(options)(limits)).status, "maintained");
  assert.equal((await row(db)).phase, "ready");
  const acquired = await acquire(db);
  assert.equal(acquired.status, "acquired");
  assert.equal((await create(options)(limits)).status, "held");
  assert.equal((await row(db)).phase, "running");
}

export async function policyFlipAfterFreshAcquisitionHasNoHandoffOrCursorWrite(db) {
  const id = await seed(db, "management");
  await reference(db, "management", id);
  await db.prepare("UPDATE follow_delivery_owner SET next_kind='management'").run();
  let p = policy(db),
    sends = 0;
  const wrapped = observe(db, undefined, async (sql, result) => {
    if (sql[0].startsWith("UPDATE follow_delivery_owner SET phase='running'")) {
      p = { sending: false };
      await db.prepare("DELETE FROM follow_management_outbox WHERE id=?").bind(id).run();
    }
    return result;
  });
  assert.equal(
    (
      await create({
        enabled: true,
        db: wrapped,
        policy: () => p,
        email: email(() => {
          sends++;
        }),
      })(limits)
    ).status,
    "maintained",
  );
  const saved = await row(db);
  assert.equal(saved.phase, "ready");
  assert.equal(saved.management_id, null);
  assert.equal(saved.next_kind, "management");
  assert.equal(sends, 0);
}
export async function restartPreservesFairTurnAndCapacityPause(db) {
  await seed(db, "confirmation");
  await seed(db, "management");
  const p = { ...policy(db), cap: 1 },
    sent = [];
  const options = {
    enabled: true,
    db,
    policy: () => p,
    email: email(async (e) => {
      sent.push(e.subject);
      return { messageId: "synthetic" };
    }),
  };
  const first = await create(options)({ ...limits, maxCandidates: 2 });
  assert.equal(first.status, "paused");
  assert.equal((await row(db)).next_kind, "management");
  p.cap = 2;
  assert.equal((await create(options)(limits)).dispatch.counts.accepted, 1);
  assert.deepEqual(sent, ["Confirm your InternScout follows", "Manage your InternScout follows"]);
}
export async function lateProviderAcceptanceCannotReleaseDurableHold(db) {
  await seed(db, "confirmation");
  let settle;
  const p = policy(db);
  const options = {
    enabled: true,
    db,
    policy: () => p,
    transportTimeoutMs: 10,
    email: email(
      () =>
        new Promise((r) => {
          settle = r;
        }),
    ),
  };
  assert.equal((await create(options)(limits)).status, "held");
  settle({ messageId: "synthetic late acceptance" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await create(options)(limits)).status, "held");
  assert.equal((await row(db)).phase, "held");
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 1);
}
export async function deletionCannotBeUndoneByRunningCompletion(db) {
  const id = await seed(db, "confirmation"),
    value = await reference(db, "confirmation", id);
  const a = await acquire(db);
  await db.prepare("DELETE FROM follow_subscribers").run();
  assert.equal((await row(db)).confirmation_id, null);
  assert.equal((await row(db)).phase, "running");
  assert.equal(
    (await finish(a.ticket, clean({ ...empty(), confirmation: value }), limits)).status,
    "ready",
  );
  assert.equal((await row(db)).confirmation_id, null);
}
export async function replacedExpiryAndIdClearOnlyExactCursor(db) {
  const id = await seed(db, "management"),
    value = await reference(db, "management", id);
  const a = await acquire(db);
  await db
    .prepare("UPDATE follow_management_outbox SET id=? WHERE id=?")
    .bind(crypto.randomUUID(), id)
    .run();
  assert.equal((await row(db)).management_id, null);
  assert.equal(
    (await finish(a.ticket, clean({ ...empty(), management: value }), limits)).status,
    "ready",
  );
  assert.equal((await row(db)).management_id, null);
}
export async function expiredCursorIsNullBeforeMaintenance(db) {
  const id = await seed(db, "management");
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id=?",
    )
    .bind(id)
    .run();
  await reference(db, "management", id);
  const a = await acquire(db);
  assert.equal(a.continuation.management, null);
  assert.equal((await row(db)).phase, "running");
}
export async function cursorExpiryMaintainsOnePhysicalRowUnderTrigger(db) {
  const id = await seed(db, "management");
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id=?",
    )
    .bind(id)
    .run();
  await reference(db, "management", id);
  await acquire(db);
  assert.deepEqual(await expireFollowManagementRequests(db, { enabled: true, maxRows: 1 }), {
    status: "maintained",
    removed: 1,
  });
  assert.equal((await row(db)).management_id, null);
  assert.equal((await row(db)).phase, "running");
  assert.equal(await db.prepare("SELECT count(*) n FROM follow_management_outbox").first("n"), 0);
}
export async function expiredManagementReplacementKeepsGenericAccepted(db) {
  const id = await seed(db, "management");
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id=?",
    )
    .bind(id)
    .run();
  await reference(db, "management", id);
  const subscriber = await db
    .prepare(
      "SELECT u.email FROM follow_subscribers u JOIN follow_management_outbox q ON q.subscriber_id=u.id WHERE q.id=?",
    )
    .bind(id)
    .first();
  assert.deepEqual(
    await enqueueFollowManagementRequest(db, subscriber, {
      enabled: true,
      ttlMs: 60000,
      dailyLimit: 50,
    }),
    { status: "accepted" },
  );
  assert.equal((await row(db)).management_id, null);
  assert.equal(await db.prepare("SELECT count(*) n FROM follow_management_outbox").first("n"), 1);
  assert.notEqual(await db.prepare("SELECT id FROM follow_management_outbox").first("id"), id);
}
export async function missingOwnerIsNeverRecreated(db) {
  await db.prepare("DELETE FROM follow_delivery_owner").run();
  assert.equal((await acquire(db)).status, "unavailable");
  assert.equal(await row(db), null);
}
export async function forgedAndConsumedTicketsCannotWrite(db) {
  const a = await acquire(db);
  assert.equal((await finish(Object.freeze({}), clean(), limits)).status, "unavailable");
  assert.equal((await row(db)).phase, "running");
  assert.equal((await finish(a.ticket, clean(), limits)).status, "ready");
  assert.equal((await finish(a.ticket, clean(), limits)).status, "unavailable");
}

export async function malformedCompletionTableNeverReleases(db) {
  const variants = [
    { status: "busy" },
    { status: "held" },
    { status: "disabled" },
    { status: "maintained" },
    { status: "maintained", cleanup: { status: "maintained", removed: 0 }, dispatch: {} },
  ];
  for (const mutate of [
    (r) => {
      r.dispatch.status = "paused";
    },
    (r) => {
      r.dispatch.counts.examined = 2;
    },
    (r) => {
      r.dispatch.counts.accepted = 1;
    },
    (r) => {
      r.dispatch.counts.uncertain = 1;
    },
    (r) => {
      r.dispatch.counts.skipped = -1;
    },
    (r) => {
      r.dispatch.counts.examined = "0";
    },
    (r) => {
      r.dispatch.continuation.nextKind = "other";
    },
    (r) => {
      r.dispatch.continuation.confirmation = { id: "bad", expires_at: "bad" };
    },
  ]) {
    const value = clean();
    mutate(value);
    variants.push(value);
  }
  for (const value of variants) {
    // Independent synthetic initial state, never a runtime reset API.
    await db
      .prepare(
        "UPDATE follow_delivery_owner SET phase='ready',generation=lower(hex(randomblob(16)))",
      )
      .run();
    const a = await acquire(db);
    assert.equal((await finish(a.ticket, value, limits)).status, "held");
    assert.equal((await row(db)).phase, "held");
  }
}

export async function corruptLegacyCursorFailsBeforeAcquisition(db) {
  await db
    .prepare(
      "UPDATE follow_delivery_owner SET confirmation_id=?,confirmation_expires_at='2028-01-01T00:00:00.000Z'",
    )
    .bind("x".repeat(36))
    .run();
  const before = await row(db);
  assert.equal((await acquire(db)).status, "unavailable");
  assert.deepEqual(await row(db), before);
}

export async function malformedPresenceScalarLeavesOwnerClosed(db) {
  const id = await seed(db, "confirmation");
  await reference(db, "confirmation", id);
  for (const bad of [undefined, "1", true, false, 0, 2, {}]) {
    await db
      .prepare(
        "UPDATE follow_delivery_owner SET phase='ready',generation=lower(hex(randomblob(16)))",
      )
      .run();
    const wrapped = observe(db, async (sql, result) =>
      sql.startsWith("SELECT 1 AS present") ? bad : result,
    );
    assert.equal((await acquire(wrapped)).status, "unavailable");
    assert.equal((await row(db)).phase, "running");
    assert.equal((await acquire(db)).status, "held");
  }
}

export async function completionRollbackPreservesRunningAndConsumesTicket(db) {
  const a = await acquire(db);
  await db
    .prepare(
      "CREATE TRIGGER owner_fixture_abort BEFORE UPDATE ON follow_delivery_owner WHEN NEW.phase='ready' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    )
    .run();
  try {
    assert.equal((await finish(a.ticket, clean(), limits)).status, "unavailable");
    assert.equal((await row(db)).phase, "running");
  } finally {
    await db.prepare("DROP TRIGGER owner_fixture_abort").run();
  }
  assert.equal((await finish(a.ticket, clean(), limits)).status, "unavailable");
  assert.equal((await acquire(db)).status, "held");
}

export async function claimOnlyUpdatesPreserveCursorAndBothResumeAfterRestart(db) {
  const c = await seed(db, "confirmation"),
    m = await seed(db, "management");
  const confirmation = await reference(db, "confirmation", c),
    management = await reference(db, "management", m);
  const a = await acquire(db),
    before = await row(db);
  await db
    .prepare("UPDATE follow_management_outbox SET claim_id=? WHERE id=?")
    .bind(crypto.randomUUID(), m)
    .run();
  assert.deepEqual(await row(db), before);
  assert.equal(
    (await finish(a.ticket, clean({ confirmation, management, nextKind: "management" }), limits))
      .status,
    "ready",
  );
  const next = await acquire(db);
  assert.deepEqual(next.continuation, { confirmation, management, nextKind: "management" });
}

export async function maintenanceWhileHeldOnlyRedactsExpiredReferences(db) {
  const id = await seed(db, "management");
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id=?",
    )
    .bind(id)
    .run();
  await reference(db, "management", id);
  const a = await acquire(db);
  await finish(a.ticket, { status: "unavailable" }, limits);
  const before = await row(db);
  assert.deepEqual(await expireFollowManagementRequests(db, { enabled: true, maxRows: 1 }), {
    status: "maintained",
    removed: 1,
  });
  const after = await row(db);
  assert.equal(after.phase, "held");
  assert.equal(after.generation, before.generation);
  assert.equal(after.next_kind, before.next_kind);
  assert.equal(after.management_id, null);
  assert.equal((await acquire(db)).status, "held");
}
