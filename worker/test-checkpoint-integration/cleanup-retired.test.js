import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { WitnessDouble } from "./worker.js";
import { createFollowCheckpointRuntime } from "../src/follow-checkpoint-runtime.js";
const DAY = 86400000,
  encoder = new TextEncoder();
const wire = (n) => new Date(n).toISOString().replace("Z", "000Z");
const ordered = (v) =>
  Array.isArray(v)
    ? v.map(ordered)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, ordered(v[k])]),
        )
      : v;
const state = (object) => runInDurableObject(object, (i) => i.state());
const physical = () =>
  Promise.all(
    [0, 1].map(async (n) => {
      const o = await env.SLOTS.get(`follow-checkpoint-slot-${n}`);
      return o ? { etag: o.etag, bytes: Array.from(new Uint8Array(await o.arrayBuffer())) } : null;
    }),
  );
beforeEach(async () => {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
});
async function fixture() {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId()),
    now = Date.now();
  const pending = JSON.parse(golden.cases[0].checkpoint);
  pending.prepared_at = wire(now - 10000);
  pending.covers_after = wire(now - 10 * DAY);
  for (const row of pending.rows) {
    row[1] = wire(now - 9 * DAY).replace(/Z$/, "");
    row[3] = wire(now - 9 * DAY);
  }
  await object.initialize(encoder.encode(JSON.stringify(ordered(pending))));
  await runInDurableObject(object, async (i) => {
    expect(await i.runtime.rejectPending(i.state().pending.digest)).toBe(true);
    i.cleanupWrites = 0;
    i.preparedReads = 0;
    const read = i.witness.read.bind(i.witness);
    i.witness.read = async () => {
      const value = await read();
      if (value.phase === "prepared") i.preparedReads++;
      return value;
    };
    const write = i.slots.write;
    i.slots.write = (...args) => {
      i.cleanupWrites++;
      return write(...args);
    };
  });
  return object;
}
const writes = (object) => runInDurableObject(object, (i) => i.cleanupWrites);

test("normal conditional tombstone clears only retired metadata after verified readback", async () => {
  const object = await fixture(),
    before = await state(object),
    slots = await physical();
  expect(await object.cleanupRetired()).toBe("committed");
  const after = await state(object),
    next = await physical();
  expect(after.retired).toBeNull();
  expect(after.current.revision).toBe(before.current.revision + 1);
  expect(after.accepted).toEqual(before.accepted);
  expect(after.initialized).toBe(before.initialized);
  expect(next[1]).toEqual(slots[1]);
  expect(next[0].etag).not.toBe(slots[0].etag);
  await runInDurableObject(object, async (i) => {
    const tombstone = await i.slots.read(0);
    expect(tombstone.kind).toBe("tombstone");
    expect(tombstone.payload.byteLength).toBe(0);
    expect(tombstone.nonce).not.toBe(before.retired.nonce);
    expect((await i.witness.read()).phase).toBe("stable");
    expect(i.preparedReads).toBe(2);
  });
  expect(await writes(object)).toBe(1);
  expect(await object.cleanupRetired()).toBe("held");
  expect(await writes(object)).toBe(1);
});

for (const kind of ["missing", "replacement", "wrong-nonce", "wrong-etag"])
  test(`physical ${kind} fails before witness prepare or PUT`, async () => {
    const object = await fixture();
    if (kind === "missing") await env.SLOTS.delete("follow-checkpoint-slot-0");
    await runInDurableObject(object, async (i) => {
      if (kind === "replacement") {
        const old = i.state().retired;
        expect((await i.slots.write(0, old.etag, await i.slots.tombstone())).status).toBe("stored");
        i.cleanupWrites = 0;
      }
      if (kind.startsWith("wrong-")) {
        const read = i.slots.read;
        i.slots.read = async (...args) => {
          const r = await read(...args);
          return {
            ...r,
            ...(kind === "wrong-nonce" ? { nonce: "e".repeat(32) } : { etag: "wrong" }),
          };
        };
      }
      i.witness.prepare = () => {
        throw Error("unexpected prepare");
      };
    });
    const before = await state(object),
      slots = await physical();
    expect(await object.cleanupRetired()).toBe("held");
    expect(await writes(object)).toBe(0);
    expect(await state(object)).toEqual(before);
    expect(await physical()).toEqual(slots);
  });

test("concurrent cleanup contenders produce one conditional PUT and one metadata successor", async () => {
  const object = await fixture(),
    before = await state(object);
  const results = await Promise.all([object.cleanupRetired(), object.cleanupRetired()]);
  expect(results.sort()).toEqual(["committed", "held"]);
  expect(await writes(object)).toBe(1);
  expect((await state(object)).current.revision).toBe(before.current.revision + 1);
});

test("same pinned witness changed after prepare cannot authorize physical effect", async () => {
  const object = await fixture(),
    before = await state(object),
    slots = await physical();
  const result = await runInDurableObject(object, async (i) => {
    const a = i.witness,
      b = new WitnessDouble(i.state().current);
    let calls = 0;
    const prepare = b.prepare.bind(b);
    b.prepare = async (...args) => {
      const result = await prepare(...args);
      b.value.intent.nonce = "e".repeat(32);
      return result;
    };
    i.control.witness = () => (++calls === 1 ? a : b);
    return { result: await i.cleanupRetired(), calls };
  });
  expect(result).toEqual({ result: "held", calls: 2 });
  expect(await writes(object)).toBe(0);
  expect(await state(object)).toEqual(before);
  expect(await physical()).toEqual(slots);
});

for (const mode of ["uncertain", "throw"])
  test(`physically committed ${mode} PUT acknowledgement remains held without replay`, async () => {
    const object = await fixture(),
      before = await state(object);
    await runInDurableObject(object, (i) => {
      const write = i.slots.write;
      i.slots.write = async (...args) => {
        const result = await write(...args);
        expect(result.status).toBe("stored");
        if (mode === "throw") throw Error("lost acknowledgement");
        return { status: "uncertain" };
      };
    });
    expect(await object.cleanupRetired()).toBe("held");
    expect(await writes(object)).toBe(1);
    expect(await state(object)).toEqual(before);
    const slots = await physical();
    expect(await object.cleanupRetired()).toBe("held");
    expect(await writes(object)).toBe(1);
    expect(await physical()).toEqual(slots);
    expect(await object.recoverAcknowledgement()).toBe("held");
    await evictDurableObject(object);
    expect(await object.cleanupRetired()).toBe("held");
    expect(await physical()).toEqual(slots);
  });

for (const fault of ["before", "after"])
  test(`witness finish ${fault} loss never repeats physical cleanup`, async () => {
    const object = await fixture();
    await runInDurableObject(object, (i) => {
      i.witness.failFinish = fault;
    });
    expect(await object.cleanupRetired()).toBe("held");
    expect(await writes(object)).toBe(1);
    expect((await state(object)).retired).toBeNull();
    const slots = await physical();
    expect(await object.cleanupRetired()).toBe("held");
    expect(await writes(object)).toBe(1);
    expect(await physical()).toEqual(slots);
  });

test("authority changed after tombstone readback holds metadata and cannot replay", async () => {
  const object = await fixture(),
    before = await state(object);
  await runInDurableObject(object, (i) => {
    const read = i.slots.read;
    let reads = 0;
    i.slots.read = async (...args) => {
      const result = await read(...args);
      if (++reads === 3) i.witness.value.intent.nonce = "e".repeat(32);
      return result;
    };
  });
  expect(await object.cleanupRetired()).toBe("held");
  expect(await writes(object)).toBe(1);
  expect(await state(object)).toEqual(before);
  expect(await object.cleanupRetired()).toBe("held");
  expect(await writes(object)).toBe(1);
});

test("metadata race before conditional effect is held with no write", async () => {
  const object = await fixture();
  await runInDurableObject(object, (i) => {
    const read = i.slots.read;
    let reads = 0;
    i.slots.read = async (...args) => {
      const result = await read(...args);
      if (++reads === 2) {
        const s = i.state();
        s.retired.etag = "changed";
        i.save(s);
      }
      return result;
    };
  });
  const slots = await physical();
  expect(await object.cleanupRetired()).toBe("held");
  expect(await writes(object)).toBe(0);
  expect(await physical()).toEqual(slots);
  expect((await state(object)).retired.etag).toBe("changed");
});

test("default closed and malformed retirement metadata cannot reach slots", async () => {
  let calls = 0;
  const options = {};
  for (const k of ["control", "slots", "witness"])
    Object.defineProperty(options, k, {
      get() {
        calls++;
        throw Error("closed");
      },
    });
  expect(await createFollowCheckpointRuntime(options).cleanupRetired()).toBe("held");
  expect(calls).toBe(0);
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const s = i.state();
    s.retired.slot = 2;
    i.save(s);
    i.slots.read = () => {
      throw Error("must not read");
    };
    expect(await i.cleanupRetired()).toBe("held");
    expect(i.cleanupWrites).toBe(0);
  });
});
