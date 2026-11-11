import assert from "node:assert/strict";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import {
  beginBudgetedFollowSnapshotAttempt as begin,
  expireFollowOutbox,
  leaseFollowDigest,
  queueFollowDigest,
} from "../src/follow-outbox.js";
import { reserveFollowSendAttempt as reserve } from "../src/follow-send-budget.js";
import {
  confirmFollow,
  mintFollowToken,
  requestFollow,
  unsubscribeFollows,
} from "../src/follows.js";

const now = new Date("2026-11-11T12:00:00.000Z");
const confirmedAt = new Date("2026-11-10T12:00:00.000Z");
const catalog = {
  companies: new Set(["alpha", "beta"]),
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
  maxWindowMs: 4 * 86400_000,
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
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const budget = async (db) => (await rows(db, "follow_send_budget"))[0];
const job = (db, id) =>
  db.prepare("SELECT * FROM follow_digest_outbox WHERE id=?").bind(id).first();

async function confirm(db, email, company) {
  const sub = await requestFollow(db, email, { kind: "company", company }, catalog, confirmedAt);
  const raw = await mintFollowToken(
    db,
    sub.subscriberId,
    "confirm",
    { scopeKey: sub.scopeKey },
    confirmedAt,
  );
  await confirmFollow(db, raw, confirmedAt);
  return sub;
}

async function fixture(db, { at = now, email = "fixture@example.test", legacy = false } = {}) {
  const sub = await confirm(db, email, "alpha");
  const refs = [{ scopeKey: sub.scopeKey, roles: [role.id] }];
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: at.toISOString(),
      covers_after: "2026-11-10T00:00:00.000Z",
      roles: [role],
    }),
  );
  const id = legacy
    ? await queueFollowDigest(db, sub.subscriberId, refs, at)
    : (
        await enqueueFollowSnapshot(
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
        )
      ).id;
  assert.ok(id);
  const lease = await leaseFollowDigest(db, id, at);
  assert.ok(lease);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { ...sub, id, lease, key, at, email };
}

const claim = (db, f, cap, clock = () => f.at) => begin(db, f.key, f.id, f.lease, cap, clock);
function intercept(db, { before, after } = {}) {
  return {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      await before?.();
      const result = await db.batch(statements);
      await after?.();
      return result;
    },
  };
}

export async function budgetedConcurrency(db) {
  const f = await fixture(db);
  for (const invalidCap of [undefined, null, 0, -1, 1.5, Infinity, "1"])
    assert.equal(await claim(db, f, invalidCap), "unavailable");
  assert.equal(await budget(db), undefined);
  const contenders = await Promise.all([
    claim(db, f, 2),
    claim(db, f, 2),
    reserve(db, 2, now),
    reserve(db, 2, now),
  ]);
  assert.equal(contenders.filter((value) => value === true || value === "claimed").length, 2);
  assert.equal((await budget(db)).attempts, 2);
  const claimed = contenders.filter((value) => value === "claimed").length;
  assert.ok(claimed <= 1);
  assert.equal((await rows(db, "follow_digest_days")).length, claimed);
  assert.equal((await job(db, f.id)).state, claimed ? "attempting" : "leased");
  assert.equal((await rows(db, "follow_pending_progress")).length, 1);
  assert.equal((await rows(db, "follow_scope_progress"))[0].watermark, confirmedAt.toISOString());
}

export async function budgetedPauseAndRollover(db) {
  const last = new Date("2026-11-11T23:59:59.999Z"),
    next = new Date(+last + 1);
  const f = await fixture(db, { at: last });
  assert.equal(await reserve(db, 2, last), true);
  assert.equal(await reserve(db, 2, last), true);
  const original = await job(db, f.id);
  assert.equal(await claim(db, f, 1), "paused"); // Lowered cap preserves spent slots.
  assert.deepEqual(await job(db, f.id), original);
  assert.equal((await rows(db, "follow_digest_days")).length, 0);
  assert.equal((await rows(db, "follow_pending_progress")).length, 1);
  assert.equal((await budget(db)).attempts, 2);
  assert.equal(await claim(db, f, 1, () => next), "claimed");
  assert.equal(await reserve(db, 1, next), false);
  assert.equal(await claim(db, f, 2, () => last), "unavailable");
  assert.equal((await budget(db)).attempts, 1);
  assert.equal((await rows(db, "follow_digest_days")).length, 1);
}

export async function budgetedExactConsent(db) {
  const f = await fixture(db);
  const extraScope = intercept(db, { before: () => confirm(db, f.email, "beta") });
  assert.equal(await claim(extraScope, f, 1), "unavailable");
  assert.equal((await job(db, f.id)).state, "cancelled");
  assert.equal((await budget(db)).attempts, 0);
  const g = await fixture(db, { email: "second@example.test" });
  const token = await mintFollowToken(db, g.subscriberId, "unsubscribe", {}, now);
  const removed = intercept(db, { before: () => unsubscribeFollows(db, token, now) });
  assert.equal(await claim(removed, g, 1), "unavailable");
  assert.equal(await job(db, g.id), null);
  assert.equal((await rows(db, "follow_digest_days")).length, 0);
  assert.equal((await budget(db)).attempts, 0);
  const legacy = await fixture(db, { email: "legacy@example.test", legacy: true });
  assert.equal(await claim(db, legacy, 1), "unavailable");
  assert.equal((await job(db, legacy.id)).state, "cancelled");
  assert.equal((await budget(db)).attempts, 0);
}

export async function budgetedClockFences(db) {
  const last = new Date("2026-11-11T23:59:59.999Z"),
    next = new Date(+last + 1);
  const f = await fixture(db, { at: last });
  for (const afterHmac of [next, new Date(+last - 1), new Date(NaN)]) {
    let samples = 0;
    assert.equal(await claim(db, f, 1, () => (samples++ ? afterHmac : last)), "unavailable");
    assert.equal(await budget(db), undefined);
    assert.equal((await job(db, f.id)).state, "leased");
  }
  let time = last;
  const late = intercept(db, {
    after: () => {
      time = next;
    },
  });
  assert.equal(await claim(late, f, 1, () => time), "unavailable");
  assert.equal((await job(db, f.id)).state, "attempting");
  assert.equal((await budget(db)).attempts, 1);
  assert.equal((await rows(db, "follow_digest_days")).length, 1);
  await expireFollowOutbox(db, next);
  assert.equal((await job(db, f.id)).state, "uncertain");
  assert.equal(await claim(db, f, 1, () => next), "unavailable");
  assert.equal((await budget(db)).attempts, 0);
}

export async function budgetedStoredTimeAndDeadline(db) {
  const f = await fixture(db);
  const newer = new Date(+now + 1);
  assert.equal(await reserve(db, 2, newer), true);
  assert.equal(await claim(db, f, 2), "unavailable");
  assert.equal((await job(db, f.id)).state, "leased");
  assert.equal((await rows(db, "follow_digest_days")).length, 0);
  assert.equal((await budget(db)).attempts, 1);

  const deadline = new Date(+now + 2);
  await db
    .prepare("UPDATE follow_digest_outbox SET expires_at=? WHERE id=?")
    .bind(deadline.toISOString(), f.id)
    .run();
  let time = newer;
  const late = intercept(db, {
    after: () => {
      time = deadline;
    },
  });
  assert.equal(await claim(late, f, 2, () => time), "unavailable");
  assert.equal((await job(db, f.id)).state, "attempting");
  assert.equal((await budget(db)).attempts, 2);
  await expireFollowOutbox(db, deadline);
  assert.equal((await job(db, f.id)).state, "uncertain");
}

export async function budgetedRollbackAndAmbiguity(db) {
  const f = await fixture(db);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_digest_debit_failure BEFORE UPDATE OF attempts ON follow_send_budget " +
        "WHEN NEW.attempts>OLD.attempts BEGIN SELECT RAISE(ABORT,'synthetic_debit_failure'); END",
    )
    .run();
  try {
    assert.equal(await claim(db, f, 1), "unavailable");
    assert.equal(await budget(db), undefined);
    assert.equal((await rows(db, "follow_digest_days")).length, 0);
    assert.equal((await job(db, f.id)).state, "leased");
  } finally {
    await db.prepare("DROP TRIGGER synthetic_digest_debit_failure").run();
  }
  const lost = intercept(db, {
    after() {
      throw new Error("synthetic response lost after commit");
    },
  });
  assert.equal(await claim(lost, f, 1), "unavailable");
  assert.equal((await job(db, f.id)).state, "attempting");
  assert.equal((await budget(db)).attempts, 1);
  assert.equal((await rows(db, "follow_digest_days")).length, 1);
  assert.equal(await claim(db, f, 3), "unavailable");
  assert.equal((await budget(db)).attempts, 1);

  const raw = await mintFollowToken(db, f.subscriberId, "unsubscribe", {}, now);
  await unsubscribeFollows(db, raw, now);
  const fresh = await fixture(db);
  assert.equal(await claim(db, fresh, 3), "unavailable");
  assert.equal((await job(db, fresh.id)).state, "cancelled");
  assert.equal((await budget(db)).attempts, 1);
  assert.equal((await rows(db, "follow_digest_days")).length, 1);
}
