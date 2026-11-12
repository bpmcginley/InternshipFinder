import assert from "node:assert/strict";
import { deliverFollowManagement as deliver } from "../src/follow-management-delivery.js";
import { enqueueFollowManagementRequest as enqueue } from "../src/follow-management-request.js";
import { inspectFollowToken, mintFollowToken } from "../src/follows.js";
export const presentation = () => ({
  from: "Synthetic Sender <sender@example.test>",
  postalAddress: "TEST FIXTURE ONLY\nNo real postal address",
  origins: ["https://follow.example.test/"],
});
export const buildLinks = ({ management, unsubscribe }) => ({
  management: `https://follow.example.test/manage?token=${management}`,
  unsubscribe: `https://follow.example.test/unsubscribe?token=${unsubscribe}`,
});
export const config = (db) => ({
  enabled: true,
  db,
  cap: 10,
  clock: () => new Date(),
  presentation: presentation(),
  buildLinks,
});
const rows = async (db, t) => (await db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results;
const reset = (db) =>
  db.batch(
    ["follow_subscribers", "follow_send_budget", "rate"].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
export async function seed(db, ttlMs = 60000) {
  const at = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') at").first("at");
  await db
    .prepare(
      "INSERT INTO follow_subscribers(id,email,created) VALUES('fixture','reader@example.test',?)",
    )
    .bind(at)
    .run();
  await db
    .prepare(
      "INSERT INTO follow_subscriptions(subscriber_id,scope_key,created) VALUES('fixture','scope',?)",
    )
    .bind(at)
    .run();
  await enqueue(db, { email: "reader@example.test" }, { enabled: true, ttlMs, dailyLimit: 20 });
  return (await rows(db, "follow_management_outbox"))[0].id;
}
export async function disabledAndMalformedConfigurationNeverAccessStorage() {
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
    },
    base = config(db);
  assert.deepEqual(await deliver(), { status: "disabled" });
  for (const change of [
    { enabled: "true" },
    { cap: 0 },
    { transport: null },
    { clock: null },
    { presentation: { ...presentation(), postalAddress: "" } },
    { presentation: { ...presentation(), origins: ["https://other.example.test/"] } },
    {
      buildLinks: () => ({
        management: "https://follow.example.test/no-credential",
        unsubscribe: "x",
      }),
    },
    {
      buildLinks: async () => {
        throw Error("fixture");
      },
    },
  ]) {
    const result = await deliver({ ...base, transport: async () => {}, ...change });
    assert.ok(["disabled", "unavailable"].includes(result.status));
  }
  await Promise.resolve();
  assert.equal(calls, 0);
}
export async function exactApprovedEnvelopeAndOneAttempt(db) {
  const jobId = await seed(db),
    sent = [];
  assert.deepEqual(await deliver({ ...config(db), jobId, transport: async (e) => sent.push(e) }), {
    status: "accepted",
  });
  assert.equal(sent.length, 1);
  const message = sent[0];
  assert.equal(message.subject, "Manage your InternScout follows");
  assert.equal(message.to, "reader@example.test");
  assert.match(
    message.text,
    /This link expires in 30 minutes\. If you did not request it, ignore this email\./,
  );
  const management = new URL(
    message.text.split("\n")[0].slice("Manage your follows: ".length),
  ).searchParams.get("token");
  const unsubscribe = new URL(
    message.text.split("\n")[2].slice("Unsubscribe: ".length),
  ).searchParams.get("token");
  assert.ok(await inspectFollowToken(db, management, "manage"));
  assert.ok(await inspectFollowToken(db, unsubscribe, "unsubscribe"));
  assert.equal(
    message.headers["List-Unsubscribe"],
    `<https://follow.example.test/unsubscribe?token=${unsubscribe}>`,
  );
  assert.equal(message.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.deepEqual(await deliver({ ...config(db), jobId, transport: async (e) => sent.push(e) }), {
    status: "unavailable",
  });
  assert.equal(sent.length, 1);
  assert.equal((await rows(db, "follow_send_budget"))[0].attempts, 1);
}
export async function concurrentInvocationsHaveOneTransport(db) {
  const jobId = await seed(db);
  let sends = 0;
  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () =>
      deliver({ ...config(db), jobId, transport: async () => sends++ }),
    ),
  );
  assert.equal(outcomes.filter((v) => v.status === "accepted").length, 1);
  assert.equal(sends, 1);
  assert.equal((await rows(db, "follow_send_budget"))[0].attempts, 1);
}
export async function unknownTransportIsSpentWithoutRetry(db) {
  for (const kind of ["throw", "reject", "nonpromise"]) {
    await reset(db);
    const jobId = await seed(db);
    let sends = 0;
    const transport = () => {
      sends++;
      if (kind === "throw") throw Error("private fixture");
      if (kind === "reject") return Promise.reject(Error("private fixture"));
      return true;
    };
    assert.deepEqual(await deliver({ ...config(db), jobId, transport }), { status: "uncertain" });
    assert.deepEqual(await deliver({ ...config(db), jobId, transport }), { status: "unavailable" });
    assert.equal(sends, 1);
    assert.equal((await rows(db, "follow_send_budget"))[0].attempts, 1);
  }
}
export async function deletedChangedOrRotatedBeforeFenceNeverHandsOff(db) {
  const mutations = [
    "DELETE FROM follow_subscribers",
    "DELETE FROM follow_management_outbox",
    "DELETE FROM follow_subscriptions",
    "DELETE FROM follow_tokens WHERE purpose='manage'",
    "DELETE FROM follow_tokens WHERE purpose='unsubscribe'",
    "UPDATE follow_management_outbox SET claim_id='different'",
    "UPDATE follow_subscribers SET email='changed@example.test'",
    "UPDATE follow_management_outbox SET queued_at=strftime('%Y-%m-%dT%H:%M:%fZ',queued_at,'-1 second')",
    "UPDATE follow_management_outbox SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',expires_at,'+1 second')",
  ];
  for (const mutation of mutations) {
    await reset(db);
    const jobId = await seed(db);
    let calls = 0,
      sends = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        if (++calls === 5) await db.prepare(mutation).run();
        return db.batch(s);
      },
    };
    assert.deepEqual(await deliver({ ...config(wrapped), jobId, transport: async () => sends++ }), {
      status: "unavailable",
    });
    assert.equal(calls, 5);
    assert.equal(sends, 0);
    assert.equal((await rows(db, "follow_send_budget"))[0].attempts, 1);
  }
}
export async function malformedFinalOrCommittedReceiptsNeverHandsOff(db) {
  for (const fault of [
    "committed",
    "false",
    "hole",
    "duplicate",
    "rowArray",
    "expiry",
    "changes",
  ]) {
    await reset(db);
    const jobId = await seed(db);
    let calls = 0,
      sends = 0;
    const wrapped = {
      prepare: (s) => db.prepare(s),
      batch: async (s) => {
        const r = await db.batch(s);
        calls++;
        if (fault === "committed" && calls === 4) throw Error("lost acknowledgement");
        if (calls === 5) {
          if (fault === "false") r[0].success = false;
          if (fault === "hole") delete r[0];
          if (fault === "duplicate") r[0].results.push(r[0].results[0]);
          if (fault === "rowArray") r[0].results[0] = Object.assign([], r[0].results[0]);
          if (fault === "expiry") r[0].results[0].expires_at = "2099-01-01T00:00:00.000Z";
          if (fault === "changes") r[0].meta.changes = 1;
        }
        return r;
      },
    };
    assert.deepEqual(await deliver({ ...config(wrapped), jobId, transport: async () => sends++ }), {
      status: "unavailable",
    });
    assert.equal(sends, 0);
    assert.equal((await rows(db, "follow_send_budget"))[0].attempts, 1);
    assert.deepEqual(await deliver({ ...config(db), jobId, transport: async () => sends++ }), {
      status: "unavailable",
    });
    assert.equal(sends, 0);
  }
}
export async function copiedConfigAndCredentialBindingAreStable(db) {
  const jobId = await seed(db),
    settings = presentation();
  let calls = 0,
    envelope;
  const wrapped = {
    prepare: (s) => db.prepare(s),
    batch: async (s) => {
      const r = await db.batch(s);
      if (++calls === 4) {
        settings.from = "changed@example.test";
        settings.origins[0] = "https://other.example.test/";
        settings.postalAddress = "changed";
      }
      return r;
    },
  };
  assert.deepEqual(
    await deliver({
      ...config(wrapped),
      presentation: settings,
      jobId,
      transport: async (e) => (envelope = e),
    }),
    { status: "accepted" },
  );
  assert.equal(envelope.from.email, "sender@example.test");
  assert.match(envelope.text, /TEST FIXTURE ONLY/);
  await reset(db);
  const second = await seed(db);
  let links = 0,
    sends = 0;
  const builder = (credentials) => {
    const values = buildLinks(credentials);
    if (++links === 2) values.management = values.unsubscribe;
    return values;
  };
  assert.deepEqual(
    await deliver({
      ...config(db),
      jobId: second,
      buildLinks: builder,
      transport: async () => sends++,
    }),
    { status: "unavailable" },
  );
  assert.equal(sends, 0);
  assert.equal((await rows(db, "follow_send_budget"))[0].attempts, 1);
}
export async function invalidRecipientDoesNotInvalidatePriorManagement(db) {
  const jobId = await seed(db);
  const old = await mintFollowToken(db, "fixture", "manage");
  await db.prepare("UPDATE follow_subscribers SET email='bad,address@example.test'").run();
  let sends = 0;
  assert.deepEqual(await deliver({ ...config(db), jobId, transport: async () => sends++ }), {
    status: "unavailable",
  });
  assert.equal(sends, 0);
  assert.deepEqual(await rows(db, "follow_send_budget"), []);
  assert.equal((await rows(db, "follow_management_outbox"))[0].claim_id, null);
  assert.ok(await inspectFollowToken(db, old, "manage"));
}
export async function lateOrRegressedAppClockBlocksHandoff(db) {
  for (const delta of [-1, 86400000, 1800000]) {
    await reset(db);
    const jobId = await seed(db);
    let samples = 0,
      sends = 0;
    const at = Date.now();
    const clock = () => new Date(at + (++samples >= 3 ? delta : 0));
    assert.deepEqual(
      await deliver({ ...config(db), jobId, clock, transport: async () => sends++ }),
      { status: "unavailable" },
    );
    assert.equal(sends, 0);
    assert.equal((await rows(db, "follow_send_budget"))[0].attempts, 1);
  }
}
