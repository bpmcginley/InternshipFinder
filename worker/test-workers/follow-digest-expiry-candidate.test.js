import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { expireFollowDigestCandidate } from "../src/follow-digest-expiry-candidate.js";
import { expireFollowDigestPage } from "../src/follow-digest-expiry-page.js";

const at = "2026-11-13T05:00:00.000Z";
const old = "2026-11-06T05:00:00.000Z";
const recent = "2026-11-12T05:00:00.000Z";
const future = "2026-11-20T05:00:00.000Z";
const initial = "2026-11-01T05:00:00.000Z";
const first = "2026-11-02T05:00:00.000Z";
const second = "2026-11-03T05:00:00.000Z";
const generation = "00000000-0000-0000-0000-000000000001";
const enabled = { enabled: true };
const rows = async (db, sql) => (await db.prepare(sql).all()).results;

async function seed(db) {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare("DELETE FROM follow_subscribers"),
    db.prepare("DELETE FROM follow_digest_days"),
    db.prepare("DELETE FROM follow_send_budget"),
    db
      .prepare(
        "INSERT INTO follow_subscribers VALUES('fixture','fixture@example.test',?,NULL,NULL)",
      )
      .bind(initial),
    db
      .prepare("INSERT INTO follow_subscriptions VALUES('fixture','scope',?,?,NULL)")
      .bind(initial, initial),
    db
      .prepare("INSERT INTO follow_scope_progress VALUES('fixture','scope',?,?)")
      .bind(generation, initial),
    db.prepare("INSERT INTO follow_digest_days VALUES(?,?)").bind("3".repeat(64), future),
    db.prepare("INSERT INTO follow_send_budget VALUES(1,?,3)").bind(at),
    db.prepare(
      "UPDATE follow_delivery_owner SET generation='ffffffffffffffffffffffffffffffff',phase='held',next_kind='management'",
    ),
  ]);
}

const job = (db, key, id, state, { created = recent, expires = future, lease = null } = {}) =>
  db
    .prepare(
      `INSERT INTO follow_digest_outbox(rowid,id,subscriber_id,day,payload,created,expires_at,state,lease_token,lease_until,attempted_at,accepted_at)
    VALUES(CAST(? AS INTEGER),?,'fixture',?,'[]',?,?,?,?,?,?,NULL)`,
    )
    .bind(
      key,
      id,
      id,
      created,
      expires,
      state,
      lease ? "fixture" : null,
      lease,
      state === "attempting" ? created : null,
    );
const pending = (db, id, from, to) =>
  db
    .prepare("INSERT INTO follow_pending_progress VALUES(?,?,?,?)")
    .bind(
      id,
      "a".repeat(64),
      to,
      JSON.stringify([{ scopeKey: "scope", generation, confirmedAt: initial, from, to }]),
    );

function port(db, { mutate = async (stmts) => db.batch(stmts), reads = [], clock = [] } = {}) {
  return {
    prepare(sql) {
      if (sql.startsWith("SELECT strftime(")) {
        return {
          all() {
            clock.push(at);
            return db.prepare("SELECT ? AS at").bind(at).all();
          },
        };
      }
      const statement = db.prepare(sql);
      if (!sql.startsWith("WITH")) return statement;
      return {
        bind(...args) {
          return {
            async all() {
              const result = await statement.bind(...args).all();
              reads.push(result.meta.rows_read);
              return result;
            },
          };
        },
      };
    },
    batch: mutate,
  };
}

async function snapshot(db) {
  return Promise.all(
    [
      "SELECT id,state,payload,lease_token,lease_until FROM follow_digest_outbox WHERE id NOT LIKE 'keep-%' ORDER BY id",
      "SELECT * FROM follow_pending_progress ORDER BY job_id",
      "SELECT * FROM follow_scope_progress",
      "SELECT * FROM follow_digest_days",
      "SELECT * FROM follow_send_budget",
      "SELECT * FROM follow_delivery_owner",
    ].map((sql) => rows(db, sql)),
  );
}

it("qualifies ordered expiry and bounded reads with 20000 healthy jobs", async () => {
  const db = env.DB;
  await seed(db);
  await db.batch([
    db
      .prepare(
        `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
      INSERT INTO follow_digest_outbox SELECT 'keep-'||i,'fixture','keep-'||i,'[]',?,?,'queued',NULL,NULL,NULL,NULL FROM n`,
      )
      .bind(recent, future),
    job(db, "20001", "a-old-overlap", "attempting", { created: old, lease: at }),
    pending(db, "a-old-overlap", initial, first),
    job(db, "20002", "b-queue", "queued", { expires: at }),
    job(db, "20003", "c-lease", "leased", { expires: at, lease: future }),
    job(db, "20004", "d-old-live", "attempting", { created: old, lease: future }),
    pending(db, "d-old-live", first, second),
    job(db, "20005", "e-healthy", "leased", { lease: future }),
  ]);
  const before = await snapshot(db);
  const reads = [],
    clock = [],
    batchReads = [];
  const binding = port(db, {
    reads,
    clock,
    async mutate(stmts) {
      const result = await db.batch(stmts);
      batchReads.push(result.reduce((sum, r) => sum + r.meta.rows_read, 0));
      return result;
    },
  });
  const prepare = binding.prepare;
  const queryPlans = [];
  binding.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("UPDATE") && !sql.startsWith("DELETE")) return statement;
    return {
      bind(...args) {
        queryPlans.push([sql, args]);
        return statement.bind(...args);
      },
    };
  };
  const expected = [
    [1, 0, 1],
    [0, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (const [uncertain, cancelled, removed] of expected) {
    expect(await expireFollowDigestCandidate(binding, enabled)).toEqual({
      status: "maintained",
      complete: false,
      uncertain,
      cancelled,
      removed,
    });
  }
  expect(await expireFollowDigestCandidate(binding, enabled)).toEqual({
    status: "maintained",
    complete: true,
  });
  const plans = await Promise.all(
    queryPlans.map(async ([sql, args]) =>
      (
        await db
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .bind(...args)
          .all()
      ).results
        .map((row) => row.detail)
        .join("\n"),
    ),
  );
  expect(plans).toHaveLength(5);
  for (const plan of plans) {
    expect(plan).toMatch(/SEARCH follow_digest_outbox USING INTEGER PRIMARY KEY/);
    expect(plan).not.toMatch(/SCAN (follow_digest_outbox|q)\b/);
  }
  const guarded = plans.filter((plan) => plan.includes("follow_digest_outbox_due"));
  expect(guarded).toHaveLength(4);
  for (const plan of guarded) {
    for (const index of ["due", "expiry", "created"])
      expect(plan).toContain(`follow_digest_outbox_${index}`);
    expect(plan).toMatch(
      /SEARCH p USING INDEX sqlite_autoindex_follow_pending_progress_1 \(job_id=\?\)/,
    );
  }
  expect(clock).toHaveLength(5);
  expect(reads).toHaveLength(5);
  expect(Math.max(...reads)).toBeLessThan(50);
  expect(Math.max(...batchReads)).toBeLessThan(150);
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM follow_digest_outbox WHERE id LIKE 'keep-%'")
      .first("n"),
  ).toBe(20000);
  const after = await snapshot(db);
  expect(after[0].map(({ id, state }) => [id, state])).toEqual([
    ["b-queue", "cancelled"],
    ["c-lease", "cancelled"],
    ["e-healthy", "leased"],
  ]);
  expect(after[1]).toEqual([]);
  expect(after[2][0].watermark).toBe(first);
  expect(after.slice(3)).toEqual(before.slice(3));
  console.log("digest candidate D1 rows read", JSON.stringify({ reads, batchReads }));
});

for (const chained of [false, true]) {
  it(`preserves ${chained ? "chained" : "competing"} watermark order for signed rowids`, async () => {
    for (const db of [env.DB, env.MIGRATION_DB]) {
      await seed(db);
      await db.batch([
        job(db, "-9223372036854775808", "a", "attempting", { lease: at }),
        pending(db, "a", initial, first),
        job(db, "9223372036854775807", "b", "attempting", { lease: recent }),
        pending(db, "b", chained ? first : initial, second),
      ]);
    }
    let cursor = null;
    do {
      const page = await expireFollowDigestPage(port(env.DB), { ...enabled, maxRows: 1, cursor });
      expect(page.status).toBe("maintained");
      cursor = page.next;
    } while (cursor);
    for (let n = 0; n < 2; n++)
      expect(await expireFollowDigestCandidate(port(env.MIGRATION_DB), enabled)).toMatchObject({
        status: "maintained",
        uncertain: 1,
      });
    expect(await expireFollowDigestCandidate(port(env.MIGRATION_DB), enabled)).toEqual({
      status: "maintained",
      complete: true,
    });
    const actual = await snapshot(env.MIGRATION_DB);
    expect(actual).toEqual(await snapshot(env.DB));
    expect(actual[2][0].watermark).toBe(chained ? second : first);
  });
}

it("fails closed at three due attempts without writing any job", async () => {
  const db = env.DB;
  await seed(db);
  await db.batch(
    [1, 2, 3, 4].map((key) => job(db, String(key), `a${key}`, "attempting", { lease: at })),
  );
  const before = await snapshot(db);
  let mutations = 0;
  const binding = port(db, {
    mutate() {
      mutations++;
      throw Error();
    },
  });
  expect(await expireFollowDigestCandidate(binding, enabled)).toEqual({ status: "unavailable" });
  expect(mutations).toBe(0);
  expect(await snapshot(db)).toEqual(before);
});

it("rechecks the complete attempt set and exact identity before admission", async () => {
  const db = env.DB;
  for (const race of ["append", "saturate", "replace-peer", "replace", "state"]) {
    await seed(db);
    await job(db, "2", "a", "attempting", { created: old, lease: at }).run();
    await pending(db, "a", initial, first).run();
    if (["saturate", "replace-peer"].includes(race))
      await job(db, "3", "peer", "attempting", { lease: at }).run();
    let calls = 0;
    const binding = port(db, {
      async mutate(stmts) {
        calls++;
        if (race === "append") await job(db, "3", "b", "attempting", { lease: at }).run();
        if (race === "saturate") await job(db, "4", "third", "attempting", { lease: at }).run();
        if (race === "replace-peer") {
          await db.prepare("DELETE FROM follow_digest_outbox WHERE rowid=3").run();
          await job(db, "3", "other-peer", "attempting", { lease: at }).run();
        }
        if (race === "replace") {
          await db.prepare("DELETE FROM follow_digest_outbox WHERE rowid=2").run();
          await job(db, "2", "replacement", "attempting", { created: old, lease: at }).run();
        }
        if (race === "state")
          await db
            .prepare("UPDATE follow_digest_outbox SET created=? WHERE rowid=2")
            .bind(recent)
            .run();
        const result = await db.batch(stmts);
        expect(result.map((r) => r.meta.changes)).toEqual([0, 0]);
        return result;
      },
    });
    expect(await expireFollowDigestCandidate(binding, enabled)).toEqual({ status: "unavailable" });
    expect(calls).toBe(1);
    expect(await db.prepare("SELECT watermark FROM follow_scope_progress").first("watermark")).toBe(
      initial,
    );
    expect(
      await db.prepare("SELECT state FROM follow_digest_outbox WHERE rowid=2").first("state"),
    ).toBe("attempting");
  }
});

it("rolls back overlap and never retries missing or contradictory write receipts", async () => {
  const db = env.DB;
  for (const mode of ["rollback", "lost", "contradictory"]) {
    await seed(db);
    await job(db, "1", "a", "attempting", { created: old, lease: at }).run();
    await pending(db, "a", initial, first).run();
    const before = await snapshot(db);
    let calls = 0;
    if (mode === "rollback")
      await db
        .prepare(
          "CREATE TRIGGER candidate_fail BEFORE DELETE ON follow_digest_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END",
        )
        .run();
    try {
      const binding = port(db, {
        async mutate(stmts) {
          calls++;
          const result = await db.batch(stmts);
          if (mode === "lost") throw Error("synthetic lost acknowledgement");
          result[1].results[0].rowid = "2";
          return result;
        },
      });
      expect(await expireFollowDigestCandidate(binding, enabled)).toEqual({
        status: "unavailable",
      });
      expect(calls).toBe(1);
      const after = await snapshot(db);
      if (mode === "rollback") expect(after).toEqual(before);
      else {
        expect(after[0]).toEqual([]);
        expect(after[2][0].watermark).toBe(first);
      }
    } finally {
      if (mode === "rollback") await db.prepare("DROP TRIGGER candidate_fail").run();
    }
  }
});

it("keeps disabled and malformed planning receipts away from mutations", async () => {
  const never = {
    prepare() {
      throw Error("unexpected prepare");
    },
  };
  expect(await expireFollowDigestCandidate(never)).toEqual({ status: "disabled" });
  expect(await expireFollowDigestCandidate(never, { enabled: "1" })).toEqual({
    status: "disabled",
  });
  expect(await expireFollowDigestCandidate(never, { enabled: true, extra: 1 })).toEqual({
    status: "unavailable",
  });
  const db = env.DB;
  await seed(db);
  await job(db, "1", "a", "attempting", { lease: at }).run();
  const before = await snapshot(db);
  for (const amend of [
    (r) => {
      r.results[0].due = 0;
    },
    (r) => {
      r.results[0].first_id = "other";
    },
    (r) => {
      r.results[0].selected = "-0";
    },
    (r) => {
      delete r.results[0].target;
    },
    (r) => {
      r.results[0].digest = "a".repeat(64);
    },
    (r) => {
      delete r.results[0].snapshot_at;
    },
  ]) {
    let batches = 0;
    const binding = {
      prepare(sql) {
        if (!sql.startsWith("WITH")) return port(db).prepare(sql);
        return {
          bind(...args) {
            return {
              async all() {
                const r = await db
                  .prepare(sql)
                  .bind(...args)
                  .all();
                amend(r);
                return r;
              },
            };
          },
        };
      },
      batch() {
        batches++;
        throw Error("unexpected batch");
      },
    };
    expect(await expireFollowDigestCandidate(binding, enabled)).toEqual({ status: "unavailable" });
    expect(batches).toBe(0);
  }
  expect(await snapshot(db)).toEqual(before);
});

it("fences the pending snapshot used for uncertain finalization", async () => {
  const db = env.DB;
  for (const mode of [
    "digest",
    "time",
    "time-only",
    "advances",
    "remove",
    "insert",
    "stable",
    "absent",
  ]) {
    await seed(db);
    await job(db, "1", "a", "attempting", { created: old, lease: at }).run();
    const advanceRows = [
      { scopeKey: "scope", generation, confirmedAt: initial, from: initial, to: first },
    ];
    if (mode === "stable") {
      const statements = [];
      for (let index = 0; index < 182; index++) {
        const scopeKey = index.toString(36);
        const scopeGeneration = `00000000-0000-0000-0000-${String(index + 2).padStart(12, "0")}`;
        statements.push(
          db
            .prepare("INSERT INTO follow_subscriptions VALUES('fixture',?,?,?,NULL)")
            .bind(scopeKey, initial, initial),
          db
            .prepare("INSERT INTO follow_scope_progress VALUES('fixture',?,?,?)")
            .bind(scopeKey, scopeGeneration, initial),
        );
        advanceRows.push({
          scopeKey,
          generation: scopeGeneration,
          confirmedAt: initial,
          from: initial,
          to: first,
        });
      }
      await db.batch(statements);
    }
    const advances = JSON.stringify(advanceRows).padEnd(32768);
    expect(new TextEncoder().encode(advances)).toHaveLength(32768);
    const put = (digest, snapshot, payload) =>
      db
        .prepare("INSERT INTO follow_pending_progress VALUES('a',?,?,?)")
        .bind(digest, snapshot, payload);
    if (!["insert", "absent"].includes(mode)) await put("a".repeat(64), first, advances).run();
    let calls = 0;
    const reads = [];
    const binding = port(db, {
      reads,
      async mutate(stmts) {
        calls++;
        if (["digest", "time", "time-only", "advances", "remove"].includes(mode))
          await db.prepare("DELETE FROM follow_pending_progress WHERE job_id='a'").run();
        if (mode === "digest") await put("b".repeat(64), first, advances).run();
        if (mode === "time")
          await put("a".repeat(64), second, advances.replace(first, second)).run();
        if (mode === "time-only") await put("a".repeat(64), second, advances).run();
        if (mode === "advances") await put("a".repeat(64), first, advances.slice(0, -1)).run();
        if (mode === "insert") await put("a".repeat(64), first, advances).run();
        const receipts = await db.batch(stmts);
        if (!["stable", "absent"].includes(mode))
          expect(receipts.map((r) => r.meta.changes)).toEqual([0, 0]);
        if (mode === "stable") {
          const batchReads = receipts.map((r) => r.meta.rows_read);
          const batchWrites = receipts.map((r) => r.meta.rows_written);
          expect(batchReads[0]).toBeLessThan(10000);
          expect(batchReads[1]).toBeLessThan(10);
          expect(batchWrites[0]).toBeLessThanOrEqual(187);
          console.log(
            "packed digest candidate D1",
            JSON.stringify({ reads, batchReads, batchWrites }),
          );
        }
        return receipts;
      },
    });
    const result = await expireFollowDigestCandidate(binding, enabled);
    expect(calls).toBe(1);
    if (["stable", "absent"].includes(mode)) {
      expect(result).toEqual({
        status: "maintained",
        complete: false,
        uncertain: 1,
        cancelled: 0,
        removed: 1,
      });
      expect(await rows(db, "SELECT id FROM follow_digest_outbox")).toEqual([]);
    } else {
      expect(result).toEqual({ status: "unavailable" });
      expect(await rows(db, "SELECT state FROM follow_digest_outbox")).toEqual([
        { state: "attempting" },
      ]);
    }
    expect(reads).toHaveLength(1);
    expect(reads[0]).toBeLessThan(50);
    const progress = await rows(db, "SELECT watermark FROM follow_scope_progress");
    const expectedWatermark = mode === "stable" ? first : initial;
    expect(progress).toEqual(
      Array.from({ length: advanceRows.length }, () => ({ watermark: expectedWatermark })),
    );
  }
});
