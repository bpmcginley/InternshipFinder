import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { CLOCK_CRON } from "../src/clock.js";

function runClock(bindings) {
  const pending = [];
  worker.scheduled(
    { cron: CLOCK_CRON, scheduledTime: Date.now() - 86400000 },
    bindings,
    { waitUntil: (promise) => pending.push(promise) },
  );
  return Promise.all(pending);
}

it("leaves employer maintenance off unless its own flag is exactly 1", async () => {
  const prepare = vi.fn(() => {
    throw new Error("Disabled maintenance must not access D1");
  });
  for (const value of [undefined, "0", true]) {
    await expect(
      runClock({
        DB: { prepare },
        EMPLOYER_POSTING_COUNTS_ENABLED: "1",
        EMPLOYER_POSTING_MAINTENANCE_ENABLED: value,
      }),
    ).resolves.toHaveLength(1);
  }
  expect(prepare).not.toHaveBeenCalled();
});

it("runs bounded retention with intake off and independently of GitHub dispatch", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const { day } = await env.DB.prepare("SELECT date('now') AS day").first();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO employer_posting_day_caps VALUES(?,7)").bind(day),
    env.DB
      .prepare("INSERT INTO employer_posting_counts VALUES(date(?,'-91 days'),'expired',1)")
      .bind(day),
  ]);
  const bindings = { DB: env.DB, EMPLOYER_POSTING_MAINTENANCE_ENABLED: "1" };
  await expect(runClock(bindings)).resolves.toContainEqual({ status: "ready" });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new TypeError("Synthetic dispatch failure"));
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await env.DB
      .prepare("INSERT INTO employer_posting_counts VALUES(date(?,'-91 days'),'expired',1)")
      .bind(day)
      .run();
    await expect(
      runClock({ ...bindings, GITHUB_DISPATCH_TOKEN: "synthetic-dispatch" }),
    ).resolves.toContainEqual({ status: "ready" });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    report.mockRestore();
    fetch.mockRestore();
  }
  expect(await env.DB.prepare("SELECT n FROM employer_posting_day_caps").first()).toEqual({ n: 7 });
  expect((await env.DB.prepare("SELECT day FROM employer_posting_counts").all()).results).toEqual([]);
});
