import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { createFollowCheckpointRuntime } from "../src/follow-checkpoint-runtime.js";

const DAY = 86400000,
  encode = new TextEncoder();
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
const bytes = (v) => encode.encode(JSON.stringify(ordered(v)));
const hash = async (v) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", v)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
const state = (object) => runInDurableObject(object, (i) => i.state());
const physical = () =>
  Promise.all(
    [0, 1].map(async (n) => {
      const value = await env.SLOTS.get(`follow-checkpoint-slot-${n}`);
      return { etag: value.etag, bytes: Array.from(new Uint8Array(await value.arrayBuffer())) };
    }),
  );
const reject = (object, generation) =>
  object.fetch(
    new Request("https://checkpoint.example.test/v1/checkpoint/reject", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + "A".repeat(43),
        "Follow-Pending-Generation": generation,
      },
    }),
  );
beforeEach(async () => {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
});
async function fixture(prior = false) {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId()),
    now = Date.now();
  const pending = JSON.parse(golden.cases[0].checkpoint),
    accepted = JSON.parse(golden.cases[1].checkpoint);
  for (const v of [pending, accepted]) {
    v.covers_after = wire(now - 10 * DAY);
    for (const row of v.rows) {
      row[1] = wire(now - 9 * DAY).replace(/Z$/, "");
      row[3] = wire(now - 9 * DAY);
    }
  }
  pending.prepared_at = wire(now - 60000);
  accepted.accepted_at = wire(now - 6 * DAY);
  accepted.accepted_commit = "a".repeat(40);
  accepted.public_tree = "b".repeat(40);
  if (prior)
    pending.predecessor = {
      commit: accepted.accepted_commit,
      public_tree: accepted.public_tree,
      checkpoint_sha256: await hash(bytes(accepted)),
    };
  await object.initialize(bytes(pending), prior ? bytes(accepted) : null);
  return { object, pending, generation: await hash(bytes(pending)) };
}

test("actual HTTP rejection retires only exact pending metadata, preserving accepted and physical bytes", async () => {
  const { object, generation } = await fixture(true),
    before = await state(object),
    slots = await physical();
  const response = await reject(object, generation);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "rejected" });
  const after = await state(object);
  expect(after.accepted).toEqual(before.accepted);
  expect(after.initialized).toBe(true);
  expect(after.pending).toBeNull();
  expect(after.retired).toEqual({
    slot: before.pending.slot,
    nonce: before.pending.nonce,
    etag: before.pending.etag,
    expires: before.pending.expires,
  });
  expect(after.current.revision).toBe(before.current.revision + 1);
  expect(await physical()).toEqual(slots);
  expect((await reject(object, generation)).status).toBe(409);
  expect(await state(object)).toEqual(after);
  expect((await object.readSnapshot()).state).toBe("active");
});

test("wrong generation, missing pending and occupied retired slot are known stale without writes", async () => {
  const { object, generation } = await fixture(),
    before = await state(object),
    slots = await physical();
  expect((await reject(object, "0".repeat(64))).status).toBe(409);
  expect(await state(object)).toEqual(before);
  await runInDurableObject(object, async (i) => {
    const empty = await i.slots.read(1);
    expect(
      await i.change((s) => {
        s.retired = { slot: 1, etag: empty.etag, nonce: empty.nonce, expires: i.now() };
        return true;
      }),
    ).toBe("committed");
  });
  const occupied = await state(object);
  expect((await reject(object, generation)).status).toBe(409);
  expect(await state(object)).toEqual(occupied);
  expect(await physical()).toEqual(slots);
});

test("initialized empty pending is known stale", async () => {
  const generation = "a".repeat(64);
  const empty = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await empty.bootstrap();
  expect((await reject(empty, generation)).status).toBe(409);
});

test("expired pending uses actual SQLite cutoff and retains only the original retired descriptor", async () => {
  const { object, pending } = await fixture();
  pending.prepared_at = wire((await object.now()) - DAY - 1);
  const raw = bytes(pending);
  await runInDurableObject(object, async (i) => {
    const expired = (await i.descriptor(raw, "pending", 0)).record;
    expect(
      await i.change((s) => {
        s.pending = { ...s.pending, ...expired };
        return true;
      }),
    ).toBe("committed");
  });
  const before = await state(object),
    slots = await physical();
  expect((await reject(object, before.pending.digest)).status).toBe(409);
  expect(await object.retireExpired("pending")).toBe("committed");
  expect(await object.retireExpired("pending")).toBe("stale");
  expect((await state(object)).retired.expires).toBe(before.pending.expires);
  expect(await physical()).toEqual(slots);
});

for (const fault of ["before", "after"])
  test(`lost finish acknowledgement ${fault} is HTTP unavailable, never stale or retried`, async () => {
    const { object, generation } = await fixture(),
      slots = await physical();
    await runInDurableObject(object, (i) => {
      i.witness.failFinish = fault;
    });
    expect((await reject(object, generation)).status).toBe(503);
    const committed = await state(object);
    expect(committed.pending).toBeNull();
    expect(committed.retired).not.toBeNull();
    expect(await physical()).toEqual(slots);
    expect((await reject(object, generation)).status).toBe(fault === "before" ? 503 : 409);
    expect(await state(object)).toEqual(committed);
    if (fault === "before") {
      await runInDurableObject(object, (i) => {
        i.witness.failFinish = null;
      });
      expect(await object.recoverAcknowledgement()).toBe("recovered");
      expect((await reject(object, generation)).status).toBe(409);
    }
  });

test("unavailable authority and malformed descriptors cannot prepare or retire", async () => {
  const { object, generation } = await fixture();
  const result = await runInDurableObject(object, async (i) => {
    const original = i.snapshot();
    let prepared = 0;
    const prepare = i.witness.prepare.bind(i.witness);
    i.witness.prepare = (...args) => {
      prepared++;
      return prepare(...args);
    };
    for (const mutate of [
      (s) => {
        s.pending.expires = "1";
      },
      (s) => {
        s.pending.slot = 3;
      },
      (s) => {
        s.pending.header = "{}";
      },
      (s) => {
        s.pending.digest = null;
      },
      (s) => {
        s.pending.starts = -1;
      },
    ]) {
      const s = JSON.parse(original);
      mutate(s);
      i.save(s);
      await expect(i.runtime.rejectPending(generation)).rejects.toThrow("unavailable");
      expect(await i.retireExpired("pending")).toBe("held");
    }
    i.save(JSON.parse(original));
    i.witness.value.phase = "closed";
    await expect(i.runtime.rejectPending(generation)).rejects.toThrow("unavailable");
    return prepared;
  });
  expect(result).toBe(0);
});

test("pre-commit generation replacement holds and preserves the replacement", async () => {
  const { object, generation } = await fixture();
  await runInDurableObject(object, (i) => {
    i.beforeCommit = () => {
      const s = i.state();
      s.pending.digest = "e".repeat(64);
      i.save(s);
    };
  });
  const slots = await physical();
  expect((await reject(object, generation)).status).toBe(503);
  const after = await state(object);
  expect(after.pending.digest).toBe("e".repeat(64));
  expect(after.retired).toBeNull();
  expect(await physical()).toEqual(slots);
});

test("disabled runtime and invalid generation/phase preserve zero dependency access", async () => {
  let calls = 0;
  const options = {};
  for (const k of ["control", "slots", "witness", "codec"])
    Object.defineProperty(options, k, {
      get() {
        calls++;
        throw Error("closed");
      },
    });
  const closed = createFollowCheckpointRuntime(options);
  await expect(closed.rejectPending("a".repeat(64))).rejects.toThrow("unavailable");
  expect(await closed.retireExpired("pending")).toBe("held");
  expect(calls).toBe(0);
  const { object } = await fixture();
  await runInDurableObject(object, async (i) => {
    i.control.capture = () => {
      throw Error("must not capture");
    };
    await expect(i.runtime.rejectPending(["a".repeat(64)])).rejects.toThrow("unavailable");
    expect(await i.retireExpired("other")).toBe("held");
  });
});

for (const fault of ["before", "after"])
  test(`lost prepare acknowledgement ${fault} leaves logical and physical state unchanged`, async () => {
    const { object, generation } = await fixture(),
      before = await state(object),
      slots = await physical();
    await runInDurableObject(object, (i) => {
      i.witness.failPrepare = fault;
    });
    expect((await reject(object, generation)).status).toBe(503);
    expect(await state(object)).toEqual(before);
    expect(await physical()).toEqual(slots);
  });

test("slot collision and contradictory predecessor are unavailable before witness prepare", async () => {
  const { object, generation } = await fixture(true);
  await runInDurableObject(object, async (i) => {
    const before = i.state();
    let calls = 0;
    i.witness.prepare = () => {
      calls++;
      throw Error("must not prepare");
    };
    for (const collision of [true, false]) {
      const s = structuredClone(before);
      if (collision) s.pending.slot = s.accepted.slot;
      else {
        const header = JSON.parse(s.pending.header);
        header.predecessor.commit = "e".repeat(40);
        s.pending.header = JSON.stringify(ordered(header));
      }
      i.save(s);
      await expect(i.runtime.rejectPending(generation)).rejects.toThrow("unavailable");
    }
    expect(calls).toBe(0);
  });
});

test("rejection crossing actual SQLite expiry after witness prepare holds without logical deletion", async () => {
  const { object, pending } = await fixture();
  pending.prepared_at = wire((await object.now()) - DAY + 2000);
  const raw = bytes(pending);
  await runInDurableObject(object, async (i) => {
    const next = (await i.descriptor(raw, "pending", 0)).record;
    expect(
      await i.change((s) => {
        s.pending = { ...s.pending, ...next };
        return true;
      }),
    ).toBe("committed");
    i.beforeCommit = async () => {
      expect(i.now()).toBeLessThan(next.expires);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, next.expires - i.now()) + 10));
    };
  });
  const before = await state(object),
    slots = await physical();
  expect((await reject(object, before.pending.digest)).status).toBe(503);
  expect(await state(object)).toEqual(before);
  expect(await physical()).toEqual(slots);
  expect((await reject(object, before.pending.digest)).status).toBe(503);
});

test("changed metadata between capture and authority admission is held, not reported stale", async () => {
  const { object, generation } = await fixture();
  await runInDurableObject(object, (i) => {
    const change = i.control.change.bind(i.control);
    i.control.change = (...args) => {
      const s = i.state();
      s.pending.header = "{}";
      i.save(s);
      return change(...args);
    };
    i.witness.prepare = () => {
      throw Error("must not prepare");
    };
  });
  expect((await reject(object, generation)).status).toBe(503);
});
