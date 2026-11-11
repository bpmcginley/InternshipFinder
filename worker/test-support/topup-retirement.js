import assert from "node:assert/strict";
import {
  captureTopupSettlement as capture,
  settleFirstTopup as settle,
} from "../src/topup-first-settlement.js";
import { readTopupRevision, reconcileExistingTopup } from "../src/topup-reconciliation.js";
import { retireResolvedTopup } from "../src/topup-retirement.js";
import { financialEvidenceDigest } from "../src/topup-retention.js";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
import { reserveFirstFundedRun } from "../src/funded-run-admission.js";
import { releaseFundedCall } from "../src/funded-run-callbacks.js";
import { restorePurchasedRun } from "../src/topup-allocation.js";
import { deleteUser } from "../src/limits.js";
async function fixture(db) {
  const id = crypto.randomUUID(),
    suffix = id.replaceAll("-", ""),
    user = suffix.repeat(2);
  await db
    .prepare(
      "INSERT INTO topup_checkout_attempts(id,user_hash,offer_version,amount,currency,units,created,state) " +
        "VALUES (?,?,'fixture-v1',300,'usd',25,'2026-11-10T00:00:00.000Z','creating')",
    )
    .bind(id, user)
    .run();
  const a = await capture(db, id);
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
    livemode: p.livemode,
    currency: "usd",
    capturedAmount: 327,
    refunds: [],
    disputes: [],
    refundsComplete: true,
    disputesComplete: true,
  };
  return { a, p, r };
}
const apply = (db, f) => settle(db, f.a, f.p, f.r, new Date("2026-11-11T00:00:00Z"));
const item = (status) => ({ id: "synthetic-dispute", status, amount: 327, currency: "usd" });
const row = (db, table, key) =>
  db.prepare(`SELECT * FROM ${table} WHERE payment_hash=?`).bind(key).first();
async function refresh(db, f, patch = {}) {
  const p = await readTopupRevision(db, f.key);
  return reconcileExistingTopup(db, f.key, p.revision, { ...f.r, ...patch });
}
async function age(db, key, days = 401) {
  await db
    .prepare(
      "UPDATE topup_retention SET resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?)," +
        "resolved_zero_since=strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE payment_hash=?",
    )
    .bind(`-${days} days`, `-${days} days`, key)
    .run();
}
async function ready(db, patch = {}) {
  const f = await fixture(db);
  Object.assign(f.r, patch);
  f.key = (await apply(db, f)).paymentHash;
  if (!patch.refunds?.some((r) => r.status === "succeeded"))
    await db
      .prepare("UPDATE topup_purchases SET available=0,held=0,consumed=25 WHERE payment_hash=?")
      .bind(f.key)
      .run();
  await age(db, f.key);
  return f;
}
const retire = (db, f, reader = async () => f.r) => retireResolvedTopup(db, f.key, reader);

export async function retirementHistory(db) {
  const f = await ready(db);
  assert.equal((await row(db, "topup_retention", f.key)).history_proven, 1);
  await refresh(db, f);
  await refresh(db, f);
  assert.equal((await row(db, "topup_retention", f.key)).history_proven, 1);
  await refresh(db, f, { disputes: [item("under_review")] });
  await refresh(db, f, { disputes: [item("won")] });
  assert.equal((await row(db, "topup_retention", f.key)).history_proven, 1);
  await age(db, f.key);
  assert.equal(
    (await retire(db, f, async () => ({ ...f.r, disputes: [item("won")] }))).status,
    "retired",
  );
  const unknown = await ready(db);
  await db
    .prepare("UPDATE topup_retention SET history_proven=0 WHERE payment_hash=?")
    .bind(unknown.key)
    .run();
  await refresh(db, unknown);
  assert.equal((await retire(db, unknown)).status, "pending");
  const dropped = await ready(db);
  await refresh(db, dropped, { disputes: [item("under_review")] });
  await refresh(db, dropped, { refunds: [item("succeeded")], disputes: [item("under_review")] });
  assert.equal((await row(db, "topup_retention", dropped.key)).history_proven, 0);
  await refresh(db, dropped, { refunds: [item("succeeded")], disputes: [item("won")] });
  assert.equal((await row(db, "topup_retention", dropped.key)).history_proven, 0);
  assert.equal((await retire(db, dropped)).status, "pending");
  const missing = await ready(db);
  await refresh(db, missing, { disputes: [item("under_review")] });
  await refresh(db, missing, { refunds: [item("succeeded")], disputes: [] });
  assert.equal((await row(db, "topup_retention", missing.key)).history_proven, 0);
}

export async function retirementEraseAndReplay(db) {
  const f = await ready(db),
    other = await ready(db);
  await db
    .prepare(
      "INSERT INTO topup_allocations VALUES(?,'2020-01','autofill','expired-run',?,'allocated')",
    )
    .bind(f.p.userHash, f.key)
    .run();
  await db
    .prepare(
      "INSERT INTO topup_generation_allocations VALUES(?,?,'2020-01','autofill','old-generation',?,'allocated')",
    )
    .bind(crypto.randomUUID(), f.p.userHash, f.key)
    .run();
  const proof = await Promise.all([retire(db, f), retire(db, f)]);
  assert.equal(proof.filter((p) => p.status === "retired").length, 1);
  assert.deepEqual(Object.keys(await row(db, "topup_claims", f.key)).sort(), [
    "checkout_hash",
    "payment_hash",
    "state",
  ]);
  assert.equal((await row(db, "topup_claims", f.key)).state, "retired");
  for (const table of [
    "topup_purchases",
    "topup_reconciliations",
    "topup_retention",
    "topup_allocations",
    "topup_generation_allocations",
  ])
    assert.equal(await row(db, table, f.key), null);
  assert.equal(
    await db.prepare("SELECT id FROM topup_checkout_attempts WHERE id=?").bind(f.a.id).first(),
    null,
  );
  assert.ok(await row(db, "topup_purchases", other.key));
  assert.equal((await retire(db, f)).status, "unavailable");
  await assert.rejects(
    () =>
      recordVerifiedTopup(db, {
        paymentId: f.p.paymentId,
        checkoutId: f.p.checkoutId,
        userHash: f.p.userHash,
        offerVersion: f.p.offerVersion,
        livemode: false,
        amount: 327,
        currency: "usd",
        units: 25,
      }),
    /unavailable/,
  );
}

export async function retirementEvidenceAndUtc(db) {
  for (const patch of [
    { status: "pending" },
    { livemode: true },
    { paymentId: "pi_other" },
    { checkoutId: "cs_other" },
    { refundsComplete: false },
    { disputesComplete: false },
    { refunds: [item("pending")] },
    { disputes: [item("warning_under_review")] },
    { disputes: [item("appeal_under_review")] },
    { disputes: [item("lost")] },
    { refunds: [item("succeeded")] },
  ]) {
    const f = await ready(db);
    assert.equal((await retire(db, f, async () => ({ ...f.r, ...patch }))).status, "pending");
  }
  const f = await ready(db);
  assert.equal(
    (
      await retire(db, f, async () => {
        throw new Error("synthetic read failure");
      })
    ).status,
    "pending",
  );
  await age(db, f.key, 399);
  assert.equal((await retire(db, f)).status, "stale");
  await age(db, f.key, 400);
  assert.equal((await retire(db, f)).status, "retired");
  const refunded = await ready(db, { refunds: [item("succeeded")] });
  assert.equal((await retire(db, refunded)).status, "retired");
  const vanished = await ready(db, { refunds: [item("succeeded")] });
  assert.equal(
    (await retire(db, vanished, async () => ({ ...vanished.r, refunds: [] }))).status,
    "pending",
  );
  assert.equal((await row(db, "topup_retention", vanished.key)).history_proven, 0);
  const loss = await ready(db, { refunds: [item("succeeded")], disputes: [item("lost")] });
  assert.equal((await retire(db, loss)).status, "pending");
}

export async function retirementRacesAndRollback(db) {
  for (const kind of ["refresh", "delete", "reset", "restore"]) {
    const f = await ready(db);
    const result = await retire(db, f, async () => {
      if (kind === "refresh") await refresh(db, f);
      if (kind === "delete") await deleteUser(db, f.p.userHash);
      if (kind === "reset")
        await db
          .prepare(
            "UPDATE topup_retention SET resolved_at=NULL,resolved_zero_since=NULL WHERE payment_hash=?",
          )
          .bind(f.key)
          .run();
      if (kind === "restore") {
        await db
          .prepare(
            "INSERT INTO topup_allocations VALUES(?,'2020-01','autofill','late-release',?,'allocated')",
          )
          .bind(f.p.userHash, f.key)
          .run();
        assert.equal(
          (
            await restorePurchasedRun(db, {
              userHash: f.p.userHash,
              month: "2020-01",
              task: "autofill",
              runId: "late-release",
            })
          ).changed,
          true,
        );
      }
      return f.r;
    });
    assert.equal(result.status, "stale");
    assert.equal(
      (await row(db, "topup_claims", f.key)).state,
      kind === "delete" ? "deleted" : "granted",
    );
  }
  const f = await ready(db);
  await db
    .prepare(
      "CREATE TRIGGER retirement_failure BEFORE DELETE ON topup_checkout_attempts BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    )
    .run();
  await assert.rejects(() => retire(db, f), /synthetic rollback/);
  await db.prepare("DROP TRIGGER retirement_failure").run();
  assert.equal((await row(db, "topup_claims", f.key)).state, "granted");
  assert.ok(await row(db, "topup_retention", f.key));
  assert.equal((await retire(db, f)).status, "retired");
}

export async function retirementActiveCallbacks(db) {
  const f = await ready(db);
  await db
    .prepare("UPDATE topup_purchases SET available=1,consumed=24 WHERE payment_hash=?")
    .bind(f.key)
    .run();
  const month = new Date().toISOString().slice(0, 7);
  await db.prepare("INSERT INTO usage VALUES(?,?,'autofill',1)").bind(f.p.userHash, month).run();
  const input = {
    userHash: f.p.userHash,
    task: "autofill",
    runId: "retirement-run",
    allowance: 1,
    maxCalls: 3,
    estimate: 6,
    accountCeiling: 100,
    monthBudget: 100,
    dayBudget: 100,
    freeTier: true,
    allowPurchased: true,
  };
  const run = await reserveFirstFundedRun(db, input);
  assert.equal(run.status, "reserved");
  await age(db, f.key);
  assert.equal((await retire(db, f)).status, "stale");
  assert.equal((await releaseFundedCall(db, { ...input, ...run })).status, "released");
  assert.equal((await row(db, "topup_purchases", f.key)).available, 1);
  assert.equal((await row(db, "topup_retention", f.key)).resolved_zero_since, null);
  assert.equal((await retire(db, f)).status, "pending");
}
export async function retirementObservationsResetAge(db) {
  const f = await ready(db);
  const old = await row(db, "topup_retention", f.key);
  await retire(db, f, async () => {
    throw new Error("synthetic transport");
  });
  assert.deepEqual(await row(db, "topup_retention", f.key), old);
  assert.equal(
    (await retire(db, f, async () => ({ ...f.r, refunds: [item("pending")] }))).status,
    "pending",
  );
  assert.equal((await row(db, "topup_retention", f.key)).resolved_zero_since, null);
  await refresh(db, f); // Normal authoritative recovery must establish resolution again.
  assert.ok(
    (await row(db, "topup_retention", f.key)).resolved_zero_since > old.resolved_zero_since,
  );
  assert.equal((await retire(db, f)).status, "stale");
  await age(db, f.key);
  const newer = await row(db, "topup_retention", f.key);
  await retire(db, f, async () => {
    await refresh(db, f);
    return { ...f.r, refunds: [item("pending")] };
  });
  assert.deepEqual(await row(db, "topup_retention", f.key), newer); // stale pending read cannot reset
  const terminal = await ready(db);
  await retire(db, terminal, async () => ({ ...terminal.r, refunds: [item("succeeded")] }));
  assert.equal((await row(db, "topup_reconciliations", terminal.key)).full_refund, 1);
  assert.equal(
    (await retire(db, terminal, async () => ({ ...terminal.r, refunds: [item("succeeded")] })))
      .status,
    "stale",
  );
  const loss = await ready(db);
  await retire(db, loss, async () => ({ ...loss.r, disputes: [item("lost")] }));
  assert.equal((await row(db, "topup_reconciliations", loss.key)).loss, 1);
  assert.equal((await row(db, "topup_retention", loss.key)).history_proven, 0);
}

export async function retirementLegacyRunFence(db) {
  const f = await ready(db);
  await db
    .prepare(
      "INSERT INTO runs(user_hash,month,task,run_id) VALUES(?,'2020-01','autofill','legacy-run')",
    )
    .bind(f.p.userHash)
    .run();
  await db
    .prepare(
      "INSERT INTO topup_allocations VALUES(?,'2020-01','autofill','legacy-run',?,'allocated')",
    )
    .bind(f.p.userHash, f.key)
    .run();
  assert.equal((await retire(db, f)).status, "stale");
  assert.ok(await row(db, "topup_allocations", f.key));
  await db.prepare("DELETE FROM runs WHERE user_hash=?").bind(f.p.userHash).run();
  assert.equal((await retire(db, f)).status, "retired");
  assert.equal(
    (
      await restorePurchasedRun(db, {
        userHash: f.p.userHash,
        month: "2020-01",
        task: "autofill",
        runId: "legacy-run",
      })
    ).changed,
    false,
  );
}

export async function retirementCanonicalEvidence(db) {
  const refunds = [
    { ...item("failed"), id: "re_b", amount: 100 },
    { ...item("canceled"), id: "re_a", amount: 100 },
  ];
  const f = await ready(db, { refunds });
  const before = await row(db, "topup_retention", f.key);
  const permuted = {
    ...f.r,
    refunds: [...refunds]
      .reverse()
      .map((r) => ({ currency: r.currency, amount: r.amount, status: r.status, id: r.id })),
  };
  assert.equal(await financialEvidenceDigest(f.r), await financialEvidenceDigest(permuted));
  await refresh(db, f, permuted);
  assert.equal(
    (await row(db, "topup_retention", f.key)).resolved_zero_since,
    before.resolved_zero_since,
  );
  const changed = { ...f.r, refunds: [{ ...refunds[0], status: "succeeded" }, refunds[1]] };
  assert.equal((await retire(db, f, async () => changed)).status, "pending");
  const after = await row(db, "topup_retention", f.key);
  assert.ok(after.resolved_zero_since > before.resolved_zero_since);
  assert.notEqual(after.evidence_digest, before.evidence_digest);
  assert.equal((await row(db, "topup_reconciliations", f.key)).full_refund, 0); // identical credit flags
  assert.equal((await retire(db, f, async () => changed)).status, "stale");
  const dated = { ...changed, refunds: changed.refunds.map((r) => ({ ...r, created: 1 })) };
  assert.notEqual(await financialEvidenceDigest(dated), await financialEvidenceDigest(changed));
  assert.equal(await financialEvidenceDigest({ ...dated, created: NaN }), null);
  const contested = await ready(db);
  assert.equal(
    (
      await retire(db, contested, async () => {
        await refresh(db, contested, { refunds: [{ ...item("succeeded"), amount: 100 }] });
        return contested.r;
      })
    ).status,
    "stale",
  );
  assert.equal((await row(db, "topup_claims", contested.key)).state, "granted");
}

export async function retirementExactAssociation(db) {
  for (const [column, value] of [
    ["user_hash", "f".repeat(64)],
    ["amount", 327],
    ["amount", 299],
    ["offer_version", "wrong"],
    ["units", 26],
    ["currency", "eur"],
    ["state", "expired"],
  ]) {
    const f = await ready(db);
    let read = false;
    await db
      .prepare(`UPDATE topup_checkout_attempts SET ${column}=? WHERE id=?`)
      .bind(value, f.a.id)
      .run();
    assert.equal(
      (
        await retire(db, f, async () => {
          read = true;
          return f.r;
        })
      ).status,
      "unavailable",
    );
    assert.equal(read, false);
    assert.equal((await row(db, "topup_claims", f.key)).state, "granted");
    assert.ok(
      await db.prepare("SELECT id FROM topup_checkout_attempts WHERE id=?").bind(f.a.id).first(),
    );
  }
  const absent = await ready(db);
  await db.prepare("DELETE FROM topup_checkout_attempts WHERE id=?").bind(absent.a.id).run();
  assert.equal((await retire(db, absent)).status, "unavailable");
  const taxed = await ready(db);
  assert.equal((await row(db, "topup_purchases", taxed.key)).amount, 327);
  assert.equal(
    await db
      .prepare("SELECT amount FROM topup_checkout_attempts WHERE id=?")
      .bind(taxed.a.id)
      .first("amount"),
    300,
  );
  assert.equal((await retire(db, taxed)).status, "retired");
}

export async function retirementImmutableTupleRaces(db) {
  const changes = [
    ["topup_purchases", "amount=?", [300]],
    ["topup_purchases", "payment_id=?", ["pi_changed"]],
    ["topup_purchases", "checkout_id=?", ["cs_changed"]],
    ["topup_purchases", "user_hash=?", ["d".repeat(64)]],
    ["topup_purchases", "offer_version=?", ["changed"]],
    ["topup_purchases", "currency=?", ["eur"]],
    ["topup_purchases", "granted=?,consumed=?", [26, 26]],
    ["topup_purchases", "created=?", ["2020-01-02T00:00:00.000Z"]],
    ["topup_checkout_attempts", "id=?", [crypto.randomUUID()]],
    ["topup_checkout_attempts", "user_hash=?", ["e".repeat(64)]],
    ["topup_checkout_attempts", "checkout_id=?", ["cs_changed_attempt"]],
    ["topup_checkout_attempts", "offer_version=?", ["changed"]],
    ["topup_checkout_attempts", "amount=?", [327]],
    ["topup_checkout_attempts", "units=?", [26]],
    ["topup_checkout_attempts", "currency=?", ["eur"]],
    ["topup_checkout_attempts", "state=?", ["expired"]],
    ["topup_checkout_attempts", "created=?", ["2020-01-02T00:00:00.000Z"]],
  ];
  for (const [table, set, values] of changes) {
    const f = await ready(db);
    assert.equal(
      (
        await retire(db, f, async () => {
          await db
            .prepare(
              `UPDATE ${table} SET ${set} WHERE ${table === "topup_purchases" ? "payment_hash" : "id"}=?`,
            )
            .bind(...values, table === "topup_purchases" ? f.key : f.a.id)
            .run();
          return f.r;
        })
      ).status,
      "stale",
      table + set,
    );
    assert.equal((await row(db, "topup_claims", f.key)).state, "granted");
    assert.ok(await row(db, "topup_retention", f.key));
  }
  const removed = await ready(db);
  assert.equal(
    (
      await retire(db, removed, async () => {
        await db.prepare("DELETE FROM topup_checkout_attempts WHERE id=?").bind(removed.a.id).run();
        return removed.r;
      })
    ).status,
    "stale",
  );
}

export async function retirementStrictJsonFacts(db) {
  const f = await ready(db);
  const dates = [new Date("2020-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z")];
  for (const value of [
    ...dates,
    new Map([["created", 1]]),
    new Set([1]),
    new Number(1),
    new (class Fact {
      constructor() {
        this.created = 1;
      }
    })(),
    () => 1,
    1n,
  ]) {
    assert.equal(await financialEvidenceDigest({ ...f.r, created: value }), null);
    await age(db, f.key);
    assert.equal((await retire(db, f, async () => ({ ...f.r, created: value }))).status, "pending");
    assert.equal((await row(db, "topup_retention", f.key)).resolved_zero_since, null);
    await refresh(db, f);
  }
  assert.notEqual(
    await financialEvidenceDigest({ ...f.r, created: dates[0].toISOString() }),
    await financialEvidenceDigest({ ...f.r, created: dates[1].toISOString() }),
  );
  let accessed = false;
  const accessor = { ...f.r };
  Object.defineProperty(accessor, "created", {
    enumerable: true,
    get() {
      accessed = true;
      return 1;
    },
  });
  assert.equal(await financialEvidenceDigest(accessor), null);
  assert.equal(accessed, false);
  const custom = new (class Fact {
    constructor() {
      this.created = 1;
    }
  })();
  const initial = await ready(db, { created: custom });
  assert.equal((await row(db, "topup_retention", initial.key)).history_proven, 0);
  assert.equal((await row(db, "topup_retention", initial.key)).evidence_digest, null);
  const updated = await ready(db);
  await refresh(db, updated, { created: custom });
  assert.equal((await row(db, "topup_retention", updated.key)).history_proven, 0);
  assert.equal((await row(db, "topup_retention", updated.key)).evidence_digest, null);
  const sparse = { ...f.r, history: [, 1] };
  assert.equal(await financialEvidenceDigest(sparse), null);
}
