import assert from "node:assert/strict";
import { deliverFollowSnapshotDigest } from "../src/follow-digest-delivery.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import {
  requestFollow,
  mintFollowToken,
  confirmFollow,
  inspectFollowToken,
  unsubscribeFollows,
} from "../src/follows.js";
import { beginBudgetedFollowSnapshotAttempt } from "../src/follow-outbox.js";
import { reserveFollowSendAttempt } from "../src/follow-send-budget.js";
const at = new Date(),
  confirmed = new Date(+at - 86400000);
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
const role = {
  id: "1".repeat(16),
  company_key: "alpha",
  field_tags: ["biology"],
  states: ["MA"],
  first_seen: new Date(+at - 3600000).toISOString(),
  status: "open",
  company_name: "Fixture",
  title: "Fixture role",
  location: "Fixture town",
  apply_url: "https://example.test/1",
};
async function fixture(db, time = at) {
  const at = time,
    confirmed = new Date(+at - 86400000);
  const currentRole = { ...role, first_seen: new Date(+at - 3600000).toISOString() };
  const data = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: at.toISOString(),
      covers_after: new Date(+confirmed - 3600000).toISOString(),
      roles: [currentRole],
    }),
  );
  const sub = await requestFollow(
    db,
    "fixture@example.test",
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
  const job = await enqueueFollowSnapshot(
    db,
    sub.subscriberId,
    data,
    {
      catalog,
      limits,
      upperBound: at.toISOString(),
      maxProgressBytes: 4000,
      maxPendingBytes: 4000,
    },
    at,
  );
  assert.equal(job.status, "queued");
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  let now = +at,
    calls = 0;
  const messages = [];
  const present = async (input) => {
    assert.deepEqual(Object.keys(input).sort(), ["roles", "subscriberId"]);
    assert.equal(input.subscriberId, sub.subscriberId);
    assert.deepEqual(input.roles, [currentRole]);
    return {
      from: "Fixture <sender@example.test>",
      to: "must-not-use@example.test",
      matches: [],
      postalAddress: "1 Synthetic Avenue",
      origins: ["https://site.example.test"],
      links: {
        management: "https://site.example.test/manage/fixture",
        unsubscribe: "https://site.example.test/unsubscribe/fixture",
        matchingPage: "https://site.example.test/roles",
        publicShare: "https://site.example.test/share",
      },
    };
  };
  const options = {
    db,
    jobId: job.id,
    key,
    cap: 3,
    clock: () => new Date(now),
    catalog,
    limits,
    loadSnapshot: async () => data,
    present,
    transport: async (envelope) => {
      calls++;
      messages.push(envelope);
    },
  };
  return {
    sub,
    job: job.id,
    messages,
    options,
    calls: () => calls,
    setNow: (value) => (now = value),
    run: (overrides) => deliverFollowSnapshotDigest({ ...options, ...overrides }),
    row: () => db.prepare("SELECT * FROM follow_digest_outbox WHERE id=?").bind(job.id).first(),
    budget: () =>
      db.prepare("SELECT attempts FROM follow_send_budget WHERE slot=1").first("attempts"),
    watermark: () =>
      db
        .prepare("SELECT watermark FROM follow_scope_progress WHERE subscriber_id=?")
        .bind(sub.subscriberId)
        .first("watermark"),
  };
}
function intercept(db, onBatch) {
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => onBatch(statements, () => db.batch(statements)),
  };
}
export async function acceptedAndReplay(db) {
  const f = await fixture(db);
  const outcomes = await Promise.all([f.run(), f.run()]);
  assert.equal(outcomes.filter((x) => x.status === "accepted").length, 1);
  assert.equal(f.calls(), 1);
  assert.equal(f.messages[0].to, "fixture@example.test");
  assert.ok(f.messages[0].text.includes("Fixture: Fixture role"));
  assert.deepEqual(await f.run(), { status: "unavailable" });
  assert.equal(await f.budget(), 1);
  assert.equal(await f.watermark(), at.toISOString());
  assert.equal((await f.row()).payload, null);
}
export async function rejectedOrUnknown(db) {
  const f = await fixture(db);
  let calls = 0;
  assert.deepEqual(
    await f.run({
      transport: async () => {
        calls++;
        throw new Error("private recipient/provider detail");
      },
    }),
    { status: "uncertain" },
  );
  assert.equal(calls, 1);
  assert.equal((await f.row()).state, "uncertain");
  assert.equal(await f.watermark(), at.toISOString());
  assert.deepEqual(await f.run(), { status: "unavailable" });
}
export async function nonPromiseIsUncertain(db) {
  const f = await fixture(db);
  let calls = 0;
  assert.deepEqual(
    await f.run({
      transport: () => {
        calls++;
      },
    }),
    { status: "uncertain" },
  );
  assert.equal(calls, 1);
  assert.equal(await f.budget(), 1);
}
export async function pausedAndPrevalidation(db) {
  const f = await fixture(db);
  assert.deepEqual(await f.run({ present: async () => ({}) }), { status: "unavailable" });
  assert.equal(await f.budget(), null);
  f.setNow(+at + 300001);
  await reserveFollowSendAttempt(db, 1, new Date(+at + 300001));
  assert.deepEqual(await f.run({ cap: 1 }), { status: "paused" });
  assert.equal(f.calls(), 0);
  assert.equal((await f.row()).state, "leased");
  assert.equal(await f.watermark(), confirmed.toISOString());
}
export async function deletedBetweenClaimAndFinalRead(db) {
  const f = await fixture(db);
  const database = intercept(db, async (statements, run) => {
    const result = await run();
    if (statements.length === 7)
      await db.prepare("DELETE FROM follow_subscribers WHERE id=?").bind(f.sub.subscriberId).run();
    return result;
  });
  assert.deepEqual(await f.run({ db: database }), { status: "unavailable" });
  assert.equal(f.calls(), 0);
  assert.equal(await f.budget(), 1);
}
export async function consentChangedAfterClaim(db) {
  const f = await fixture(db);
  const database = intercept(db, async (statements, run) => {
    const result = await run();
    if (statements.length === 7)
      await db
        .prepare("UPDATE follow_subscriptions SET confirmed_at=? WHERE subscriber_id=?")
        .bind(new Date(+confirmed + 1).toISOString(), f.sub.subscriberId)
        .run();
    return result;
  });
  assert.deepEqual(await f.run({ db: database }), { status: "uncertain" });
  assert.equal(f.calls(), 0);
  assert.equal(await f.watermark(), confirmed.toISOString());
}
export async function recipientChangedAfterClaim(db) {
  const f = await fixture(db);
  const database = intercept(db, async (statements, run) => {
    const result = await run();
    if (statements.length === 7)
      await db
        .prepare("UPDATE follow_subscribers SET email=? WHERE id=?")
        .bind("changed@example.test", f.sub.subscriberId)
        .run();
    return result;
  });
  assert.deepEqual(await f.run({ db: database }), { status: "uncertain" });
  assert.equal(f.calls(), 0);
}
export async function delayedFinalRead(db) {
  const f = await fixture(db);
  const database = intercept(db, async (statements, run) => {
    const result = await run();
    if (statements.length === 1) f.setNow(+at + 300000);
    return result;
  });
  assert.deepEqual(await f.run({ db: database }), { status: "unavailable" });
  assert.equal(f.calls(), 0);
}
export async function ambiguousClaimResult(db) {
  const f = await fixture(db);
  const database = intercept(db, async (statements, run) => {
    const result = await run();
    if (statements.length === 7) throw new Error("Synthetic lost response");
    return result;
  });
  assert.deepEqual(await f.run({ db: database }), { status: "unavailable" });
  assert.equal(f.calls(), 0);
  assert.equal(await f.budget(), 1);
  assert.equal((await f.row()).state, "attempting");
}
export async function unsuccessfulFinalResult(db) {
  const f = await fixture(db);
  const database = intercept(db, async (statements, run) => {
    const result = await run();
    if (statements.length === 1) result[0].success = false;
    return result;
  });
  assert.deepEqual(await f.run({ db: database }), { status: "uncertain" });
  assert.equal(f.calls(), 0);
}

async function staleDatabaseClock(db, rollover, expiredJob = false) {
  const sqlNow = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at");
  const dbAt = new Date(sqlNow);
  const workerAt = rollover
    ? new Date(Date.parse(sqlNow.slice(0, 10) + "T00:00:00.000Z") - 1000)
    : new Date(+dbAt - 2000);
  const f = await fixture(db, workerAt);
  const database = intercept(db, async (statements, run) => {
    const result = await run();
    if (!rollover && statements.length === 7)
      await db
        .prepare(
          expiredJob
            ? "UPDATE follow_digest_outbox SET expires_at=? WHERE id=?"
            : "UPDATE follow_digest_outbox SET lease_until=? WHERE id=?",
        )
        .bind(new Date(+dbAt - 1000).toISOString(), f.job)
        .run();
    return result;
  });
  const result = await f.run({ db: database });
  assert.equal(
    f.calls(),
    0,
    "a lagging Worker clock cannot authorize transport after the database deadline",
  );
  assert.deepEqual(result, { status: "uncertain" });
  assert.equal((await f.row()).state, "uncertain");
  assert.equal(await f.budget(), 1);
  assert.equal(
    await f.watermark(),
    workerAt.toISOString(),
    "durable claimed uncertainty advances unchanged scopes without acceptance",
  );
  assert.equal((await f.row()).accepted_at, null);
}
export const databaseLeaseExpired = (db) => staleDatabaseClock(db, false);
export const databaseUtcRollover = (db) => staleDatabaseClock(db, true);

export const databaseJobExpired = (db) => staleDatabaseClock(db, false, true);

async function capabilityFixture(db) {
  const now = new Date(
    await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at"),
  );
  const f = await fixture(db, now);
  const oldManage = await mintFollowToken(db, f.sub.subscriberId, "manage", {}, now);
  const oldUnsubscribe = await mintFollowToken(db, f.sub.subscriberId, "unsubscribe", {}, now);
  const present = f.options.present;
  f.options.present = async (input) => ({
    ...(await present(input)),
    origins: ["https://site.example.test", "https://internscout.org"],
  });
  const raw = [];
  f.options.buildLinks = (credentials) => {
    raw.push({ ...credentials });
    assert.equal(Object.isFrozen(credentials), true);
    return {
      management: `https://internscout.org/follows/manage.html#token=${credentials.management}`,
      unsubscribe: `https://site.example.test/follows/unsubscribe?token=${credentials.unsubscribe}`,
    };
  };
  return Object.assign(f, { oldManage, oldUnsubscribe, raw, now });
}
const tokenRows = async (db) =>
  (await db.prepare("SELECT * FROM follow_tokens ORDER BY token_hash").all()).results;
async function clearCapabilities(db) {
  await db.batch(
    ["follow_subscribers", "follow_digest_days", "follow_send_budget"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
}

export async function capabilitiesAtomicSuccessAndOldUnsubscribe(db) {
  const f = await capabilityFixture(db);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.filter((r) => r.status === "accepted").length, 1);
  assert.equal(f.calls(), 1);
  const current = f.raw[0];
  assert.equal(await inspectFollowToken(db, f.oldManage, "manage", f.now), null);
  const managed = await inspectFollowToken(db, current.management, "manage", f.now);
  assert.equal(managed.subscriber_id, f.sub.subscriberId);
  const expiry = (await tokenRows(db)).find((r) => r.purpose === "manage").expires_at;
  const dbNow = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at");
  assert.ok(Date.parse(expiry) >= +f.now + 1800000);
  assert.ok(Date.parse(expiry) <= Date.parse(dbNow) + 1800000);
  assert.ok(await inspectFollowToken(db, current.unsubscribe, "unsubscribe", f.now));
  assert.ok(await inspectFollowToken(db, f.oldUnsubscribe, "unsubscribe", f.now));
  const stored = JSON.stringify(await tokenRows(db));
  for (const raw of Object.values(current)) assert.equal(stored.includes(raw), false);
  assert.ok(f.messages[0].text.includes(current.management));
  assert.equal(
    f.messages[0].headers["List-Unsubscribe"],
    `<https://site.example.test/follows/unsubscribe?token=${current.unsubscribe}>`,
  );
  assert.equal(await f.budget(), 1);
  assert.equal(await unsubscribeFollows(db, f.oldUnsubscribe, f.now), true);
  assert.equal((await tokenRows(db)).length, 0);
  assert.equal(await f.budget(), 1);
}

export async function capabilitiesPrevalidationAndPausePreserveOldTokens(db) {
  for (const invalid of [null, "async", "normalized", "foreign", "prefix", "query", "fragment"]) {
    await clearCapabilities(db);
    const f = await capabilityFixture(db),
      before = await tokenRows(db);
    const buildLinks =
      invalid === "async"
        ? async () => {
            throw Error("synthetic");
          }
        : (credentials) => ({
            management:
              invalid === "normalized"
                ? `https://internscout.org/${credentials.management}/../follows/manage.html`
                : invalid === "foreign"
                  ? `https://foreign.example.test/manage#token=${credentials.management}`
                  : ["prefix", "query", "fragment"].includes(invalid)
                    ? `https://internscout.org/follows/manage.html#token=${credentials.management}`
                    : "https://internscout.org/follows/manage.html#token=invalid",
            unsubscribe: `https://site.example.test/follows/unsubscribe?token=${invalid === "prefix" ? "fd_" : ""}${credentials.unsubscribe}${invalid === "query" ? "&extra=1" : invalid === "fragment" ? "#x" : ""}`,
          });
    assert.deepEqual(await f.run({ buildLinks }), { status: "unavailable" });
    assert.deepEqual(await tokenRows(db), before);
    assert.equal(await f.budget(), null);
    assert.equal(f.calls(), 0);
  }
  await clearCapabilities(db);
  const f = await capabilityFixture(db),
    before = await tokenRows(db);
  await reserveFollowSendAttempt(db, 1, f.now);
  assert.deepEqual(await f.run({ cap: 1 }), { status: "paused" });
  assert.deepEqual(await tokenRows(db), before);
  assert.equal((await f.row()).state, "leased");
  assert.equal(await f.budget(), 1);
}

export async function capabilitiesLastSlotAndExpiredSqlLeaseCannotIssue(db) {
  for (const mode of ["budget", "expired"]) {
    await clearCapabilities(db);
    const f = await capabilityFixture(db),
      before = await tokenRows(db);
    let claimed = false;
    const database = intercept(db, async (statements, run) => {
      if (statements.length === 10) {
        claimed = true;
        if (mode === "budget") await reserveFollowSendAttempt(db, 1, f.now);
        else
          await db
            .prepare(
              "UPDATE follow_digest_outbox SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            )
            .bind(f.job)
            .run();
      }
      return run();
    });
    assert.deepEqual(await f.run({ db: database, cap: 1 }), {
      status: mode === "budget" ? "paused" : "unavailable",
    });
    assert.equal(claimed, true);
    assert.deepEqual(await tokenRows(db), before);
    assert.equal(f.calls(), 0);
    assert.equal(await f.budget(), mode === "budget" ? 1 : 0);
    assert.equal((await db.prepare("SELECT * FROM follow_digest_days").all()).results.length, 0);
  }
}

export async function capabilitiesRollbackKeepsPreviousGeneration(db) {
  const f = await capabilityFixture(db),
    before = await tokenRows(db);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_digest_token_failure BEFORE INSERT ON follow_tokens WHEN NEW.purpose='unsubscribe' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    )
    .run();
  try {
    assert.deepEqual(await f.run(), { status: "unavailable" });
    assert.deepEqual(await tokenRows(db), before);
    assert.equal(await f.budget(), null);
    assert.equal((await f.row()).state, "leased");
    assert.equal((await db.prepare("SELECT * FROM follow_digest_days").all()).results.length, 0);
    assert.equal(f.calls(), 0);
  } finally {
    await db.prepare("DROP TRIGGER synthetic_digest_token_failure").run();
  }
}

export async function capabilitiesLostAcknowledgementCannotReissue(db) {
  const f = await capabilityFixture(db);
  const database = intercept(db, async (statements, run) => {
    const r = await run();
    if (statements.length === 10) throw Error("synthetic lost acknowledgement");
    return r;
  });
  assert.deepEqual(await f.run({ db: database }), { status: "unavailable" });
  assert.equal(f.calls(), 0);
  assert.equal(await f.budget(), 1);
  const before = await tokenRows(db),
    job = await f.row(),
    raw = f.raw[0];
  const hash = async (value) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  const credentials = {
    subscriberId: f.sub.subscriberId,
    email: "fixture@example.test",
    managementHash: await hash(raw.management),
    managementGeneration: raw.management.slice(0, 36),
    unsubscribeHash: await hash(raw.unsubscribe),
    unsubscribeGeneration: raw.unsubscribe.slice(0, 36),
  };
  assert.equal(
    await beginBudgetedFollowSnapshotAttempt(
      db,
      f.options.key,
      f.job,
      job.lease_token,
      3,
      f.options.clock,
      credentials,
    ),
    "unavailable",
  );
  assert.deepEqual(await tokenRows(db), before);
  assert.deepEqual(await f.run(), { status: "unavailable" });
  assert.equal((await f.row()).state, "attempting");
  assert.equal(f.calls(), 0);
}

export async function capabilitiesMalformedCommittedReceiptsHold(db) {
  for (const mode of ["hole", "false", "string", "getter", "wrong-count", "missing-token"]) {
    await clearCapabilities(db);
    const f = await capabilityFixture(db);
    const database = intercept(db, async (statements, run) => {
      const r = await run();
      if (statements.length === 10) {
        if (mode === "hole") delete r[5];
        if (mode === "false") r[5].success = false;
        if (mode === "string") r[5].meta.changes = "2";
        if (mode === "getter")
          Object.defineProperty(r[5].meta, "changes", {
            enumerable: true,
            get() {
              assert.fail("Do not invoke receipt getter");
            },
          });
        if (mode === "wrong-count") r[5].meta.changes = 1;
        if (mode === "missing-token") r[9].results = [];
      }
      return r;
    });
    assert.deepEqual(await f.run({ db: database }), { status: "unavailable" });
    assert.equal(f.calls(), 0);
    assert.equal(await f.budget(), 1);
    assert.equal((await f.row()).state, "attempting");
  }
}

export async function capabilitiesCurrentTokenAndConsentFence(db) {
  for (const mode of [
    "rotate",
    "coexist",
    "expire",
    "unsubscribe",
    "consent",
    "recipient",
    "delete",
    "generation",
  ]) {
    await clearCapabilities(db);
    const f = await capabilityFixture(db);
    const database = intercept(db, async (statements, run) => {
      const r = await run();
      if (statements.length === 10) {
        if (mode === "rotate") await mintFollowToken(db, f.sub.subscriberId, "manage", {}, f.now);
        if (mode === "coexist")
          await db
            .prepare(
              "INSERT INTO follow_tokens(token_hash,subscriber_id,purpose,scope_key,generation,expires_at) VALUES(?,?,'manage','',?,?)",
            )
            .bind(
              "f".repeat(64),
              f.sub.subscriberId,
              crypto.randomUUID(),
              new Date(+f.now + 1800000).toISOString(),
            )
            .run();
        if (mode === "expire")
          await db
            .prepare(
              "UPDATE follow_tokens SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE purpose='manage'",
            )
            .run();
        if (mode === "unsubscribe")
          await db.prepare("DELETE FROM follow_tokens WHERE purpose='unsubscribe'").run();
        if (mode === "consent")
          await db
            .prepare("UPDATE follow_subscriptions SET confirmed_at=? WHERE subscriber_id=?")
            .bind(new Date(+f.now - 1000).toISOString(), f.sub.subscriberId)
            .run();
        if (mode === "recipient")
          await db
            .prepare("UPDATE follow_subscribers SET email='changed@example.test' WHERE id=?")
            .bind(f.sub.subscriberId)
            .run();
        if (mode === "delete")
          await db
            .prepare("DELETE FROM follow_subscribers WHERE id=?")
            .bind(f.sub.subscriberId)
            .run();
        if (mode === "generation")
          await db
            .prepare("UPDATE follow_tokens SET generation=? WHERE purpose='manage'")
            .bind(crypto.randomUUID())
            .run();
      }
      return r;
    });
    assert.deepEqual(
      await f.run({ db: database }),
      { status: mode === "delete" ? "unavailable" : "uncertain" },
      mode,
    );
    assert.equal(f.calls(), 0, mode);
    assert.equal(await f.budget(), 1);
  }
}

export async function capabilitiesClaimBindsRenderedRecipient(db) {
  const f = await capabilityFixture(db),
    before = await tokenRows(db);
  const present = f.options.present;
  assert.deepEqual(
    await f.run({
      present: async (input) => {
        const result = await present(input);
        await db
          .prepare("UPDATE follow_subscribers SET email='changed@example.test' WHERE id=?")
          .bind(f.sub.subscriberId)
          .run();
        return result;
      },
    }),
    { status: "unavailable" },
  );
  assert.deepEqual(await tokenRows(db), before);
  assert.equal(await f.budget(), null);
  assert.equal(f.calls(), 0);
}

export async function capabilitiesFinalReceiptAndDeadlineStayClosed(db) {
  for (const mode of ["false", "hole", "row-accessor", "expired-reply"]) {
    await clearCapabilities(db);
    const f = await capabilityFixture(db);
    const database = intercept(db, async (statements, run) => {
      const r = await run();
      if (statements.length === 1) {
        if (mode === "false") r[0].success = false;
        if (mode === "hole") delete r[0].results[0];
        if (mode === "row-accessor")
          Object.defineProperty(r[0].results[0], "lease_until", {
            enumerable: true,
            get() {
              assert.fail("Do not invoke row accessor");
            },
          });
        if (mode === "expired-reply") f.setNow(+f.now + 1800000);
      }
      return r;
    });
    assert.deepEqual(await f.run({ db: database }), {
      status: mode === "expired-reply" ? "unavailable" : "uncertain",
    });
    assert.equal(f.calls(), 0);
    assert.equal(await f.budget(), 1);
  }
}

export async function capabilitiesConsentRaceBeforeClaimCannotIssue(db) {
  const f = await capabilityFixture(db),
    before = await tokenRows(db);
  const database = intercept(db, async (statements, run) => {
    if (statements.length === 10)
      await db
        .prepare("UPDATE follow_subscriptions SET confirmed_at=? WHERE subscriber_id=?")
        .bind(new Date(+f.now - 1000).toISOString(), f.sub.subscriberId)
        .run();
    return run();
  });
  assert.deepEqual(await f.run({ db: database }), { status: "unavailable" });
  assert.deepEqual(await tokenRows(db), before);
  assert.equal(await f.budget(), 0);
  assert.equal(f.calls(), 0);
  assert.equal((await db.prepare("SELECT * FROM follow_digest_days").all()).results.length, 0);
}

export async function capabilitiesRejectAsyncClockWithoutLeaking(db) {
  for (const phase of ["early", "after-claim"]) {
    await clearCapabilities(db);
    const f = await capabilityFixture(db);
    let reject = phase === "early";
    const database = intercept(db, async (statements, run) => {
      const result = await run();
      if (statements.length === 10) reject = true;
      return result;
    });
    assert.deepEqual(
      await f.run({
        db: database,
        clock: () => (reject ? Promise.reject(Error("synthetic")) : f.now),
      }),
      { status: "unavailable" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.calls(), 0);
    assert.equal(await f.budget(), phase === "early" ? null : 1);
  }
}
