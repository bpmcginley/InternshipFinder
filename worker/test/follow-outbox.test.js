import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1 } from "./helpers.js";
import {
  requestFollow,
  mintFollowToken,
  confirmFollow,
  unsubscribeFollows,
  removeManagedFollow,
  deleteLinkedFollows,
} from "../src/follows.js";
import {
  queueFollowDigest,
  leaseFollowDigest,
  beginFollowDigestAttempt as beginWithClock,
  finishFollowDigestAttempt,
  expireFollowOutbox,
} from "../src/follow-outbox.js";

const beginFollowDigestAttempt = (db, key, id, lease, now) =>
  beginWithClock(db, key, id, lease, () => now);

const now = new Date("2026-11-11T12:00:00Z"),
  time = (ms) => new Date(+now + ms),
  DAY = 86400_000;
const catalog = { companies: new Set(["example-a", "example-b"]) },
  account = "a".repeat(64);
const key = await crypto.subtle.importKey(
  "raw",
  new Uint8Array(32).fill(7),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
async function follow(
  db,
  email = "reader@example.test",
  company = "example-a",
  ownerUserHash = null,
) {
  const r = await requestFollow(db, email, { kind: "company", company }, catalog, now);
  await confirmFollow(
    db,
    await mintFollowToken(
      db,
      r.subscriberId,
      "confirm",
      { scopeKey: r.scopeKey, ownerUserHash },
      now,
    ),
    now,
  );
  return r;
}
const refs = (r) => [{ scopeKey: r.scopeKey, roles: ["1".repeat(16)] }];
const queue = (db, r, at = now) => queueFollowDigest(db, r.subscriberId, refs(r), at);

test("queue stores only validated references, snapshots once per subscriber/day, and requires every scope's consent", async () => {
  const db = fakeD1(),
    a = await follow(db),
    b = await requestFollow(
      db,
      "reader@example.test",
      { kind: "company", company: "example-b" },
      catalog,
      now,
    );
  assert.equal(await queueFollowDigest(db, a.subscriberId, [...refs(a), ...refs(b)], now), null);
  const jobs = await Promise.all([queue(db, a), queue(db, a)]);
  assert.equal(jobs[0], jobs[1]);
  assert.equal(
    await queueFollowDigest(
      db,
      a.subscriberId,
      [{ scopeKey: a.scopeKey, roles: ["2".repeat(16)] }],
      now,
    ),
    null,
  );
  assert.equal((await rows(db, "follow_digest_outbox")).length, 1);
  assert.deepEqual(JSON.parse((await rows(db, "follow_digest_outbox"))[0].payload), refs(a));
  for (const bad of [
    [],
    [{ ...refs(a)[0], email: "reader@example.test" }],
    [{ scopeKey: a.scopeKey, roles: ["personal text"] }],
  ]) {
    await assert.rejects(queueFollowDigest(db, a.subscriberId, bad, now));
  }
  assert.ok(!JSON.stringify(await rows(db, "follow_digest_outbox")).includes("@"));
  await assert.rejects(
    queueFollowDigest(
      db,
      a.subscriberId,
      [
        {
          scopeKey: a.scopeKey,
          roles: Array.from({ length: 2000 }, (_, i) => i.toString(16).padStart(16, "0")),
        },
      ],
      now,
    ),
  );
  assert.equal(
    (await rows(db, "follow_digest_outbox")).length,
    1,
    "oversize snapshots are rejected, never truncated",
  );
});

test("actual attempt day deduplicates delayed and current-day jobs, then permits a new UTC day", async () => {
  const db = fakeD1(),
    r = await follow(db),
    yesterday = await queue(db, r),
    today = time(DAY);
  const current = await queue(db, r, today),
    oldLease = await leaseFollowDigest(db, yesterday, today);
  assert.equal(await beginFollowDigestAttempt(db, key, yesterday, oldLease, today), true);
  await finishFollowDigestAttempt(db, yesterday, oldLease, "accepted", today);
  const lease = await leaseFollowDigest(db, current, today);
  assert.equal(await beginFollowDigestAttempt(db, key, current, lease, today), false);
  assert.equal((await rows(db, "follow_digest_days")).length, 1);
  const midnight = new Date("2026-11-13T00:00:00Z");
  await expireFollowOutbox(db, midnight);
  assert.deepEqual(await rows(db, "follow_digest_days"), []);
  const fresh = await queue(db, r, midnight),
    freshLease = await leaseFollowDigest(db, fresh, midnight);
  assert.equal(await beginFollowDigestAttempt(db, key, fresh, freshLease, midnight), true);
});

test("daily HMAC marker survives unsubscribe and normalized-address resubscription without an identity link", async () => {
  const db = fakeD1(),
    r = await follow(db, " Reader@EXAMPLE.test "),
    job = await queue(db, r),
    lease = await leaseFollowDigest(db, job, now);
  assert.deepEqual(
    (
      await Promise.all([
        beginFollowDigestAttempt(db, key, job, lease, now),
        beginFollowDigestAttempt(db, key, job, lease, now),
      ])
    ).sort(),
    [false, true],
  );
  const unsub = await mintFollowToken(db, r.subscriberId, "unsubscribe", {}, now);
  await unsubscribeFollows(db, unsub, now);
  assert.deepEqual(await rows(db, "follow_digest_outbox"), []);
  const markers = await rows(db, "follow_digest_days");
  assert.deepEqual(Object.keys(markers[0]).sort(), ["expires_at", "marker"]);
  assert.match(markers[0].marker, /^[a-f0-9]{64}$/);
  const again = await follow(db),
    next = await queue(db, again),
    nextLease = await leaseFollowDigest(db, next, now);
  assert.equal(await beginFollowDigestAttempt(db, key, next, nextLease, now), false);
  assert.deepEqual(await rows(db, "follow_digest_days"), markers);
});

test("pre-attempt leases serialize work and can be reclaimed, but crashed/ambiguous attempts cannot retry", async () => {
  const db = fakeD1(),
    a = await follow(db),
    b = await follow(db, "other@example.test");
  const first = await queue(db, a),
    second = await queue(db, b),
    stale = await leaseFollowDigest(db, first, now);
  assert.equal(await leaseFollowDigest(db, second, now), null);
  const later = time(5 * 60_000),
    lease = await leaseFollowDigest(db, first, later);
  assert.ok(lease && lease !== stale);
  assert.equal(await beginFollowDigestAttempt(db, key, first, stale, later), false);
  assert.equal(await beginFollowDigestAttempt(db, key, first, lease, later), true);
  await expireFollowOutbox(db, time(10 * 60_000));
  assert.equal((await rows(db, "follow_digest_outbox"))[0].state, "uncertain");
  assert.equal(await leaseFollowDigest(db, first, time(11 * 60_000)), null);
  assert.equal(
    await finishFollowDigestAttempt(db, first, lease, "accepted", time(11 * 60_000)),
    false,
  );
  assert.ok(await leaseFollowDigest(db, second, time(11 * 60_000)));
});

test("selective or linked deletion cancels the aggregate and preserves any already claimed daily marker", async () => {
  for (const [mode, attempted] of [
    ["manage", false],
    ["linked", false],
    ["manage", true],
    ["linked", true],
  ]) {
    const db = fakeD1(),
      a = await follow(db, undefined, "example-a", account),
      b = await follow(db, undefined, "example-b");
    const job = await queueFollowDigest(db, a.subscriberId, [...refs(a), ...refs(b)], now),
      lease = await leaseFollowDigest(db, job, now);
    if (attempted) assert.equal(await beginFollowDigestAttempt(db, key, job, lease, now), true);
    if (mode === "manage")
      await removeManagedFollow(
        db,
        await mintFollowToken(db, a.subscriberId, "manage", {}, now),
        a.scopeKey,
        now,
      );
    else await deleteLinkedFollows(db, account);
    assert.deepEqual(
      (await rows(db, "follow_subscriptions")).map((s) => s.scope_key),
      [b.scopeKey],
    );
    const saved = (await rows(db, "follow_digest_outbox"))[0];
    assert.equal(saved.state, "cancelled");
    assert.equal(saved.payload, null);
    assert.equal(
      await queue(db, b),
      null,
      "cancelled snapshots cannot acknowledge replacement references",
    );
    assert.equal(await beginFollowDigestAttempt(db, key, job, lease, now), false);
    assert.equal((await rows(db, "follow_digest_days")).length, attempted ? 1 : 0);
    assert.equal(await finishFollowDigestAttempt(db, job, lease, "accepted", now), false);
  }
});

test("accepted/uncertain completion erases payload; seven-day cleanup and 48-hour stale cancellation are bounded", async () => {
  const db = fakeD1(),
    r = await follow(db),
    job = await queue(db, r),
    lease = await leaseFollowDigest(db, job, now);
  await beginFollowDigestAttempt(db, key, job, lease, now);
  assert.equal(await finishFollowDigestAttempt(db, job, lease, "accepted", now), true);
  assert.equal(await finishFollowDigestAttempt(db, job, lease, "accepted", now), false);
  assert.equal((await rows(db, "follow_digest_outbox"))[0].payload, null);
  assert.equal(
    await queue(db, r),
    null,
    "terminal snapshots are not acknowledgements of a new enqueue",
  );
  assert.equal((await rows(db, "follow_subscribers"))[0].last_sent_at, now.toISOString());
  const other = await follow(db, "other@example.test"),
    stale = await queue(db, other);
  assert.equal(await leaseFollowDigest(db, stale, time(2 * DAY)), null);
  await expireFollowOutbox(db, time(2 * DAY));
  assert.equal(
    (await rows(db, "follow_digest_outbox")).find((j) => j.id === stale).state,
    "cancelled",
  );
  await expireFollowOutbox(db, time(7 * DAY));
  assert.deepEqual(await rows(db, "follow_digest_outbox"), []);
});

test("failed attempt transition rolls back its daily marker; missing/wrong keys fail closed", async () => {
  const db = fakeD1(),
    r = await follow(db),
    job = await queue(db, r),
    lease = await leaseFollowDigest(db, job, now);
  await assert.rejects(beginFollowDigestAttempt(db, null, job, lease, now));
  const wrong = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(1),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  await assert.rejects(beginFollowDigestAttempt(db, wrong, job, lease, now));
  await db.exec(
    "CREATE TRIGGER reject_digest_attempt BEFORE UPDATE ON follow_digest_outbox WHEN NEW.state='attempting' BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await assert.rejects(beginFollowDigestAttempt(db, key, job, lease, now), /fixture/);
  assert.deepEqual(await rows(db, "follow_digest_days"), []);
  await db.exec("DROP TRIGGER reject_digest_attempt");
  assert.equal(await beginFollowDigestAttempt(db, key, job, lease, now), true);
  await finishFollowDigestAttempt(db, job, lease, "uncertain", now);
  assert.equal(await leaseFollowDigest(db, job, now), null);
});

test("an attempt lease cannot extend a digest snapshot beyond its 48-hour deadline", async () => {
  const db = fakeD1(),
    r = await follow(db),
    job = await queue(db, r),
    late = time(2 * DAY - 60_000);
  const lease = await leaseFollowDigest(db, job, late);
  assert.equal(await beginFollowDigestAttempt(db, key, job, lease, late), true);
  assert.equal(
    (await rows(db, "follow_digest_outbox"))[0].lease_until,
    time(2 * DAY).toISOString(),
  );
  assert.equal(await finishFollowDigestAttempt(db, job, lease, "accepted", time(2 * DAY)), false);
  await expireFollowOutbox(db, time(2 * DAY));
  assert.equal((await rows(db, "follow_digest_outbox"))[0].state, "uncertain");
});

test("unsubscribe between email lookup and atomic attempt cannot leave a marker or resurrect a job", async () => {
  const db = fakeD1(),
    r = await follow(db),
    job = await queue(db, r),
    lease = await leaseFollowDigest(db, job, now);
  const unsub = await mintFollowToken(db, r.subscriberId, "unsubscribe", {}, now),
    batch = db.batch.bind(db);
  let remove = true;
  db.batch = async (statements) => {
    if (remove) {
      remove = false;
      await unsubscribeFollows(db, unsub, now);
    }
    return batch(statements);
  };
  assert.equal(await beginFollowDigestAttempt(db, key, job, lease, now), false);
  assert.deepEqual(await rows(db, "follow_digest_outbox"), []);
  assert.deepEqual(await rows(db, "follow_digest_days"), []);
});

test("outbox source is unwired, holds no transport, and additive schema matches legacy SQL", () => {
  const source = readFileSync(new URL("../src/follow-outbox.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|sendMail|trySend|console\./);
  assert.doesNotMatch(
    readFileSync(new URL("../src/index.js", import.meta.url), "utf8"),
    /follow-outbox/,
  );
  const sql = readFileSync(
    new URL("../migrations/0003_follow_digest_outbox.sql", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  assert.ok(
    readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
      .replaceAll("\r\n", "\n")
      .includes(sql),
  );
});

test("lookup delayed across midnight uses fresh claim day, and a delay beyond lease expiry cannot attempt", async () => {
  for (const delay of [2000, 6 * 60_000]) {
    const db = fakeD1(),
      r = await follow(db),
      start = new Date("2026-11-11T23:59:59Z");
    const job = await queue(db, r, start),
      lease = await leaseFollowDigest(db, job, start);
    let current = start;
    const prepare = db.prepare;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (!sql.startsWith("SELECT u.email")) return statement;
      return {
        bind: (...values) => {
          const bound = statement.bind(...values);
          return {
            first: async (...args) => {
              const value = await bound.first(...args);
              current = new Date(+start + delay);
              return value;
            },
          };
        },
      };
    };
    const accepted = await beginWithClock(db, key, job, lease, () => current);
    assert.equal(accepted, delay === 2000);
    const markers = await rows(db, "follow_digest_days"),
      saved = (await rows(db, "follow_digest_outbox"))[0];
    if (accepted) {
      assert.equal(saved.attempted_at, current.toISOString());
      assert.equal(markers[0].expires_at, "2026-11-13T00:00:00.000Z");
    } else {
      assert.equal(saved.attempted_at, null);
      assert.deepEqual(markers, []);
    }
  }
});

test("HMAC preparation crossing midnight fails closed; a same-day claim lease ends at midnight", async () => {
  const db = fakeD1(),
    r = await follow(db),
    start = new Date("2026-11-11T23:59:59Z");
  const job = await queue(db, r, start),
    lease = await leaseFollowDigest(db, job, start);
  let reads = 0;
  assert.equal(
    await beginWithClock(db, key, job, lease, () => (reads++ ? new Date(+start + 2000) : start)),
    false,
  );
  assert.deepEqual(await rows(db, "follow_digest_days"), []);
  const fresh = fakeD1(),
    next = await follow(fresh),
    nextJob = await queue(fresh, next, start),
    nextLease = await leaseFollowDigest(fresh, nextJob, start);
  assert.equal(await beginFollowDigestAttempt(fresh, key, nextJob, nextLease, start), true);
  assert.equal(
    (await rows(fresh, "follow_digest_outbox"))[0].lease_until,
    "2026-11-12T00:00:00.000Z",
  );
  assert.equal(
    await finishFollowDigestAttempt(fresh, nextJob, nextLease, "accepted", new Date(+start + 1000)),
    false,
  );
});
