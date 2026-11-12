import assert from "node:assert/strict";
import { runFollowLinkDispatch as tick } from "../src/follow-link-dispatch.js";
import { requestFollowConfirmation, mintFollowToken } from "../src/follows.js";
import { enqueueFollowManagementRequest } from "../src/follow-management-request.js";
import { reserveFollowSendAttempt } from "../src/follow-send-budget.js";
import { presentation, buildLinks } from "./follow-management-delivery.js";
export const config = (db, transport = async () => {}) => ({
  enabled: true,
  db,
  cap: 20,
  maxCandidates: 4,
  clock: () => new Date(),
  transport,
  confirmation: {
    present: ({ confirmation, deleteRequest, unsubscribe }) => ({
      ...presentation(),
      summary: "Synthetic company",
      links: {
        confirmation: `https://follow.example.test/confirm?token=${confirmation}`,
        deleteRequest: `https://follow.example.test/delete?token=${deleteRequest}`,
        unsubscribe: `https://follow.example.test/unsubscribe?token=${unsubscribe}`,
      },
    }),
  },
  management: { presentation: presentation(), buildLinks },
});
export async function seed(db, kind, n = 0, ttlMs = 60000) {
  const email = `${kind}${n}@example.test`;
  const result = await requestFollowConfirmation(
    db,
    email,
    { kind: "company", company: "one" },
    { companies: new Set(["one"]) },
    new Date(Date.now() - 1000),
  );
  if (kind === "confirmation") return result.confirmationJobId;
  await db
    .prepare("DELETE FROM follow_confirmation_outbox WHERE id=?")
    .bind(result.confirmationJobId)
    .run();
  await enqueueFollowManagementRequest(db, { email }, { enabled: true, ttlMs, dailyLimit: 1000 });
  // Positive fixtures are already due under both independent clocks, not at a millisecond boundary.
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ',queued_at,'-1 second') WHERE subscriber_id=(SELECT id FROM follow_subscribers WHERE email=?)",
    )
    .bind(email)
    .run();
  return db
    .prepare(
      "SELECT id FROM follow_management_outbox WHERE subscriber_id=(SELECT id FROM follow_subscribers WHERE email=?)",
    )
    .bind(email)
    .first("id");
}
const budget = (db) => db.prepare("SELECT attempts FROM follow_send_budget").first("attempts");
const kindOf = (e) => (e.subject.startsWith("Manage") ? "management" : "confirmation");
export async function disabledAndMalformedInputDoesNoIO() {
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      throw Error();
    },
    batch() {
      calls++;
      throw Error();
    },
  };
  assert.equal((await tick()).status, "disabled");
  for (const change of [
    { enabled: "true" },
    { cap: 0 },
    { maxCandidates: 65 },
    { maxCandidates: 0 },
    { transport: null },
    { continuation: {} },
    { continuation: { confirmation: [], management: null, nextKind: "confirmation" } },
    { clock: () => Promise.reject(Error("synthetic-clock")) },
  ])
    assert.ok(
      ["disabled", "unavailable"].includes((await tick({ ...config(db), ...change })).status),
    );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
}
export async function alternatingContinuationAndSequentialHandoff(db) {
  for (const kind of ["confirmation", "management"])
    for (let n = 0; n < 2; n++) await seed(db, kind, n);
  const sent = [];
  let active = 0,
    continuation;
  const transport = async (e) => {
    assert.equal(active++, 0);
    await Promise.resolve();
    sent.push(kindOf(e));
    active--;
  };
  for (let i = 0; i < 4; i++) {
    const result = await tick({
      ...config(db, transport),
      maxCandidates: 1,
      ...(continuation ? { continuation } : {}),
    });
    assert.equal(result.status, "processed");
    assert.equal(result.counts.examined, 1);
    assert.equal(result.counts.accepted, 1);
    continuation = result.continuation;
  }
  assert.deepEqual(sent, ["confirmation", "management", "confirmation", "management"]);
  assert.equal(await budget(db), 4);
  const empty = await tick({ ...config(db, transport), continuation });
  assert.equal(empty.counts.examined, 0);
  assert.equal(sent.length, 4);
  assert.equal(empty.continuation.confirmation, null);
  assert.equal(empty.continuation.management, null);
}
export async function ineligibleHeadAdvancesWithoutRetryingIt(db) {
  await seed(db, "confirmation", 1);
  await seed(db, "confirmation", 2);
  const q = await db
    .prepare("SELECT * FROM follow_confirmation_outbox ORDER BY expires_at,id LIMIT 1")
    .first();
  await mintFollowToken(db, q.subscriber_id, "confirm", { scopeKey: q.scope_key });
  let sends = 0;
  const first = await tick({ ...config(db, async () => sends++), maxCandidates: 1 });
  assert.equal(first.counts.unavailable, 1);
  assert.equal(first.continuation.confirmation.id, q.id);
  const second = await tick({
    ...config(db, async () => sends++),
    maxCandidates: 1,
    continuation: first.continuation,
  });
  assert.equal(second.counts.accepted, 1);
  assert.equal(sends, 1);
  assert.equal(await budget(db), 1);
}
export async function uncertainStopsAndSpentJobIsNeverReplayed(db) {
  const id = await seed(db, "confirmation");
  await seed(db, "management");
  let sends = 0;
  const first = await tick(
    config(db, async () => {
      sends++;
      throw Error("synthetic ambiguity");
    }),
  );
  assert.equal(first.status, "uncertain");
  assert.equal(first.counts.examined, 1);
  assert.equal(first.continuation.confirmation.id, id);
  assert.equal(sends, 1);
  const second = await tick({
    ...config(db, async () => sends++),
    continuation: first.continuation,
  });
  assert.equal(second.counts.accepted, 1);
  assert.equal(sends, 2);
  assert.equal(await budget(db), 2);
}
export async function overlappingTicksShareTheSameCap(db) {
  for (const kind of ["confirmation", "management"])
    for (let n = 0; n < 2; n++) await seed(db, kind, n);
  let sends = 0;
  await Promise.all(
    Array.from({ length: 3 }, () => tick({ ...config(db, async () => sends++), cap: 2 })),
  );
  assert.equal(sends, 2);
  assert.equal(await budget(db), 2);
}
export async function futureDueRowsAreBoundedSkippedCandidates(db) {
  const id = await seed(db, "management");
  await db
    .prepare(
      "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 seconds') WHERE id=?",
    )
    .bind(id)
    .run();
  let sends = 0;
  const result = await tick(config(db, async () => sends++));
  assert.equal(result.counts.skipped, 1);
  assert.equal(result.counts.examined, 1);
  assert.equal(sends, 0);
  assert.equal(await budget(db), null);
  assert.equal(result.continuation.management.id, id);
}
export async function selectionReceiptsAndClockFailClosed(db) {
  await seed(db, "management");
  for (const fault of ["false", "hole", "oversize", "badRow", "regression", "duplicateId"]) {
    let batches = 0,
      samples = 0,
      sends = 0;
    const at = Date.now();
    const wrapped = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        const result = await db.batch(statements);
        if (++batches === 2) {
          if (fault === "false") result[1].success = false;
          if (fault === "hole") delete result[1];
          if (fault === "oversize") result[1].results = Array(5).fill(result[1].results[0]);
          if (fault === "badRow") result[1].results[0].id = [result[1].results[0].id];
          if (fault === "duplicateId")
            result[1].results.push({
              ...result[1].results[0],
              expires_at: new Date(Date.parse(result[1].results[0].expires_at) + 1).toISOString(),
            });
        }
        return result;
      },
    };
    const result = await tick({
      ...config(wrapped, async () => sends++),
      clock: () => new Date(at - (fault === "regression" && ++samples > 2 ? 1 : 0)),
    });
    assert.equal(result.status, "unavailable");
    assert.equal(sends, 0);
    assert.equal(await budget(db), null);
  }
}
export async function expiryAndClaimedBacklogsUseIndexedPages(db) {
  // Large fixture bands are built in SQL, never provider data.
  for (const kind of ["confirmation", "management"]) {
    for (const band of ["expired", "claimed"]) {
      const prefix = kind + band;
      const cte = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500) ";
      await db
        .prepare(
          cte +
            "INSERT INTO follow_subscribers(id,email,created) SELECT ?||i,?||i||'@example.test','2026-01-01T00:00:00.000Z' FROM n",
        )
        .bind(prefix, prefix)
        .run();
      await db
        .prepare(
          "INSERT INTO follow_subscriptions(subscriber_id,scope_key,created) SELECT id,'scope',created FROM follow_subscribers WHERE id LIKE ?",
        )
        .bind(prefix + "%")
        .run();
      const expires =
        band === "expired"
          ? "'2026-01-02T00:00:00.000Z'"
          : "strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')";
      const queued =
        band === "expired" ? "'2026-01-01T00:00:00.000Z'" : "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
      await db
        .prepare(
          `INSERT INTO follow_${kind}_outbox(id,subscriber_id,${kind === "confirmation" ? "scope_key," : ""}queued_at,expires_at,claim_id) SELECT id,id,${kind === "confirmation" ? "'scope'," : ""}${queued},${expires},${band === "claimed" ? "'spent'" : "NULL"} FROM follow_subscribers WHERE id LIKE ?`,
        )
        .bind(prefix + "%")
        .run();
    }
    const table = `follow_${kind}_outbox`;
    for (const condition of ["expires_at>?", "(expires_at,id)>(?,?)"]) {
      const plan = (
        await db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT id,queued_at,expires_at FROM ${table} INDEXED BY ${table}_dispatch WHERE claim_id IS NULL AND ${condition} ORDER BY expires_at,id LIMIT 2`,
          )
          .bind(
            ...(condition.includes("id")
              ? ["2026-11-12T00:00:00.000Z", "cursor"]
              : ["2026-11-12T00:00:00.000Z"]),
          )
          .all()
      ).results
        .map((r) => r.detail)
        .join(" ");
      assert.match(plan, /SEARCH/);
      assert.ok(plan.includes(table + "_dispatch"));
      assert.doesNotMatch(plan, /TEMP|SCAN/);
    }
    await seed(db, kind);
  }
  let sends = 0;
  const result = await tick({ ...config(db, async () => sends++), maxCandidates: 2 });
  assert.equal(result.counts.examined, 2);
  assert.equal(result.counts.accepted, 2);
  assert.equal(sends, 2);
}

export async function exhaustedCapacityPreservesTheBlockedTurn(db) {
  for (const kind of ["confirmation", "management"])
    for (let n = 0; n < 3; n++) await seed(db, kind, n);
  let continuation;
  const sent = [];
  for (let cap = 1; cap <= 6; cap++) {
    const result = await tick({
      ...config(db, async (e) => sent.push(kindOf(e))),
      maxCandidates: 2,
      cap,
      ...(continuation ? { continuation } : {}),
    });
    assert.equal(result.counts.accepted, 1);
    if (cap === 1) {
      assert.equal(result.status, "paused");
      assert.equal(result.continuation.management, null);
      assert.equal(result.continuation.nextKind, "management");
    }
    continuation = result.continuation;
  }
  assert.deepEqual(sent, [
    "confirmation",
    "management",
    "confirmation",
    "management",
    "confirmation",
    "management",
  ]);
  assert.equal(await budget(db), 6);
}
export async function competingCapacityClaimPreservesEitherKindCursor(db) {
  for (const kind of ["confirmation", "management"]) {
    await db.batch(
      ["follow_subscribers", "follow_send_budget", "rate"].map((t) =>
        db.prepare(`DELETE FROM ${t}`),
      ),
    );
    await seed(db, kind);
    let raced = false,
      sends = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (statements) => {
        if (!raced && statements.length > 2) {
          raced = true;
          assert.equal(await reserveFollowSendAttempt(db, 1), true);
        }
        return db.batch(statements);
      },
    };
    const first = await tick({
      ...config(wrapped, async () => sends++),
      cap: 1,
      maxCandidates: 2,
      continuation: { confirmation: null, management: null, nextKind: kind },
    });
    assert.equal(raced, true);
    assert.equal(first.status, "paused");
    assert.equal(first.continuation[kind], null);
    assert.equal(first.continuation.nextKind, kind);
    assert.equal(sends, 0);
    const second = await tick({
      ...config(db, async () => sends++),
      cap: 2,
      maxCandidates: 2,
      continuation: first.continuation,
    });
    assert.equal(second.counts.accepted, 1);
    assert.equal(sends, 1);
  }
}
