import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { WitnessDouble } from "./worker.js";

const DAY = 86_400_000,
  key = "follow-checkpoint-slot-0";
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
async function setup() {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await object.bootstrap();
  // Exclude cold native storage startup from this deliberately short real lifetime.
  const value = JSON.parse(golden.cases[0].checkpoint),
    now = await runInDurableObject(object, (i) => i.now());
  value.prepared_at = new Date(now - DAY + 2000).toISOString().replace("Z", "000Z");
  value.covers_after = new Date(now - 2 * DAY).toISOString().replace("Z", "000Z");
  const { status, nonce } = await object.reservePending(
    new TextEncoder().encode(JSON.stringify(ordered(value))),
  );
  expect(status).toBe("reserved");
  const before = await state(object);
  const remaining = await runInDurableObject(
    object,
    (i) => i.state().reservation.expires - i.now(),
  );
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 10));
  expect(await runInDurableObject(object, (i) => i.now())).toBeGreaterThanOrEqual(
    before.reservation.expires,
  );
  return { object, nonce, before };
}
async function restart(object) {
  const retained = await runInDurableObject(object, async (i) => ({
    value: await i.witness.read(),
    cleanup: await i.witness.readCleanup(),
  }));
  await evictDurableObject(object);
  expect(await object.recoverCleanup()).toBe("held");
  await runInDurableObject(object, (i) => {
    i.witness = new WitnessDouble(retained.value.current);
    i.witness.value = retained.value;
    i.witness.cleanup = retained.cleanup;
    expect(i.uploads.size).toBe(0);
  });
  return retained;
}

test.each(["lost-write", "before-sql"])(
  "recovery preserves original cutoff after predecessor physical cleanup (%s)",
  async (point) => {
    const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId()),
      now = await runInDurableObject(object, (i) => i.now()),
      wire = (ms) => new Date(ms).toISOString().replace("Z", "000Z"),
      bytes = (value) => new TextEncoder().encode(JSON.stringify(ordered(value))),
      accepted = JSON.parse(golden.cases[1].checkpoint),
      pending = JSON.parse(golden.cases[0].checkpoint);
    for (const value of [accepted, pending]) {
      value.covers_after = wire(now - 10 * DAY);
      for (const row of value.rows) {
        row[1] = wire(now - 9 * DAY).replace(/Z$/, "");
        row[3] = wire(now - 9 * DAY);
      }
    }
    accepted.accepted_at = wire(now - 7 * DAY + 2000);
    pending.prepared_at = wire(now - 1000);
    const acceptedBytes = bytes(accepted);
    pending.predecessor = {
      commit: accepted.accepted_commit,
      public_tree: accepted.public_tree,
      checkpoint_sha256: Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", acceptedBytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join(""),
    };
    await object.bootstrap(acceptedBytes);
    const reserved = await object.reservePending(bytes(pending));
    expect(reserved.status).toBe("reserved");
    const before = await state(object),
      originalCutoff = before.accepted.expires,
      originalPendingExpiry = before.reservation.expires,
      remaining = await runInDurableObject(object, (i) => originalCutoff - i.now());
    expect(originalCutoff).toBeLessThan(originalPendingExpiry);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 10));
    expect(await object.retireExpired("accepted")).toBe("committed");
    expect(await object.cleanupRetired()).toBe("committed");
    const cleaned = await state(object);
    expect(cleaned.accepted).toBeNull();
    expect(cleaned.retired).toBeNull();
    expect(cleaned.reservation).toEqual(before.reservation);
    expect((await runInDurableObject(object, (i) => i.slots.read(1))).kind).toBe("tombstone");
    expect(await runInDurableObject(object, (i) => i.now())).toBeLessThan(originalPendingExpiry);
    await runInDurableObject(object, (i) => {
      if (point === "lost-write") {
        const write = i.slots.write;
        i.slots.write = async (...args) => {
          expect((await write(...args)).status).toBe("stored");
          return { status: "uncertain" };
        };
      } else i.beforeCommit = () => { throw new Error("stop"); };
    });
    expect(await object.reconcileReserved(reserved.nonce)).toBe("held");
    const retained = await restart(object);
    expect(retained.cleanup).not.toBeNull();
    expect(retained.cleanup.cutoff).toBe(originalCutoff);
    expect(retained.cleanup.reservation.cutoff).toBe(originalCutoff);
    expect(retained.cleanup.reservation.expires).toBe(originalPendingExpiry);
    expect(retained.cleanup.reservation).not.toHaveProperty("predecessorExpires");
    const etag = (await env.SLOTS.head(key)).etag;
    await runInDurableObject(object, (i) => {
      i.slots.write = () => { throw new Error("no replay"); };
    });
    expect(await object.recoverCleanup()).toBe("recovered");
    expect(await runInDurableObject(object, (i) => i.now())).toBeLessThan(originalPendingExpiry);
    const after = await state(object);
    expect(after.reservation).toBeNull();
    expect(after.pending).toBeNull();
    expect(after.accepted).toBeNull();
    expect(after.current).toEqual(retained.value.intent.next);
    expect((await env.SLOTS.head(key)).etag).toBe(etag);
    expect(await object.recoverCleanup()).toBe("held");
    expect(await state(object)).toEqual(after);
  },
);
beforeEach(async () => {
  await env.SLOTS.delete([key, "follow-checkpoint-slot-1"]);
});

test.each(["lost-write", "before-sql", "before-finish"])(
  "cold recovery completes only the exact planned tombstone (%s)",
  async (point) => {
    const { object, nonce, before } = await setup();
    await runInDurableObject(object, (i) => {
      if (point === "lost-write") {
        const write = i.slots.write;
        i.slots.write = async (...args) => {
          expect(i.witness.cleanup.forwarded).toBe(true);
          expect((await write(...args)).status).toBe("stored");
          return { status: "uncertain" };
        };
      } else if (point === "before-sql")
        i.beforeCommit = () => {
          throw new Error("stop");
        };
      else i.witness.failFinish = "before";
    });
    expect(await object.reconcileReserved(nonce)).toBe("held");
    const etag = (await env.SLOTS.head(key)).etag;
    const retained = await restart(object);
    expect(retained.cleanup.reservation.expires).toBe(before.reservation.expires);
    expect(retained.cleanup.cutoff).toBe(before.reservation.expires);
    expect(JSON.stringify(retained.cleanup)).not.toContain('"rows"');
    await runInDurableObject(object, (i) => {
      i.slots.write = () => {
        throw new Error("no replay");
      };
    });
    expect(await object.recoverCleanup()).toBe("recovered");
    const after = await state(object);
    expect(after.current).toEqual(retained.value.intent.next);
    expect(after.reservation).toBeNull();
    expect(after.pending).toBeNull();
    expect((await env.SLOTS.head(key)).etag).toBe(etag);
    expect(await object.recoverCleanup()).toBe("held");
    expect(await state(object)).toEqual(after);
  },
);

test("a never-forwarded plan is replaced once under competing recovery CAS", async () => {
  const { object, nonce } = await setup();
  await runInDurableObject(object, (i) => {
    i.beforeReservationCleanup = () => {
      throw new Error("stop");
    };
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  const retained = await restart(object);
  expect(retained.cleanup.forwarded).toBe(false);
  await runInDurableObject(object, (i) => {
    const write = i.slots.write;
    i.writes = 0;
    i.slots.write = (...args) => {
      i.writes++;
      return write(...args);
    };
  });
  const outcomes = await Promise.all([object.recoverCleanup(), object.recoverCleanup()]);
  expect(outcomes).toContain("recovered");
  expect(await runInDurableObject(object, (i) => i.writes)).toBe(1);
  const physical = await runInDurableObject(object, (i) => i.slots.read(0));
  expect(physical.nonce).not.toBe(retained.cleanup.planned.nonce);
  expect((await state(object)).reservation).toBeNull();
});

test("delayed original payload defeats cleanup but proves its condition dead after eviction", async () => {
  const { object, nonce, before } = await setup();
  await runInDurableObject(object, (i) => {
    const payload = i.uploads.get(nonce),
      r = i.state().reservation;
    i.beforeReservationCleanup = async () => {
      expect((await i.slots.write(r.slot, r.fenceEtag, payload)).status).toBe("stored");
    };
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  const retained = await restart(object),
    payloadEtag = (await env.SLOTS.head(key)).etag;
  expect(payloadEtag).not.toBe(retained.cleanup.sourceEtag);
  expect(await state(object)).toEqual(before);
  expect(await object.recoverCleanup()).toBe("recovered");
  const physical = await runInDurableObject(object, (i) => i.slots.read(0));
  expect(physical.kind).toBe("tombstone");
  expect(physical.nonce).not.toBe(retained.cleanup.planned.nonce);
  expect((await state(object)).current).toEqual(retained.value.intent.next);
  expect((await state(object)).pending).toBeNull();
  const etag = physical.etag;
  expect(await object.reconcileReserved(nonce)).toBe("held");
  expect(await object.recoverCleanup()).toBe("held");
  expect((await env.SLOTS.head(key)).etag).toBe(etag);
});

test.each(["prepared-only", "forwarded-unchanged"])("cold %s remains held", async (point) => {
  const { object, nonce, before } = await setup();
  await runInDurableObject(object, (i) => {
    if (point === "prepared-only") i.witness.failPrepare = "after";
    else
      i.beforeCleanupPut = () => {
        throw new Error("unknown invocation");
      };
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  const retained = await restart(object),
    etag = (await env.SLOTS.head(key)).etag;
  expect(retained.value.phase).toBe("prepared");
  expect(await object.recoverCleanup()).toBe("held");
  expect(await state(object)).toEqual(before);
  expect((await env.SLOTS.head(key)).etag).toBe(etag);
});

test.each([
  "missing",
  "malformed",
  "unrelated",
  "cutoff",
  "transition",
  "control",
  "body",
  "digest",
])("recovery holds on %s instead of adopting unrelated evidence", async (fault) => {
  const { object, nonce } = await setup();
  await runInDurableObject(object, (i) => {
    i.beforeCommit = () => {
      throw new Error("stop");
    };
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  await restart(object);
  if (fault === "missing") await env.SLOTS.delete(key);
  else if (fault === "malformed") await env.SLOTS.put(key, "not an envelope");
  else
    await runInDurableObject(object, async (i) => {
      if (fault === "unrelated") {
        const current = await i.slots.read(0);
        expect((await i.slots.write(0, current.etag, await i.slots.tombstone())).status).toBe(
          "stored",
        );
      } else if (fault === "cutoff") i.witness.cleanup.cutoff--;
      else if (fault === "transition") i.witness.cleanup.transition.nonce = "a".repeat(32);
      else if (fault === "body") i.witness.cleanup.planned.bytes = 1;
      else if (fault === "digest") i.witness.cleanup.planned.sha256 = "0".repeat(64);
      else {
        const s = i.state();
        s.initialized = !s.initialized;
        i.save(s);
      }
    });
  const before = await state(object),
    etag = (await env.SLOTS.head(key))?.etag;
  expect(await object.recoverCleanup()).toBe("held");
  expect(await state(object)).toEqual(before);
  expect((await env.SLOTS.head(key))?.etag).toBe(etag);
});

test("an uncertain delayed cleanup is not retried and can later reconcile its original tombstone", async () => {
  const { object, nonce, before } = await setup();
  await runInDurableObject(object, (i) => {
    const write = i.slots.write;
    i.slots.write = async (...args) => {
      i.lateWrite = () => write(...args);
      return { status: "uncertain" }; // Invocation may still finish. Preserve its original receipt.
    };
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  expect(await object.recoverCleanup()).toBe("held");
  expect(await state(object)).toEqual(before);
  await runInDurableObject(object, async (i) => {
    expect((await i.lateWrite()).status).toBe("stored");
    expect((await i.lateWrite()).status).toBe("invalid"); // Same envelope cannot be forwarded twice.
  });
  await restart(object);
  expect(await object.recoverCleanup()).toBe("recovered");
  expect((await state(object)).reservation).toBeNull();
});

test("a changed reservation cannot be cleared after the tombstone read", async () => {
  const { object, nonce } = await setup();
  await runInDurableObject(object, (i) => {
    i.beforeCommit = () => {
      throw new Error("stop");
    };
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  await restart(object);
  await runInDurableObject(object, (i) => {
    const read = i.slots.read;
    i.slots.read = async (...args) => {
      const result = await read(...args),
        s = i.state();
      s.reservation.nonce = "c".repeat(32);
      i.save(s);
      return result;
    };
  });
  const etag = (await env.SLOTS.head(key)).etag;
  expect(await object.recoverCleanup()).toBe("held");
  expect((await state(object)).reservation.nonce).toBe("c".repeat(32));
  expect((await env.SLOTS.head(key)).etag).toBe(etag);
});
