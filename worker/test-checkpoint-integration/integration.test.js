import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { createFollowCheckpointPayloadCodec } from "../src/follow-checkpoint-payload.js";
import { classifyFollowCheckpointWitness as classify } from "../src/follow-checkpoint-witness.js";

const DAY = 86_400_000;
const wire = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
const encoder = new TextEncoder();
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  return value && typeof value === "object"
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])]),
      )
    : value;
}
const bytes = (value) => encoder.encode(JSON.stringify(ordered(value)));
const hash = async (raw) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
const stub = () => env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
const inspect = (object) => runInDurableObject(object, (instance) => instance.state());
const etags = async () =>
  Promise.all(
    [0, 1].map(async (slot) => (await env.SLOTS.head(`follow-checkpoint-slot-${slot}`)).etag),
  );
beforeEach(async () => {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
});

async function records({
  old = false,
  pendingAge = 120000,
  acceptedAge = 60000,
  oldAge = 6 * DAY,
} = {}) {
  const now = Date.now();
  const pending = JSON.parse(golden.cases[0].checkpoint),
    accepted = JSON.parse(golden.cases[1].checkpoint);
  for (const value of [pending, accepted]) {
    value.covers_after = wire(now - 10 * DAY);
    for (const row of value.rows) {
      row[1] = wire(now - 9 * DAY).replace(/Z$/, "");
      row[3] = wire(now - 9 * DAY);
    }
  }
  pending.prepared_at = wire(now - pendingAge);
  accepted.accepted_at = wire(now - acceptedAge);
  let oldBytes = null;
  if (old) {
    const prior = structuredClone(accepted);
    prior.accepted_at = wire(now - oldAge);
    prior.accepted_commit = "a".repeat(40);
    prior.public_tree = "b".repeat(40);
    oldBytes = bytes(prior);
    pending.predecessor = {
      commit: prior.accepted_commit,
      public_tree: prior.public_tree,
      checkpoint_sha256: await hash(oldBytes),
    };
  }
  return {
    pending: bytes(pending),
    accepted: bytes(accepted),
    old: oldBytes,
    generation: await hash(bytes(pending)),
    now,
  };
}

test("native codec golden bytes and metadata-only promotion retain both raw R2 identities", async () => {
  const codec = createFollowCheckpointPayloadCodec({
    maxCheckpointBytes: 12000,
    maxPayloadBytes: 10000,
    maxHeaderBytes: 2000,
    maxRows: 5,
  });
  for (const row of golden.cases) {
    const parts = await codec.split(encoder.encode(row.checkpoint), row.phase);
    expect(
      (await codec.reassemble(parts.payload, parts.header, row.phase, row.sha256)).bytes,
    ).toEqual(encoder.encode(row.checkpoint));
  }
  const object = stub(),
    value = await records({ old: true, oldAge: 7 * DAY - 60000 });
  await object.initialize(value.pending, value.old);
  expect((await object.read("pending")).bytes).toEqual(value.pending);
  expect((await object.read("accepted")).bytes).toEqual(value.old);
  const before = await etags(),
    prior = await inspect(object);
  expect(await object.promote(value.accepted, value.generation)).toBe("committed");
  expect(await etags()).toEqual(before);
  expect((await object.read("accepted")).bytes).toEqual(value.accepted);
  const after = await inspect(object);
  expect(after.current.revision).toBe(prior.current.revision + 1);
  expect(after.retired.etag).toBe(prior.accepted.etag);
  expect(after.accepted.replayUntil).toBe(Math.min(prior.pending.expires, prior.accepted.expires));
  expect(after.accepted.replayUntil).toBe(prior.accepted.expires);
  expect(after.accepted.expires).toBe(value.now - 60000 + 7 * DAY);
  expect(JSON.stringify(after)).not.toContain('"rows"');
  const replay = await object.promote(value.accepted, value.generation);
  expect(replay).toBe("already_promoted");
  expect(await inspect(object)).toEqual(after);
  expect(await object.cleanupRetired()).toBe("committed");
  expect((await etags())[0]).toBe(before[0]);
  expect((await etags())[1]).not.toBe(before[1]);
  expect((await object.read("accepted")).bytes).toEqual(value.accepted);
  expect((await env.SLOTS.list()).objects).toHaveLength(2);
  expect((await SELF.fetch("https://local.invalid/")).status).toBe(404);
});

test("simulated pre-promotion SQLite rollback is held despite unchanged R2 objects", async () => {
  const object = stub(),
    value = await records({ old: true });
  await object.initialize(value.pending, value.old);
  const before = await runInDurableObject(object, (instance) => instance.snapshot()),
    slots = await etags();
  expect(await object.promote(value.accepted, value.generation)).toBe("committed");
  await runInDurableObject(object, (instance) => {
    instance.ctx.storage.sql.exec("UPDATE control SET metadata=?", before);
  });
  expect(await etags()).toEqual(slots);
  expect(
    await runInDurableObject(object, async (instance) =>
      classify(await instance.witness.read(), {
        current: instance.state().current,
        receipt: instance.state().receipt,
      }),
    ),
  ).toBe("rollback");
  expect((await object.read("accepted")).status).toBe("held");
  expect(await object.promote(value.accepted, value.generation)).toBe("held");
  expect(await object.cleanupRetired()).toBe("held");
  expect(await object.recoverAcknowledgement()).toBe("held");
});

test("committed promotion with lost witness acknowledgement requires exact explicit recovery", async () => {
  const object = stub(),
    value = await records();
  await object.initialize(value.pending);
  const slots = await etags();
  await runInDurableObject(object, (instance) => {
    instance.witness.failFinish = "before";
  });
  expect(await object.promote(value.accepted, value.generation)).toBe("held");
  expect((await object.read("accepted")).status).toBe("held");
  const committed = await inspect(object);
  expect(committed.accepted.digest).toBe(await hash(value.accepted));
  await runInDurableObject(object, (instance) => {
    instance.witness.failFinish = null;
  });
  expect(await object.recoverAcknowledgement()).toBe("recovered");
  expect(await inspect(object)).toEqual(committed);
  expect((await object.read("accepted")).bytes).toEqual(value.accepted);
  expect(await etags()).toEqual(slots);
});

test("lost prepare acknowledgement and rolled-back prepared predecessor stay ambiguous", async () => {
  const object = stub(),
    value = await records();
  await object.initialize(value.pending);
  const before = await inspect(object);
  await runInDurableObject(object, (instance) => {
    instance.witness.failPrepare = "after";
  });
  expect(await object.promote(value.accepted, value.generation)).toBe("held");
  expect(await inspect(object)).toEqual(before);
  expect(
    await runInDurableObject(object, async (instance) =>
      classify(await instance.witness.read(), {
        current: instance.state().current,
        receipt: instance.state().receipt,
      }),
    ),
  ).toBe("ambiguous_predecessor");
  expect(await object.recoverAcknowledgement()).toBe("held");
  expect((await object.read("pending")).status).toBe("held");
});

test("native SQLite cutoffs refuse expired pending, preserve live predecessor and fence cleanup", async () => {
  const object = stub(),
    value = await records({ old: true, pendingAge: DAY + 1000 });
  await object.initialize(value.pending, value.old);
  const before = await etags();
  expect((await object.read("pending")).status).toBe("expired");
  expect((await object.read("accepted")).bytes).toEqual(value.old);
  expect(await object.promote(value.accepted, value.generation)).toBe("stale");
  expect(await object.retireExpired("accepted")).toBe("stale");
  expect(await object.retireExpired("pending")).toBe("committed");
  expect(await object.cleanupRetired()).toBe("committed");
  expect((await etags())[0]).not.toBe(before[0]);
  expect((await etags())[1]).toBe(before[1]);
  expect((await object.read("accepted")).bytes).toEqual(value.old);
});

test("fresh native SQLite check blocks delayed read release at the original cutoff", async () => {
  const object = stub(),
    value = await records({ pendingAge: DAY - 4000 });
  await object.initialize(value.pending);
  await runInDurableObject(object, (instance) => {
    instance.beforeReadRelease = async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, instance.state().pending.expires - instance.now()) + 5),
      );
    };
  });
  expect((await object.read("pending")).status).toBe("held");
  expect(await object.promote(value.accepted, value.generation)).toBe("stale");
});

test("fresh native SQLite transaction blocks promotion crossing the original pending cutoff", async () => {
  const object = stub(),
    value = await records({ pendingAge: DAY - 4000 });
  await object.initialize(value.pending);
  const before = await inspect(object),
    slots = await etags();
  await runInDurableObject(object, (instance) => {
    instance.beforeCommit = async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, instance.state().pending.expires - instance.now()) + 5),
      );
    };
  });
  expect(await object.promote(value.accepted, value.generation)).toBe("held");
  expect(await inspect(object)).toEqual(before);
  expect(await etags()).toEqual(slots);
  expect((await object.read("pending")).status).toBe("held");
  expect(await object.recoverAcknowledgement()).toBe("held");
});

test("seven-day predecessor cutoff cannot promote or retire the live pending slot", async () => {
  const object = stub(),
    value = await records({ old: true, oldAge: 7 * DAY + 1000 });
  await object.initialize(value.pending, value.old);
  const before = await etags();
  expect((await object.read("accepted")).status).toBe("expired");
  expect((await object.read("pending")).bytes).toEqual(value.pending);
  expect(await object.promote(value.accepted, value.generation)).toBe("stale");
  expect(await object.retireExpired("accepted")).toBe("committed");
  expect(await object.cleanupRetired()).toBe("committed");
  expect((await etags())[0]).toBe(before[0]);
  expect((await etags())[1]).not.toBe(before[1]);
  expect((await object.read("pending")).bytes).toEqual(value.pending);
  expect(await object.promote(value.accepted, value.generation)).toBe("stale");
});

test("rollback after committed promotion but before witness finalization remains ambiguous", async () => {
  const object = stub(),
    value = await records();
  await object.initialize(value.pending);
  const previous = await runInDurableObject(object, (instance) => instance.snapshot());
  await runInDurableObject(object, (instance) => {
    instance.witness.failFinish = "before";
  });
  expect(await object.promote(value.accepted, value.generation)).toBe("held");
  await runInDurableObject(object, (instance) => {
    instance.ctx.storage.sql.exec("UPDATE control SET metadata=?", previous);
    instance.witness.failFinish = null;
  });
  expect(await object.recoverAcknowledgement()).toBe("held");
  expect((await object.read("pending")).status).toBe("held");
});

test("a lost stable acknowledgement never repeats promotion or extends expiry", async () => {
  const object = stub(),
    value = await records();
  await object.initialize(value.pending);
  await runInDurableObject(object, (instance) => {
    instance.witness.failFinish = "after";
  });
  expect(await object.promote(value.accepted, value.generation)).toBe("held");
  const committed = await inspect(object);
  expect((await object.read("accepted")).bytes).toEqual(value.accepted);
  expect(await object.promote(value.accepted, value.generation)).toBe("already_promoted");
  expect(await inspect(object)).toEqual(committed);
});

test("closed or missing external witness prevents reads and physical slot retirement", async () => {
  const object = stub(),
    value = await records({ old: true });
  await object.initialize(value.pending, value.old);
  await object.promote(value.accepted, value.generation);
  const before = await etags();
  await runInDurableObject(object, (instance) => {
    instance.witness.value.phase = "closed";
  });
  expect((await object.read("accepted")).status).toBe("held");
  expect(await object.cleanupRetired()).toBe("held");
  expect(await etags()).toEqual(before);
  await runInDurableObject(object, (instance) => {
    instance.witness = null;
  });
  expect((await object.read("accepted")).status).toBe("held");
});

test("microsecond start/expiry rounding and wrong generations preserve original control", async () => {
  const object = stub(),
    value = await records();
  const pending = JSON.parse(new TextDecoder().decode(value.pending));
  const accepted = JSON.parse(new TextDecoder().decode(value.accepted));
  pending.prepared_at = pending.prepared_at.slice(0, -7) + "123456Z";
  accepted.accepted_at = accepted.accepted_at.slice(0, -7) + "456789Z";
  const pendingBytes = bytes(pending),
    acceptedBytes = bytes(accepted),
    generation = await hash(pendingBytes);
  await object.initialize(pendingBytes);
  const before = await inspect(object),
    slots = await etags();
  const floor = Date.parse(pending.prepared_at.slice(0, -4) + "Z");
  expect(before.pending.starts).toBe(floor + 1);
  expect(before.pending.expires).toBe(floor + DAY);
  expect(await object.promote(acceptedBytes, "0".repeat(64))).toBe("stale");
  const altered = structuredClone(accepted);
  altered.rows.pop();
  expect(await object.promote(bytes(altered), generation)).toBe("stale");
  expect(await inspect(object)).toEqual(before);
  expect(await etags()).toEqual(slots);
  expect(await object.promote(acceptedBytes, generation)).toBe("committed");
  const after = await inspect(object),
    acceptedFloor = Date.parse(accepted.accepted_at.slice(0, -4) + "Z");
  expect(after.accepted.starts).toBe(acceptedFloor + 1);
  expect(after.accepted.expires).toBe(acceptedFloor + 7 * DAY);
});
