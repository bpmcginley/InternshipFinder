import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { handle } from "../src/index.js";
import { createSession, sessionTokenHash } from "../src/session.js";
import {
  inspectFollowToken,
  mintFollowToken,
  requestFollow,
  requestFollowConfirmation,
} from "../src/follows.js";
import { requestLinkedFollowConfirmation } from "../src/follow-linked-request.js";
import {
  claimFollowConfirmation,
  commitFollowConfirmationClaim,
  prepareFollowConfirmationClaim,
  readFollowConfirmationClock,
  readFollowConfirmationTransportFence,
  readUnclaimedFollowConfirmation,
} from "../src/follow-confirmation-claim.js";

const owner = "a".repeat(64),
  other = "b".repeat(64),
  marker = "c".repeat(64);
const email = "mixed-linked@example.test";
const catalog = {
  companies: new Set(["fresh", "retained", "anonymous", "other", "legacy", "new"]),
};
const followTables = [
  "follow_subscribers",
  "follow_subscriptions",
  "follow_scope_progress",
  "follow_confirmation_outbox",
  "follow_tokens",
  "follow_request_deletions",
  "follow_digest_days",
  "follow_send_budget",
];
const accountTables = [
  "demand",
  "usage",
  "forget",
  "sessions",
  "topup_checkout_attempts",
  "topup_attempt_revisions",
];
const run = (sql, ...args) =>
  env.DB.prepare(sql)
    .bind(...args)
    .run();
const first = (sql, ...args) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first();
const snapshot = async (names) => {
  const state = {};
  for (const table of names)
    state[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return state;
};
const deniedFetch = () => {
  throw new Error("Fixture outbound network forbidden");
};
const route = (path, options) =>
  handle(new Request("https://api.example.test" + path, options), { DB: env.DB }, undefined, {
    now: () => new Date(),
    fetch: deniedFetch,
  });
const remove = (token) =>
  route("/me", {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token, Origin: "https://internscout.org" },
  });
const confirm = (body) => route("/follows/confirm", { method: "POST", body });
const scope = (item) =>
  first(
    "SELECT * FROM follow_subscriptions WHERE subscriber_id=? AND scope_key=?",
    item.subscriberId,
    item.scopeKey,
  );
const progress = (item) =>
  first(
    "SELECT * FROM follow_scope_progress WHERE subscriber_id=? AND scope_key=?",
    item.subscriberId,
    item.scopeKey,
  );
const job = (item) =>
  first("SELECT * FROM follow_confirmation_outbox WHERE id=?", item.confirmationJobId);
const markerRow = () => first("SELECT * FROM follow_digest_days WHERE marker=?", marker);
const linked = (company, proof) =>
  requestLinkedFollowConfirmation(env.DB, email, { kind: "company", company }, catalog, proof);
const anonymous = (company, now) =>
  requestFollowConfirmation(
    env.DB,
    email,
    { kind: "company", company },
    catalog,
    new Date(now.getTime() - 1000),
  );
async function issue(item) {
  const issued = await claimFollowConfirmation(env.DB, item.confirmationJobId);
  expect(Boolean(issued)).toBe(true);
  return issued;
}
async function identity(user, now) {
  const { token } = await createSession(env.DB, { user, tier: "edu", provider: "google" }, now);
  return { token, proof: { id: await sessionTokenHash(token), user } };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    [
      "DROP TRIGGER IF EXISTS fixture_linked_cleanup_abort",
      "DELETE FROM follow_subscribers",
      "DELETE FROM follow_digest_days",
      "DELETE FROM follow_send_budget",
      "DELETE FROM sessions",
      "DELETE FROM demand",
      "DELETE FROM usage",
      "DELETE FROM topup_checkout_attempts",
      "DELETE FROM forget",
    ].map((sql) => env.DB.prepare(sql)),
  );
});

async function mixed() {
  const now = new Date(await readFollowConfirmationClock(env.DB));
  const account = await identity(owner, now),
    unrelated = await identity(other, now);
  const alreadyAnonymous = await anonymous("retained", now);
  const original = await issue(alreadyAnonymous);
  expect((await confirm(original.confirmation)).status).toBe(204);
  const retainedBefore = await scope(alreadyAnonymous);
  const retainedProgress = await progress(alreadyAnonymous);
  expect(retainedBefore?.confirmed_at).toBeTruthy();
  expect(retainedBefore?.owner_user_hash).toBeNull();
  const retained = await linked("retained", account.proof);
  const fresh = await linked("fresh", account.proof);
  const unrelatedJob = await linked("other", unrelated.proof);
  const anonymousJob = await anonymous("anonymous", now);
  const legacy = await requestFollow(
    env.DB,
    email,
    { kind: "company", company: "legacy" },
    catalog,
    now,
  );
  const legacyToken = await mintFollowToken(
    env.DB,
    legacy.subscriberId,
    "confirm",
    { scopeKey: legacy.scopeKey, ownerUserHash: owner },
    now,
  );
  const legacyBefore = await scope(legacy);
  expect((await job(fresh))?.owner_user_hash).toBe(owner);
  expect((await job(retained))?.owner_user_hash).toBe(owner);
  expect((await scope(fresh))?.confirmed_at).toBeNull();
  expect((await job(unrelatedJob))?.owner_user_hash).toBe(other);
  expect((await job(anonymousJob))?.owner_user_hash).toBeNull();
  await run(
    "INSERT INTO follow_digest_days VALUES(?,?)",
    marker,
    new Date(now.getTime() + 86_400_000).toISOString(),
  );
  await run("INSERT INTO demand VALUES(?,'[]','fixture','fixture')", owner);
  await run("INSERT INTO usage VALUES(?,'2026-09','autofill',1)", owner);
  const orphan = crypto.randomUUID();
  await run(
    "INSERT INTO follow_subscribers(id,email,created) VALUES(?,?,?)",
    orphan,
    "orphan@example.test",
    now.toISOString(),
  );
  return {
    ...account,
    now,
    fresh,
    retained,
    retainedBefore,
    retainedProgress,
    orphan,
    originalUnsubscribe: original.unsubscribe,
    legacy,
    legacyBefore,
    legacyToken,
    unrelatedJob,
    anonymousJob,
    unrelatedBefore: await job(unrelatedJob),
    anonymousBefore: await job(anonymousJob),
    markerBefore: await markerRow(),
  };
}
async function survivors(fixture) {
  expect(await job(fixture.unrelatedJob)).toEqual(fixture.unrelatedBefore);
  expect(await job(fixture.anonymousJob)).toEqual(fixture.anonymousBefore);
  expect(await markerRow()).toEqual(fixture.markerBefore);
  expect(await scope(fixture.legacy)).toEqual(fixture.legacyBefore);
  expect(Boolean(await first("SELECT 1 FROM follow_subscribers WHERE id=?", fixture.orphan))).toBe(
    true,
  );
  expect(
    Boolean(await inspectFollowToken(env.DB, fixture.originalUnsubscribe, "unsubscribe")),
  ).toBe(true);
}
async function targetCleanup(fixture) {
  expect(await scope(fixture.retained)).toEqual(fixture.retainedBefore);
  expect(await progress(fixture.retained)).toEqual(fixture.retainedProgress);
  expect(await scope(fixture.fresh)).toBeNull();
  expect(await job(fixture.fresh)).toBeNull();
  expect(await job(fixture.retained)).toBeNull();
  expect(await inspectFollowToken(env.DB, fixture.legacyToken, "confirm")).toBeNull();
  await survivors(fixture);
}

it("DELETE /me separates owner-only pending from confirmed anonymous intent and revokes exact session proof", async () => {
  const f = await mixed();
  const sole = await requestLinkedFollowConfirmation(
    env.DB,
    "sole@example.test",
    { kind: "company", company: "fresh" },
    catalog,
    f.proof,
  );
  const soleCredentials = await issue(sole);
  expect((await remove(f.token)).status).toBe(200);
  expect((await remove(f.token)).status).toBe(401);
  expect(await first("SELECT 1 FROM follow_subscribers WHERE id=?", sole.subscriberId)).toBeNull();
  expect(await inspectFollowToken(env.DB, soleCredentials.unsubscribe, "unsubscribe")).toBeNull();
  await targetCleanup(f);
  const before = await snapshot(followTables);
  expect(await linked("new", f.proof)).toBeNull();
  expect(await snapshot(followTables)).toEqual(before);
  for (const q of [f.fresh, f.retained])
    expect(await claimFollowConfirmation(env.DB, q.confirmationJobId)).toBeNull();
});

it("claim-first exact transport fences observe account deletion without refunding the shared cap", async () => {
  const f = await mixed();
  const attempts = [];
  for (const q of [f.fresh, f.retained]) {
    const record = await readUnclaimedFollowConfirmation(env.DB, q.confirmationJobId);
    const prepared = await prepareFollowConfirmationClaim();
    const at = await readFollowConfirmationClock(env.DB);
    expect(
      (
        await commitFollowConfirmationClaim(env.DB, q.confirmationJobId, prepared, {
          job: record,
          at,
          cap: 5,
        })
      ).status,
    ).toBe("claimed");
    expect(
      await readFollowConfirmationTransportFence(env.DB, q.confirmationJobId, record, prepared, at),
    ).toBe(true);
    attempts.push({ q, record, prepared, at });
  }
  expect((await remove(f.token)).status).toBe(200);
  for (const { q, record, prepared, at } of attempts)
    expect(
      await readFollowConfirmationTransportFence(env.DB, q.confirmationJobId, record, prepared, at),
    ).toBe(false);
  for (const { prepared } of attempts) {
    expect(
      await first("SELECT 1 FROM follow_tokens WHERE token_hash=?", prepared.confirm.digest),
    ).toBeNull();
    expect(
      await first(
        "SELECT 1 FROM follow_request_deletions WHERE confirm_hash=?",
        prepared.confirm.digest,
      ),
    ).toBeNull();
  }
  expect((await first("SELECT attempts FROM follow_send_budget WHERE slot=1"))?.attempts).toBe(2);
  await targetCleanup(f);
});

it("real confirmation and DELETE /me preserve the serial winner in both operation orders", async () => {
  const f = await mixed();
  const confirmedFirst = await issue(f.fresh),
    deletedFirst = await issue(f.retained);
  expect((await confirm(confirmedFirst.confirmation)).status).toBe(204);
  expect((await scope(f.fresh))?.owner_user_hash).toBe(owner);
  const unownedToken = await mintFollowToken(
    env.DB,
    f.fresh.subscriberId,
    "confirm",
    { scopeKey: f.fresh.scopeKey },
    f.now,
  );
  expect(Boolean(await inspectFollowToken(env.DB, unownedToken, "confirm"))).toBe(true);
  expect((await remove(f.token)).status).toBe(200);
  expect(await scope(f.fresh)).toBeNull();
  expect(await inspectFollowToken(env.DB, unownedToken, "confirm")).toBeNull();
  expect((await confirm(deletedFirst.confirmation)).status).toBe(410);
  expect(await scope(f.retained)).toEqual(f.retainedBefore);
  expect(await progress(f.retained)).toEqual(f.retainedProgress);
  await survivors(f);
});

it("the existing top-up payment guard rolls back the repeated forget and both owner-intent variants", async () => {
  const f = await mixed();
  await run("INSERT INTO forget VALUES(?,'2026-10')", owner);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO topup_checkout_attempts VALUES(?,?,'fixture',300,'usd',25,?,?,'open')",
    id,
    owner,
    f.now.toISOString(),
    "cs_" + id.replaceAll("-", ""),
  );
  await run("INSERT INTO topup_attempt_revisions VALUES(?,1)", id);
  const before = await snapshot([...accountTables, ...followTables]);
  const response = await remove(f.token);
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("topup_payment_pending");
  expect(await snapshot([...accountTables, ...followTables])).toEqual(before);
});

it("injected owner-queue cleanup failure rolls back the complete account deletion", async () => {
  const f = await mixed();
  const before = await snapshot([...accountTables, ...followTables]);
  await run(
    "CREATE TRIGGER fixture_linked_cleanup_abort BEFORE DELETE ON follow_confirmation_outbox " +
      "WHEN OLD.owner_user_hash IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture_cleanup_abort'); END",
  );
  try {
    const response = await remove(f.token);
    expect(response.status).toBe(500);
    expect(await snapshot([...accountTables, ...followTables])).toEqual(before);
  } finally {
    await run("DROP TRIGGER fixture_linked_cleanup_abort");
  }
});
