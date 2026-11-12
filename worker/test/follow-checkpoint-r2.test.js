import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollowCheckpointR2Slots } from "../src/follow-checkpoint-r2.js";

const bounds = { maxPayloadBytes: 32, maxEnvelopeBytes: 288 };
const bytes = new TextEncoder().encode("canonical caller bytes");
function memory() {
  const values = new Map();
  let serial = 0;
  return {
    values,
    async put(key, body, { onlyIf }) {
      const old = values.get(key);
      if (onlyIf.etagDoesNotMatch === "*" ? old : old?.etag !== onlyIf.etagMatches) return null;
      const value = { body: body.slice(), etag: String(++serial) };
      values.set(key, value);
      return { etag: value.etag };
    },
    async get(key) {
      const value = values.get(key);
      return value
        ? { etag: value.etag, size: value.body.length, body: new Response(value.body).body }
        : null;
    },
  };
}

test("R2 slots copy caller bytes, restrict keys, and require opaque single-attempt envelopes", async () => {
  const bucket = memory();
  const slots = createFollowCheckpointR2Slots(bucket, bounds);
  assert.throws(() =>
    createFollowCheckpointR2Slots(bucket, { maxPayloadBytes: 0, maxEnvelopeBytes: 288 }),
  );
  assert.equal(await slots.prepare(new Uint8Array(33)), null);
  assert.equal(await slots.prepare("text"), null);
  const input = bytes.slice();
  const preparing = slots.prepare(input);
  input.fill(0);
  const receipt = await preparing;
  assert.equal((await slots.write("0", null, receipt)).status, "invalid");
  assert.equal((await slots.write(0, undefined, receipt)).status, "invalid");
  assert.equal((await slots.write(0, null, { ...receipt })).status, "invalid");
  assert.equal((await slots.write(0, null, receipt)).status, "stored");
  assert.deepEqual((await slots.read(0)).payload, bytes);
  assert.equal((await slots.write(0, null, receipt)).status, "invalid");
  assert.equal((await slots.read(2)).status, "invalid");
  assert.deepEqual([...bucket.values.keys()], ["follow-checkpoint-slot-0"]);
});

test("R2 slots reject corrupt, oversized and truncated reads and cancel the body", async () => {
  const bucket = memory();
  const slots = createFollowCheckpointR2Slots(bucket, bounds);
  await slots.write(0, null, await slots.prepare(bytes));
  const original = bucket.values.get("follow-checkpoint-slot-0").body;
  for (const [size, body] of [
    [289, original],
    [original.length - 1, original],
    [original.length + 1, original],
    [original.length, original.map((v, i) => (i === original.length - 1 ? v ^ 1 : v))],
    [3, new Uint8Array([255, 10, 0])],
  ]) {
    const finite = createFollowCheckpointR2Slots(
      {
        async get() {
          return { size, etag: "valid", body: new Response(body).body };
        },
      },
      bounds,
    );
    assert.equal((await finite.read(0)).status, "unavailable");
  }
  let cancelled = false;
  const overflow = createFollowCheckpointR2Slots(
    {
      async get() {
        return {
          size: original.length - 1,
          etag: "valid",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(original);
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    },
    bounds,
  );
  assert.equal((await overflow.read(0)).status, "unavailable");
  assert.equal(cancelled, true);
});

test("R2 slots reject unknown headers and uncertain readback without retry", async () => {
  const bucket = memory();
  const slots = createFollowCheckpointR2Slots(bucket, bounds);
  await slots.write(0, null, await slots.prepare(bytes));
  const stored = bucket.values.get("follow-checkpoint-slot-0");
  const text = new TextDecoder().decode(stored.body);
  stored.body = new TextEncoder().encode(text.replace('"v":1', '"extra":1,"v":1'));
  assert.equal((await slots.read(0)).status, "unavailable");
  let writes = 0;
  const unreadable = createFollowCheckpointR2Slots(
    {
      async put() {
        writes++;
        return { etag: "committed" };
      },
      async get() {
        throw new Error("private storage details");
      },
    },
    bounds,
  );
  assert.deepEqual(await unreadable.write(0, null, await unreadable.tombstone()), {
    status: "uncertain",
  });
  assert.equal(writes, 1);
  assert.deepEqual(await slots.read(1), { status: "missing" });
});

test("R2 slots return generic uncertainty without retry or leaking storage errors", async () => {
  let calls = 0;
  const slots = createFollowCheckpointR2Slots(
    {
      async put() {
        calls++;
        throw new Error("private detail");
      },
    },
    bounds,
  );
  const receipt = await slots.prepare(bytes);
  assert.deepEqual(await slots.write(0, null, receipt), { status: "uncertain" });
  assert.deepEqual(await slots.write(0, null, receipt), { status: "invalid" });
  assert.equal(calls, 1);
});
