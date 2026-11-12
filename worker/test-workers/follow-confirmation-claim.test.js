import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { claimFollowConfirmation } from "../src/follow-confirmation-claim.js";
import { deleteFollowRequest, mintFollowRequestDeletion } from "../src/follow-request-deletion.js";
import {
  confirmFollow,
  inspectFollowToken,
  mintFollowToken,
  requestFollowConfirmation,
  unsubscribeFollows,
} from "../src/follows.js";

const DAY = 86400_000;
const email = "claim@example.test";
const catalog = { companies: new Set(["one", "two"]) };
const queue = (company, now = new Date(Date.now() - 1_000)) =>
  requestFollowConfirmation(env.DB, email, { kind: "company", company }, catalog, now);
const claim = (job, db = env.DB) => claimFollowConfirmation(db, job.confirmationJobId);
const row = (job) =>
  env.DB.prepare("SELECT * FROM follow_confirmation_outbox WHERE id=?")
    .bind(job.confirmationJobId)
    .first();
const mint = (job) =>
  mintFollowToken(env.DB, job.subscriberId, "confirm", { scopeKey: job.scopeKey });
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const batchThrough = (batch) => ({ prepare: env.DB.prepare.bind(env.DB), batch });

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
});

it("returns all credentials once for a concurrent exact claim", async () => {
  const first = await queue("one");
  const pending = await row(first);
  expect(pending.claim_id).toBeNull();

  const attempts = await Promise.all([claim(first), claim(first), claim(first)]);
  const issued = attempts.find(Boolean);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect(issued.expiresAt).toBe(pending.expires_at);
  expect(await row(first)).toEqual({ ...pending, claim_id: issued.claimId });
  expect(issued.claimId === issued.confirmation.split(".")[0]).toBe(false);
  expect(await claim(first)).toBeNull();
  expect((await queue("one")).confirmationJobId).toBe(first.confirmationJobId);
  expect(
    await rows("SELECT purpose,scope_key,expires_at FROM follow_tokens ORDER BY purpose"),
  ).toEqual([
    { purpose: "confirm", scope_key: first.scopeKey, expires_at: pending.expires_at },
    { purpose: "unsubscribe", scope_key: "", expires_at: null },
  ]);
  expect(await rows("SELECT COUNT(*) AS n FROM follow_request_deletions")).toEqual([{ n: 1 }]);
  expect(await confirmFollow(env.DB, issued.confirmation)).toBe(true);
  expect(await row(first)).toBeNull();
  expect(await deleteFollowRequest(env.DB, issued.deleteRequest)).toBe(false);
});

it("uses a separate scoped deletion and preserves the address-wide unsubscribe capability", async () => {
  const first = await queue("one");
  const sibling = await queue("two");
  const issued = await claim(first);
  expect(await deleteFollowRequest(env.DB, issued.confirmation)).toBe(false);
  expect(await deleteFollowRequest(env.DB, issued.unsubscribe)).toBe(false);
  expect(await deleteFollowRequest(env.DB, issued.deleteRequest)).toBe(true);
  expect(await row(first)).toBeNull();
  expect(await row(sibling)).not.toBeNull();
  expect(await confirmFollow(env.DB, issued.confirmation)).toBe(false);
  expect(await unsubscribeFollows(env.DB, issued.unsubscribe)).toBe(true);
  expect(await row(sibling)).toBeNull();
});

it("preserves a newer live confirmation and deletion capability for the exact same scope", async () => {
  const pending = await queue("one");
  const existing = await mint(pending);
  const deletion = await mintFollowRequestDeletion(env.DB, existing);
  const sibling = await queue("two");
  expect(await claim(sibling)).not.toBeNull();
  const before = await rows("SELECT * FROM follow_tokens ORDER BY token_hash");
  expect(await claim(pending)).toBeNull();
  expect((await row(pending)).claim_id).toBeNull();
  expect(await rows("SELECT * FROM follow_tokens ORDER BY token_hash")).toEqual(before);
  expect(await inspectFollowToken(env.DB, existing, "confirm")).not.toBeNull();
  expect(await deleteFollowRequest(env.DB, deletion)).toBe(true);
});

it("rejects old IDs after same-millisecond recreation and expired lifetime renewal", async () => {
  const at = new Date(Date.now() - 1_000);
  const initial = await queue("one", at);
  const existing = await mint(initial);
  const deletion = await mintFollowRequestDeletion(env.DB, existing);
  const sibling = await queue("two", new Date(Date.now() - 7 * DAY - 60_000));
  expect(await deleteFollowRequest(env.DB, deletion)).toBe(true);
  const recreated = await queue("one", at);
  expect(recreated.subscriberId).toBe(initial.subscriberId);
  expect(recreated.confirmationJobId).not.toBe(initial.confirmationJobId);
  expect(await claim(initial)).toBeNull();
  expect(await claim(sibling)).toBeNull();
  const renewed = await queue("two", at);
  expect(renewed.confirmationJobId).not.toBe(sibling.confirmationJobId);
  expect(await claim(sibling)).toBeNull();
  expect(await claim(renewed)).not.toBeNull();
  expect(await claim(recreated)).not.toBeNull();
});

it("blocks an expired, future, or missing job without writes", async () => {
  const expired = await queue("one", new Date(Date.now() - 7 * DAY - 60_000));
  const future = await queue("two", new Date(Date.now() + 60_000));
  const before = [await row(expired), await row(future)];
  expect(await claim(expired)).toBeNull();
  expect(await claim(future)).toBeNull();
  expect(await claimFollowConfirmation(env.DB, crypto.randomUUID())).toBeNull();
  expect(await claimFollowConfirmation(null, "invalid-job")).toBeNull();
  expect([await row(expired), await row(future)]).toEqual(before);
  expect(await rows("SELECT * FROM follow_tokens")).toEqual([]);
  expect(await rows("SELECT * FROM follow_request_deletions")).toEqual([]);
});

it("rolls back the job, confirmation and deletion when the last token insert aborts", async () => {
  const pending = await queue("one");
  const before = await row(pending);
  await env.DB.prepare(
    "CREATE TRIGGER fail_unsubscribe BEFORE INSERT ON follow_tokens WHEN NEW.purpose='unsubscribe' " +
      "BEGIN SELECT RAISE(ABORT,'fixture final token failure'); END",
  ).run();
  try {
    await expect(claim(pending)).rejects.toThrow("Follow confirmation claim unavailable");
    expect(await row(pending)).toEqual(before);
    expect(await rows("SELECT * FROM follow_tokens")).toEqual([]);
    expect(await rows("SELECT * FROM follow_request_deletions")).toEqual([]);
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_unsubscribe").run();
  }
  expect(await claim(pending)).not.toBeNull();
});

it("cannot reconstruct or mint again after a committed batch loses acknowledgement", async () => {
  const pending = await queue("one");
  const uncertain = batchThrough(async (statements) => {
    await env.DB.batch(statements);
    throw new Error("fixture lost receipt");
  });
  await expect(claim(pending, uncertain)).rejects.toThrow("Follow confirmation claim unavailable");
  expect((await row(pending)).claim_id).not.toBeNull();
  expect(await claim(pending)).toBeNull();
  expect(await rows("SELECT COUNT(*) AS n FROM follow_tokens")).toEqual([{ n: 2 }]);
  expect(await rows("SELECT COUNT(*) AS n FROM follow_request_deletions")).toEqual([{ n: 1 }]);
});

it("withholds the credentials when the exact expiry is reached before the Worker sees the receipt", async () => {
  const pending = await queue("one");
  const expiry = Date.parse((await row(pending)).expires_at);
  const now = vi.spyOn(Date, "now");
  try {
    const late = batchThrough(async (statements) => {
      const result = await env.DB.batch(statements);
      now.mockReturnValue(expiry);
      return result;
    });
    expect(await claim(pending, late)).toBeNull();
  } finally {
    now.mockRestore();
  }
  expect((await row(pending)).claim_id).not.toBeNull();
  expect(await claim(pending)).toBeNull();
});
