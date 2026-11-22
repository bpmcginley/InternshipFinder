import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import { createFollowSignupRoute } from "../src/follow-signup-route.js";
import { admitFollowSignup } from "../src/follow-signup-admission.js";
import { createSession, sessionTokenHash } from "../src/session.js";

const NOW = "CAST(round((julianday('now')-2440587.5)*86400000) AS INTEGER)";
const guard = (db, cutoff) =>
  db.prepare("INSERT INTO follow_catalog_admissions(expires_at_ms) VALUES(?)").bind(cutoff);

it("native guard validates exact cutoff, has a zero-write receipt and rolls back the full batch", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const db = env.DB;
  await db.prepare("DELETE FROM rate").run();
  for (const cutoff of [null, "9999999999999", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(
      db.batch([
        db.prepare("INSERT INTO rate(user_hash,bucket,calls) VALUES('fixture','guard',1)"),
        guard(db, cutoff),
      ]),
    ).rejects.toThrow("Follow catalog unavailable");
    expect(await db.prepare("SELECT count(*) AS n FROM rate").first("n")).toBe(0);
  }
  await expect(
    db.prepare(`INSERT INTO follow_catalog_admissions SELECT ${NOW}`).run(),
  ).rejects.toThrow("Follow catalog unavailable");
  await expect(
    db.prepare("INSERT INTO follow_catalog_admissions DEFAULT VALUES").run(),
  ).rejects.toThrow("Follow catalog unavailable");
  const [receipt] = await db.batch([guard(db, Date.now() + 60000)]);
  expect(receipt.success).toBe(true);
  expect(receipt.meta.changes).toBe(0);
  expect(receipt.results).toEqual([]);
  expect(await db.prepare("SELECT count(*) AS n FROM follow_catalog_admissions").first("n")).toBe(
    0,
  );
});

it("native admission permits atomic completion after the clock crosses the cutoff", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const db = env.DB;
  await db.prepare("DELETE FROM rate").run();
  const [receipt, , written, after] = await db.batch([
    db.prepare(`INSERT INTO follow_catalog_admissions SELECT ${NOW}+1 RETURNING expires_at_ms`),
    db.prepare(
      "WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<1000000) SELECT sum(n) FROM slow",
    ),
    db.prepare("INSERT INTO rate(user_hash,bucket,calls) VALUES('fixture','guard',1)"),
    db.prepare(`SELECT ${NOW} AS at`),
  ]);
  expect(receipt.success).toBe(true);
  expect(written.meta.changes).toBe(1);
  expect(after.results[0].at).toBeGreaterThan(receipt.results[0].expires_at_ms);
  expect(await db.prepare("SELECT calls FROM rate WHERE user_hash='fixture'").first("calls")).toBe(
    1,
  );
}, 15000);

const catalog = {
  companies: new Set(["fixture"]),
  fields: new Set(["biology"]),
  states: new Set(["MA"]),
};
const input = (link = false, email = "reader@example.test") => ({
  email,
  link,
  scope: { kind: "company", company: "fixture" },
});
const opts = (more = {}) => ({ enabled: true, dailyLimit: 100, catalog, ...more });
const state = async (db) =>
  Promise.all(
    [
      "follow_subscribers",
      "follow_subscriptions",
      "follow_confirmation_outbox",
      "follow_tokens",
    ].map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results),
  );
async function boot(kind) {
  const db = kind === "legacy" ? env.LEGACY_DB : env.DB;
  if (kind === "legacy") await db.batch(env.TEST_SCHEMA_SQL.map((sql) => db.prepare(sql)));
  else await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch(
    ["follow_subscribers", "rate", "sessions"].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
  return db;
}
async function proof(db) {
  const user = "a".repeat(64);
  const { token } = await createSession(
    db,
    { user, tier: "general", provider: "google" },
    new Date(),
  );
  return { user, id: await sessionTokenHash(token) };
}
for (const kind of ["legacy", "migrations"]) {
  it(`${kind}: expired cutoff preserves new and existing anonymous/linked queue state`, async () => {
    const db = await boot(kind),
      sessionProof = await proof(db);
    for (const link of [false, true]) {
      const request = input(link, `${link}@example.test`);
      let before = await state(db);
      expect(
        await admitFollowSignup(db, request, opts({ sessionProof, catalogExpiresAtMs: 1 })),
      ).toEqual({ status: "unavailable" });
      expect(await state(db)).toEqual(before);
      expect(await admitFollowSignup(db, { ...request, link: false }, opts())).toEqual({
        status: "accepted",
      });
      await db.prepare("UPDATE follow_subscriptions SET created='2020-01-01T00:00:00.000Z'").run();
      await db
        .prepare("UPDATE follow_confirmation_outbox SET expires_at='2020-01-02T00:00:00.000Z'")
        .run();
      before = await state(db);
      expect(
        await admitFollowSignup(db, request, opts({ sessionProof, catalogExpiresAtMs: 1 })),
      ).toEqual({ status: "unavailable" });
      expect(await state(db)).toEqual(before);
      expect(
        await admitFollowSignup(
          db,
          request,
          opts({ sessionProof, catalogExpiresAtMs: Date.now() + 60000 }),
        ),
      ).toEqual({ status: "accepted" });
    }
    expect(await db.prepare("SELECT count(*) AS n FROM follow_catalog_admissions").first("n")).toBe(
      0,
    );
    await db.prepare("UPDATE follow_subscriptions SET confirmed_at=created").run();
    await db
      .prepare(
        "INSERT OR IGNORE INTO follow_scope_progress(subscriber_id,scope_key,scope_generation,watermark) SELECT subscriber_id,scope_key,lower(hex(randomblob(16))),created FROM follow_subscriptions",
      )
      .run();
    const confirmed = await state(db),
      progress = (
        await db.prepare("SELECT * FROM follow_scope_progress ORDER BY subscriber_id").all()
      ).results;
    for (const link of [false, true])
      expect(
        await admitFollowSignup(
          db,
          input(link, `${link}@example.test`),
          opts({ sessionProof, catalogExpiresAtMs: 1 }),
        ),
      ).toEqual({ status: "unavailable" });
    expect(await state(db)).toEqual(confirmed);
    expect(
      (await db.prepare("SELECT * FROM follow_scope_progress ORDER BY subscriber_id").all())
        .results,
    ).toEqual(progress);
    expect(await db.prepare("SELECT calls FROM rate").first("calls")).toBe(10);
  });
  it(`${kind}: expiry before the first batch statement blocks all queue writes`, async () => {
    const db = await boot(kind),
      sessionProof = await proof(db);
    for (const link of [false, true]) {
      const cutoff = Date.now() + 50,
        oldClock = new Date();
      const wrapped = {
        prepare: (sql) => db.prepare(sql),
        batch: async (statements) => {
          while (Date.now() <= cutoff) await new Promise((resolve) => setTimeout(resolve, 5));
          return db.batch(statements);
        },
      };
      expect(
        await admitFollowSignup(
          wrapped,
          input(link),
          opts({ sessionProof, catalogExpiresAtMs: cutoff, clock: () => oldClock }),
        ),
      ).toEqual({ status: "unavailable" });
      expect(await state(db)).toEqual([[], [], [], []]);
    }
    expect(await db.prepare("SELECT calls FROM rate").first("calls")).toBe(2);
  });
}
it("malformed trusted cutoffs fail before rate or queue I/O; explicit undefined is not omission", async () => {
  const db = {
    prepare() {
      throw new Error("unexpected I/O");
    },
    batch() {
      throw new Error("unexpected I/O");
    },
  };
  let reads = 0;
  const watched = {
    prepare() {
      reads++;
      return db.prepare();
    },
    batch() {
      reads++;
      return db.batch();
    },
  };
  for (const cutoff of [
    undefined,
    null,
    "123",
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(await admitFollowSignup(watched, input(), opts({ catalogExpiresAtMs: cutoff }))).toEqual(
      { status: "unavailable" },
    );
  expect(reads).toBe(0);
});
it("uncertain guard receipt never succeeds or retries even after a committed queue", async () => {
  const db = await boot("migrations"),
    sessionProof = await proof(db);
  for (const link of [false, true])
    for (const fault of ["hole", "false", "changes", "results", "length"]) {
      await db.prepare("DELETE FROM follow_subscribers").run();
      let batches = 0;
      const wrapped = {
        prepare: (sql) => db.prepare(sql),
        batch: async (statements) => {
          batches++;
          const rows = await db.batch(statements);
          if (fault === "hole") delete rows[0];
          if (fault === "false") rows[0].success = false;
          if (fault === "changes") rows[0].meta.changes = 1;
          if (fault === "results") rows[0].results = [{}];
          if (fault === "length") rows.pop();
          return rows;
        },
      };
      expect(
        await admitFollowSignup(
          wrapped,
          input(link),
          opts({ sessionProof, catalogExpiresAtMs: Date.now() + 60000 }),
        ),
      ).toEqual({ status: "unavailable" });
      expect(batches).toBe(1);
      expect(
        await db.prepare("SELECT count(*) AS n FROM follow_confirmation_outbox").first("n"),
      ).toBe(1);
    }
});
it("later queue failure rolls back the admitted writes and leaves the cap spent", async () => {
  const db = await boot("migrations"),
    sessionProof = await proof(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_reject_queue BEFORE INSERT ON follow_confirmation_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    )
    .run();
  try {
    for (const link of [false, true]) {
      expect(
        await admitFollowSignup(
          db,
          input(link),
          opts({ sessionProof, catalogExpiresAtMs: Date.now() + 60000 }),
        ),
      ).toEqual({ status: "unavailable" });
      expect(await state(db)).toEqual([[], [], [], []]);
    }
    expect(await db.prepare("SELECT calls FROM rate").first("calls")).toBe(2);
  } finally {
    await db.prepare("DROP TRIGGER fixture_reject_queue").run();
  }
});

for (const kind of ["legacy", "migrations"])
  it(`${kind}: actual HTTP composition cannot queue after expiry during database scheduling`, async () => {
    const db = await boot(kind);
    const { token } = await createSession(
      db,
      { user: "b".repeat(64), tier: "general", provider: "google" },
      new Date(),
    );
    for (const link of [false, true]) {
      let cutoff;
      const wrapped = {
        prepare: (sql) => db.prepare(sql),
        batch: async (statements) => {
          while (Date.now() <= cutoff) await new Promise((resolve) => setTimeout(resolve, 5));
          return db.batch(statements);
        },
      };
      const handle = createFollowSignupRoute({
        enabled: true,
        dailyLimit: 100,
        originAllowed: (r) => r.headers.get("Origin") === "https://example.test",
        loadCatalog: async () => {
          cutoff = Date.now() + 1000;
          return { status: "available", catalog: { signup: catalog }, expiresAt: cutoff };
        },
      });
      const result = await handle(
        new Request("https://api.example.test/unmounted", {
          method: "POST",
          headers: {
            Origin: "https://example.test",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(input(link)),
        }),
        { db: wrapped },
      );
      expect(result.status).toBe(503);
      expect(await result.text()).toBe("");
      expect(await state(db)).toEqual([[], [], [], []]);
    }
    expect(await db.prepare("SELECT calls FROM rate").first("calls")).toBe(2);
  }, 15000);
