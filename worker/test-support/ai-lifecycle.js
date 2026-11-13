import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { CONFIG } from "../src/config.js";
import { createSession } from "../src/session.js";
import { recordVerifiedTopup } from "../src/topup-ledger.js";
const user = "a".repeat(64);
const raw = JSON.stringify({
  candidates: [{ content: { parts: [{ text: "synthetic answer" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
});
const rows = async (db, t) => (await db.prepare(`SELECT * FROM ${t}`).all()).results;
async function setup(db, mode = "create", patch = {}) {
  await db.batch(
    [
      "runs",
      "usage",
      "bonus",
      "budget",
      "spend",
      "rate",
      "forget",
      "sessions",
      "plans",
      "event_counts",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  const now = new Date(),
    pending = [];
  const session = await createSession(db, { user, tier: "edu", provider: "google" }, now);
  const env = {
    DB: db,
    GEMINI_API_KEY: crypto.randomUUID(),
    FUNDED_RESPONSE_MAX_BYTES: "16384",
    FUNDED_RESPONSE_EVENT_BYTES: "8192",
    FUNDED_RESPONSE_DEADLINE_MS: "5000",
    ...(mode ? { FUNDED_RUNS_MODE: mode } : {}),
  };
  const config = {
    ...CONFIG,
    TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, allowance: 2 } },
    MAX_CALLS_PER_RUN: 2,
    USER_BUDGET_CENTS: { free: 1000 },
    MONTHLY_BUDGET_CENTS: 10000,
    DAILY_BUDGET_CENTS: 1000,
    ...patch,
  };
  let calls = 0,
    provider = async (_url, init) => new Response(init.body && raw);
  const api = async (runId = "fixture", stream = false, bodyPatch = {}, token = session.token) =>
    handle(
      new Request("https://internscout.test/ai" + (stream ? "?stream=1" : ""), {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          task: "autofill",
          run_id: runId,
          request: { contents: [{ role: "user", parts: [{ text: "synthetic input" }] }] },
          ...bodyPatch,
        }),
      }),
      env,
      { waitUntil: (p) => pending.push(p) },
      {
        now: () => now,
        config,
        fetch: async (url, init) => {
          assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\//);
          calls++;
          return provider(url, init);
        },
      },
    );
  const flush = async () => {
    await Promise.all(pending.splice(0));
  };
  const consume = async (response) => {
    const text = await response.text();
    await flush();
    return text;
  };
  return {
    env,
    config,
    now,
    api,
    flush,
    consume,
    calls: () => calls,
    provider: (fn) => {
      provider = fn;
    },
  };
}
export async function aiLegacyDoesNotReadFundedSchema(db) {
  let attempts = 0;
  const guarded = {
    prepare: (sql) => {
      if (/funded_|topup_/i.test(sql)) {
        attempts++;
        throw Error("no new schema");
      }
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  };
  const w = await setup(guarded, null);
  const response = await w.api();
  assert.equal(response.status, 200);
  assert.equal(await w.consume(response), raw);
  assert.equal(response.headers.get("X-InternScout-Remaining"), "1");
  assert.equal(attempts, 0);
  assert.equal(w.calls(), 1);
}
export async function aiCreateDrainAndLegacyContinuation(db) {
  const w = await setup(db, "legacy");
  assert.equal((await w.api("old")).status, 200);
  await w.flush();
  w.env.FUNDED_RUNS_MODE = "create";
  assert.equal((await w.api("old")).status, 200);
  await w.flush();
  assert.equal((await rows(db, "funded_runs")).length, 0);
  const fresh = await w.api("new");
  assert.equal(fresh.status, 200);
  assert.equal(await w.consume(fresh), raw);
  assert.equal((await rows(db, "funded_runs"))[0].accepted, 1);
  w.env.FUNDED_RUNS_MODE = "drain";
  const sibling = await w.api("new");
  assert.equal(sibling.status, 200);
  await w.consume(sibling);
  const denied = await w.api("not-created");
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).error, "busy");
  assert.equal((await rows(db, "runs")).length, 2);
  assert.equal(w.calls(), 4);
}
export async function aiFundedCapsAndInputsPreserveContracts(db) {
  const w = await setup(db);
  assert.equal((await w.api("unauth", false, {}, null)).status, 401);
  assert.equal((await w.api("bad id")).status, 400);
  assert.equal((await w.api("bad-task", false, { task: "unknown" })).status, 400);
  assert.equal(w.calls(), 0);
  for (const id of ["a", "a", "b"]) {
    const response = await w.api(id);
    assert.equal(response.status, 200);
    await w.consume(response);
  }
  const perRun = await w.api("a"),
    cap = await w.api("c");
  assert.equal(perRun.status, 429);
  assert.equal((await perRun.json()).message, "This run reached its call limit");
  const error = await cap.json();
  assert.equal(cap.status, 429);
  assert.equal(error.message, "Monthly autofill allowance is used up");
  assert.equal(error.task, "autofill");
  assert.equal(error.tier, "edu");
  assert.equal(typeof error.upgrade, "boolean");
  assert.ok(Object.hasOwn(error, "offer"));
  assert.equal(w.calls(), 3);
  assert.equal((await db.prepare("SELECT n FROM event_counts WHERE event='cap_hit'").first()).n, 1);
}
export async function aiConcurrentFundedCallsDoNotDoubleDebit(db) {
  const w = await setup(db);
  const created = await w.api();
  assert.equal(created.status, 200);
  await w.consume(created);
  const responses = await Promise.all([w.api(), w.api(), w.api()]);
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  for (const response of responses) await w.consume(response);
  assert.equal(w.calls(), 2);
  assert.equal((await rows(db, "usage"))[0].units, 1);
  assert.equal((await rows(db, "runs"))[0].calls, 2);
}
export async function aiFundedProviderJsonSseAndFailure(db) {
  const w = await setup(db);
  w.provider(async () => new Response("provider details", { status: 500 }));
  const refusal = await w.api("refusal");
  assert.equal(refusal.status, 502);
  assert.doesNotMatch(await refusal.text(), /provider details/);
  assert.equal((await rows(db, "usage"))[0].units, 0);
  w.provider(async () => {
    throw Error("synthetic lost response");
  });
  const unknown = await w.api("unknown");
  assert.equal(unknown.status, 502);
  assert.equal((await rows(db, "funded_run_calls"))[0].state, "reserved");
  const event = "data: " + raw + "\r\n\r\n";
  w.provider(async () => new Response(event));
  const response = await w.api("stream", true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
  assert.equal(await w.consume(response), event);
  assert.equal((await rows(db, "funded_run_calls")).length, 1);
}
export async function aiUnknownReservationNeverFallsBackOrSends(db) {
  const w = await setup(db);
  const broken = {
    prepare: db.prepare.bind(db),
    batch: async (list) => {
      await db.batch(list);
      throw Error("lost batch acknowledgment");
    },
  };
  w.env.DB = broken;
  const response = await w.api();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "busy");
  assert.equal(w.calls(), 0);
  assert.equal((await rows(db, "runs")).length, 1);
  assert.equal((await rows(db, "funded_run_calls")).length, 1);
  assert.equal((await rows(db, "usage"))[0].units, 1);
}
export async function aiPurchasedFundingIsIndependentlyDisabled(db) {
  const w = await setup(db);
  await db.prepare("DELETE FROM topup_purchases").run();
  await db.prepare("DELETE FROM topup_claims").run();
  await recordVerifiedTopup(
    db,
    {
      userHash: user,
      paymentId: "pi_fixture",
      checkoutId: "cs_fixture",
      livemode: false,
      offerVersion: "fixture",
      amount: 300,
      currency: "usd",
      units: 2,
    },
    w.now,
  );
  await db
    .prepare("INSERT INTO usage VALUES(?,?,'autofill',2)")
    .bind(user, w.now.toISOString().slice(0, 7))
    .run();
  assert.equal((await w.api()).status, 429);
  assert.equal(w.calls(), 0);
  w.env.FUNDED_PURCHASES = "1";
  const response = await w.api();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-InternScout-Remaining"), "1");
  await w.consume(response);
  assert.equal((await rows(db, "funded_runs"))[0].funding, "purchase");
  assert.equal((await rows(db, "topup_purchases"))[0].consumed, 1);
  w.env.FUNDED_PURCHASES = "0";
  assert.equal((await w.api()).status, 200);
  await w.flush();
  assert.equal((await rows(db, "topup_purchases"))[0].consumed, 1);
}
export async function aiInvalidModeMissingBoundsAndClockFailClosed(db) {
  const w = await setup(db, "unrecognized");
  assert.equal((await w.api()).status, 503);
  assert.equal(w.calls(), 0);
  w.env.FUNDED_RUNS_MODE = "create";
  delete w.env.FUNDED_RESPONSE_MAX_BYTES;
  assert.equal((await w.api()).status, 503);
  assert.equal((await rows(db, "runs")).length, 0);
  w.env.FUNDED_RESPONSE_MAX_BYTES = "16384";
  w.now.setUTCDate(w.now.getUTCDate() - 1);
  assert.equal((await w.api()).status, 503);
  assert.equal(w.calls(), 0);
  assert.equal((await rows(db, "runs")).length, 0);
}
export async function aiRateBudgetAndOmittedIdContracts(db) {
  for (const mode of ["legacy", "create"]) {
    const w = await setup(db, mode);
    w.env.GLOBAL_RPM = "0";
    const busy = await w.api();
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error, "busy");
    assert.equal(w.calls(), 0);
    assert.ok(
      (await rows(db, "rate")).filter((r) => r.user_hash === user).every((r) => r.calls === 0),
    );
    w.env.GLOBAL_RPM = "120";
    w.env.DAILY_BUDGET_CENTS = "0";
    const paused = await w.api();
    assert.equal(paused.status, 503);
    const daily = await paused.json();
    assert.equal(daily.error, "paused");
    assert.ok(daily.retry_after > 0);
    assert.ok((await rows(db, "rate")).every((r) => r.calls === 0));
    w.env.DAILY_BUDGET_CENTS = "1000";
    await db
      .prepare(
        "INSERT INTO rate VALUES(?,?,1000) ON CONFLICT(user_hash,bucket) DO UPDATE SET calls=1000",
      )
      .bind(user, "m:" + w.now.toISOString().slice(0, 16))
      .run();
    const rate = await w.api();
    assert.equal(rate.status, 429);
    assert.equal((await rate.json()).error, "rate");
    assert.equal(w.calls(), 0);
    await db.prepare("DELETE FROM rate").run();
    for (let i = 0; i < 2; i++) {
      const response = await w.api(undefined, false, { run_id: null });
      assert.equal(response.status, 200);
      await w.consume(response);
    }
    assert.equal((await rows(db, "runs")).length, 2);
    assert.equal((await rows(db, "usage"))[0].units, 2);
  }
}
export async function aiLegacyContinuationCannotCrossFundedGeneration(db) {
  const w = await setup(db, "legacy");
  await w.consume(await w.api());
  w.env.FUNDED_RUNS_MODE = "create";
  const guarded = {
    batch: db.batch.bind(db),
    prepare(sql) {
      const wrap = (statement) => ({
        bind: (...values) => wrap(statement.bind(...values)),
        first: (...args) => statement.first(...args),
        all: () => statement.all(),
        run: async () => {
          if (
            sql.startsWith("UPDATE runs SET calls") &&
            sql.includes("NOT EXISTS(SELECT 1 FROM funded_runs")
          )
            await db
              .prepare(
                "INSERT INTO funded_runs(user_hash,month,task,run_id,generation,funding,accepted) VALUES(?,?,'autofill','fixture',?,'monthly',1)",
              )
              .bind(user, w.now.toISOString().slice(0, 7), crypto.randomUUID())
              .run();
          return statement.run();
        },
      });
      return wrap(db.prepare(sql));
    },
  };
  w.env.DB = guarded;
  const response = await w.api();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "busy");
  assert.equal(w.calls(), 1);
  assert.equal((await rows(db, "runs"))[0].calls, 1);
  assert.equal((await rows(db, "usage"))[0].units, 1);
}
export async function aiSiblingSuccessSurvivesFirstProviderFailure(db) {
  const w = await setup(db);
  let entered,
    resolveFirst,
    n = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  w.provider(async () => {
    if (++n === 1) {
      entered();
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return new Response(raw);
  });
  const first = w.api();
  await started;
  const second = await w.api();
  assert.equal(second.status, 200);
  await w.consume(second);
  resolveFirst(new Response("rejected", { status: 503 }));
  const failed = await first;
  assert.equal(failed.status, 502);
  await w.flush();
  assert.equal((await rows(db, "usage"))[0].units, 1);
  assert.equal((await rows(db, "runs"))[0].calls, 1);
  assert.equal((await rows(db, "funded_runs"))[0].accepted, 1);
  assert.equal((await rows(db, "funded_run_calls")).length, 0);
}
export async function aiAcceptanceFailureAndTransportTimeoutNeverExpose(db) {
  const w = await setup(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_route_accept BEFORE UPDATE OF accepted ON funded_runs BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  const response = await w.api();
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /synthetic answer/);
  assert.equal((await rows(db, "funded_run_calls"))[0].state, "reserved");
  await db.prepare("DROP TRIGGER fixture_route_accept").run();
  w.env.FUNDED_RESPONSE_DEADLINE_MS = "20";
  let aborted = false;
  w.provider(async (_url, init) => {
    init.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise(() => {});
  });
  const timeout = await w.api("timeout");
  assert.equal(timeout.status, 502);
  assert.equal(aborted, true);
  assert.equal(w.calls(), 2);
  assert.equal((await rows(db, "funded_run_calls")).length, 2);
  assert.ok((await rows(db, "budget"))[0].spend_cents > 0);
}
export async function aiPaidUnlimitedAndNewRunBurstUseCurrentLimits(db) {
  const w = await setup(db);
  await db
    .prepare("INSERT INTO plans(user_hash,plan,status,updated) VALUES(?,'supporter','active',?)")
    .bind(user, w.now.toISOString())
    .run();
  w.env.DAILY_BUDGET_CENTS = "0";
  const response = await w.api("deep", false, { task: "deep_dive" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-InternScout-Remaining"), "unlimited");
  await w.consume(response);
  assert.equal((await rows(db, "spend")).filter((r) => r.user_hash === "*").length, 0);
  const fresh = await setup(db);
  const burst = await Promise.all(Array.from({ length: 5 }, () => fresh.api("new-burst")));
  for (const r of burst) await fresh.consume(r);
  assert.ok(fresh.calls() >= 1 && fresh.calls() <= 2);
  assert.equal((await rows(db, "usage"))[0].units, 1);
  assert.equal((await rows(db, "runs"))[0].calls, fresh.calls());
}
