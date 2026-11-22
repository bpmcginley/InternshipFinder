import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { WitnessDouble } from "./worker.js";

const DAY = 86_400_000;
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
const stamp = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
const post = (object, raw) =>
  object.fetch(
    new Request("https://checkpoint.example.test/v1/checkpoint/stage", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + "A".repeat(43),
        "Content-Type": "application/octet-stream",
      },
      body: raw,
    }),
  );
async function setup(age = 1000, withAccepted = false) {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  let prior = null;
  if (withAccepted) {
    const accepted = JSON.parse(golden.cases[1].checkpoint),
      at = Date.now();
    accepted.accepted_at = stamp(at - DAY);
    accepted.covers_after = stamp(at - 2 * DAY);
    for (const row of accepted.rows) {
      row[1] = stamp(at - 3 * DAY);
      row[3] = stamp(at - 3 * DAY);
    }
    prior = encode(accepted);
  }
  await object.bootstrap(prior);
  const now = await object.now(),
    value = JSON.parse(golden.cases[0].checkpoint);
  value.covers_after = stamp(now - 2 * DAY);
  for (const row of value.rows) {
    row[1] = stamp(now - 3 * DAY);
    row[3] = stamp(now - 3 * DAY);
  }
  value.prepared_at = stamp(now - age);
  if (prior) {
    const accepted = JSON.parse(new TextDecoder().decode(prior));
    value.predecessor = {
      commit: accepted.accepted_commit,
      public_tree: accepted.public_tree,
      checkpoint_sha256: Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", prior)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join(""),
    };
  }
  await runInDurableObject(object, (i) => {
    const write = i.slots.write;
    i.payloadWrites = 0;
    i.slots.write = (...args) => {
      if (args[2].kind === "payload") i.payloadWrites++;
      return write(...args);
    };
  });
  return { object, raw: encode(value) };
}
const inspect = (object) =>
  runInDurableObject(object, (i) => ({ state: i.state(), writes: i.payloadWrites }));

test("actual HTTP stage commits exact bytes once and replays without a new upload", async () => {
  const { object, raw } = await setup();
  const response = await post(object, raw);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "pending" });
  const before = await inspect(object);
  expect(before.writes).toBe(1);
  expect(before.state.reservation).toBeNull();
  expect(JSON.stringify(before.state)).not.toContain('"rows"');
  const replay = await post(object, raw);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ status: "already_pending" });
  expect(await inspect(object)).toEqual(before);
  const get = await object.fetch(
    new Request("https://checkpoint.example.test/v1/checkpoint", {
      headers: { Authorization: "Bearer " + "A".repeat(43) },
    }),
  );
  expect(new Uint8Array(await get.arrayBuffer())).toEqual(raw);
});

test("competing HTTP candidates preserve one exact reservation and a single payload upload", async () => {
  const { object, raw } = await setup();
  const changed = JSON.parse(new TextDecoder().decode(raw));
  changed.candidate_commit = "d".repeat(40);
  const bodies = [raw, encode(changed)];
  const results = await Promise.all(bodies.map((body) => post(object, body)));
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(results.every((r) => [200, 409, 503].includes(r.status))).toBe(true);
  const winner = results.findIndex((r) => r.status === 200);
  expect((await inspect(object)).writes).toBe(1);
  expect(new Uint8Array((await object.readSnapshot()).pending)).toEqual(bodies[winner]);
  expect((await post(object, bodies[1 - winner])).status).toBe(409);
});

for (const stored of [true, false])
  test(`ambiguous upload reconciles only physical evidence (stored=${stored})`, async () => {
    const { object, raw } = await setup();
    await runInDurableObject(object, (i) => {
      const write = i.slots.write;
      i.slots.write = async (...args) => {
        if (stored) await write(...args);
        else i.payloadWrites++;
        return { status: "uncertain" };
      };
    });
    const result = await post(object, raw);
    expect(result.status).toBe(stored ? 200 : 503);
    const first = await inspect(object);
    expect(first.writes).toBe(1);
    expect((await post(object, raw)).status).toBe(stored ? 200 : 503);
    expect(await inspect(object)).toEqual(first);
  });

test("restart after uploaded bytes reconciles exact receipt without replaying PUT", async () => {
  const { object, raw } = await setup();
  const reservation = await object.reservePending(raw);
  expect(reservation.status).toBe("reserved");
  expect(await object.uploadReserved(reservation.nonce)).toBe("stored");
  const before = await inspect(object);
  const external = await runInDurableObject(object, (i) => i.witness.read());
  const physical = await env.SLOTS.head("follow-checkpoint-slot-0");
  await evictDurableObject(object);
  await runInDurableObject(object, (i) => {
    i.witness = new WitnessDouble(external.current);
    i.witness.value = external;
    i.slots.write = () => {
      throw new Error("A retry must never PUT");
    };
  });
  const reply = await post(object, raw);
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({ status: "already_pending" });
  expect((await object.read("pending")).bytes).toEqual(raw);
  const after = await inspect(object);
  expect(after.state.pending.expires).toBe(before.state.reservation.expires);
  expect(after.state.pending.starts).toBe(before.state.reservation.starts);
  expect((await env.SLOTS.head("follow-checkpoint-slot-0")).etag).toBe(physical.etag);
});

for (const fault of ["missing", "prepare-before", "prepare-after", "finish-before", "finish-after"])
  test(`HTTP stage holds unresolved witness ${fault} without payload writes`, async () => {
    const { object, raw } = await setup();
    await runInDurableObject(object, (i) => {
      if (fault === "missing") i.witness = null;
      else {
        const [step, timing] = fault.split("-");
        i.witness[step === "prepare" ? "failPrepare" : "failFinish"] = timing;
      }
    });
    expect((await post(object, raw)).status).toBe(503);
    expect((await post(object, raw)).status).toBe(503);
    expect((await inspect(object)).writes).toBe(0);
    expect((await object.readSnapshot()).pending).toBeUndefined();
  });

for (const age of [DAY + 1000, -60000])
  test(`original pending time is never refreshed (age=${age})`, async () => {
    const { object, raw } = await setup(age);
    expect((await post(object, raw)).status).toBe(409);
    const result = await inspect(object);
    expect(result.writes).toBe(0);
    expect(result.state.reservation).toBeNull();
    expect(result.state.pending).toBeNull();
  });

test("late physical upload is fenced after original cutoff, never acknowledged pending", async () => {
  const { object, raw } = await setup(DAY - 6000);
  await runInDurableObject(object, (i) => {
    i.beforeUpload = async () => {
      const expires = i.state().reservation.cutoff;
      while (i.now() < expires) await new Promise((resolve) => setTimeout(resolve, 25));
    };
  });
  expect((await post(object, raw)).status).toBe(503);
  const after = await inspect(object);
  expect(after.state.pending).toBeNull();
  expect(after.state.reservation).toBeNull();
  expect(await runInDurableObject(object, async (i) => (await i.slots.read(0)).kind)).toBe(
    "tombstone",
  );
  expect((await post(object, raw)).status).toBe(409);
});

test("stage copies input before awaiting the canonical codec", async () => {
  const { object, raw } = await setup();
  await runInDurableObject(object, async (i) => {
    const original = new Uint8Array(raw),
      body = new Uint8Array(raw);
    const result = i.stageSnapshot(body.buffer);
    body.fill(0);
    expect(await result).toBe("pending");
    expect(new Uint8Array((await i.readSnapshot()).pending)).toEqual(original);
  });
});

test("stage authorization and canonical body checks precede any reservation", async () => {
  const { object, raw } = await setup();
  const before = await inspect(object);
  const forbidden = await object.fetch(
    new Request("https://checkpoint.example.test/v1/checkpoint/stage", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + "B".repeat(43),
        "Content-Type": "application/octet-stream",
      },
      body: raw,
    }),
  );
  expect(forbidden.status).toBe(403);
  expect((await post(object, new TextEncoder().encode("{}"))).status).toBe(400);
  expect(await inspect(object)).toEqual(before);
});

test("concurrent identical stages use one payload envelope and repeat idempotently", async () => {
  const { object, raw } = await setup();
  const responses = await Promise.all([post(object, raw), post(object, raw)]);
  expect(responses.some((r) => r.status === 200)).toBe(true);
  expect(responses.every((r) => [200, 503].includes(r.status))).toBe(true);
  expect((await inspect(object)).writes).toBe(1);
  const replay = await post(object, raw);
  expect(await replay.json()).toEqual({ status: "already_pending" });
  expect((await inspect(object)).writes).toBe(1);
});

test("active accepted predecessor is preserved while its exact successor stages", async () => {
  const { object, raw } = await setup(1000, true);
  const before = await object.readSnapshot();
  expect(before.state).toBe("active");
  const response = await post(object, raw);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "pending" });
  const after = await object.readSnapshot();
  expect(after.accepted).toEqual(before.accepted);
  expect(new Uint8Array(after.pending)).toEqual(raw);
  expect((await inspect(object)).writes).toBe(1);
});

test("lost reconciliation acknowledgement succeeds only from exact committed readback", async () => {
  const { object, raw } = await setup();
  await runInDurableObject(object, (i) => {
    const reconcile = i.reservations.reconcileReserved;
    i.reservations.reconcileReserved = async (nonce) => {
      await reconcile(nonce);
      throw new Error("lost acknowledgement");
    };
  });
  const response = await post(object, raw);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "pending" });
  expect(new Uint8Array((await object.readSnapshot()).pending)).toEqual(raw);
  const replay = await post(object, raw);
  expect(await replay.json()).toEqual({ status: "already_pending" });
  expect((await inspect(object)).writes).toBe(1);
});
