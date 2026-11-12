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
