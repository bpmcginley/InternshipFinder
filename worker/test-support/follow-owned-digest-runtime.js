import assert from "node:assert/strict";
import { createOwnedFollowDigestRuntime as create } from "../src/follow-owned-digest-runtime.js";
import { createOwnedFollowLinkRuntime } from "../src/follow-owned-runtime.js";
import {
  acquireFollowDeliveryOwner,
  finishFollowDigestOwner,
} from "../src/follow-delivery-owner.js";
import { config, seed } from "./follow-link-dispatch.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
const catalog = {
  companies: new Set(["alpha"]),
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
  maxWindowMs: 4 * 86400000,
};
async function fixture(db, n = 3) {
  const at = new Date(
    await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at"),
  );
  const confirmed = new Date(+at - 86400000),
    ids = [];
  const role = {
    id: "1".repeat(16),
    company_key: "alpha",
    field_tags: ["biology"],
    states: ["MA"],
    first_seen: new Date(+at - 3600000).toISOString(),
    status: "open",
    company_name: "Fixture",
    title: "Role",
    location: "Town",
    apply_url: "https://example.test/job",
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: at.toISOString(),
      covers_after: new Date(+confirmed - 3600000).toISOString(),
      roles: [role],
    }),
  );
  for (let i = 0; i < n; i++) {
    const sub = await requestFollow(
      db,
      `fixture${i}@example.test`,
      { kind: "company", company: "alpha" },
      catalog,
      confirmed,
    );
    const raw = await mintFollowToken(
      db,
      sub.subscriberId,
      "confirm",
      { scopeKey: sub.scopeKey },
      confirmed,
    );
    await confirmFollow(db, raw, confirmed);
    const queued = await enqueueFollowSnapshot(
      db,
      sub.subscriberId,
      bytes,
      {
        catalog,
        limits,
        upperBound: at.toISOString(),
        maxProgressBytes: 4000,
        maxPendingBytes: 4000,
      },
      at,
    );
    assert.equal(queued.status, "queued");
    ids.push(queued.id);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const present = async () => ({
    from: "sender@example.test",
    postalAddress: "1 Synthetic Avenue",
    origins: ["https://example.test"],
    links: {
      management: "https://example.test/manage",
      unsubscribe: "https://example.test/unsubscribe",
      matchingPage: "https://example.test/matches",
      publicShare: "https://example.test/share",
    },
  });
  const p = { sending: true, cap: 20, present };
  let calls = 0;
  const options = {
    enabled: true,
    db,
    key,
    catalog,
    limits,
    loadSnapshot: async () => bytes,
    clock: () => new Date(+at),
    policy: () => p,
    email: {
      send: async () => {
        calls++;
        return { messageId: "synthetic" };
      },
    },
  };
  return {
    ids,
    options,
    policy: p,
    calls: () => calls,
    run: (changes) => create({ ...options, ...changes })(),
  };
}
const owner = (db) => db.prepare("SELECT * FROM follow_delivery_owner").first();
const reset = (db) => db.prepare("UPDATE follow_delivery_owner SET phase='ready'").run(); // Test fixture only.
function wrap(db, batch = async (_sql, result) => result, run = async (_sql, result) => result) {
  const bound = (s, sql) => ({
    raw: s,
    sql,
    bind: (...args) => bound(s.bind(...args), sql),
    first: (...args) => s.first(...args),
    all: () => s.all(),
    run: async () => run(sql, await s.run()),
  });
  return {
    prepare: (sql) => bound(db.prepare(sql), sql),
    batch: async (statements) =>
      batch(
        statements.map((s) => s.sql),
        await db.batch(statements.map((s) => s.raw)),
      ),
  };
}
export async function disabledAndInvalidPolicyNoIo() {
  let io = 0;
  const db = {
    prepare() {
      io++;
      throw Error();
    },
    batch() {
      io++;
      throw Error();
    },
  };
  for (const enabled of [undefined, false, 1, "true"])
    assert.equal((await create({ enabled, db })()).status, "disabled");
  for (const p of [{ sending: false }, { sending: true, cap: 0 }, null]) {
    const r = await create({
      enabled: true,
      db,
      policy: () => p,
      loadSnapshot: async () => null,
    })();
    assert.equal(r.status, p?.sending === false ? "disabled" : "unavailable");
  }
  assert.equal(io, 0);
}
export async function oneCandidateAndCleanEmpty(db) {
  const f = await fixture(db, 2);
  assert.deepEqual(await f.run(), { status: "processed", counts: { accepted: 1 } });
  assert.equal(f.calls(), 1);
  assert.equal(
    await db.prepare("SELECT count(*) n FROM follow_digest_outbox WHERE state='queued'").first("n"),
    1,
  );
  assert.equal((await owner(db)).phase, "ready");
  assert.deepEqual(await f.run(), { status: "processed", counts: { accepted: 1 } });
  assert.deepEqual(await f.run(), { status: "processed", counts: {} });
  assert.equal(f.calls(), 2);
}
export async function digestAndLinkContendAndPreserveCursors(db) {
  const f = await fixture(db, 2);
  const id = await seed(db, "management");
  const ref = await db
    .prepare("SELECT id,expires_at FROM follow_management_outbox WHERE id=?")
    .bind(id)
    .first();
  await db
    .prepare(
      "UPDATE follow_delivery_owner SET next_kind='management',management_id=?,management_expires_at=?",
    )
    .bind(id, ref.expires_at)
    .run();
  let release, started;
  const gate = new Promise((r) => {
    release = r;
  });
  const reached = new Promise((r) => {
    started = r;
  });
  let calls = 0;
  const email = {
    send: async () => {
      calls++;
      started();
      await gate;
      return { messageId: "synthetic" };
    },
  };
  const active = f.run({ email });
  await reached;
  const p = config(db);
  assert.equal(
    (
      await createOwnedFollowLinkRuntime({
        enabled: true,
        db,
        email,
        policy: () => ({
          sending: true,
          cap: p.cap,
          confirmation: p.confirmation,
          management: p.management,
        }),
      })({ maxCandidates: 1, maxExpired: 1 })
    ).status,
    "held",
  );
  assert.equal((await f.run()).status, "held");
  release();
  assert.equal((await active).counts.accepted, 1);
  const after = await owner(db);
  assert.equal(calls, 1);
  assert.equal(after.management_id, id);
  assert.equal(after.management_expires_at, ref.expires_at);
  assert.equal(after.next_kind, "management");
}
export async function linkAcquisitionBlocksDigest(db) {
  const f = await fixture(db, 1);
  await seed(db, "confirmation");
  let release, started;
  const gate = new Promise((r) => {
    release = r;
  });
  const reached = new Promise((r) => {
    started = r;
  });
  const p = config(db);
  const runtime = createOwnedFollowLinkRuntime({
    enabled: true,
    db,
    policy: () => ({
      sending: true,
      cap: p.cap,
      confirmation: p.confirmation,
      management: p.management,
    }),
    email: {
      send: async () => {
        started();
        await gate;
        return { messageId: "synthetic" };
      },
    },
  });
  const active = runtime({ maxCandidates: 1, maxExpired: 1 });
  await reached;
  assert.equal((await f.run()).status, "held");
  assert.equal(f.calls(), 0);
  release();
  assert.equal((await active).status, "processed");
}
export async function uncertaintyHoldsAcrossInstances(db) {
  const f = await fixture(db, 2);
  let sends = 0;
  assert.equal(
    (
      await f.run({
        email: {
          send: async () => {
            sends++;
            throw Error("synthetic");
          },
        },
      })
    ).status,
    "held",
  );
  assert.equal((await owner(db)).phase, "held");
  assert.equal((await f.run()).status, "held");
  assert.equal(sends, 1);
  assert.equal(f.calls(), 0);
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM follow_digest_outbox WHERE state='uncertain'")
      .first("n"),
    1,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM follow_digest_outbox WHERE state='queued'").first("n"),
    1,
  );
}
export async function terminalFailedSuccessAndLostAckHold(db) {
  const f = await fixture(db, 2);
  for (const mode of ["failed", "lost"]) {
    const proxy = wrap(db, async (sql, rows) => {
      if (sql[1]?.startsWith("UPDATE follow_digest_outbox SET state=?")) {
        if (mode === "lost") throw Error("synthetic acknowledgement lost");
        return [rows[0], { ...rows[1], success: false }];
      }
      return rows;
    });
    assert.equal((await f.run({ db: proxy })).status, "held");
    assert.equal((await owner(db)).phase, "held");
    assert.equal((await f.run()).status, "held");
    await reset(db);
  }
  assert.equal(f.calls(), 2);
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM follow_digest_outbox WHERE state='accepted'")
      .first("n"),
    2,
  );
}
export async function malformedTerminalReturningHolds(db) {
  const f = await fixture(db, 4);
  for (const results of [[], new Array(1), [{ changed: "1" }], [{ changed: 1, extra: 1 }]]) {
    const proxy = wrap(db, async (sql, rows) =>
      sql[1]?.startsWith("UPDATE follow_digest_outbox SET state=?")
        ? [rows[0], { ...rows[1], results }]
        : rows,
    );
    assert.equal((await f.run({ db: proxy })).status, "held");
    await reset(db);
  }
  assert.equal(f.calls(), 4);
}
export async function acquisitionLostAckNeverInvokes(db) {
  const f = await fixture(db, 1);
  const proxy = wrap(db, async (sql, rows) => {
    if (sql[0]?.startsWith("UPDATE follow_delivery_owner SET phase='running'")) throw Error("lost");
    return rows;
  });
  assert.equal((await f.run({ db: proxy })).status, "unavailable");
  assert.equal(f.calls(), 0);
  assert.equal((await owner(db)).phase, "running");
  assert.equal((await f.run()).status, "held");
}
export async function cleanCompletionLostAckDoesNotCompensate(db) {
  const f = await fixture(db, 1);
  const proxy = wrap(db, undefined, async (sql, row) => {
    if (sql.startsWith("UPDATE follow_delivery_owner SET phase='ready'")) throw Error("lost");
    return row;
  });
  assert.equal((await f.run({ db: proxy })).status, "unavailable");
  assert.equal((await owner(db)).phase, "ready");
  assert.deepEqual(await f.run(), { status: "processed", counts: {} });
  assert.equal(f.calls(), 1);
}
export async function optionDbCapturedOnce(db) {
  const f = await fixture(db, 1);
  let reads = 0,
    forbidden = 0;
  const options = {
    ...f.options,
    get db() {
      reads++;
      return reads === 1
        ? db
        : {
            prepare() {
              forbidden++;
              throw Error();
            },
          };
    },
  };
  assert.equal((await create(options)()).counts.accepted, 1);
  assert.equal(reads, 1);
  assert.equal(forbidden, 0);
}
export async function policyRotationBeforeTransportHolds(db) {
  const f = await fixture(db, 1);
  const original = f.policy.present;
  f.policy.present = async (args) => {
    f.policy.sending = false;
    return original(args);
  };
  assert.equal((await f.run()).status, "held");
  assert.equal(f.calls(), 0);
  assert.equal((await owner(db)).phase, "held");
}
export async function concurrentRedactionSurvivesDigestCompletion(db) {
  const f = await fixture(db, 1);
  const id = await seed(db, "management");
  const ref = await db
    .prepare("SELECT expires_at FROM follow_management_outbox WHERE id=?")
    .bind(id)
    .first();
  await db
    .prepare("UPDATE follow_delivery_owner SET management_id=?,management_expires_at=?")
    .bind(id, ref.expires_at)
    .run();
  const send = f.options.email.send;
  const email = {
    send: async () => {
      await db.prepare("DELETE FROM follow_management_outbox WHERE id=?").bind(id).run();
      return send();
    },
  };
  assert.equal((await f.run({ email })).counts.accepted, 1);
  assert.equal((await owner(db)).management_id, null);
}
export async function digestCompletionCountsAndTicketAreStrict(db) {
  for (const result of [
    { status: "processed", counts: { uncertain: 1 } },
    { status: "processed", counts: { unavailable: 1 } },
    { status: "processed", counts: { accepted: 2 } },
    { status: "processed", counts: { accepted: 1, paused: 1 } },
    { status: "paused", counts: {} },
    { status: "processed", counts: { paused: 1 } },
    { status: "processed", counts: { accepted: "1" } },
    { status: "unavailable", counts: {} },
  ]) {
    const a = await acquireFollowDeliveryOwner(db);
    assert.equal(a.status, "acquired");
    assert.equal((await finishFollowDigestOwner(a.ticket, result)).status, "held");
    assert.equal(
      (await finishFollowDigestOwner(a.ticket, { status: "processed", counts: {} })).status,
      "unavailable",
    );
    await reset(db);
  }
  const a = await acquireFollowDeliveryOwner(db);
  assert.equal(
    (await finishFollowDigestOwner(a.ticket, { status: "paused", counts: { paused: 1 } })).status,
    "ready",
  );
}

export async function exhaustedSharedBudgetPausesCleanly(db) {
  const f = await fixture(db, 2);
  f.policy.cap = 1;
  assert.equal((await f.run()).counts.accepted, 1);
  assert.deepEqual(await f.run(), { status: "paused", counts: { paused: 1 } });
  assert.equal(f.calls(), 1);
  assert.equal((await owner(db)).phase, "ready");
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 1);
}
export async function timeoutAndLateAcceptanceCannotReleaseOwner(db) {
  const f = await fixture(db, 2);
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  let calls = 0;
  const email = {
    send: () => {
      calls++;
      return pending;
    },
  };
  assert.equal((await f.run({ email, transportTimeoutMs: 10 })).status, "held");
  assert.equal((await owner(db)).phase, "held");
  resolve({ messageId: "synthetic-late" });
  await pending;
  await Promise.resolve();
  assert.equal((await f.run()).status, "held");
  assert.equal(calls, 1);
  assert.equal(f.calls(), 0);
}
export async function terminalRollbackLeavesAttemptAndClosedOwner(db) {
  const f = await fixture(db, 1);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_digest_terminal_failure BEFORE UPDATE OF state ON follow_digest_outbox WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    )
    .run();
  try {
    assert.equal((await f.run()).status, "held");
    assert.equal((await owner(db)).phase, "held");
    assert.equal(
      await db
        .prepare("SELECT state FROM follow_digest_outbox WHERE id=?")
        .bind(f.ids[0])
        .first("state"),
      "attempting",
    );
    assert.equal(
      await db
        .prepare("SELECT count(*) n FROM follow_subscribers WHERE last_sent_at IS NOT NULL")
        .first("n"),
      0,
    );
    assert.equal(f.calls(), 1);
    assert.equal((await f.run()).status, "held");
  } finally {
    await db.prepare("DROP TRIGGER synthetic_digest_terminal_failure").run();
  }
}
