import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import { recordVerifiedTopup } from "../src/topup-ledger.js";

it("local D1 atomically claims a purchase, rolls back failure and preserves terminal replay protection", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const input = {
    paymentId: "pi_d1_fixture",
    checkoutId: "cs_d1_fixture",
    userHash: "a".repeat(64),
    livemode: false,
    offerVersion: "fixture-v1",
    amount: 300,
    currency: "usd",
    units: 25,
  };
  const now = new Date("2026-11-11T12:00:00Z");
  const results = await Promise.all(
    Array.from({ length: 6 }, () => recordVerifiedTopup(env.DB, input, now)),
  );
  expect(results.filter((r) => r.granted)).toHaveLength(1);
  expect(results[0].purchase.available).toBe(25);
  await expect(
    recordVerifiedTopup(env.DB, { ...input, userHash: "b".repeat(64) }, now),
  ).rejects.toThrow(/Conflicting/);
  await expect(
    recordVerifiedTopup(env.DB, { ...input, paymentId: "pi_alias" }, now),
  ).rejects.toThrow(/Conflicting/);
  await env.DB.prepare("UPDATE topup_purchases SET available=20, held=5").run();
  expect((await recordVerifiedTopup(env.DB, input, now)).purchase.available).toBe(20);
  await expect(env.DB.prepare("UPDATE topup_purchases SET available=26").run()).rejects.toThrow();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM topup_purchases"),
    env.DB.prepare("UPDATE topup_claims SET state='deleted'"),
  ]);
  await expect(recordVerifiedTopup(env.DB, input, now)).rejects.toThrow(/unavailable/);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM topup_purchases").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM topup_claims").first("n")).toBe(1);
  await env.DB.prepare(
    "CREATE TRIGGER reject_topup BEFORE INSERT ON topup_purchases BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  ).run();
  const second = { ...input, paymentId: "pi_retry", checkoutId: "cs_retry" };
  await expect(recordVerifiedTopup(env.DB, second, now)).rejects.toThrow(/fixture failure/);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM topup_claims").first("n")).toBe(1);
  await env.DB.prepare("DROP TRIGGER reject_topup").run();
  expect((await recordVerifiedTopup(env.DB, second, now)).granted).toBe(true);
  const third = { ...input, paymentId: "pi_third", checkoutId: "cs_third" };
  await recordVerifiedTopup(env.DB, third, now);
  await expect(
    recordVerifiedTopup(env.DB, { ...second, checkoutId: third.checkoutId }, now),
  ).rejects.toThrow(/Conflicting top-up purchase identity/);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM topup_purchases").first("n")).toBe(2);
  for (const aliases of [
    [
      { ...input, paymentId: "pi_race", checkoutId: "cs_race_a" },
      { ...input, paymentId: "pi_race", checkoutId: "cs_race_b" },
    ],
    [
      { ...input, paymentId: "pi_race_c", checkoutId: "cs_race" },
      { ...input, paymentId: "pi_race_d", checkoutId: "cs_race" },
    ],
  ]) {
    const raced = await Promise.allSettled(
      aliases.map((value) => recordVerifiedTopup(env.DB, value, now)),
    );
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM topup_purchases").first("n")).toBe(4);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM topup_claims").first("n")).toBe(5);
});
