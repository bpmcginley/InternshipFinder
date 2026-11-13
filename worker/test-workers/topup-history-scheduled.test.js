import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, it } from "vitest";
import { runTopupHistoryScheduled as run } from "../src/topup-history-scheduled.js";
const fixed = ["4,34 * * * *", "27 7 * * *", "47 7 * * *", "17 7 * * *"];
const config = () => ({
  enabled: true,
  cron: "51 3 * * *",
  limit: 2,
  maxPages: 3,
  deadlineMs: 5000,
});
const context = () => ({
  excludedCrons: fixed,
  getDb: () => env.DB,
  monotonicNow: () => performance.now(),
});
const call = (descriptor = config(), ctx = context(), cron = descriptor.cron) =>
  run(cron, descriptor, ctx);
const unavailable = { status: "unavailable", pages: 0, removed: 0 };
const count = () => env.DB.prepare("SELECT count(*) n FROM topup_history_receipts").first("n");
async function seed(n) {
  await env.DB.prepare(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO topup_history_receipts SELECT printf('%064x',x),strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days') FROM n",
  )
    .bind(n)
    .run();
}
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM topup_history_receipts").run();
});
it("one explicit daily invocation drains actual indexed receipt pages", async () => {
  await seed(5);
  assert.deepEqual(await call(), { status: "complete", pages: 3, removed: 5 });
  assert.equal(await count(), 0);
});
it("default, off, inherited enablement and unmatched events inspect no context", async () => {
  let reads = 0;
  const trap = () => {
    reads++;
    throw Error();
  };
  const ctx = Object.defineProperty({}, "getDb", { get: trap });
  for (const descriptor of [
    undefined,
    {},
    Object.create({ enabled: true }),
    {
      enabled: false,
      get cron() {
        return trap();
      },
    },
  ])
    assert.deepEqual(await run("51 3 * * *", descriptor, ctx), { status: "disabled" });
  assert.deepEqual(await run("52 3 * * *", config(), ctx), { status: "disabled" });
  assert.equal(reads, 0);
});
it("descriptor requires exact plain own-data daily UTC shape and free-tier page ceiling", async () => {
  let reads = 0;
  const ctx = {
    ...context(),
    getDb() {
      reads++;
      throw Error();
    },
  };
  for (const change of [
    { cron: "04 7 * * *" },
    { cron: "60 3 * * *" },
    { cron: "1 24 * * *" },
    { cron: "*/5 * * * *" },
    { cron: "1 3 * * MON" },
    { cron: "1 3 * * * " },
    { limit: 0 },
    { limit: 257 },
    { maxPages: 49 },
    { maxPages: 0 },
    { deadlineMs: 0 },
    { deadlineMs: 60001 },
    { extra: true },
  ])
    assert.deepEqual(await call({ ...config(), ...change }, ctx), unavailable);
  assert.deepEqual(await call(Object.assign(Object.create({}), config()), ctx), unavailable);
  assert.deepEqual(
    await run(
      "51 3 * * *",
      {
        ...config(),
        get enabled() {
          reads++;
          throw Error();
        },
      },
      ctx,
    ),
    unavailable,
  );
  assert.deepEqual(
    await call(Object.defineProperty(config(), "enabled", { enumerable: false }), ctx),
    unavailable,
  );
  assert.equal(reads, 0);
});
it("semantic collisions cover the existing four and configured lists and ranges", async () => {
  let reads = 0;
  for (const [cron, excluded] of [
    ["4 7 * * *", fixed],
    ["34 3 * * *", fixed],
    ["27 7 * * *", fixed],
    ["47 7 * * *", fixed],
    ["17 7 * * *", fixed],
    ["51 3 * * *", [...fixed, "50-55 2-4 * * *"]],
    ["51 3 * * *", [...fixed, "49,51 3 * * *"]],
  ])
    assert.deepEqual(
      await call(
        { ...config(), cron },
        {
          ...context(),
          excludedCrons: excluded,
          getDb() {
            reads++;
            throw Error();
          },
        },
      ),
      unavailable,
    );
  assert.equal(reads, 0);
});
it("unverifiable or accessor exclusions hold without consulting database", async () => {
  let reads = 0;
  const ctx = {
    ...context(),
    getDb() {
      reads++;
      throw Error();
    },
  };
  for (const excludedCrons of [
    [],
    Array(17).fill("1 1 * * *"),
    ["1 */3 * * *"],
    ["*/5 * * * *"],
    ["1 1 * * MON"],
    ["x"],
    Array(1),
  ])
    assert.deepEqual(await call(config(), { ...ctx, excludedCrons }), unavailable);
  const arr = Object.defineProperty(["1 1 * * *"], "0", {
    get() {
      reads++;
      throw Error();
    },
  });
  assert.deepEqual(await call(config(), { ...ctx, excludedCrons: arr }), unavailable);
  assert.equal(reads, 0);
});
it("48 pages cannot spill into a 49th database call", async () => {
  await seed(49);
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch(s) {
      calls++;
      return env.DB.batch(s);
    },
  };
  assert.deepEqual(
    await call(
      { ...config(), limit: 1, maxPages: 48, deadlineMs: 60000 },
      { ...context(), getDb: () => db },
    ),
    { status: "partial", pages: 48, removed: 48 },
  );
  assert.equal(calls, 48);
  assert.equal(await count(), 1);
});
it("database acquisition delay consumes the same drain deadline", async () => {
  await seed(1);
  let time = 0,
    calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch(s) {
      calls++;
      return env.DB.batch(s);
    },
  };
  assert.deepEqual(
    await call(
      { ...config(), deadlineMs: 10 },
      {
        ...context(),
        monotonicNow: () => time,
        getDb() {
          time = 10;
          return db;
        },
      },
    ),
    { status: "partial", pages: 0, removed: 0 },
  );
  assert.equal(calls, 0);
  assert.equal(await count(), 1);
});
it("lost acknowledgement and late short page preserve inherited drain statuses", async () => {
  await seed(3);
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(s) {
      calls++;
      await env.DB.batch(s);
      throw Error("lost");
    },
  };
  assert.deepEqual(await call(config(), { ...context(), getDb: () => db }), {
    status: "unavailable",
    pages: 1,
    removed: 0,
  });
  assert.equal(calls, 1);
  assert.equal(await count(), 1);
  let time = 0;
  const late = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(s) {
      const r = await env.DB.batch(s);
      time = 10;
      return r;
    },
  };
  assert.deepEqual(
    await call(
      { ...config(), deadlineMs: 10 },
      { ...context(), getDb: () => late, monotonicNow: () => time },
    ),
    { status: "partial", pages: 1, removed: 1 },
  );
});
it("accidental async DB port is held without unhandled ordinary rejection", async () => {
  assert.deepEqual(
    await call(config(), {
      ...context(),
      getDb: async () => {
        throw Error("synthetic");
      },
    }),
    unavailable,
  );
  await new Promise((r) => setTimeout(r, 0));
});
