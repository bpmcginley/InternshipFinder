import assert from "node:assert/strict";
import { deleteFollowRequest } from "../src/follow-request-deletion.js";
import { requestLinkedFollowConfirmation as linked } from "../src/follow-linked-request.js";
import {
  requestFollowConfirmation,
  confirmFollow,
  inspectFollowToken,
  expireFollows,
} from "../src/follows.js";
import {
  claimFollowConfirmation,
  readUnclaimedFollowConfirmation,
  prepareFollowConfirmationClaim,
  commitFollowConfirmationClaim,
  readFollowConfirmationTransportFence,
  readFollowConfirmationClock,
} from "../src/follow-confirmation-claim.js";

const email = "linked@example.test",
  catalog = { companies: new Set(["one", "two"]) };
const scope = { kind: "company", company: "one" };
const session = { id: "a".repeat(64), user: "b".repeat(64) };
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
const request = (db, proof = session) => linked(db, email, scope, catalog, proof);
async function setup(db, proof = session) {
  await db
    .prepare(
      `INSERT INTO sessions(id,user_hash,tier,provider,created,last_used,expires)
    VALUES(?,?,'free','google',datetime('now'),datetime('now'),datetime('now','+1 day'))`,
    )
    .bind(proof.id, proof.user)
    .run();
}
// Node's existing fake omits SELECT changes metadata; model actual D1 without changing it.
export function d1Reads(db) {
  return {
    batch: db.batch.bind(db),
    prepare(sql) {
      const adapt = (s) => ({
        ...s,
        bind: (...v) => adapt(s.bind(...v)),
        async all() {
          const r = await s.all();
          return { ...r, meta: { ...r.meta, changes: 0 } };
        },
      });
      return adapt(db.prepare(sql));
    },
  };
}

export async function consentTravelsOnlyThroughConfirmation(db) {
  await setup(db);
  const [a, b] = await Promise.all([request(db), request(db)]);
  assert.deepEqual(a, b);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, null);
  const q = (await rows(db, "follow_confirmation_outbox"))[0];
  assert.equal(q.owner_user_hash, session.user);
  assert.equal(JSON.stringify(q).includes(session.id), false);
  const issued = await claimFollowConfirmation(db, a.confirmationJobId);
  assert.ok(issued);
  assert.equal(
    (await inspectFollowToken(db, issued.confirmation, "confirm")).owner_user_hash,
    session.user,
  );
  assert.equal(await confirmFollow(db, issued.confirmation), true);
  assert.equal(await confirmFollow(db, issued.confirmation), false);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, session.user);
  assert.equal(await request(db), null);
}

export async function confirmedUnlinkedPreservesWatermark(db) {
  await setup(db);
  const old = await requestFollowConfirmation(
    db,
    email,
    scope,
    catalog,
    new Date(Date.now() - 1000),
  );
  const issued = await claimFollowConfirmation(db, old.confirmationJobId);
  assert.equal(await confirmFollow(db, issued.confirmation), true);
  const before = await rows(db, "follow_scope_progress");
  const sub = (await rows(db, "follow_subscriptions"))[0];
  const job = await request(db);
  assert.ok(job);
  const next = await claimFollowConfirmation(db, job.confirmationJobId);
  assert.ok(next);
  assert.equal(await confirmFollow(db, next.confirmation), true);
  assert.deepEqual(await rows(db, "follow_scope_progress"), before);
  assert.equal((await rows(db, "follow_subscriptions"))[0].confirmed_at, sub.confirmed_at);
}

export async function conflictingIntentNeverChangesLiveConsent(db) {
  await setup(db);
  const job = await request(db),
    before = await rows(db, "follow_confirmation_outbox");
  const other = { id: "c".repeat(64), user: "d".repeat(64) };
  await setup(db, other);
  assert.equal(await request(db, other), null);
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), before);
  const issued = await claimFollowConfirmation(db, job.confirmationJobId);
  await confirmFollow(db, issued.confirmation);
  assert.equal(await request(db, other), null);
}

export async function anonymousJobIsNotSilentlyLinked(db) {
  await setup(db);
  await requestFollowConfirmation(db, email, scope, catalog, new Date(Date.now() - 1000));
  const before = await rows(db, "follow_confirmation_outbox");
  assert.equal(await request(db), null);
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), before);
}

export async function revokedSessionAtWriteCannotCreate(db) {
  await setup(db);
  const raced = {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      await db.prepare("DELETE FROM sessions").run();
      return db.batch(statements);
    },
  };
  assert.equal(await request(raced), null);
  assert.deepEqual(await rows(db, "follow_subscribers"), []);
  assert.equal(await request(db), null);
  await setup(db);
  await db.prepare("UPDATE sessions SET expires=datetime('now','-1 second')").run();
  assert.equal(await request(db), null);
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), []);
  assert.equal(await request(db, { ...session, user: "e".repeat(64) }), null);
}

export async function expiryAllowsFreshExplicitIntent(db) {
  await setup(db);
  const old = await request(db);
  await db
    .prepare(
      "UPDATE follow_subscriptions SET created=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days')",
    )
    .run();
  assert.equal(await claimFollowConfirmation(db, old.confirmationJobId), null);
  const fresh = await request(db);
  assert.ok(fresh);
  assert.notEqual(fresh.confirmationJobId, old.confirmationJobId);
  assert.ok(await claimFollowConfirmation(db, fresh.confirmationJobId));
}

export async function ownerChangesFailClaimAndFinalFence(db) {
  await setup(db);
  const q = await request(db),
    job = await readUnclaimedFollowConfirmation(db, q.confirmationJobId);
  const prepared = await prepareFollowConfirmationClaim(),
    at = await readFollowConfirmationClock(db);
  await db
    .prepare("UPDATE follow_confirmation_outbox SET owner_user_hash=?")
    .bind("c".repeat(64))
    .run();
  assert.equal(
    (await commitFollowConfirmationClaim(db, q.confirmationJobId, prepared, { job, at, cap: 10 }))
      .status,
    "unavailable",
  );
  await db
    .prepare("UPDATE follow_confirmation_outbox SET owner_user_hash=?")
    .bind(session.user)
    .run();
  assert.equal(
    (await commitFollowConfirmationClaim(db, q.confirmationJobId, prepared, { job, at, cap: 10 }))
      .status,
    "claimed",
  );
  assert.equal(
    await readFollowConfirmationTransportFence(db, q.confirmationJobId, job, prepared, at),
    true,
  );
  await db.prepare("UPDATE follow_tokens SET owner_user_hash=NULL WHERE purpose='confirm'").run();
  assert.equal(
    await readFollowConfirmationTransportFence(db, q.confirmationJobId, job, prepared, at),
    false,
  );
  await db.prepare("DELETE FROM follow_confirmation_outbox").run();
  assert.equal(
    await readFollowConfirmationTransportFence(db, q.confirmationJobId, job, prepared, at),
    false,
  );
}

export async function failedQueueWriteRollsBackAllRequestRows(db) {
  await setup(db);
  await db
    .prepare(
      "CREATE TRIGGER fail_link BEFORE INSERT ON follow_confirmation_outbox BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  try {
    await assert.rejects(request(db));
  } finally {
    await db.prepare("DROP TRIGGER fail_link").run();
  }
  assert.deepEqual(await rows(db, "follow_subscribers"), []);
  assert.deepEqual(await rows(db, "follow_subscriptions"), []);
  assert.ok(await request(db));
}

export async function confirmedLinkCancellationAndExpiryPreserveScope(db) {
  await setup(db);
  const original = await requestFollowConfirmation(
    db,
    email,
    scope,
    catalog,
    new Date(Date.now() - 1000),
  );
  await confirmFollow(
    db,
    (await claimFollowConfirmation(db, original.confirmationJobId)).confirmation,
  );
  const before = await rows(db, "follow_scope_progress");
  const pending = await request(db),
    issued = await claimFollowConfirmation(db, pending.confirmationJobId);
  assert.equal(await deleteFollowRequest(db, issued.deleteRequest), true);
  assert.equal(await confirmFollow(db, issued.confirmation), false);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, null);
  await db
    .prepare(
      "UPDATE follow_confirmation_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')",
    )
    .run();
  await expireFollows(db, new Date());
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), []);
  assert.equal((await rows(db, "follow_subscriptions"))[0].owner_user_hash, null);
  const fresh = await request(db);
  assert.notEqual(fresh.confirmationJobId, pending.confirmationJobId);
  assert.equal(
    await confirmFollow(
      db,
      (await claimFollowConfirmation(db, fresh.confirmationJobId)).confirmation,
    ),
    true,
  );
  assert.deepEqual(await rows(db, "follow_scope_progress"), before);
}

export async function malformedSessionNeverTouchesStorage() {
  for (const proof of [
    null,
    undefined,
    {},
    { id: [session.id], user: session.user },
    { ...session, id: "bad" },
  ])
    assert.equal(await linked(null, email, scope, catalog, proof), null);
}

export async function malformedCommittedReceiptDoesNotAuthorizeRetry(db) {
  await setup(db);
  const uncertain = {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      const result = await db.batch(statements);
      result.at(-1).results[0].scopeKey = "wrong";
      return result;
    },
  };
  await assert.rejects(request(uncertain), /Follow linkage unavailable/);
  const before = await rows(db, "follow_confirmation_outbox");
  assert.equal((await request(db)).confirmationJobId, before[0].id);
  assert.deepEqual(await rows(db, "follow_confirmation_outbox"), before);
}
