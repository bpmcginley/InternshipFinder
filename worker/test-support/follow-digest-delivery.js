import assert from "node:assert/strict";
import { deliverFollowSnapshotDigest } from "../src/follow-digest-delivery.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";
import { reserveFollowSendAttempt } from "../src/follow-send-budget.js";
const at = new Date("2026-11-11T12:00:00.000Z"),
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
  first_seen: "2026-11-11T00:00:00.000Z",
  status: "open",
  company_name: "Fixture",
  title: "Fixture role",
  location: "Fixture town",
  apply_url: "https://example.test/1",
};
const data = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    complete: true,
    generated_at: at.toISOString(),
    covers_after: "2026-11-10T00:00:00.000Z",
    roles: [role],
  }),
);
async function fixture(db) {
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
    assert.deepEqual(input.roles, [role]);
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
