import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

const DAY = 86_400_000;
const MAX = 3_000_000;
const SEED = {
  commit: "1".repeat(40),
  public_tree: "2".repeat(40),
  checkpoint_sha256: null,
};
const CANDIDATE = "3".repeat(40);
const ACCEPTED = "4".repeat(40);
const TREE = "5".repeat(40);
const wire = (ms, micros = "000") => new Date(ms).toISOString().replace("Z", micros + "Z");
const body = (object) => new TextEncoder().encode(JSON.stringify(object)).buffer;
const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

function pending(at, previous = SEED, tree = TREE) {
  return body({
    version: 1,
    predecessor: previous,
    candidate_commit: CANDIDATE,
    candidate_tree: "6".repeat(40),
    public_tree: tree,
    prepared_at: wire(at, "123"),
    rows: [],
  });
}

function accepted(at, rows = [], tree = TREE) {
  return body({
    version: 1, accepted_commit: ACCEPTED, public_tree: tree,
    accepted_at: wire(at, "456"), rows,
  });
}

const stub = () => env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
const alarmAt = (object) => runInDurableObject(object, (_, state) => state.storage.getAlarm());
const stored = (object) => runInDurableObject(object, (_, { storage }) =>
  storage.sql.exec("SELECT slot, digest, starts, expires FROM checkpoint ORDER BY slot").toArray());

const localError = (object, operation, ...args) =>
  runInDurableObject(object, async (instance) => {
    try {
      await instance[operation](...args);
      return null;
    } catch (error) {
      return error.message;
    }
  });

test("SQLite UTC clock, measured-size BLOB, eviction and detached HTTP entry", async () => {
  const object = stub();
  const now = Date.now();
  const record = pending(now - 120_000);
  expect(await object.reservePending(record, MAX)).toBe("pending");
  const options = { predecessor: SEED, generation: await digest(record), checkedAt: wire(now - 1_000) };
  const sample = ["x".repeat(2_541_026)];
  const next = accepted(now - 60_000, sample);
  expect(await object.promote(next, MAX, options)).toBe("promoted");
  await evictDurableObject(object);
  expect((await object.read(MAX)).accepted).toEqual(next);
  expect(await localError(object, "read", next.byteLength - 1)).toBe("invalid follow checkpoint input");
  const [row] = await stored(object);
  expect(row.starts).toBe(now - 60_000 + 1);
  expect(row.expires).toBe(now - 60_000 + 7 * DAY);
  expect(await alarmAt(object)).toBe(row.expires);
  const sqliteNow = await runInDurableObject(object, (_, { storage }) => storage.transactionSync(() =>
    storage.sql.exec("SELECT CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER) AS now").one().now));
  expect(Math.abs(sqliteNow - Date.now())).toBeLessThan(1000);
  expect((await SELF.fetch("https://local.test/checkpoint")).status).toBe(404);
});

test("exact CAS, concurrent promotion, and replay preserve original expiry and newer pending", async () => {
  const object = stub();
  const now = Date.now();
  const original = pending(now - 120_000);
  expect(await object.reservePending(original, MAX)).toBe("pending");
  expect(await object.reservePending(original, MAX)).toBe("already_pending");
  expect(await object.reservePending(pending(now - 110_000), MAX)).toBe("stale");
  const options = { predecessor: SEED, generation: await digest(original), checkedAt: wire(now - 1_000) };
  const next = accepted(now - 60_000);
  expect(await object.promote(next, MAX, { ...options, generation: "0".repeat(64) })).toBe("stale");
  expect(await object.promote(next, MAX, {
    ...options, predecessor: { ...SEED, commit: "0".repeat(40) },
  })).toBe("stale");
  expect(await object.promote(accepted(now - 60_000, [], "0".repeat(40)), MAX, options)).toBe("stale");
  expect(await object.promote(next, MAX, { ...options, checkedAt: wire(now + 60_000) })).toBe("stale");
  const outcomes = await Promise.all([object.promote(next, MAX, options), object.promote(next, MAX, options)]);
  expect(outcomes.sort()).toEqual(["already_promoted", "promoted"]);
  const future = pending(now - 1_000, {
    commit: ACCEPTED, public_tree: TREE, checkpoint_sha256: await digest(next),
  });
  expect(await object.reservePending(future, MAX)).toBe("pending");
  const before = await stored(object);
  expect(await object.promote(accepted(now - 45_000), MAX, options)).toBe("already_promoted");
  expect(await object.rejectPending(options.generation)).toBe(false);
  expect(await object.read(MAX)).toEqual({ accepted: next, pending: future });
  expect(await stored(object)).toEqual(before);
  expect(await object.rejectPending(await digest(future))).toBe(true);
  expect(await object.read(MAX)).toEqual({ accepted: next });
});

test("alarms use earliest deadline, prune expired exact slots and rearm", async () => {
  const object = stub();
  const now = Date.now();
  const original = pending(now - 120_000);
  await object.reservePending(original, MAX);
  const next = accepted(now - 60_000);
  await object.promote(next, MAX, {
    predecessor: SEED, generation: await digest(original), checkedAt: wire(now - 1_000),
  });
  const future = pending(now - 1_000, {
    commit: ACCEPTED, public_tree: TREE, checkpoint_sha256: await digest(next),
  });
  await object.reservePending(future, MAX);
  const deadline = now - 1_000 + DAY;
  expect(await alarmAt(object)).toBe(deadline);
  // Trigger the real scheduled handler early, then simulate a due timestamp on persisted slots.
  expect(await runDurableObjectAlarm(object)).toBe(true);
  expect(await object.read(MAX)).toEqual({ accepted: next, pending: future });
  expect(await alarmAt(object)).toBe(deadline);
  const due = (slot) => runInDurableObject(object, (_, { storage }) =>
    storage.sql.exec("UPDATE checkpoint SET expires = ? WHERE slot = ?", now, slot));
  await due("pending");
  expect(await runDurableObjectAlarm(object)).toBe(true);
  expect(await stored(object)).toHaveLength(1);
  expect(await alarmAt(object)).toBe(now - 60_000 + 7 * DAY);
  await due("accepted");
  expect(await runDurableObjectAlarm(object)).toBe(true);
  expect(await stored(object)).toEqual([]);
  expect(await alarmAt(object)).toBeNull();
});

test("bounds, expiry and SQL/alarms rollback preserve the pending generation", async () => {
  const object = stub();
  const now = Date.now();
  expect(await localError(object, "reservePending", body({ version: 1, rows: [] }), MAX)).toContain("invalid");
  expect(await object.reservePending(pending(now - DAY), MAX)).toBe("stale");
  expect(await object.reservePending(pending(now + 60_000), MAX)).toBe("stale");
  const original = pending(now - 120_000);
  expect(await localError(object, "reservePending", original, original.byteLength - 1)).toContain("invalid");
  expect(await object.reservePending(original, original.byteLength)).toBe("pending");
  const alarm = await alarmAt(object);
  await runInDurableObject(object, (_, { storage }) => storage.sql.exec(`
    CREATE TRIGGER reject_clear BEFORE DELETE ON checkpoint WHEN OLD.slot = 'pending'
    BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`));
  const options = { predecessor: SEED, generation: await digest(original), checkedAt: wire(now - 1_000) };
  expect(await localError(object, "promote", accepted(now - 60_000), MAX, options)).toContain("synthetic rollback");
  expect(await object.read(MAX)).toEqual({ pending: original });
  expect(await alarmAt(object)).toBe(alarm);
  // Throw after changing both resources to test the pinned runtime transaction boundary.
  await expect(runInDurableObject(object, async (_, { storage }) => storage.transaction(async () => {
    storage.transactionSync(() => storage.sql.exec("UPDATE checkpoint SET expires = ?", now));
    await storage.setAlarm(now + 120_000);
    throw new Error("synthetic alarm rollback");
  }))).rejects.toThrow("synthetic alarm rollback");
  expect(await alarmAt(object)).toBe(alarm);
  expect((await stored(object))[0].expires).toBe(alarm);
});


test("expired accepted predecessor cannot authorize a still-live pending generation", async () => {
  const object = stub();
  const now = Date.now();
  const first = pending(now - 120_000);
  const current = accepted(now - 60_000);
  await object.reservePending(first, MAX);
  await object.promote(current, MAX, {
    predecessor: SEED, generation: await digest(first), checkedAt: wire(now - 1_000),
  });
  const prior = { commit: ACCEPTED, public_tree: TREE, checkpoint_sha256: await digest(current) };
  const next = pending(now - 20_000, prior);
  expect(await object.reservePending(next, MAX)).toBe("pending");
  await runInDurableObject(object, (_, { storage }) =>
    storage.sql.exec("UPDATE checkpoint SET expires = ? WHERE slot = 'accepted'", now));
  expect(await object.promote(accepted(now - 10_000), MAX, {
    predecessor: prior, generation: await digest(next), checkedAt: wire(now - 1_000),
  })).toBe("stale");
  expect(await object.read(MAX)).toEqual({ pending: next });
});
