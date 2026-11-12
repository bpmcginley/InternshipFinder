import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { WitnessDouble } from "./worker.js";

const DAY = 86_400_000,
  encode = (s) => new TextEncoder().encode(s);
const wire = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
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
const key = "follow-checkpoint-slot-0";
const state = (object) => runInDurableObject(object, (i) => i.state());
async function pending(age = 1000) {
  const value = JSON.parse(golden.cases[0].checkpoint),
    now = Date.now();
  value.prepared_at = wire(now - age);
  value.covers_after = wire(now - 2 * DAY);
  return encode(JSON.stringify(ordered(value)));
}
async function setup(age) {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId()),
    raw = await pending(age);
  await object.bootstrap();
  const reserved = await object.reservePending(raw);
  expect(reserved.status).toBe("reserved");
  return { object, raw, nonce: reserved.nonce };
}
async function expire(object) {
  const remaining = await runInDurableObject(
    object,
    (i) => i.state().reservation.expires - i.now(),
  );
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 5));
}
beforeEach(async () => {
  await env.SLOTS.delete([key, "follow-checkpoint-slot-1"]);
});

test("reservation precedes upload, competing reservation holds, and bytes stay out of SQLite", async () => {
  const { object, raw, nonce } = await setup();
  const before = await state(object),
    fence = await env.SLOTS.head(key);
  expect(before.pending).toBeNull();
  expect(before.reservation.fenceEtag).toBe(fence.etag);
  expect(JSON.stringify(before)).not.toContain('"rows"');
  expect(await object.reservePending(raw)).toEqual({ status: "held" });
  expect(await object.reconcileReserved(nonce)).toBe("uncertain");
  expect(await object.uploadReserved(nonce)).toBe("stored");
  expect(await object.uploadReserved(nonce)).toBe("held");
  expect(await object.reconcileReserved(nonce)).toBe("committed");
  expect((await object.read("pending")).bytes).toEqual(raw);
  expect((await state(object)).pending.expires).toBe(before.reservation.expires);
  expect(Object.hasOwn((await state(object)).pending, "cutoff")).toBe(false);
  expect(await object.reconcileReserved(nonce)).toBe("held");
});

test("lost upload reply reconciles after actual eviction only with an explicitly restored witness", async () => {
  const { object, raw, nonce } = await setup();
  const before = await state(object);
  const witness = await runInDurableObject(object, (i) => {
    const write = i.slots.write;
    i.slots.write = async (...args) => {
      expect((await write(...args)).status).toBe("stored");
      return { status: "uncertain" }; // The native PUT committed but its reply is lost.
    };
    return i.witness.read();
  });
  expect(await object.uploadReserved(nonce)).toBe("uncertain");
  const etag = (await env.SLOTS.head(key)).etag;
  await evictDurableObject(object);
  expect(await state(object)).toEqual(before);
  expect(await object.reconcileReserved(nonce)).toBe("held");
  await runInDurableObject(object, (i) => {
    i.witness = new WitnessDouble(witness.current);
    i.witness.value = witness;
    expect(i.uploads.size).toBe(0);
  });
  expect(await object.uploadReserved(nonce)).toBe("held");
  expect(await object.reconcileReserved(nonce)).toBe("committed");
  expect((await object.read("pending")).bytes).toEqual(raw);
  expect((await env.SLOTS.head(key)).etag).toBe(etag);
  expect((await state(object)).pending.expires).toBe(before.reservation.expires);
});

test.each([false, true])(
  "a delayed PUT across expiry cannot expose bytes (cleanup first: %s)",
  async (cleanupFirst) => {
    const { object, nonce } = await setup(DAY - 1000);
    await runInDurableObject(object, (i) => {
      i.beforeUpload = () =>
        new Promise((resolve) => {
          i.releaseUpload = resolve;
        });
    });
    const upload = object.uploadReserved(nonce);
    for (let n = 0; n < 100; n++) {
      if (await runInDurableObject(object, (i) => Boolean(i.releaseUpload))) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await expire(object);
    if (cleanupFirst) expect(await object.reconcileReserved(nonce)).toBe("committed");
    await runInDurableObject(object, (i) => {
      expect(i.releaseUpload).toBeTypeOf("function");
      i.releaseUpload();
    });
    expect(await upload).toBe(cleanupFirst ? "conflict" : "stored");
    if (!cleanupFirst) expect(await object.reconcileReserved(nonce)).toBe("committed");
    expect((await state(object)).pending).toBeNull();
    expect((await state(object)).reservation).toBeNull();
    expect((await object.read("pending")).status).not.toBe("current");
    await runInDurableObject(object, (i) => {
      i.beforeUpload = null;
    });
    const next = await object.reservePending(await pending());
    expect(next.status).toBe("reserved");
    expect(await object.uploadReserved(next.nonce)).toBe("stored");
    expect(await object.reconcileReserved(next.nonce)).toBe("committed");
    const nextEtag = (await env.SLOTS.head(key)).etag;
    expect(await object.reconcileReserved(nonce)).toBe("held");
    expect((await env.SLOTS.head(key)).etag).toBe(nextEtag);
  },
);

test("expired reservation survives restart and cannot restart upload or extend its cutoff", async () => {
  const { object, nonce } = await setup(DAY - 1000),
    before = await state(object);
  const witness = await runInDurableObject(object, (i) => i.witness.read());
  await evictDurableObject(object);
  await expire(object);
  expect(await object.uploadReserved(nonce)).toBe("held");
  expect(await object.reconcileReserved(nonce)).toBe("held");
  expect(await state(object)).toEqual(before);
  await runInDurableObject(object, (i) => {
    i.witness = new WitnessDouble(witness.current);
    i.witness.value = witness;
  });
  expect(await object.reconcileReserved(nonce)).toBe("committed");
  expect((await state(object)).reservation).toBeNull();
  expect((await state(object)).pending).toBeNull();
});

test("PUT beating the stale cleanup ETag holds its exact reservation and prepared witness", async () => {
  const { object, nonce } = await setup(DAY - 1000),
    before = await state(object);
  await expire(object);
  await runInDurableObject(object, (i) => {
    const receipt = i.uploads.get(nonce),
      r = i.state().reservation;
    i.beforeReservationCleanup = async () => {
      expect((await i.slots.write(r.slot, r.fenceEtag, receipt)).status).toBe("stored");
    };
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  expect(await state(object)).toEqual(before);
  expect((await object.read("pending")).status).toBe("held");
  expect(await object.recoverAcknowledgement()).toBe("held");
  expect((await env.SLOTS.get(key)).size).toBeGreaterThan(256);
});

test("unverified eligibility alone cannot authorize early physical retirement", async () => {
  const { object, nonce } = await setup();
  expect(await object.uploadReserved(nonce)).toBe("stored");
  const before = await state(object),
    etag = (await env.SLOTS.head(key)).etag;
  await runInDurableObject(object, (i) => {
    i.predecessorMatches = () => false;
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  expect(await state(object)).toEqual(before);
  expect((await env.SLOTS.head(key)).etag).toBe(etag);
});

test("reconciliation crossing its original cutoff cannot publish or extend expiry", async () => {
  const { object, nonce } = await setup(DAY - 1000);
  expect(await object.uploadReserved(nonce)).toBe("stored");
  const before = await state(object);
  await runInDurableObject(object, (i) => {
    i.beforeCommit = () =>
      new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, i.state().reservation.expires - i.now()) + 5),
      );
  });
  expect(await object.reconcileReserved(nonce)).toBe("held");
  expect(await state(object)).toEqual(before);
  expect((await object.read("pending")).status).toBe("held");
});

test.each(["missing", "malformed", "wrong nonce", "wrong digest"])(
  "uncertain %s slot never changes reservation or publishes",
  async (kind) => {
    const { object, nonce } = await setup(),
      before = await state(object);
    if (kind === "missing") await env.SLOTS.delete(key);
    else if (kind === "malformed") await env.SLOTS.put(key, "bad envelope");
    else if (kind === "wrong nonce") {
      expect(await object.uploadReserved(nonce)).toBe("stored");
      const original = await (await env.SLOTS.get(key)).text();
      const at = original.indexOf("\n"),
        header = JSON.parse(original.slice(0, at));
      header.nonce = "0".repeat(32);
      await env.SLOTS.put(key, JSON.stringify(header) + original.slice(at));
    } else {
      const payload = encode("different");
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", payload)),
        (x) => x.toString(16).padStart(2, "0"),
      ).join("");
      await env.SLOTS.put(
        key,
        encode(
          JSON.stringify({
            v: 1,
            kind: "payload",
            nonce,
            sha256: digest,
            bytes: payload.length,
          }) + "\ndifferent",
        ),
      );
    }
    expect(await object.reconcileReserved(nonce)).toBe("held");
    expect(await state(object)).toEqual(before);
    expect((await state(object)).pending).toBeNull();
  },
);

test.each(["uploaded", "fence", "delayed"])(
  "captured predecessor cutoff survives retirement and physical cleanup (%s)",
  async (mode) => {
    const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
    const now = await runInDurableObject(object, (i) => i.now());
    const next = JSON.parse(golden.cases[0].checkpoint),
      prior = JSON.parse(golden.cases[1].checkpoint);
    for (const value of [next, prior]) {
      value.covers_after = wire(now - 10 * DAY);
      for (const row of value.rows) {
        row[1] = wire(now - 9 * DAY).replace(/Z$/, "");
        row[3] = wire(now - 9 * DAY);
      }
    }
    next.prepared_at = wire(now - 1000);
    prior.accepted_at = wire(now - 7 * DAY + 2000);
    const oldBytes = encode(JSON.stringify(ordered(prior)));
    next.predecessor = {
      commit: prior.accepted_commit,
      public_tree: prior.public_tree,
      checkpoint_sha256: Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", oldBytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join(""),
    };
    await object.bootstrap(oldBytes);
    const { status, nonce } = await object.reservePending(encode(JSON.stringify(ordered(next))));
    expect(status).toBe("reserved");
    const before = await state(object);
    expect(before.reservation.cutoff).toBe(before.accepted.expires);
    if (mode === "fence")
      await runInDurableObject(object, async (i) => {
        const saved = i.state(),
          inconsistent = structuredClone(saved);
        inconsistent.reservation.cutoff++;
        i.save(inconsistent);
        expect(await i.uploadReserved(nonce)).toBe("held");
        expect(await i.reconcileReserved(nonce)).toBe("held");
        i.save(saved);
      });
    let late;
    if (mode === "uploaded") expect(await object.uploadReserved(nonce)).toBe("stored");
    if (mode === "delayed") {
      await runInDurableObject(object, (i) => {
        i.beforeUpload = () =>
          new Promise((resolve) => {
            i.releaseUpload = resolve;
          });
      });
      late = object.uploadReserved(nonce);
      for (let n = 0; n < 100; n++) {
        if (await runInDurableObject(object, (i) => Boolean(i.releaseUpload))) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(await runInDurableObject(object, (i) => Boolean(i.releaseUpload))).toBe(true);
    }
    const remaining = await runInDurableObject(
      object,
      (i) => i.state().reservation.cutoff - i.now(),
    );
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 10));
    const expiredAt = await runInDurableObject(object, (i) => i.now());
    expect(expiredAt).toBeGreaterThanOrEqual(before.accepted.expires);
    expect(expiredAt).toBeLessThan(before.reservation.expires); // Pending's own 24 hours are still live.
    expect(await object.retireExpired("accepted")).toBe("committed");
    expect(await object.cleanupRetired()).toBe("committed");
    const cleared = await state(object);
    expect(cleared.accepted).toBeNull();
    expect(cleared.retired).toBeNull();
    expect(cleared.reservation.cutoff).toBe(before.accepted.expires);
    expect(await object.reconcileReserved(nonce)).toBe("committed");
    expect((await state(object)).reservation).toBeNull();
    expect((await state(object)).pending).toBeNull();
    const physical = await runInDurableObject(object, (i) => i.slots.read(0));
    expect(physical.kind).toBe("tombstone");
    if (late) {
      await runInDurableObject(object, (i) => i.releaseUpload());
      expect(await late).toBe("conflict");
    }
    expect(await object.reconcileReserved(nonce)).toBe("held");
    expect((await env.SLOTS.head(key)).etag).toBe(physical.etag);
  },
);

test.each([
  "missing",
  "null",
  "string",
  "fraction",
  "after-expiry",
  "before-start",
  "wrong-genesis",
])("malformed captured cutoff stays held (%s)", async (fault) => {
  const { object, nonce } = await setup();
  await runInDurableObject(object, (i) => {
    const s = i.state(),
      r = s.reservation;
    if (fault === "missing") delete r.cutoff;
    else if (fault === "null") r.cutoff = null;
    else if (fault === "string") r.cutoff = String(r.cutoff);
    else if (fault === "fraction") r.cutoff += 0.5;
    else if (fault === "wrong-genesis") r.cutoff--;
    else r.cutoff = fault === "after-expiry" ? r.expires + 1 : r.starts - 1;
    i.save(s);
  });
  const before = await state(object),
    etag = (await env.SLOTS.head(key)).etag;
  expect(await object.uploadReserved(nonce)).toBe("held");
  expect(await object.reconcileReserved(nonce)).toBe("held");
  expect(await state(object)).toEqual(before);
  expect((await env.SLOTS.head(key)).etag).toBe(etag);
});
