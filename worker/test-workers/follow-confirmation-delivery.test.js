import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { deliverFollowConfirmation } from "../src/follow-confirmation-delivery.js";
import { reserveFollowSendAttempt } from "../src/follow-send-budget.js";
import { mintFollowToken, requestFollowConfirmation } from "../src/follows.js";

const DAY = 86_400_000;
const email = "pending@example.test";
const origin = "https://follow.example.test";
const catalog = { companies: new Set(["one", "two"]) };
const queue = (company = "one", at = new Date(Date.now() - 1_000)) =>
  requestFollowConfirmation(env.DB, email, { kind: "company", company }, catalog, at);
const budget = () => env.DB.prepare("SELECT * FROM follow_send_budget").first();
const job = ({ confirmationJobId }) =>
  env.DB.prepare("SELECT * FROM follow_confirmation_outbox WHERE id=?")
    .bind(confirmationJobId)
    .first();
const count = (table) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");
const present = ({ confirmation, deleteRequest, unsubscribe }) => ({
  from: "sender@example.test",
  to: "ignored@example.test",
  postalAddress: "Synthetic address",
  origins: [origin],
  summary: "Example company",
  links: {
    confirmation: `${origin}/confirm?token=${confirmation}`,
    deleteRequest: `${origin}/delete?token=${deleteRequest}`,
    unsubscribe: `${origin}/unsubscribe?token=${unsubscribe}`,
  },
});
const delivery = (pending, overrides) =>
  deliverFollowConfirmation({
    db: env.DB,
    jobId: pending.confirmationJobId,
    cap: 2,
    clock: () => new Date(),
    present,
    transport: async () => {},
    ...overrides,
  });
const proxyBatch = (batch) => ({ prepare: env.DB.prepare.bind(env.DB), batch });
const status = (value) => ({ status: value });

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM follow_subscribers"),
    env.DB.prepare("DELETE FROM follow_send_budget"),
  ]);
});

it("debited confirmation uses one exact recipient, hashes and attempt across concurrent duplicates", async () => {
  const pending = await queue();
  const transport = vi.fn(async () => {});
  const presentation = vi.fn(present);
  const outcomes = await Promise.all([
    delivery(pending, { transport, present: presentation }),
    delivery(pending, { transport, present: presentation }),
  ]);
  expect(outcomes).toContainEqual(status("accepted"));
  expect(outcomes).toContainEqual(status("unavailable"));
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][0].to).toBe(email);
  expect(presentation.mock.calls.every(([input]) => !Object.hasOwn(input, "email"))).toBe(true);
  expect((await budget()).attempts).toBe(1);
  expect((await job(pending)).claim_id).not.toBeNull();
  expect(await count("follow_tokens")).toBe(2);
  expect(await count("follow_request_deletions")).toBe(1);
  expect(await delivery(pending, { transport })).toEqual(status("unavailable"));
  expect(transport).toHaveBeenCalledTimes(1);
});

it("full shared cap preserves the same pending job and original expiry for retry", async () => {
  const pending = await queue();
  const initial = await job(pending);
  expect(await reserveFollowSendAttempt(env.DB, 1)).toBe(true);
  const transport = vi.fn(async () => {});
  expect(await delivery(pending, { cap: 1, transport })).toEqual(status("paused"));
  expect(await job(pending)).toEqual(initial);
  expect(await count("follow_tokens")).toBe(0);
  expect(transport).not.toHaveBeenCalled();
  expect((await queue()).confirmationJobId).toBe(pending.confirmationJobId);
  expect(await delivery(pending, { cap: 2, transport })).toEqual(status("accepted"));
  expect((await job(pending)).expires_at).toBe(initial.expires_at);
  expect((await budget()).attempts).toBe(2);
});

it("competing different jobs and the common ledger share one available attempt", async () => {
  const [first, second] = await Promise.all([queue("one"), queue("two")]);
  const transport = vi.fn(async () => {});
  const results = await Promise.all([
    delivery(first, { cap: 1, transport }),
    delivery(second, { cap: 1, transport }),
    reserveFollowSendAttempt(env.DB, 1),
  ]);
  const accepted = results.slice(0, 2).filter((value) => value.status === "accepted").length;
  expect(accepted + Number(results[2])).toBe(1);
  expect(transport).toHaveBeenCalledTimes(accepted);
  expect((await budget()).attempts).toBe(1);
  expect(await count("follow_tokens")).toBe(accepted * 2);
  expect([await job(first), await job(second)].filter((row) => row.claim_id)).toHaveLength(
    accepted,
  );
});

it("malformed presentation leaves both the claim and budget untouched", async () => {
  const pending = await queue();
  const transport = vi.fn(async () => {});
  expect(await delivery(pending, { present: () => ({}), transport })).toEqual(
    status("unavailable"),
  );
  expect(await budget()).toBeNull();
  expect((await job(pending)).claim_id).toBeNull();
  expect(await count("follow_tokens")).toBe(0);
  expect(transport).not.toHaveBeenCalled();
});

it.each(["other scope", "swapped purpose", "duplicate token"])(
  "a presentation with %s cannot spend the claim or capacity",
  async (fault) => {
    const pending = await queue();
    const other = await requestFollowConfirmation(
      env.DB,
      "other@example.test",
      { kind: "company", company: "two" },
      catalog,
      new Date(Date.now() - 1_000),
    );
    const previous = await job(other);
    const borrowed = await mintFollowToken(env.DB, other.subscriberId, "confirm", {
      scopeKey: other.scopeKey,
    });
    const transport = vi.fn(async () => {});
    const presentation = (input) => {
      const output = present(input);
      const link = `${origin}/confirm?token=${borrowed}`;
      output.links.confirmation =
        fault === "other scope"
          ? link
          : fault === "swapped purpose"
            ? output.links.deleteRequest
            : `${output.links.confirmation}&token=${borrowed}`;
      return output;
    };
    expect(await delivery(pending, { present: presentation, transport })).toEqual(
      status("unavailable"),
    );
    expect((await job(pending)).claim_id).toBeNull();
    expect(await budget()).toBeNull();
    expect(await count("follow_tokens")).toBe(1);
    expect(await job(other)).toEqual(previous);
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each(["newer confirmation", "scope replacement", "expired scope"])(
  "%s during presentation prevents the exact claim and debit",
  async (change) => {
    const pending = await queue();
    const transport = vi.fn(async () => {});
    const presentation = async (input) => {
      if (change === "newer confirmation") {
        await mintFollowToken(env.DB, pending.subscriberId, "confirm", {
          scopeKey: pending.scopeKey,
        });
      } else if (change === "scope replacement") {
        await env.DB.prepare(
          "DELETE FROM follow_subscriptions WHERE subscriber_id=? AND scope_key=?",
        )
          .bind(pending.subscriberId, pending.scopeKey)
          .run();
        await queue();
      } else {
        await env.DB.prepare(
          "UPDATE follow_subscriptions SET created=? WHERE subscriber_id=? AND scope_key=?",
        )
          .bind(
            new Date(Date.now() - 7 * DAY - 1_000).toISOString(),
            pending.subscriberId,
            pending.scopeKey,
          )
          .run();
      }
      return present(input);
    };
    expect(await delivery(pending, { present: presentation, transport })).toEqual(
      status("unavailable"),
    );
    expect((await budget()).attempts).toBe(0);
    expect((await job(pending))?.claim_id ?? null).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each(["lost receipt", "delete scope", "replace token", "changed recipient", "invalid receipt"])(
  "a committed claim with %s never sends or replays",
  async (fault) => {
    const pending = await queue();
    const transport = vi.fn(async () => {});
    const db = proxyBatch(async (statements) => {
      const results = await env.DB.batch(statements);
      if (fault === "lost receipt") throw new Error("Synthetic lost commit acknowledgement");
      if (fault === "invalid receipt") results[2].meta.changes = 0;
      if (fault === "delete scope") {
        await env.DB.prepare("DELETE FROM follow_subscribers WHERE id=?")
          .bind(pending.subscriberId)
          .run();
      }
      if (fault === "replace token") {
        await mintFollowToken(env.DB, pending.subscriberId, "confirm", {
          scopeKey: pending.scopeKey,
        });
      }
      if (fault === "changed recipient") {
        await env.DB.prepare("UPDATE follow_subscribers SET email=? WHERE id=?")
          .bind("replacement@example.test", pending.subscriberId)
          .run();
      }
      return results;
    });
    expect(await delivery(pending, { db, transport })).toEqual(status("unavailable"));
    expect(await delivery(pending, { transport })).toEqual(status("unavailable"));
    expect((await budget()).attempts).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  },
);

it("a token insert failure rolls back the shared debit, claim and every hash", async () => {
  const pending = await queue();
  await env.DB.prepare(
    "CREATE TRIGGER fail_unsubscribe BEFORE INSERT ON follow_tokens WHEN NEW.purpose='unsubscribe' " +
      "BEGIN SELECT RAISE(ABORT,'synthetic token insert failure'); END",
  ).run();
  const transport = vi.fn(async () => {});
  try {
    expect(await delivery(pending, { transport })).toEqual(status("unavailable"));
    expect(await budget()).toBeNull();
    expect((await job(pending)).claim_id).toBeNull();
    expect(await count("follow_tokens")).toBe(0);
    expect(await count("follow_request_deletions")).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_unsubscribe").run();
  }
  expect(await delivery(pending, { transport })).toEqual(status("accepted"));
});

it("a future Worker day cannot advance the SQLite-qualified shared ledger", async () => {
  const pending = await queue();
  expect(await reserveFollowSendAttempt(env.DB, 2)).toBe(true);
  const previous = await budget();
  const transport = vi.fn(async () => {});
  expect(await delivery(pending, { clock: () => new Date(Date.now() + DAY), transport })).toEqual(
    status("unavailable"),
  );
  expect(await budget()).toEqual(previous);
  expect((await job(pending)).claim_id).toBeNull();
  expect(transport).not.toHaveBeenCalled();
});

it("an ambiguous transport call is terminal and spends only one attempt", async () => {
  const pending = await queue();
  const transport = vi.fn(async () => {
    throw new Error("Synthetic uncertain transport");
  });
  expect(await delivery(pending, { transport })).toEqual(status("uncertain"));
  expect(await delivery(pending, { transport })).toEqual(status("unavailable"));
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await budget()).attempts).toBe(1);
});
