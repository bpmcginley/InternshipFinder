import assert from "node:assert/strict";
import { createFollowManagementHttp } from "../src/follow-management-http.js";
import {
  requestFollow,
  requestFollowConfirmation,
  mintFollowToken,
  confirmFollow,
} from "../src/follows.js";

export const post = (tuple, headers = {}, url = "https://api.example.test/manage") =>
  new Request(url, {
    method: "POST",
    body: typeof tuple === "string" ? tuple : JSON.stringify(tuple),
    duplex: "half",
    headers: { Origin: "https://example.test", "Content-Type": "application/json", ...headers },
  });
export const handler = (db, extra = {}) =>
  createFollowManagementHttp({
    db,
    enabled: true,
    originAllowed: (r) => r.headers.get("Origin") === "https://example.test",
    ...extra,
  });
const catalog = { companies: new Set(["alpha", "beta"]) };
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
export async function fixture(db) {
  const now = new Date(),
    a = await requestFollow(
      db,
      "reader@example.test",
      { kind: "company", company: "alpha" },
      catalog,
      now,
    );
  const b = await requestFollow(
    db,
    "reader@example.test",
    { kind: "company", company: "beta" },
    catalog,
    now,
  );
  const token = await mintFollowToken(db, a.subscriberId, "manage", {}, now);
  return { a, b, token, now, http: handler(db) };
}
export const cases = [
  [
    "bounded keyset pagination is read-only and uses the exact last scope",
    async (db) => {
      const { a, token, now, http } = await fixture(db);
      await db.batch(
        Array.from({ length: 51 }, (_, i) =>
          db
            .prepare(
              "INSERT INTO follow_subscriptions (subscriber_id,scope_key,created) VALUES (?,?,?)",
            )
            .bind(
              a.subscriberId,
              JSON.stringify({ kind: "company", company: `other-${String(i).padStart(2, "0")}` }),
              now.toISOString(),
            ),
        ),
      );
      const before = await rows(db, "follow_subscriptions");
      const first = await http.list(post([token, null]));
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("Cache-Control"), "no-store");
      const p = await first.json();
      assert.equal(p.scopes.length, 50);
      assert.equal(p.next, p.scopes.at(-1).scope_key);
      const q = await (await http.list(post([token, p.next]))).json();
      assert.equal(q.scopes.length, 3);
      assert.equal(q.next, null);
      const all = [...p.scopes, ...q.scopes];
      assert.equal(new Set(all.map((s) => s.scope_key)).size, 53);
      assert.deepEqual(
        all.map((s) => s.scope_key),
        before.map((s) => s.scope_key).sort(),
      );
      assert.deepEqual(Object.keys(all[0]).sort(), ["confirmed_at", "created", "scope_key"]);
      assert.deepEqual(await rows(db, "follow_subscriptions"), before);
      assert.equal((await http.list(post([token, "x".repeat(4096)]))).status, 200);
      assert.equal((await http.list(post([token, "x".repeat(4097)]))).status, 400);
      const plan = await db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT scope_key FROM follow_subscriptions WHERE subscriber_id=? AND scope_key>? ORDER BY scope_key LIMIT 51",
        )
        .bind(a.subscriberId, "")
        .all();
      assert.ok(plan.results.some((r) => /INDEX.*subscriber_id=.*scope_key>/.test(r.detail)));
    },
  ],
  [
    "purpose, reissue and original expiry cannot authorize management",
    async (db) => {
      const { a, token, now, http } = await fixture(db);
      for (const wrong of [
        await mintFollowToken(db, a.subscriberId, "confirm", { scopeKey: a.scopeKey }, now),
        await mintFollowToken(db, a.subscriberId, "unsubscribe", {}, now),
      ]) {
        assert.equal((await http.list(post([wrong, null]))).status, 410);
        assert.deepEqual(await (await http.remove(post([wrong, a.scopeKey]))).json(), {
          removed: false,
        });
        assert.deepEqual(await (await http.deleteAll(post([wrong]))).json(), { deleted: false });
      }
      const current = await mintFollowToken(db, a.subscriberId, "manage", {}, now);
      assert.equal((await http.list(post([token, null]))).status, 410);
      assert.equal((await http.list(post([current, null]))).status, 200);
      const expiry = new Date(+now + 30 * 60_000);
      const expired = handler(db, { now: () => expiry });
      assert.equal((await expired.list(post([current, null]))).status, 410);
      assert.deepEqual(await (await expired.remove(post([current, a.scopeKey]))).json(), {
        removed: false,
      });
      assert.deepEqual(await (await expired.deleteAll(post([current]))).json(), { deleted: false });
      assert.equal((await rows(db, "follow_subscriptions")).length, 2);
    },
  ],
  [
    "remove preserves sibling owner and scope progress, cancels aggregate digest, and replays once",
    async (db) => {
      const { a, b, token, now, http } = await fixture(db);
      await db
        .prepare("UPDATE follow_subscriptions SET confirmed_at=? WHERE subscriber_id=?")
        .bind(now.toISOString(), a.subscriberId)
        .run();
      const confirmation = await mintFollowToken(
        db,
        a.subscriberId,
        "confirm",
        { scopeKey: a.scopeKey },
        now,
      );
      await db
        .prepare(
          "UPDATE follow_subscriptions SET confirmed_at=?,owner_user_hash=? WHERE scope_key=?",
        )
        .bind(now.toISOString(), "a".repeat(64), b.scopeKey)
        .run();
      await db
        .prepare(
          "INSERT INTO follow_digest_outbox (id,subscriber_id,day,payload,state,created,expires_at) VALUES (?,?,?,?,'queued',?,?)",
        )
        .bind(
          "synthetic-job",
          a.subscriberId,
          now.toISOString().slice(0, 10),
          "[]",
          now.toISOString(),
          new Date(+now + 3600000).toISOString(),
        )
        .run();
      const before = (await rows(db, "follow_subscriptions")).find(
        (s) => s.scope_key === b.scopeKey,
      );
      const removed = await Promise.all([
        http.remove(post([token, a.scopeKey])),
        http.remove(post([token, a.scopeKey])),
      ]);
      assert.deepEqual(
        (await Promise.all(removed.map((r) => r.json()))).map((r) => r.removed).sort(),
        [false, true],
      );
      assert.equal(await confirmFollow(db, confirmation, now), false);
      assert.deepEqual(await rows(db, "follow_subscriptions"), [before]);
      const job = (await rows(db, "follow_digest_outbox"))[0];
      assert.equal(job.state, "cancelled");
      assert.equal(job.payload, null);
      // Management owns the current inbox scope key, not a historical scope lifetime.
      await requestFollow(
        db,
        "reader@example.test",
        { kind: "company", company: "alpha" },
        catalog,
        now,
      );
      assert.deepEqual(await (await http.remove(post([token, a.scopeKey]))).json(), {
        removed: true,
      });
      assert.deepEqual(await (await http.remove(post([token, a.scopeKey]))).json(), {
        removed: false,
      });
      const other = await requestFollow(
        db,
        "other@example.test",
        { kind: "company", company: "alpha" },
        catalog,
        now,
      );
      const otherToken = await mintFollowToken(db, other.subscriberId, "manage", {}, now);
      assert.deepEqual(await (await http.remove(post([otherToken, b.scopeKey]))).json(), {
        removed: false,
      });
      assert.deepEqual(await (await http.deleteAll(post([token]))).json(), { deleted: true });
      assert.deepEqual(await (await http.deleteAll(post([token]))).json(), { deleted: false });
      assert.equal((await rows(db, "follow_subscribers"))[0].id, other.subscriberId);
      await requestFollow(
        db,
        "reader@example.test",
        { kind: "company", company: "beta" },
        catalog,
        now,
      );
      assert.deepEqual(await (await http.remove(post([token, b.scopeKey]))).json(), {
        removed: false,
      });
    },
  ],
  [
    "selective removal rolls back confirmation deletion on a failing scope transaction",
    async (db) => {
      const { a, token, now, http } = await fixture(db);
      const confirmation = await mintFollowToken(
        db,
        a.subscriberId,
        "confirm",
        { scopeKey: a.scopeKey },
        now,
      );
      await db
        .prepare(
          "CREATE TRIGGER fixture_management_rollback BEFORE DELETE ON follow_subscriptions BEGIN SELECT RAISE(ABORT,'fixture'); END",
        )
        .run();
      try {
        const response = await http.remove(post([token, a.scopeKey]));
        assert.equal(response.status, 503);
        assert.equal(await response.text(), "");
        assert.equal((await rows(db, "follow_subscriptions")).length, 2);
        assert.equal(await confirmFollow(db, confirmation, now), true);
      } finally {
        await db.prepare("DROP TRIGGER fixture_management_rollback").run();
      }
    },
  ],
  [
    "last-scope removal cascades only its inbox and preserves invalid replay",
    async (db) => {
      const { a, b, token, now, http } = await fixture(db);
      await requestFollowConfirmation(
        db,
        "reader@example.test",
        { kind: "company", company: "alpha" },
        catalog,
        now,
      );
      await mintFollowToken(db, a.subscriberId, "confirm", { scopeKey: a.scopeKey }, now);
      assert.deepEqual(await (await http.remove(post([token, a.scopeKey]))).json(), {
        removed: true,
      });
      assert.equal((await rows(db, "follow_confirmation_outbox")).length, 0);
      assert.deepEqual(await (await http.remove(post([token, b.scopeKey]))).json(), {
        removed: true,
      });
      for (const table of ["follow_subscribers", "follow_subscriptions", "follow_tokens"])
        assert.deepEqual(await rows(db, table), []);
      assert.deepEqual(await (await http.remove(post([token, b.scopeKey]))).json(), {
        removed: false,
      });
      assert.equal((await http.list(post([token, null]))).status, 410);
    },
  ],
];
