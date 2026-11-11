import assert from "node:assert/strict";
// Separate module state keeps synthetic past/future admission clocks out of the legacy limiter tests.
import {
  admitEmployerPosting,
  createEmployerPostingCounter,
  createRequestSafeEmployerPostingCatalog,
  createRetentionCheckedEmployerPostingCounter,
  EMPLOYER_POSTING_EVENT,
} from "../src/employer-posting-counts.js?retention-tests";
const DAY = 86400000;
let address = 0;
const day = (at) => at.toISOString().slice(0, 10);
const event = (c) => ({ e: EMPLOYER_POSTING_EVENT, c });
async function fixture(db, at = new Date(), keys = ["acme"]) {
  await db.batch([
    db.prepare("DELETE FROM employer_posting_counts"),
    db.prepare("DELETE FROM employer_posting_day_caps"),
  ]);
  const now = () => new Date(at),
    cache = createRequestSafeEmployerPostingCatalog({ maxBytes: 200000, now: () => +at });
  const load = () => Promise.resolve(new Response(JSON.stringify(keys)));
  await cache.match(keys[0], load);
  const scheduler = createEmployerPostingCounter({ db, keys, now });
  const receipt = (c) =>
    admitEmployerPosting(event(c), `2001:db8::${(++address).toString(16)}`, now());
  return {
    at,
    scheduler,
    receipt,
    cache,
    load,
    counter: (database = db) =>
      createRetentionCheckedEmployerPostingCounter({ db: database, cache, load, now }),
    count: async (c = keys[0], database = db) =>
      createRetentionCheckedEmployerPostingCounter({
        db: database,
        cache,
        load,
        now,
      }).countAdmitted(await receipt(c)),
    total: async () =>
      (
        await db
          .prepare("SELECT n FROM employer_posting_day_caps WHERE day=?")
          .bind(day(at))
          .first()
      )?.n,
  };
}
export async function aStaleDatabaseDay(db) {
  const f = await fixture(db, new Date(Date.now() - DAY));
  assert.equal(await f.scheduler.cleanup(), true);
  assert.equal(await f.count(), false, "real database day rejects the stale Worker admission");
  assert.equal(await f.total(), 0);
}
export async function separateInstances(db) {
  const f = await fixture(db);
  assert.equal(await f.count(), false);
  assert.equal(await f.total(), undefined, "click never bootstraps cap");
  assert.equal(await f.scheduler.cleanup(), true);
  assert.equal(await f.count(), true, "separate request sees scheduler database state");
  const receipt = await f.receipt("acme"),
    counter = f.counter();
  assert.equal(await counter.countAdmitted(receipt), true);
  assert.equal(await counter.countAdmitted(receipt), false);
  assert.equal(await counter.countAdmitted({}), false);
  await db.prepare("DELETE FROM employer_posting_counts").run();
  assert.equal(await f.count(), true, "owner deletion does not reset current cap");
  assert.equal(await f.total(), 3);
}
export async function retentionBoundaries(db) {
  const f = await fixture(db),
    today = day(f.at),
    cutoff = day(new Date(+f.at - 90 * DAY));
  await f.scheduler.cleanup();
  await db
    .prepare("INSERT INTO employer_posting_counts VALUES(?, 'retained',1)")
    .bind(cutoff)
    .run();
  assert.equal(await f.count(), true);
  await db
    .prepare("INSERT INTO employer_posting_counts VALUES(?, 'expired',1)")
    .bind(day(new Date(+f.at - 91 * DAY)))
    .run();
  assert.equal(await f.count(), false);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM employer_posting_counts WHERE day<?")
        .bind(cutoff)
        .first()
    ).n,
    1,
    "click never deletes expired rows",
  );
  await f.scheduler.cleanup();
  for (const delta of [-1, 1]) {
    const capDay = day(new Date(+f.at + delta * DAY));
    await db.prepare("INSERT INTO employer_posting_day_caps VALUES(?,0)").bind(capDay).run();
    assert.equal(await f.count(), false);
    await db.prepare("DELETE FROM employer_posting_day_caps WHERE day=?").bind(capDay).run();
  }
  const futureDay = day(new Date(+f.at + DAY));
  const total = await f.total();
  await db
    .prepare("INSERT INTO employer_posting_counts VALUES(?, 'future',1)")
    .bind(futureDay)
    .run();
  assert.equal(await f.count(), false, "a future count without a cap blocks intake");
  assert.equal(await f.total(), total);
  const currentCount = await db
    .prepare("SELECT n FROM employer_posting_counts WHERE day=? AND company='acme'")
    .bind(today)
    .first();
  assert.equal(currentCount.n, total);
  await db.prepare("DELETE FROM employer_posting_counts WHERE day=?").bind(futureDay).run();
  assert.equal(await f.count(), true);
  await db.prepare("DELETE FROM employer_posting_day_caps WHERE day=?").bind(today).run();
  assert.equal(await f.count(), false);
  assert.equal(await f.scheduler.cleanup(), false, "history without a cap stays ambiguous");
}
export async function failuresAndRollback(db) {
  const f = await fixture(db);
  await f.scheduler.cleanup();
  await db
    .prepare("INSERT INTO employer_posting_counts VALUES(?, 'expired',1)")
    .bind(day(new Date(+f.at - 91 * DAY)))
    .run();
  await db
    .prepare(
      "CREATE TRIGGER retention_cleanup_fail BEFORE DELETE ON employer_posting_counts BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  assert.equal(await f.scheduler.cleanup(), false);
  assert.equal(await f.count(), false);
  await db.prepare("DROP TRIGGER retention_cleanup_fail").run();
  await f.scheduler.cleanup();
  await db
    .prepare(
      "CREATE TRIGGER retention_cap_fail BEFORE UPDATE ON employer_posting_day_caps BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  assert.equal(await f.count(), false);
  assert.equal(await f.total(), 0);
  assert.equal((await db.prepare("SELECT count(*) n FROM employer_posting_counts").first()).n, 0);
  await db.prepare("DROP TRIGGER retention_cap_fail").run();
  const failed = {
    prepare: (sql) => db.prepare(sql),
    batch: async () => [{ success: false, meta: { changes: 0 } }],
  };
  assert.equal(await f.count("acme", failed), false);
  assert.equal(await f.count("acme", { ...failed, batch: async () => [] }), false);
  const failedScheduler = createEmployerPostingCounter({
    db: failed,
    keys: ["acme"],
    now: () => f.at,
  });
  assert.equal(await failedScheduler.cleanup(), false);
  assert.equal(
    await f.count(),
    true,
    "current invariant can recover without a historical failure latch",
  );
  const brokenCache = createRetentionCheckedEmployerPostingCounter({
    db,
    cache: { match: async () => null },
    load: f.load,
    now: () => f.at,
  });
  assert.equal(await brokenCache.countAdmitted(await f.receipt("acme")), false);
}
export async function atomicCaps(db) {
  const f = await fixture(db);
  await f.scheduler.cleanup();
  await db.prepare("UPDATE employer_posting_day_caps SET n=49995").run();
  const results = await Promise.all(Array.from({ length: 20 }, () => f.count()));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(await f.total(), 50000);
  await db.prepare("UPDATE employer_posting_day_caps SET n=5").run();
  await db.prepare("UPDATE employer_posting_counts SET n=999").run();
  assert.equal(
    (await Promise.all(Array.from({ length: 20 }, () => f.count()))).filter(Boolean).length,
    1,
  );
  assert.equal(await f.total(), 6);
}
export async function zFutureDatabaseDay(db) {
  const f = await fixture(db, new Date(Date.now() + DAY));
  assert.equal(await f.scheduler.cleanup(), true);
  assert.equal(await f.count(), false, "real database day rejects a future Worker admission");
  assert.equal(await f.total(), 0);
}
export async function measureRetentionReads(db) {
  const measurements = [];
  for (const size of [8, 10000]) {
    const keys = Array.from({ length: size }, (_, i) => "k" + String(i).padStart(5, "0"));
    const f = await fixture(db, new Date(), keys);
    await f.scheduler.cleanup();
    await db
      .prepare(
        "WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n+1<?) INSERT INTO employer_posting_counts SELECT ?,printf('k%05d',n),1 FROM seq",
      )
      .bind(size, day(f.at))
      .run();
    await db.prepare("UPDATE employer_posting_day_caps SET n=?").bind(size).run();
    let meta;
    const measured = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        const r = await db.batch(statements);
        meta = {
          reads: r.reduce((n, x) => n + x.meta.rows_read, 0),
          writes: r.reduce((n, x) => n + x.meta.rows_written, 0),
        };
        return r;
      },
    };
    const samples = [];
    for (let i = 0; i < 5; i++) {
      assert.equal(await f.count(keys[0], measured), true);
      samples.push(meta);
    }
    measurements.push({ keys: size, samples });
  }
  assert.deepEqual(
    measurements[0].samples,
    measurements[1].samples,
    "indexed cost does not grow with the catalog fixture",
  );
  assert.deepEqual(
    measurements[1].samples,
    Array.from({ length: 5 }, () => ({ reads: 8, writes: 2 })),
    "accepted indexed D1 work",
  );
  return measurements;
}
