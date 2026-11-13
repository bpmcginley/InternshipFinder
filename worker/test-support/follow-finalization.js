import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import {
  confirmFollow,
  mintFollowToken,
  requestFollow,
  removeManagedFollow,
  unsubscribeFollows,
} from "../src/follows.js";
import {
  beginFollowSnapshotAttempt,
  leaseFollowDigest,
  finishFollowDigestAttempt,
  expireFollowOutbox,
} from "../src/follow-outbox.js";

const start = new Date("2026-11-10T12:00:00.000Z"),
  now = new Date("2026-11-11T12:00:00.000Z");
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
  maxWindowMs: 5 * 86400_000,
};
const key = () =>
  crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const progress = (db) =>
  db
    .prepare("SELECT * FROM follow_scope_progress ORDER BY scope_key")
    .all()
    .then((r) => r.results);
const reset = async (db) => {
  await db.prepare("DELETE FROM follow_subscribers").run();
  await db.prepare("DELETE FROM follow_digest_days").run();
};
async function follow(db, company = "alpha") {
  const r = await requestFollow(
    db,
    "fixture@example.test",
    { kind: "company", company },
    catalog,
    start,
  );
  await confirmFollow(
    db,
    await mintFollowToken(db, r.subscriberId, "confirm", { scopeKey: r.scopeKey }, start),
    start,
  );
  return r;
}
async function enqueue(db, id, at = now) {
  const input = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      complete: true,
      generated_at: at.toISOString(),
      covers_after: "2026-11-10T00:00:00.000Z",
      roles: ["alpha", "beta"].map((company_key, i) => ({
        id: String(i + 1).repeat(16),
        company_key,
        field_tags: ["biology"],
        states: ["MA"],
        first_seen: "2026-11-11T00:00:00.000Z",
        status: "open",
        company_name: "Fixture",
        title: "Fixture role",
        location: "Fixture place",
        apply_url: `https://example.test/${i}`,
      })),
    }),
  );
  return enqueueFollowSnapshot(
    db,
    id,
    input,
    {
      catalog,
      limits,
      upperBound: at.toISOString(),
      maxProgressBytes: 4000,
      maxPendingBytes: 4000,
    },
    at,
  );
}
async function attempt(db, id, equal, at = now) {
  const lease = await leaseFollowDigest(db, id, at);
  equal(typeof lease, "string");
  equal(await beginFollowSnapshotAttempt(db, await key(), id, lease, () => at), true);
  return lease;
}
const remove = async (db, r, at = now) =>
  removeManagedFollow(
    db,
    await mintFollowToken(db, r.subscriberId, "manage", {}, at),
    r.scopeKey,
    at,
  );
async function replacePending(db, job, advances) {
  const old = await db
    .prepare("SELECT * FROM follow_pending_progress WHERE job_id=?")
    .bind(job)
    .first();
  await db.prepare("DELETE FROM follow_pending_progress WHERE job_id=?").bind(job).run();
  await db
    .prepare("INSERT INTO follow_pending_progress VALUES (?,?,?,?)")
    .bind(job, old.snapshot_digest, old.snapshot_at, advances)
    .run();
}

export async function terminalFinalization(db, equal) {
  for (const outcome of ["accepted", "uncertain"]) {
    await reset(db);
    const a = await follow(db);
    await follow(db, "beta");
    const before = await progress(db),
      job = await enqueue(db, a.subscriberId);
    const lease = await attempt(db, job.id, equal);
    equal(await finishFollowDigestAttempt(db, job.id, lease, outcome, now), true);
    equal(
      await progress(db),
      before.map((p) => ({ ...p, watermark: now.toISOString() })),
    );
    equal(await rows(db, "follow_pending_progress"), []);
    equal((await rows(db, "follow_digest_outbox"))[0].state, outcome);
    equal(
      (await rows(db, "follow_subscribers"))[0].last_sent_at,
      outcome === "accepted" ? now.toISOString() : null,
    );
    equal(await finishFollowDigestAttempt(db, job.id, lease, outcome, now), false);
    equal((await rows(db, "follow_digest_days")).length, 1);
  }
}

export async function deletionTiming(db, equal) {
  for (const attempted of [false, true]) {
    await reset(db);
    const a = await follow(db),
      b = await follow(db, "beta");
    const survivor = (await progress(db)).find((p) => p.scope_key === b.scopeKey);
    const job = await enqueue(db, a.subscriberId);
    const lease = attempted
      ? await attempt(db, job.id, equal)
      : await leaseFollowDigest(db, job.id, now);
    await remove(db, a);
    equal((await rows(db, "follow_digest_outbox"))[0].state, attempted ? "uncertain" : "cancelled");
    equal(await progress(db), [
      { ...survivor, watermark: attempted ? now.toISOString() : start.toISOString() },
    ]);
    equal(await rows(db, "follow_pending_progress"), []);
    const recreated = await follow(db);
    equal(recreated.subscriberId, b.subscriberId);
    const fresh = (await progress(db)).find((p) => p.scope_key === a.scopeKey);
    equal(fresh.watermark, start.toISOString());
    equal(await finishFollowDigestAttempt(db, job.id, lease, "accepted", now), false);
    equal(
      (await progress(db)).find((p) => p.scope_key === a.scopeKey),
      fresh,
    );
    await unsubscribeFollows(
      db,
      await mintFollowToken(db, a.subscriberId, "unsubscribe", {}, now),
      now,
    );
    equal(await progress(db), []);
    equal(await rows(db, "follow_digest_outbox"), []);
    equal((await rows(db, "follow_digest_days")).length, attempted ? 1 : 0);
  }
  await reset(db);
  const a = await follow(db);
  await follow(db, "beta");
  const job = await enqueue(db, a.subscriberId),
    lease = await attempt(db, job.id, equal);
  await unsubscribeFollows(
    db,
    await mintFollowToken(db, a.subscriberId, "unsubscribe", {}, now),
    now,
  );
  equal(await progress(db), []);
  equal(await rows(db, "follow_digest_outbox"), []);
  equal(await rows(db, "follow_pending_progress"), []);
  equal((await rows(db, "follow_digest_days")).length, 1);
  equal(await finishFollowDigestAttempt(db, job.id, lease, "accepted", now), false);
}

export async function exactLifetimeFinalization(db, equal) {
  for (const field of ["generation", "confirmedAt", "from"]) {
    await reset(db);
    const a = await follow(db);
    await follow(db, "beta");
    const job = await enqueue(db, a.subscriberId),
      lease = await attempt(db, job.id, equal);
    if (field === "generation")
      await db
        .prepare("UPDATE follow_scope_progress SET scope_generation=? WHERE scope_key=?")
        .bind(crypto.randomUUID(), a.scopeKey)
        .run();
    else if (field === "from")
      await db
        .prepare("UPDATE follow_scope_progress SET watermark=? WHERE scope_key=?")
        .bind(new Date(+start + 1).toISOString(), a.scopeKey)
        .run();
    else
      await db
        .prepare("UPDATE follow_subscriptions SET confirmed_at=? WHERE scope_key=?")
        .bind(new Date(+start + 1).toISOString(), a.scopeKey)
        .run();
    const before = await progress(db);
    equal(await finishFollowDigestAttempt(db, job.id, lease, "uncertain", now), true);
    equal(
      await progress(db),
      before.map((p) => (p.scope_key === a.scopeKey ? p : { ...p, watermark: now.toISOString() })),
    );
  }
}

export async function staleDelayedJob(db, equal) {
  const a = await follow(db),
    first = await enqueue(db, a.subscriberId);
  const oldLease = await attempt(db, first.id, equal);
  const later = new Date(+now + 2 * 86400_000);
  const second = await enqueue(db, a.subscriberId, later);
  equal(second.status, "queued");
  equal(await leaseFollowDigest(db, second.id, later), null);
  await expireFollowOutbox(db, later);
  equal((await progress(db))[0].watermark, now.toISOString());
  equal(await finishFollowDigestAttempt(db, first.id, oldLease, "accepted", later), false);
  const lease = await leaseFollowDigest(db, second.id, later);
  equal(typeof lease, "string");
  equal(await beginFollowSnapshotAttempt(db, await key(), second.id, lease, () => later), false);
  equal(
    (await rows(db, "follow_digest_outbox")).find((r) => r.id === second.id).state,
    "cancelled",
  );
  equal(await rows(db, "follow_pending_progress"), []);
  equal(await rows(db, "follow_digest_days"), []);
  equal((await progress(db))[0].watermark, now.toISOString());
}

export async function preAttemptFence(db, equal) {
  for (const change of ["generation", "confirmedAt", "added", "clock"]) {
    await reset(db);
    const a = await follow(db),
      job = await enqueue(db, a.subscriberId);
    const lease = await leaseFollowDigest(db, job.id, now);
    if (change === "generation")
      await db
        .prepare("UPDATE follow_scope_progress SET scope_generation=?")
        .bind(crypto.randomUUID())
        .run();
    else if (change === "confirmedAt")
      await db
        .prepare("UPDATE follow_subscriptions SET confirmed_at=?")
        .bind(new Date(+start + 1).toISOString())
        .run();
    else if (change === "added") await follow(db, "beta");
    const before = await progress(db);
    equal(
      await beginFollowSnapshotAttempt(db, await key(), job.id, lease, () =>
        change === "clock" ? new Date(+now - 1) : now,
      ),
      false,
    );
    equal(await rows(db, "follow_digest_days"), []);
    equal(await rows(db, "follow_pending_progress"), []);
    equal(await progress(db), before);
    equal((await rows(db, "follow_digest_outbox"))[0].state, "cancelled");
  }
}

export async function malformedPending(db, equal) {
  for (const mutation of [
    "missing",
    "primitive",
    "extra",
    "duplicate",
    "badDate",
    "futureFrom",
    "badGeneration",
  ]) {
    await reset(db);
    const a = await follow(db),
      before = await progress(db),
      job = await enqueue(db, a.subscriberId);
    const stored = (await rows(db, "follow_pending_progress"))[0];
    const data = JSON.parse(stored.advances);
    if (mutation === "missing") await db.prepare("DELETE FROM follow_pending_progress").run();
    else {
      if (mutation === "primitive") data[0] = "invalid";
      if (mutation === "extra") data[0].extra = true;
      if (mutation === "duplicate") data.push(data[0]);
      if (mutation === "badDate") data[0].confirmedAt = "2026-02-30T00:00:00.000Z";
      if (mutation === "futureFrom") data[0].from = "2026-11-12T00:00:00.000Z";
      if (mutation === "badGeneration") data[0].generation = "x".repeat(36);
      await replacePending(db, job.id, JSON.stringify(data));
    }
    const lease = await leaseFollowDigest(db, job.id, now);
    equal(await beginFollowSnapshotAttempt(db, await key(), job.id, lease, () => now), false);
    equal(await progress(db), before);
    equal(await rows(db, "follow_digest_days"), []);
    equal(await rows(db, "follow_pending_progress"), []);
  }
  await reset(db);
  const a = await follow(db);
  await follow(db, "beta");
  const before = await progress(db),
    job = await enqueue(db, a.subscriberId);
  const lease = await attempt(db, job.id, equal);
  const mixed = JSON.parse((await rows(db, "follow_pending_progress"))[0].advances);
  mixed[0] = "invalid"; // A valid second row must not permit partial advancement.
  await replacePending(db, job.id, JSON.stringify(mixed));
  equal(await finishFollowDigestAttempt(db, job.id, lease, "uncertain", now), true);
  equal(await progress(db), before);
  equal(await rows(db, "follow_pending_progress"), []);
  await expireFollowOutbox(db, new Date(+now + 7 * 86400_000));
  equal(await rows(db, "follow_digest_outbox"), []);
}

export async function finalizeRollback(db, equal, rejects) {
  const a = await follow(db);
  await follow(db, "beta");
  const before = await progress(db),
    job = await enqueue(db, a.subscriberId);
  const lease = await attempt(db, job.id, equal);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_finalize_failure BEFORE UPDATE ON follow_scope_progress BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END",
    )
    .run();
  try {
    await rejects(() => finishFollowDigestAttempt(db, job.id, lease, "accepted", now));
    await rejects(() => remove(db, a));
  } finally {
    await db.prepare("DROP TRIGGER synthetic_finalize_failure").run();
  }
  equal(await progress(db), before);
  equal((await rows(db, "follow_subscriptions")).length, 2);
  equal((await rows(db, "follow_digest_outbox"))[0].state, "attempting");
  equal((await rows(db, "follow_pending_progress")).length, 1);
  equal((await rows(db, "follow_subscribers"))[0].last_sent_at, null);
  equal(await finishFollowDigestAttempt(db, job.id, lease, "accepted", now), true);
  equal((await progress(db))[0].watermark, now.toISOString());
}

export async function validatedLookupPlan(db, equal) {
  const a = await follow(db),
    job = await enqueue(db, a.subscriberId);
  const result = await db
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM follow_valid_pending WHERE job_id=?")
    .bind(job.id)
    .all();
  equal(
    result.results.some((r) => r.detail.includes("SEARCH p") && r.detail.includes("job_id=?")),
    true,
  );
  equal(
    result.results.some((r) => /SCAN p\b/.test(r.detail)),
    false,
  );
}
