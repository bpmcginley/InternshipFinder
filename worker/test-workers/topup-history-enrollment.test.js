import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, it } from "vitest";
import { captureTopupSettlement, settleFirstTopup } from "../src/topup-first-settlement.js";
import { captureTopupEnrollment, topupRetentionStatement } from "../src/topup-retention.js";
const epoch = "a".repeat(32);
const created = "2026-01-02T00:00:00.000Z";
const enabled = { enabled: true, schemaKey: "fixture-v1" };
const select = async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of [
    "topup_purchases",
    "topup_claims",
    "topup_checkout_attempts",
    "topup_history_coverage",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare(
    "INSERT INTO topup_history_coverage VALUES('test',?,'fixture-v1','2026-01-01T00:00:00.000Z','2026-01-03T00:00:00.000Z',7,'qualified')",
  )
    .bind(epoch)
    .run();
});
async function fixture(db = env.DB) {
  const id = crypto.randomUUID(),
    suffix = id.replaceAll("-", ""),
    user = suffix.repeat(2);
  await db
    .prepare(
      "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state) VALUES (?,?,'fixture-v1',300,'usd',25,?,'creating')",
    )
    .bind(id, user, created)
    .run();
  const a = await captureTopupSettlement(db, id);
  const p = {
    status: "paid_evidence",
    attemptId: id,
    userHash: user,
    offerVersion: "fixture-v1",
    offerAmount: 300,
    currency: "usd",
    units: 25,
    livemode: false,
    checkoutId: `cs_${suffix}`,
    paymentId: `pi_${suffix}`,
    chargeId: `ch_${suffix}`,
    capturedAmount: 327,
  };
  const r = {
    status: "reversal_evidence",
    paymentId: p.paymentId,
    checkoutId: p.checkoutId,
    chargeId: p.chargeId,
    livemode: false,
    currency: "usd",
    capturedAmount: 327,
    refunds: [],
    disputes: [],
    refundsComplete: true,
    disputesComplete: true,
  };
  return { a, p, r };
}
const capture = (f, db = env.DB) => captureTopupEnrollment(db, f.a, false, enabled);
const settle = (f, token, db = env.DB) =>
  settleFirstTopup(db, f.a, f.p, f.r, new Date("1999-01-01T00:00:00Z"), undefined, token);
async function afterCapture() {
  // Ensure a strictly later SQLite millisecond without manufacturing an application timestamp.
  const start = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t").first("t");
  for (let i = 0; i < 100; i++) {
    if (
      (await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t").first("t")) > start
    )
      return;
  }
  throw new Error("SQLite clock did not advance");
}
it("records only exact captured candidacy, independent of caller purchase clock; cascade removes it", async () => {
  const f = await fixture(),
    token = await capture(f);
  assert.equal(token.status, "captured");
  await afterCapture();
  assert.equal((await settle(f, token)).status, "settled");
  assert.equal((await select("topup_retention"))[0].coverage_epoch, epoch);
  assert.equal((await select("topup_purchases"))[0].available, 25);
  assert.equal((await settle(f, token)).status, "stale");
  await env.DB.prepare("DELETE FROM topup_purchases").run();
  assert.deepEqual(await select("topup_retention"), []);
});
for (const mutation of [
  "revision=revision+1",
  "epoch='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
  "schema_key='other'",
  "starts_at='2026-01-01T00:00:00.001Z'",
  "covered_through='2026-01-03T00:00:00.001Z'",
  "health='closed'",
  "mode='live'",
]) {
  it(`stale ${mutation} leaves grant intact and candidacy null`, async () => {
    const f = await fixture(),
      token = await capture(f);
    await env.DB.prepare(`UPDATE topup_history_coverage SET ${mutation}`).run();
    assert.equal((await settle(f, token)).status, "settled");
    assert.equal((await select("topup_retention"))[0].coverage_epoch, null);
    assert.equal((await select("topup_purchases"))[0].available, 25);
  });
}
it("historical, unproven, wrong-schema/mode and disabled captures cannot enroll", async () => {
  const f = await fixture();
  assert.equal(
    (
      await captureTopupEnrollment(
        {
          get batch() {
            throw new Error();
          },
        },
        null,
        null,
      )
    ).status,
    "disabled",
  );
  assert.equal((await captureTopupEnrollment(env.DB, f.a, true, enabled)).status, "unproven");
  assert.equal(
    (await captureTopupEnrollment(env.DB, f.a, false, { ...enabled, schemaKey: "other" })).status,
    "unproven",
  );
  await env.DB.prepare(
    "UPDATE topup_history_coverage SET starts_at='2026-01-02T00:00:00.001Z'",
  ).run();
  assert.equal((await capture(f)).status, "unproven");
  await env.DB.prepare(
    "UPDATE topup_history_coverage SET covered_through=NULL,health='unproven'",
  ).run();
  assert.equal((await capture(f)).status, "unproven");
  assert.equal((await settle(f)).status, "settled");
  assert.equal((await select("topup_retention"))[0].coverage_epoch, null);
});
it("copied authority, other attempt, stale attempt revision and another binding do not enroll", async () => {
  for (const kind of ["copy", "attempt", "revision", "binding"]) {
    const f = await fixture(),
      token = await capture(f);
    let target = f,
      bound = env.DB,
      supplied = token;
    if (kind === "copy") supplied = { ...token };
    if (kind === "attempt") target = await fixture();
    if (kind === "revision") target = { ...f, a: await captureTopupSettlement(env.DB, f.a.id) };
    if (kind === "binding")
      bound = { prepare: env.DB.prepare.bind(env.DB), batch: env.DB.batch.bind(env.DB) };
    assert.equal((await settle(target, supplied, bound)).status, "settled");
  }
  assert.ok((await select("topup_retention")).every((r) => r.coverage_epoch === null));
});
it("malformed capture acknowledgements do not create authority", async () => {
  const f = await fixture();
  for (const mutate of [
    (rows) => {
      delete rows[0];
    },
    (rows) => {
      rows[0].success = false;
    },
    (rows) => {
      rows[0].results.push(rows[0].results[0]);
    },
    (rows) => {
      delete rows[0].results[0].epoch;
    },
  ]) {
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (s) => {
        const rows = await env.DB.batch(s);
        mutate(rows);
        return rows;
      },
    };
    assert.equal((await capture(f, db)).status, "unavailable");
  }
});
it("retention refresh cannot backfill historical rows or rewrite captured epoch", async () => {
  for (const use of [false, true]) {
    const f = await fixture(),
      token = use ? await capture(f) : undefined;
    await afterCapture();
    const result = await settle(f, token);
    await env.DB.batch([
      env.DB.prepare("UPDATE topup_purchases SET available=available WHERE payment_hash=?").bind(
        result.paymentHash,
      ),
      topupRetentionStatement(env.DB, result.paymentHash, true),
    ]);
    assert.equal(
      (
        await env.DB.prepare("SELECT coverage_epoch FROM topup_retention WHERE payment_hash=?")
          .bind(result.paymentHash)
          .first()
      ).coverage_epoch,
      use ? epoch : null,
    );
    assert.equal((await capture(f)).status, "unproven");
  }
});

it("an original pre-0034 database retains ordinary financial settlement", async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(
    db,
    env.TEST_MIGRATIONS.filter((m) => !m.name.startsWith("0034")),
  );
  const f = await fixture(db);
  assert.equal((await settle(f, undefined, db)).status, "settled");
  const row = await db.prepare("SELECT * FROM topup_retention").first();
  assert.equal(Object.hasOwn(row, "coverage_epoch"), false);
});
it("coverage changing at actual batch arrival yields NULL without losing the grant", async () => {
  const f = await fixture();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      if (statements.length === 6)
        await env.DB.prepare("UPDATE topup_history_coverage SET revision=revision+1").run();
      return env.DB.batch(statements);
    },
  };
  const token = await capture(f, db);
  await afterCapture();
  assert.equal((await settle(f, token, db)).status, "settled");
  assert.equal((await select("topup_retention"))[0].coverage_epoch, null);
  assert.equal((await select("topup_purchases"))[0].available, 25);
});
it("exact database capture/settlement equality cannot establish precedence", async () => {
  const f = await fixture();
  const utc = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  let equalityChecks = 0;
  const db = {
    prepare(sql) {
      if (!sql.includes(`AND ?<${utc}`)) return env.DB.prepare(sql);
      equalityChecks++;
      // Native same-step clock equality: substitute only the captured-time bound.
      // All other exact guards and the real financial transaction execute unchanged.
      const statement = env.DB.prepare(sql.replace(`AND ?<${utc}`, `AND ${utc}<${utc}`));
      return {
        bind(...args) {
          args.splice(args.length - 2, 1);
          return statement.bind(...args);
        },
      };
    },
    batch: env.DB.batch.bind(env.DB),
  };
  const token = await capture(f, db);
  assert.equal((await settle(f, token, db)).status, "settled");
  assert.equal(equalityChecks, 1);
  assert.equal((await select("topup_retention"))[0].coverage_epoch, null);
});
it("transaction rollback preserves no partial claim or epoch; committed lost acknowledgement is not retried", async () => {
  const f = await fixture();
  let fail = true;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      if (statements.length !== 6) return env.DB.batch(statements);
      if (fail)
        return env.DB.batch([
          ...statements,
          env.DB.prepare("SELECT * FROM nonexistent_enrollment_fixture"),
        ]);
      await env.DB.batch(statements);
      throw new Error("synthetic committed acknowledgement lost");
    },
  };
  const token = await capture(f, db);
  await afterCapture();
  await assert.rejects(settle(f, token, db));
  assert.deepEqual(await select("topup_claims"), []);
  assert.deepEqual(await select("topup_retention"), []);
  fail = false;
  await assert.rejects(settle(f, token, db));
  assert.equal((await select("topup_retention"))[0].coverage_epoch, epoch);
  assert.equal((await settle(f, token)).status, "stale");
  assert.equal((await select("topup_purchases"))[0].available, 25);
});

it("rejects accessor receipt fields without executing them", async () => {
  const f = await fixture();
  for (const path of ["batch", "success", "results", "meta", "changes", "row", "epoch"]) {
    let reads = 0;
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements) => {
        const rows = await env.DB.batch(statements);
        const [target, key] = {
          batch: [rows, "0"],
          success: [rows[0], "success"],
          results: [rows[0], "results"],
          meta: [rows[0], "meta"],
          changes: [rows[0].meta, "changes"],
          row: [rows[0].results, "0"],
          epoch: [rows[0].results[0], "epoch"],
        }[path];
        const original = target[key];
        Object.defineProperty(target, key, {
          get() {
            reads++;
            return original;
          },
        });
        return rows;
      },
    };
    assert.equal((await capture(f, db)).status, "unavailable", path);
    assert.equal(reads, 0, path);
  }
});
it("missing actual capture revision cannot be replaced by a results getter before settlement", async () => {
  const f = await fixture();
  let captureReads = 0,
    getters = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      const rows = await env.DB.batch(statements);
      if (statements.length === 1) {
        captureReads++;
        assert.deepEqual(rows[0].results, []);
        const row = await env.DB.prepare(
          "SELECT mode,epoch,schema_key,starts_at,covered_through,revision,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at FROM topup_history_coverage",
        ).first();
        Object.defineProperty(rows[0], "results", {
          get() {
            getters++;
            return [row];
          },
        });
      }
      return rows;
    },
  };
  await env.DB.prepare("DELETE FROM topup_attempt_revisions WHERE attempt_id=?").bind(f.a.id).run();
  const token = await capture(f, db);
  assert.equal(token.status, "unavailable");
  assert.equal(captureReads, 1);
  assert.equal(getters, 0);
  const actual = await captureTopupSettlement(env.DB, f.a.id);
  assert.equal(actual.revision, f.a.revision);
  await afterCapture();
  assert.equal((await settle(f, token, db)).status, "settled");
  assert.equal((await select("topup_retention"))[0].coverage_epoch, null);
  assert.equal((await select("topup_purchases"))[0].available, 25);
});
