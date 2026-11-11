// Identical offline deletion/copy races in SQLite and actual local D1.
import assert from "node:assert/strict";
import {
  createSession,
  copySession,
  sessionUser,
  endSession,
  forgetSessions,
  forgetCopies,
  MAX_SESSIONS,
} from "../src/session.js";
import { deleteUser } from "../src/limits.js";
const user = "a".repeat(64),
  now = new Date("2026-11-10T12:00:00Z"),
  deps = { now: now.getTime() };
const count = async (db, table) =>
  (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
const start = (db) => createSession(db, { user, tier: "edu", provider: "google" }, now);
const authError = (err) => err.status === 401 && err.code === "auth";
// copySession's only batch is its write transaction, after preflight has succeeded.
const beforeWrite = (db, change) => ({
  prepare: (sql) => db.prepare(sql),
  batch: async (statements) => {
    await change();
    return db.batch(statements);
  },
});

export async function copyDeletedSource(db) {
  const source = await start(db);
  await assert.rejects(
    () =>
      copySession(
        beforeWrite(db, () => deleteUser(db, user, now)),
        source.token,
        deps,
      ),
    authError,
  );
  assert.equal(await count(db, "sessions"), 0);
  assert.equal(await count(db, "session_copies"), 0);
  const next = await start(db);
  const copied = await copySession(db, next.token, deps);
  assert.equal((await sessionUser(db, copied.session, deps)).user, user);
  // Reverse transaction order: deletion removes both the already-committed sessions.
  await deleteUser(db, user, now);
  await assert.rejects(() => sessionUser(db, copied.session, deps), authError);
  assert.equal(await count(db, "session_copies"), 0);
}

export async function copyExpiredOrChangedSource(db) {
  for (const kind of ["signout", "expiry", "owner", "tier", "provider"]) {
    await db.batch([forgetSessions(db, user), forgetCopies(db, user)]);
    const source = await start(db);
    const change = async () => {
      if (kind === "signout") return endSession(db, source.token);
      const key = { expiry: "expires", owner: "user_hash", tier: "tier", provider: "provider" }[
        kind
      ];
      const value =
        kind === "expiry" ? now.toISOString() : kind === "owner" ? "b".repeat(64) : "changed";
      await db.prepare(`UPDATE sessions SET ${key}=? WHERE user_hash=?`).bind(value, user).run();
    };
    await assert.rejects(() => copySession(beforeWrite(db, change), source.token, deps), authError);
    assert.equal(await count(db, "session_copies"), 0);
    assert.equal(await count(db, "sessions"), kind === "signout" ? 0 : 1);
    await db.prepare("DELETE FROM sessions").run();
  }
  const expired = await start(db);
  await db.prepare("UPDATE sessions SET expires=?").bind(now.toISOString()).run();
  await assert.rejects(() => copySession(db, expired.token, deps), authError);
  await db.prepare("DELETE FROM sessions").run();
  for (let i = 0; i < MAX_SESSIONS - 1; i++) await start(db);
  const atLimit = await start(db);
  await assert.rejects(
    () =>
      copySession(
        beforeWrite(db, () =>
          db
            .prepare("UPDATE sessions SET expires=? WHERE user_hash=?")
            .bind(now.toISOString(), user)
            .run(),
        ),
        atLimit.token,
        deps,
      ),
    authError,
  );
  assert.equal(
    await count(db, "sessions"),
    MAX_SESSIONS,
    "a failed insert must not trim another session",
  );
}

export async function copyCapabilityAndLimit(db) {
  const source = await start(db);
  const results = await Promise.allSettled([
    copySession(db, source.token, deps),
    copySession(db, source.token, deps),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const refused = results.find((r) => r.status === "rejected").reason;
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "copied");
  assert.equal(await count(db, "sessions"), 2);
  assert.equal(await count(db, "session_copies"), 1);
  const copy = results.find((r) => r.status === "fulfilled").value;
  assert.deepEqual(Object.keys(copy).sort(), ["account", "expires", "provider", "session", "tier"]);
  assert.equal(copy.account, user.slice(0, 16));
  assert.equal(copy.tier, "edu");
  assert.equal(copy.provider, "google");
  assert.equal(copy.expires, "2027-11-10T12:00:00.000Z");
  await assert.rejects(
    () => copySession(db, copy.session, deps),
    (e) => e.status === 409 && e.code === "copied",
  );
  await endSession(db, source.token);
  assert.equal((await sessionUser(db, copy.session, deps)).user, user);
  await db.batch([forgetSessions(db, user), forgetCopies(db, user)]);
  for (let i = 0; i < MAX_SESSIONS; i++) await start(db);
  const newest = await start(db);
  assert.equal(await count(db, "sessions"), MAX_SESSIONS);
  const made = await copySession(db, newest.token, deps);
  assert.equal(await count(db, "sessions"), MAX_SESSIONS);
  assert.equal((await sessionUser(db, made.session, deps)).user, user);
}

export async function copyRollback(db) {
  const source = await start(db);
  await db
    .prepare(
      "CREATE TRIGGER fixture_copy_abort BEFORE INSERT ON session_copies BEGIN SELECT RAISE(ABORT,'fixture_copy_rollback'); END",
    )
    .run();
  await assert.rejects(() => copySession(db, source.token, deps));
  assert.equal(await count(db, "sessions"), 1);
  assert.equal(await count(db, "session_copies"), 0);
  await db.prepare("DROP TRIGGER fixture_copy_abort").run();
  const made = await copySession(db, source.token, deps);
  assert.equal((await sessionUser(db, made.session, deps)).user, user);
}
