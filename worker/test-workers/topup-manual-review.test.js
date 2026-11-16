import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, it } from "vitest";
import { listTopupManualReview as list } from "../src/topup-manual-review.js";

const UTC = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const epoch = "c".repeat(32);
const hash = (value) => value.toString(16).padStart(64, "0");
const checked = (changes = {}) => ({ enabled: true, limit: 4, after: null, ...changes });

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of [
    "topup_purchases",
    "topup_claims",
    "topup_checkout_attempts",
    "topup_history_coverage",
  ])
    await env.DB.prepare("DELETE FROM " + table).run();
});

async function seed(
  n,
  {
    age = 401,
    available = 0,
    held = 0,
    loss = 0,
    hasAttempt = true,
    claim = "granted",
    withEvidence = true,
    history = false,
    holdIds = "[]",
    preTax = 300,
  } = {},
) {
  const p = hash(n);
  const owner = hash(n + 128);
  const checkout = "cs_synthetic" + n;
  const attempt = crypto.randomUUID();
  const q = (sql, ...bind) => env.DB.prepare(sql).bind(...bind);
  const statements = [
    q("INSERT INTO topup_claims VALUES(?,?,?)", p, hash(n + 256), claim),
    q(
      "INSERT INTO topup_purchases VALUES(?,?,?,?,'topup-v1',327,'usd',25,?,?,?,0,'2020-01-02T00:00:00.000Z')",
      p,
      "pi_synthetic" + n,
      checkout,
      owner,
      available,
      held,
      25 - available - held,
    ),
    q("INSERT INTO topup_reconciliations VALUES(?,7,?,0,?)", p, loss, holdIds),
  ];
  if (hasAttempt)
    statements.push(
      q(
        "INSERT INTO topup_checkout_attempts VALUES(?,?,'topup-v1',?,'usd',25,'2020-01-01T00:00:00.000Z',?,'settled')",
        attempt,
        owner,
        preTax,
        checkout,
      ),
    );
  if (withEvidence)
    statements.push(
      q(
        "INSERT INTO topup_retention(payment_hash,resolved_at,resolved_zero_since,history_proven,evidence_digest,coverage_epoch) " +
          "SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?),strftime('%Y-%m-%dT%H:%M:%fZ','now',?),?,?,?",
        p,
        "-" + age + " days",
        "-" + age + " days",
        Number(history),
        hash(n + 512),
        history ? epoch : null,
      ),
    );
  await env.DB.batch(statements);
}

it("disabled and malformed options never inspect the DB or invoke accessors", async () => {
  const db = {
    get prepare() {
      assert.fail("unexpected database access");
    },
  };
  assert.deepEqual(await list(db), { status: "disabled" });
  assert.deepEqual(await list(db, null), { status: "disabled" });
  assert.deepEqual(await list(db, Object.create({ enabled: true })), { status: "disabled" });
  assert.deepEqual(
    await list(db, {
      get enabled() {
        assert.fail("getter ran");
      },
    }),
    { status: "disabled" },
  );
  for (const fields of [
    { limit: 0 },
    { limit: 65 },
    { limit: 2.5 },
    { after: "untrusted" },
    { after: undefined },
    {
      get limit() {
        assert.fail("getter ran");
      },
    },
  ]) {
    const options = Object.defineProperties(checked(), Object.getOwnPropertyDescriptors(fields));
    assert.deepEqual(await list(db, options), { status: "unavailable" });
  }
});

it("reports only finance revision, age and evidence without creating erasure authority", async () => {
  await seed(1, { age: 400, history: true });
  await seed(2, { age: 399 });
  await seed(3, { history: true, withEvidence: false });
  await seed(4, { hasAttempt: false });
  await seed(5, { loss: 1 });
  await seed(6, { holdIds: '["du_synthetic"]' });
  await seed(7, { preTax: 299 });
  await seed(8, { available: 1 });
  await seed(9, { held: 1 });
  await seed(10, { claim: "retired" });
  await seed(11, { age: 399, history: true });
  await env.DB.prepare(
    "INSERT INTO topup_history_coverage VALUES('test',?,'fixture','2019-12-31T00:00:00.000Z'," +
      UTC +
      ",2,'qualified')",
  )
    .bind(epoch)
    .run();
  const candidates = [
    { paymentHash: hash(1), revision: 7, age: "mature", evidence: "verify_history" },
    { paymentHash: hash(2), revision: 7, age: "not_due", evidence: "history_gap" },
    ...[3, 4, 5, 6, 7].map((n) => ({
      paymentHash: hash(n),
      revision: 7,
      age: "pending",
      evidence: "payment_pending",
    })),
    { paymentHash: hash(11), revision: 7, age: "not_due", evidence: "under_observation" },
  ];
  assert.deepEqual(await list(env.DB, checked({ limit: 16 })), {
    status: "listed",
    candidates,
    next: null,
  });
  assert.equal(await env.DB.prepare("SELECT count(*) n FROM topup_purchases").first("n"), 11);
  assert.equal(
    await env.DB.prepare("SELECT count(*) n FROM topup_claims WHERE state='retired'").first("n"),
    1,
  );
  assert.equal(
    await env.DB.prepare("SELECT revision FROM topup_reconciliations WHERE payment_hash=?")
      .bind(hash(1))
      .first("revision"),
    7,
  );
});

it("bounds the indexed ledger scan upfront and advances across an empty page", async () => {
  let plan;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              plan = (
                await env.DB.prepare("EXPLAIN QUERY PLAN " + sql)
                  .bind(...params)
                  .all()
              ).results;
              assert.equal(params[1], 3);
              return env.DB.prepare(sql)
                .bind(...params)
                .all();
            },
          };
        },
      };
    },
  };
  await seed(1, { available: 1 });
  await seed(2, { available: 1 });
  await seed(3);
  await seed(4);
  await seed(5, { available: 1 });
  const a = await list(db, checked({ limit: 2 }));
  assert.deepEqual(a, { status: "listed", candidates: [], next: hash(2) });
  assert.ok(plan.some((row) => row.detail.includes("MATERIALIZE page")));
  assert.ok(
    plan.some((row) =>
      /SEARCH topup_purchases USING INDEX .+ \(payment_hash>\?\)/.test(row.detail),
    ),
  );
  const b = await list(db, checked({ limit: 2, after: a.next }));
  assert.deepEqual(
    b.candidates.map((p) => p.paymentHash),
    [hash(3), hash(4)],
  );
  assert.equal(b.next, hash(4));
  const c = await list(db, checked({ limit: 2, after: b.next }));
  assert.deepEqual(c, { status: "listed", candidates: [], next: null });
});

it("fails closed on an unavailable acknowledgement and replayed or malformed rows", async () => {
  const row = {
    payment_hash: hash(7),
    revision: 1,
    age: "mature",
    evidence: "verify_history",
    reviewable: 1,
  };
  for (const ack of [
    { success: false, meta: { changes: 0 }, results: [row] },
    { success: true, meta: { changes: 1 }, results: [row] },
    { success: true, meta: { changes: 0 }, results: [row, row] },
    { success: true, meta: { changes: 0 }, results: [{ ...row, age: "pending" }] },
    { success: true, meta: { changes: 0 }, results: [{ ...row, revision: -1 }] },
  ]) {
    const db = { prepare: () => ({ bind: () => ({ all: async () => ack }) }) };
    assert.deepEqual(await list(db, checked()), { status: "unavailable" });
  }
  const db = {
    prepare: () => ({
      bind: () => ({ all: async () => ({ success: true, meta: { changes: 0 }, results: [row] }) }),
    }),
  };
  assert.deepEqual(await list(db, checked({ after: hash(7) })), { status: "unavailable" });
});
