import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { measureFollowScheduledMaintenance } from "../src/follow-scheduled-maintenance.js";

const cron = "13 2 * * *";
const policy = JSON.stringify({
  deadlineMs: 30000,
  maxD1Calls: 16,
  maxRows: 4,
  digestCandidates: true,
});
const settings = {
  FOLLOW_MAINTENANCE_CRON: cron,
  FOLLOW_MAINTENANCE_ENABLED: "1",
  FOLLOW_MAINTENANCE_POLICY: policy,
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { resolve, reject, promise };
};
function run(bindings, at = cron) {
  const jobs = [];
  worker.scheduled({ cron: at }, { ...settings, ...bindings }, { waitUntil: (p) => jobs.push(p) });
  return jobs;
}
async function reset() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    ["follow_subscribers", "follow_digest_days", "follow_send_budget"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
function counted(after = async () => {}) {
  const native = new WeakMap(),
    calls = [];
  const wrap = (statement) => {
    const outer = {
      bind: (...values) => wrap(statement.bind(...values)),
      all: async () => {
        calls.push("all");
        const result = await statement.all();
        await after(calls.length);
        return result;
      },
    };
    native.set(outer, statement);
    return outer;
  };
  return {
    calls,
    db: {
      prepare: (sql) => wrap(env.DB.prepare(sql)),
      batch: async (statements) => {
        calls.push("batch");
        const result = await env.DB.batch(statements.map((s) => native.get(s)));
        await after(calls.length);
        return result;
      },
    },
  };
}
function observed(db, record, timeout = "50") {
  return {
    DB: db,
    FOLLOW_MAINTENANCE_OBSERVATION: { record },
    FOLLOW_MAINTENANCE_OBSERVATION_TIMEOUT_MS: timeout,
  };
}

it("keeps off/unknown events untouched and no-observer or invalid port on one original waitUntil", async () => {
  const getter = vi.fn(() => {
    throw Error("unexpected observer access");
  });
  const guarded = { DB: { prepare: vi.fn() }, FOLLOW_MAINTENANCE_POLICY: "{}" };

  // Construct directly: spreading a fixture getter would itself read it.
  for (const [enabled, at] of [
    ["0", cron],
    ["1", "unknown"],
  ]) {
    const jobs = [];
    worker.scheduled(
      { cron: at },
      Object.defineProperty(
        { ...settings, FOLLOW_MAINTENANCE_ENABLED: enabled },
        "FOLLOW_MAINTENANCE_OBSERVATION",
        { get: getter },
      ),
      { waitUntil: (p) => jobs.push(p) },
    );
    expect(jobs).toEqual([]);
  }
  expect(getter).not.toHaveBeenCalled();
  const record = vi.fn();
  for (const extra of [
    {},
    ...[undefined, "0", "01", "1.5", "30001", 1].map((v) => ({
      ...observed(guarded.DB, record),
      FOLLOW_MAINTENANCE_OBSERVATION_TIMEOUT_MS: v,
    })),
    {
      FOLLOW_MAINTENANCE_OBSERVATION: { record: 1 },
      FOLLOW_MAINTENANCE_OBSERVATION_TIMEOUT_MS: "10",
    },
  ]) {
    const jobs = run({ ...guarded, FOLLOW_MAINTENANCE_OBSERVATION: undefined, ...extra });
    expect(jobs).toHaveLength(1);
    expect(await jobs[0]).toEqual({ status: "unavailable" });
  }
  expect(record).not.toHaveBeenCalled();
  const broken = Object.defineProperty(
    { ...settings, FOLLOW_MAINTENANCE_POLICY: "{}" },
    "FOLLOW_MAINTENANCE_OBSERVATION",
    { get: getter },
  );
  const jobs = [];
  worker.scheduled({ cron }, broken, { waitUntil: (p) => jobs.push(p) });
  expect(jobs).toHaveLength(1);
  expect(await jobs[0]).toEqual({ status: "unavailable" });
});

it("invalid maintenance policy records an honest zero-call unavailable outcome", async () => {
  const record = vi.fn(),
    db = { prepare: vi.fn(), batch: vi.fn() };
  const jobs = run({ ...observed(db, record), FOLLOW_MAINTENANCE_POLICY: "{}" });
  expect(await jobs[0]).toEqual({ status: "unavailable" });
  await jobs[1];
  expect(record.mock.calls[0][0]).toMatchObject({ status: "unavailable", d1Calls: 0 });
  expect(db.prepare).not.toHaveBeenCalled();
  expect(db.batch).not.toHaveBeenCalled();
});

it("actual entry reports only frozen aggregate after native work, counting bound all and batch", async () => {
  await reset();
  const tracker = counted(),
    record = vi.fn();
  const jobs = run(observed(tracker.db, record));
  expect(jobs).toHaveLength(2);
  expect(await jobs[0]).toEqual({ status: "pass-complete" });
  await jobs[1];
  expect(record).toHaveBeenCalledOnce();
  const value = record.mock.calls[0][0];
  expect(Reflect.ownKeys(value)).toEqual(["status", "durationMs", "d1Calls"]);
  expect(value.status).toBe("pass-complete");
  expect(value.d1Calls).toBe(tracker.calls.length);
  expect(tracker.calls).toContain("all");
  expect(tracker.calls).toContain("batch");
  expect(Number.isSafeInteger(value.durationMs)).toBe(true);
  expect(value.durationMs).toBeGreaterThanOrEqual(0);
  expect(Object.isFrozen(value)).toBe(true);
});

it("reports partial and uncertain attempted calls exactly without retry", async () => {
  await reset();
  const capped = counted(),
    partial = await measureFollowScheduledMaintenance(
      capped.db,
      JSON.stringify({ deadlineMs: 30000, maxD1Calls: 1, maxRows: 4 }),
    );
  expect(partial.result).toEqual({ status: "partial" });
  expect(partial.observation.d1Calls).toBe(1);
  const lost = counted(async () => {
    throw Error("synthetic lost acknowledgement");
  });
  const failure = await measureFollowScheduledMaintenance(lost.db, policy);
  expect(failure.result).toEqual({ status: "unavailable" });
  expect(failure.observation.d1Calls).toBe(1);
  expect(lost.calls).toHaveLength(1);
  const bad = await measureFollowScheduledMaintenance({ prepare: () => ({}), batch: 1 }, policy);
  expect(bad.result).toEqual({ status: "unavailable" });
  expect(bad.observation.d1Calls).toBe(0);
});

it("duration includes late completion and broken measurement cannot change work", async () => {
  await reset();
  let time = 0;
  const slow = counted(async () => {
    time = 40001.2;
  });
  const result = await measureFollowScheduledMaintenance(
    slow.db,
    policy,
    () => time,
    () => time,
  );
  expect(result.result).toEqual({ status: "partial" });
  expect(result.observation).toEqual({ status: "partial", durationMs: 40002, d1Calls: 1 });
  for (const clock of [
    () => NaN,
    () => {
      throw Error("clock unavailable");
    },
    (() => {
      let n = 1;
      return () => n--;
    })(),
  ]) {
    const fresh = counted();
    const measured = await measureFollowScheduledMaintenance(fresh.db, policy, clock);
    expect(measured.result).toEqual({ status: "pass-complete" });
    expect(measured.observation).toBeNull();
    expect(fresh.calls.length).toBeGreaterThan(0);
  }
});

it("pending, throwing and rejected recorders cannot change or hold maintenance completion", async () => {
  await reset();
  const pending = deferred(),
    record = vi.fn(() => pending.promise);
  const jobs = run(observed(env.DB, record, "10"));
  expect(await jobs[0]).toEqual({ status: "pass-complete" });
  expect(record).toHaveBeenCalledOnce();
  // The independent observation job finishes while the recorder is still unresolved.
  await jobs[1];
  pending.reject(Error("synthetic late failure"));
  await Promise.resolve();
  for (const recorder of [
    () => {
      throw Error("synthetic detail");
    },
    () => Promise.reject({ private: "synthetic" }),
  ]) {
    const calls = vi.fn(recorder),
      done = run(observed(env.DB, calls));
    expect(await done[0]).toEqual({ status: "pass-complete" });
    await done[1];
    expect(calls).toHaveBeenCalledOnce();
  }
});

it("captures the optional binding but starts no recording before maintenance settles", async () => {
  await reset();
  const entered = deferred(),
    release = deferred();
  const tracker = counted(async (n) => {
    if (n === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  const record = vi.fn(),
    replacement = vi.fn(),
    binding = { record };
  const jobs = run({ ...observed(tracker.db, record), FOLLOW_MAINTENANCE_OBSERVATION: binding });
  await entered.promise;
  expect(record).not.toHaveBeenCalled();
  binding.record = replacement;
  release.resolve();
  expect(await jobs[0]).toEqual({ status: "pass-complete" });
  await jobs[1];
  expect(record).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
});
