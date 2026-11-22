import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";

const DAY = 86_400_000;
const stamp = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
const encode = (value) =>
  new TextEncoder().encode(
    JSON.stringify(value, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
    ),
  );
const sha = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
const inspect = (object) => runInDurableObject(object, (i) => i.state());
async function setup(priorAge = null) {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  let prior = null;
  if (priorAge !== null) {
    const old = JSON.parse(golden.cases[1].checkpoint),
      now = Date.now();
    old.accepted_at = stamp(now - priorAge);
    old.covers_after = stamp(now - 8 * DAY);
    for (const row of old.rows) {
      row[1] = stamp(now - 9 * DAY);
      row[3] = row[1];
    }
    prior = encode(old);
  }
  await object.bootstrap(prior);
  const now = await object.now(),
    pending = JSON.parse(golden.cases[0].checkpoint);
  pending.prepared_at = stamp(now - 120000);
  pending.covers_after = stamp(now - 2 * DAY);
  for (const row of pending.rows) {
    row[1] = stamp(now - 3 * DAY);
    row[3] = row[1];
  }
  if (prior) {
    const old = JSON.parse(new TextDecoder().decode(prior));
    pending.predecessor = {
      commit: old.accepted_commit,
      public_tree: old.public_tree,
      checkpoint_sha256: await sha(prior),
    };
  }
  const raw = encode(pending);
  expect(await object.stageSnapshot(raw.buffer, 3000000)).toBe("pending");
  const accepted = { ...pending, accepted_at: stamp(now - 60000), accepted_commit: "e".repeat(40) };
  for (const key of ["predecessor", "candidate_commit", "candidate_tree", "prepared_at"])
    delete accepted[key];
  return {
    object,
    accepted,
    options: {
      predecessor: pending.predecessor,
      generation: await sha(raw),
      checkedAt: stamp(now - 1000),
    },
  };
}
const promote = ({ object, accepted, options }) =>
  object.fetch(
    new Request("https://checkpoint.example.test/v1/checkpoint/promote", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + "B".repeat(43),
        "Content-Type": "application/octet-stream",
        "Follow-Pending-Generation": options.generation,
        "Follow-Predecessor": [
          options.predecessor.commit,
          options.predecessor.public_tree,
          options.predecessor.checkpoint_sha256 ?? "-",
        ].join(":"),
        "Follow-Checked-At": options.checkedAt,
      },
      body: encode(accepted),
    }),
  );

for (const priorAge of [null, DAY])
  test(`HTTP promotion preserves bytes and original replay deadline (${priorAge})`, async () => {
    const f = await setup(priorAge),
      before = await inspect(f.object);
    const physical = await env.SLOTS.head(`follow-checkpoint-slot-${before.pending.slot}`);
    await runInDurableObject(f.object, (i) => {
      i.slots.write = () => {
        throw new Error("promotion must not PUT");
      };
    });
    const response = await promote(f);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "promoted" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const after = await inspect(f.object);
    expect(after.accepted.replayUntil).toBe(
      Math.min(before.pending.expires, before.accepted?.expires ?? Infinity),
    );
    expect(new Uint8Array((await f.object.readSnapshot()).accepted)).toEqual(encode(f.accepted));
    expect((await env.SLOTS.head(`follow-checkpoint-slot-${before.pending.slot}`)).etag).toBe(
      physical.etag,
    );
    f.accepted.accepted_at = stamp((await f.object.now()) - 500);
    f.options.checkedAt = stamp(await f.object.now());
    expect(await (await promote(f)).json()).toEqual({ status: "already_promoted" });
    expect(await inspect(f.object)).toEqual(after);
    f.options.predecessor.commit = "f".repeat(40);
    expect((await promote(f)).status).toBe(409);
  });

for (const mismatch of [
  "generation",
  "predecessor",
  "publicTree",
  "payload",
  "futureCheck",
  "earlyCheck",
  "earlyAccepted",
])
  test(`HTTP promotion rejects ${mismatch} without changing control`, async () => {
    const f = await setup(),
      before = await inspect(f.object);
    if (mismatch === "generation") f.options.generation = "0".repeat(64);
    if (mismatch === "predecessor") f.options.predecessor.commit = "f".repeat(40);
    if (mismatch === "publicTree") f.accepted.public_tree = "f".repeat(40);
    if (mismatch === "payload") f.accepted.index_sha256 = "0".repeat(64);
    if (mismatch === "futureCheck") f.options.checkedAt = stamp((await f.object.now()) + DAY);
    if (mismatch === "earlyCheck") f.options.checkedAt = stamp((await f.object.now()) - DAY);
    if (mismatch === "earlyAccepted") f.accepted.accepted_at = stamp((await f.object.now()) - DAY);
    expect((await promote(f)).status).toBe(409);
    expect(await inspect(f.object)).toEqual(before);
  });

for (const fault of ["missing", "prepare-before", "prepare-after", "finish-before", "finish-after"])
  test(`promotion fails closed or proves exact lost acknowledgement (${fault})`, async () => {
    const f = await setup();
    await runInDurableObject(f.object, (i) => {
      if (fault === "missing") i.witness = null;
      else {
        const [step, timing] = fault.split("-");
        i.witness[step === "prepare" ? "failPrepare" : "failFinish"] = timing;
      }
    });
    const response = await promote(f);
    expect(response.status).toBe(fault === "finish-after" ? 200 : 503);
    if (fault === "finish-after")
      expect(await response.json()).toEqual({ status: "already_promoted" });
    if (fault === "finish-before") {
      await runInDurableObject(f.object, (i) => {
        i.witness.failFinish = null;
      });
      expect(await f.object.recoverAcknowledgement()).toBe("recovered");
      expect(await (await promote(f)).json()).toEqual({ status: "already_promoted" });
    }
  });

test("promotion CAS rechecks the actual SQLite clock at predecessor expiry", async () => {
  const f = await setup(7 * DAY - 6000),
    before = await inspect(f.object);
  await runInDurableObject(f.object, (i) => {
    i.beforeCommit = async () => {
      while (i.now() < i.state().accepted.expires)
        await new Promise((resolve) => setTimeout(resolve, 25));
    };
  });
  expect((await promote(f)).status).toBe(503);
  expect(await inspect(f.object)).toEqual(before);
  expect((await f.object.readSnapshot()).state).toBe("unavailable");
});

test("competing promotion and restored SQLite cannot bypass the external witness", async () => {
  const f = await setup(),
    before = await inspect(f.object);
  const responses = await Promise.all([promote(f), promote(f)]);
  expect(responses.some((r) => r.status === 200)).toBe(true);
  expect(responses.every((r) => [200, 503].includes(r.status))).toBe(true);
  expect(await (await promote(f)).json()).toEqual({ status: "already_promoted" });
  await runInDurableObject(f.object, (i) => i.save(before));
  expect((await promote(f)).status).toBe(503);
});

test("promotion copies caller bytes and options before awaiting validation", async () => {
  const f = await setup();
  await runInDurableObject(f.object, async (i) => {
    const body = encode(f.accepted),
      options = structuredClone(f.options);
    const result = i.promoteSnapshot(body.buffer, 3000000, options);
    body.fill(0);
    options.predecessor.commit = "f".repeat(40);
    options.generation = "0".repeat(64);
    expect(await result).toBe("promoted");
    expect(new Uint8Array((await i.readSnapshot()).accepted)).toEqual(encode(f.accepted));
  });
});

test("retired predecessor cleanup preserves replay identity and a newer pending candidate", async () => {
  const f = await setup(DAY);
  expect((await promote(f)).status).toBe(200);
  expect(await f.object.cleanupRetired()).toBe("committed");
  const accepted = (await inspect(f.object)).accepted;
  const next = {
    ...f.accepted,
    predecessor: {
      commit: f.accepted.accepted_commit,
      public_tree: f.accepted.public_tree,
      checkpoint_sha256: accepted.digest,
    },
    candidate_commit: "f".repeat(40),
    candidate_tree: "f".repeat(40),
    prepared_at: stamp((await f.object.now()) - 100),
  };
  delete next.accepted_at;
  delete next.accepted_commit;
  expect(await f.object.stageSnapshot(encode(next).buffer, 3000000)).toBe("pending");
  const before = await inspect(f.object);
  expect(await (await promote(f)).json()).toEqual({ status: "already_promoted" });
  expect(await inspect(f.object)).toEqual(before);
  f.options.predecessor.checkpoint_sha256 = "0".repeat(64);
  expect((await promote(f)).status).toBe(409);
  expect(await inspect(f.object)).toEqual(before);
});

test("failed native SQLite write rolls back promotion and leaves witness uncertainty closed", async () => {
  const f = await setup(),
    before = await inspect(f.object);
  await runInDurableObject(f.object, (i) => {
    i.ctx.storage.sql.exec(
      "CREATE TRIGGER reject_promotion BEFORE INSERT ON control BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    );
  });
  expect((await promote(f)).status).toBe(503);
  expect(await inspect(f.object)).toEqual(before);
  expect((await f.object.readSnapshot()).state).toBe("unavailable");
});

test("malformed completed replay metadata is unavailable, never accepted", async () => {
  const f = await setup();
  expect((await promote(f)).status).toBe(200);
  await runInDurableObject(f.object, (i) => {
    const state = i.state();
    state.accepted.promotionKey = [state.accepted.promotionKey];
    i.save(state);
  });
  expect((await f.object.readSnapshot()).state).toBe("unavailable");
  expect((await promote(f)).status).toBe(503);
});

test("same-target replay stops at the original predecessor cutoff", async () => {
  const f = await setup(7 * DAY - 6000);
  expect((await promote(f)).status).toBe(200);
  const before = await inspect(f.object);
  await runInDurableObject(f.object, async (i) => {
    while (i.now() < i.state().accepted.replayUntil)
      await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect((await promote(f)).status).toBe(409);
  expect(await inspect(f.object)).toEqual(before);
  expect(new Uint8Array((await f.object.readSnapshot()).accepted)).toEqual(encode(f.accepted));
});
