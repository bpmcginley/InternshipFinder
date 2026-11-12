import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPlatformProxy } from "wrangler";
import { createFollowCheckpointR2Slots } from "../src/follow-checkpoint-r2.js";

test("actual local workerd R2: two bounded slots, conditional races and lost acknowledgements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "internscout-r2-offline-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "offline-checkpoint-slots",
      compatibility_date: "2026-09-01",
      r2_buckets: [{ binding: "SLOTS", bucket_name: "offline-only-slots" }],
    }),
  );
  // Disable auxiliary metadata retrieval as well as all remote binding connections.
  const prior = process.env.CLOUDFLARE_CF_FETCH_ENABLED;
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
  let proxy;
  try {
    proxy = await getPlatformProxy({
      configPath,
      persist: false,
      remoteBindings: false,
      envFiles: [],
    });
    const bucket = proxy.env.SLOTS;
    const bounds = { maxPayloadBytes: 2_540_000, maxEnvelopeBytes: 2_540_256 };
    const slots = createFollowCheckpointR2Slots(bucket, bounds);
    assert.equal((await slots.read(0)).status, "missing");
    const fences = await Promise.all([slots.tombstone(), slots.tombstone()]);
    const initialized = await Promise.all(fences.map((v, slot) => slots.write(slot, null, v)));
    assert.deepEqual(
      initialized.map((v) => v.status),
      ["stored", "stored"],
    );
    const payload = new Uint8Array(bounds.maxPayloadBytes).fill(65);
    const second = payload.slice();
    second[second.length - 1] = 66;
    const prepared = await Promise.all([slots.prepare(payload), slots.prepare(second)]);
    const initial = await Promise.all(
      prepared.map((value, slot) => slots.write(slot, initialized[slot].etag, value)),
    );
    assert.deepEqual(
      initial.map((v) => v.status),
      ["stored", "stored"],
    );
    for (const slot of [0, 1]) {
      const current = await slots.read(slot);
      assert.deepEqual(current.payload, slot ? second : payload);
      assert.equal(current.nonce, prepared[slot].nonce);
      assert.equal(current.sha256, prepared[slot].sha256);
    }
    const contenders = await Promise.all([slots.prepare(payload), slots.prepare(payload)]);
    const race = await Promise.all(contenders.map((v) => slots.write(0, initial[0].etag, v)));
    assert.deepEqual(race.map((v) => v.status).sort(), ["conflict", "stored"]);
    const winner = await slots.read(0);
    assert.notEqual(
      winner.etag,
      initial[0].etag,
      "body nonce changes identity for identical payload",
    );
    assert.equal(
      (await slots.write(0, initial[0].etag, await slots.tombstone())).status,
      "conflict",
    );
    assert.equal((await slots.read(0)).etag, winner.etag, "stale cleanup cannot replace winner");
    assert.equal((await slots.write(1, null, await slots.tombstone())).status, "conflict");

    // Simulate a committed PUT whose acknowledgement is lost, without replaying it.
    let puts = 0;
    const lost = createFollowCheckpointR2Slots(
      {
        get: (...args) => bucket.get(...args),
        async put(...args) {
          puts++;
          await bucket.put(...args);
          throw new Error("lost reply");
        },
      },
      bounds,
    );
    const reserved = await lost.prepare(payload);
    assert.equal((await lost.write(1, initial[1].etag, reserved)).status, "uncertain");
    assert.equal(puts, 1);
    assert.equal(
      (await slots.write(1, initial[1].etag, await slots.tombstone())).status,
      "conflict",
    );
    const cold = createFollowCheckpointR2Slots(bucket, bounds);
    const recovered = await cold.read(1);
    assert.equal(recovered.nonce, reserved.nonce);
    assert.equal(recovered.sha256, reserved.sha256);
    assert.deepEqual(recovered.payload, payload);
    const tombstone = await cold.tombstone();
    assert.equal((await cold.write(1, recovered.etag, tombstone)).status, "stored");
    const retired = await cold.read(1);
    assert.equal(retired.kind, "tombstone");
    assert.equal(retired.payload.length, 0);
    const nextTombstone = await cold.tombstone();
    assert.notEqual(nextTombstone.nonce, retired.nonce);
    assert.equal((await cold.write(1, retired.etag, nextTombstone)).status, "stored");
    assert.notEqual((await cold.read(1)).etag, retired.etag);
    assert.deepEqual((await bucket.list()).objects.map((v) => v.key).sort(), [
      "follow-checkpoint-slot-0",
      "follow-checkpoint-slot-1",
    ]);
    assert.equal(await slots.prepare(new Uint8Array(bounds.maxPayloadBytes + 1)), null);
    await bucket.put("follow-checkpoint-slot-0", new Uint8Array(bounds.maxEnvelopeBytes + 1));
    assert.equal((await slots.read(0)).status, "unavailable", "oversize native object is refused");
    await bucket.put("follow-checkpoint-slot-0", new Uint8Array([255, 10, 0]));
    assert.equal(
      (await slots.read(0)).status,
      "unavailable",
      "malformed native envelope is refused",
    );
  } finally {
    await proxy?.dispose();
    if (prior === undefined) delete process.env.CLOUDFLARE_CF_FETCH_ENABLED;
    else process.env.CLOUDFLARE_CF_FETCH_ENABLED = prior;
    // This test-created absolute directory is the sole cleanup target.
    await rm(directory, { recursive: true, force: true });
  }
});
