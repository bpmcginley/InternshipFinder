import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, it } from "vitest";
import { drainTopupHistoryReceipts as drain } from "../src/topup-history-drain.js";
import { cleanupTopupHistoryReceipts as cleanup } from "../src/topup-history-observation.js";
const options = () => ({
  enabled: true,
  limit: 2,
  maxPages: 3,
  deadlineMs: 1000,
  monotonicNow: () => performance.now(),
});
const rows = async () =>
  (await env.DB.prepare("SELECT * FROM topup_history_receipts ORDER BY event_digest").all())
    .results;
async function seed(n, modifier = "-31 days", base = 0) {
  await env.DB.prepare(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO topup_history_receipts SELECT printf('%064x',x+?),strftime('%Y-%m-%dT%H:%M:%fZ','now',?) FROM n",
  )
    .bind(n, base, modifier)
    .run();
}
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM topup_history_receipts").run();
});
it("drains full pages and requires the acknowledged short page", async () => {
  await seed(5);
  assert.deepEqual(await drain(env.DB, options()), { status: "complete", pages: 3, removed: 5 });
  assert.deepEqual(await rows(), []);
  assert.deepEqual(await drain(env.DB, options()), { status: "complete", pages: 1, removed: 0 });
});
it("exact full final page remains partial even when it removed the last row", async () => {
  await seed(4);
  assert.deepEqual(await drain(env.DB, { ...options(), maxPages: 2 }), {
    status: "partial",
    pages: 2,
    removed: 4,
  });
  assert.deepEqual(await rows(), []);
});
it("cap stops with remaining backlog and a fresh invocation can complete", async () => {
  await seed(5);
  assert.deepEqual(await drain(env.DB, { ...options(), maxPages: 2 }), {
    status: "partial",
    pages: 2,
    removed: 4,
  });
  assert.equal((await rows()).length, 1);
  assert.deepEqual(await drain(env.DB, options()), { status: "complete", pages: 1, removed: 1 });
});
it("uses database UTC inclusive thirty-day cutoff and leaves younger, future and unrelated records", async () => {
  await seed(1, "-30 days");
  await seed(1, "-29 days", 1);
  await seed(1, "+1 day", 2);
  const before = (await rows()).slice(1);
  await env.DB.prepare(
    "INSERT INTO topup_history_coverage VALUES('test',?,'fixture','2020-01-01T00:00:00.000Z',NULL,1,'unproven')",
  )
    .bind("a".repeat(32))
    .run();
  const other = await env.DB.prepare("SELECT * FROM topup_history_coverage").all();
  assert.deepEqual(await drain(env.DB, options()), { status: "complete", pages: 1, removed: 1 });
  assert.deepEqual(await rows(), before);
  assert.deepEqual(
    await env.DB.prepare("SELECT * FROM topup_history_coverage")
      .all()
      .then((r) => r.results),
    other.results,
  );
});
it("ties retain digest ordering and use the existing expiry index", async () => {
  await seed(4);
  const before = await rows();
  assert.deepEqual(await drain(env.DB, { ...options(), maxPages: 1 }), {
    status: "partial",
    pages: 1,
    removed: 2,
  });
  assert.deepEqual(await rows(), before.slice(2));
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT event_digest FROM topup_history_receipts INDEXED BY topup_history_receipts_expiry WHERE observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') ORDER BY observed_at,event_digest LIMIT 2",
  ).all();
  const detail = plan.results.map((r) => r.detail).join(" ");
  assert.match(detail, /SEARCH.*topup_history_receipts_expiry/);
  assert.doesNotMatch(detail, /SCAN|TEMP/);
});
it("disabled and malformed configuration perform no DB or option getter I/O", async () => {
  let touches = 0;
  const nope = () => {
    touches++;
    throw new Error();
  };
  const db = Object.defineProperty({}, "prepare", { get: nope });
  assert.deepEqual(await drain(db), { status: "disabled" });
  assert.deepEqual(await drain(db, Object.create({ enabled: true })), { status: "disabled" });
  assert.deepEqual(
    await drain(db, {
      enabled: false,
      get limit() {
        return nope();
      },
    }),
    { status: "disabled" },
  );
  for (const change of [
    { limit: 0 },
    { limit: 257 },
    { maxPages: 0 },
    { maxPages: 257 },
    { deadlineMs: 0 },
    { deadlineMs: 60001 },
    { monotonicNow: null },
    { extra: true },
  ])
    assert.deepEqual(await drain(db, { ...options(), ...change }), {
      status: "unavailable",
      pages: 0,
      removed: 0,
    });
  assert.deepEqual(
    await drain(db, {
      ...options(),
      get limit() {
        return nope();
      },
    }),
    { status: "unavailable", pages: 0, removed: 0 },
  );
  assert.equal(touches, 0);
});
it("deadline equality before preparation stops with zero submissions", async () => {
  let calls = 0,
    time = -1;
  const db = {
    prepare() {
      calls++;
      throw new Error();
    },
  };
  assert.deepEqual(await drain(db, { ...options(), deadlineMs: 1, monotonicNow: () => ++time }), {
    status: "partial",
    pages: 0,
    removed: 0,
  });
  assert.equal(calls, 0);
});
for (const boundary of ["prepare", "batch"])
  it(`time consumed by ${boundary} lookup cannot admit a late batch`, async () => {
    await seed(2);
    let time = 0,
      calls = 0;
    const db = {
      prepare(sql) {
        if (boundary === "prepare") time = 10;
        return env.DB.prepare(sql);
      },
      get batch() {
        if (boundary === "batch") time = 10;
        return (s) => {
          calls++;
          return env.DB.batch(s);
        };
      },
    };
    assert.deepEqual(await drain(db, { ...options(), deadlineMs: 10, monotonicNow: () => time }), {
      status: "partial",
      pages: 0,
      removed: 0,
    });
    assert.equal(calls, 0);
    assert.equal((await rows()).length, 2);
  });
for (const n of [1, 2])
  it(`late acknowledged ${n === 1 ? "short" : "full"} page preserves totals but cannot complete`, async () => {
    await seed(n);
    let time = 0,
      calls = 0;
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(s) {
        calls++;
        const receipt = await env.DB.batch(s);
        time = 10;
        return receipt;
      },
    };
    assert.deepEqual(await drain(db, { ...options(), deadlineMs: 10, monotonicNow: () => time }), {
      status: "partial",
      pages: 1,
      removed: n,
    });
    assert.equal(calls, 1);
  });
it("lost committed acknowledgement holds without retry or claiming unknown removal", async () => {
  await seed(3);
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(s) {
      calls++;
      await env.DB.batch(s);
      throw new Error("synthetic lost ACK");
    },
  };
  assert.deepEqual(await drain(db, options()), { status: "unavailable", pages: 1, removed: 0 });
  assert.equal(calls, 1);
  assert.equal((await rows()).length, 1);
});
it("malformed second acknowledgement preserves only previously acknowledged totals", async () => {
  await seed(5);
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(s) {
      const r = await env.DB.batch(s);
      if (++calls === 2) delete r[0].meta.changes;
      return r;
    },
  };
  assert.deepEqual(await drain(db, options()), { status: "unavailable", pages: 2, removed: 2 });
  assert.equal(calls, 2);
  assert.equal((await rows()).length, 1);
});
it("cleanup rejects forged changes accessor without evaluating it", async () => {
  await seed(3);
  let getters = 0,
    calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(s) {
      calls++;
      const r = await env.DB.batch(s);
      Object.defineProperty(r[0].meta, "changes", {
        get() {
          return ++getters < 4 ? 2 : 0;
        },
      });
      return r;
    },
  };
  assert.deepEqual(await drain(db, options()), { status: "unavailable", pages: 1, removed: 0 });
  assert.equal(getters, 0);
  assert.equal(calls, 1);
  assert.equal((await rows()).length, 1);
});
it("cleanup rejects malformed or accessor receipt containers without a retry", async () => {
  for (const kind of ["batch", "success", "results", "meta", "count", "bad-count", "nonempty"]) {
    let touches = 0;
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(s) {
        const r = await env.DB.batch(s);
        if (kind === "bad-count") r[0].meta.changes = 257;
        else if (kind === "nonempty") r[0].results = [{}];
        else {
          const [target, key] = {
            batch: [r, "0"],
            success: [r[0], "success"],
            results: [r[0], "results"],
            meta: [r[0], "meta"],
            count: [r[0].meta, "changes"],
          }[kind];
          Object.defineProperty(target, key, {
            get() {
              touches++;
              throw new Error();
            },
          });
        }
        return r;
      },
    };
    assert.deepEqual(
      await cleanup(db, { enabled: true, limit: 2 }),
      { status: "unavailable" },
      kind,
    );
    assert.equal(touches, 0);
  }
});
it("backward or invalid monotonic clocks hold rather than extending work", async () => {
  for (const invalid of [-1, NaN, Infinity]) {
    let calls = 0;
    assert.deepEqual(
      await drain(
        {
          prepare() {
            calls++;
          },
        },
        { ...options(), monotonicNow: () => invalid },
      ),
      { status: "unavailable", pages: 0, removed: 0 },
    );
    assert.equal(calls, 0);
  }
  await seed(3);
  let time = 2;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(s) {
      const r = await env.DB.batch(s);
      time = 1;
      return r;
    },
  };
  assert.deepEqual(await drain(db, { ...options(), monotonicNow: () => time }), {
    status: "unavailable",
    pages: 1,
    removed: 2,
  });
});

it("native fixed-clock boundary removes equality but preserves the next millisecond", async () => {
  const clock = "2030-01-31T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO topup_history_receipts VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'-30 days'))",
    ).bind("a".repeat(64), clock),
    env.DB.prepare(
      "INSERT INTO topup_history_receipts VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'-30 days','+0.001 seconds'))",
    ).bind("b".repeat(64), clock),
  ]);
  let replacements = 0;
  const db = {
    prepare(sql) {
      assert.equal(sql.split("'now'").length, 2);
      replacements++;
      // Change only the native SQL clock source; preserve exact indexed DELETE predicate.
      return env.DB.prepare(sql.replace("'now'", `'${clock}'`));
    },
    batch: env.DB.batch.bind(env.DB),
  };
  assert.deepEqual(await drain(db, options()), { status: "complete", pages: 1, removed: 1 });
  assert.equal(replacements, 1);
  assert.deepEqual(
    (await rows()).map((r) => r.event_digest),
    ["b".repeat(64)],
  );
});
it("supports the full existing 256-row page with explicit aggregate bounds", async () => {
  await seed(257);
  assert.deepEqual(
    await drain(env.DB, { ...options(), limit: 256, maxPages: 256, deadlineMs: 60000 }),
    { status: "complete", pages: 2, removed: 257 },
  );
});

it("accidental rejected async clock fails closed without an unhandled rejection", async () => {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw new Error();
    },
  };
  assert.deepEqual(
    await drain(db, {
      ...options(),
      monotonicNow: async () => {
        throw new Error("synthetic clock rejection");
      },
    }),
    { status: "unavailable", pages: 0, removed: 0 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
});
it("async clock after an acknowledged page retains aggregate without another submission", async () => {
  await seed(3);
  let settled = false,
    calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(s) {
      calls++;
      const r = await env.DB.batch(s);
      settled = true;
      return r;
    },
  };
  assert.deepEqual(
    await drain(db, {
      ...options(),
      monotonicNow: () =>
        settled ? Promise.reject(new Error("synthetic late clock rejection")) : 0,
    }),
    { status: "unavailable", pages: 1, removed: 2 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal((await rows()).length, 1);
});
it("invalid clocks never consult foreign thenables or native then getters", async () => {
  let reads = 0;
  const trap = () => {
    reads++;
    throw new Error("must not inspect");
  };
  const foreign = Object.defineProperty({}, "then", { get: trap });
  const native = Object.defineProperty(Promise.reject(new Error("synthetic")), "then", {
    get: trap,
  });
  for (const at of [foreign, { then: trap }, native])
    assert.deepEqual(await drain(null, { ...options(), monotonicNow: () => at }), {
      status: "unavailable",
      pages: 0,
      removed: 0,
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 0);
});
