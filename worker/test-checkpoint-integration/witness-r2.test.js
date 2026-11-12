import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { createFollowCheckpointR2WitnessPort as createPort } from "../src/follow-checkpoint-r2.js";
import {
  createFollowCheckpointCleanupWitnessCas,
  createFollowCheckpointWitnessCas,
} from "../src/follow-checkpoint-witness-cas.js";

const key = "follow-checkpoint-witness";
const slots = ["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"];
const previous = { epoch: "1".repeat(32), revision: 1, token: "2".repeat(32) };
const intent = { nonce: "3".repeat(32), next: { ...previous, revision: 2, token: "4".repeat(32) } };
const stable = (current, phase = "stable") => ({ version: 1, phase, current, intent: null });
const v2 = (current) => JSON.stringify({ version: 2, witness: stable(current), cleanup: null });
const text = JSON.stringify(stable(previous));
const next = JSON.stringify(stable(intent.next));
const encoder = new TextEncoder();

// Local test provisioning only. The runtime port has no creation method.
async function seed(body, extra = {}) {
  const bytes = encoder.encode(body);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const envelope = {
    v: 1,
    kind: "payload",
    nonce: "a".repeat(32),
    sha256,
    bytes: bytes.length,
    ...extra,
  };
  return env.SLOTS.put(key, JSON.stringify(envelope) + "\n" + body);
}

const bucket = (put) => ({ get: (name) => env.SLOTS.get(name), put });

test("the dedicated R2 port holds missing, malformed and closed authority without any PUT", async () => {
  await env.SLOTS.delete(key);
  let puts = 0;
  const port = createPort(bucket(() => ++puts));
  expect(await port.readRecord()).toBeNull();
  expect(await port.compareAndSwap("missing", text)).toBe(false);
  for (const [body, header] of [
    [text, { sha256: "0".repeat(64) }],
    [text, { bytes: 1 }],
    [text, { nonce: "invalid" }],
    ["x".repeat(2049), {}],
    [text.replace('"version":1', '"version":1,"version":1'), {}],
    [JSON.stringify({ version: 1, phase: "stable" }), {}],
    [JSON.stringify({ version: 2, witness: stable(previous), cleanup: { bytes: "invalid" } }), {}],
  ]) {
    const { etag } = await seed(body, header);
    expect(await port.readRecord()).toBeNull();
    expect(await port.compareAndSwap(etag, text)).toBe(false);
  }
  const closed = JSON.stringify(stable(previous, "closed"));
  const { etag } = await seed(closed);
  expect(await port.readRecord()).toEqual({ tag: etag, text: closed });
  expect(await port.compareAndSwap(etag, text)).toBe(false);
  const initial = await seed(text);
  expect(await port.compareAndSwap(initial.etag, closed)).toBe(false);
  expect(await port.compareAndSwap(initial.etag, v2(previous))).toBe(false);
  expect(await port.compareAndSwap(initial.etag, JSON.stringify({ version: 1 }))).toBe(false);
  expect(puts).toBe(0);
});

test("both witness versions reject reordered nested position keys before a PUT", async () => {
  const reverse = ({ epoch, revision, token }) => ({ token, revision, epoch });
  const canonical = { version: 1, phase: "prepared", current: previous, intent };
  let puts = 0;
  const port = createPort(bucket(() => ++puts));
  for (const wrap of [
    (witness) => witness,
    (witness) => ({ version: 2, witness, cleanup: null }),
  ]) {
    const valid = JSON.stringify(wrap(canonical));
    for (const reordered of [
      { ...canonical, current: reverse(previous) },
      { ...canonical, intent: { ...intent, next: reverse(intent.next) } },
    ]) {
      const invalid = JSON.stringify(wrap(reordered));
      const malformed = await seed(invalid);
      expect(await port.readRecord()).toBeNull();
      expect(await port.compareAndSwap(malformed.etag, valid)).toBe(false);
      const good = await seed(valid);
      expect(await port.compareAndSwap(good.etag, invalid)).toBe(false);
      expect(await port.readRecord()).toEqual({ tag: good.etag, text: valid });
    }
  }
  expect(puts).toBe(0);
});

test("identical witness text creates distinct native object nonces and ETags", async () => {
  const initial = await seed(text);
  const port = createPort(env.SLOTS);
  const tags = [initial.etag],
    nonces = ["a".repeat(32)];
  for (let count = 0; count < 3; count++) {
    expect(await port.compareAndSwap(tags.at(-1), text)).toBe(true);
    const stored = await env.SLOTS.get(key);
    const raw = new TextDecoder().decode(await stored.arrayBuffer());
    const split = raw.indexOf("\n");
    nonces.push(JSON.parse(raw.slice(0, split)).nonce);
    tags.push(stored.etag);
    expect(raw.slice(split + 1)).toBe(text);
    expect(await port.readRecord()).toEqual({ tag: stored.etag, text });
  }
  expect(new Set(tags).size).toBe(tags.length);
  expect(new Set(nonces).size).toBe(nonces.length);
});

test("an out-of-band restore of identical object bytes can reuse an old ETag", async () => {
  const { etag } = await seed(text);
  const original = await (await env.SLOTS.get(key)).arrayBuffer();
  const port = createPort(env.SLOTS);
  expect(await port.compareAndSwap(etag, next)).toBe(true);
  expect((await port.readRecord()).tag).not.toBe(etag);
  // This bypasses the port in the synthetic bucket, like a restore outside its authority.
  expect((await env.SLOTS.put(key, original)).etag).toBe(etag);
  expect(await port.readRecord()).toEqual({ tag: etag, text });
});

test("native R2 conditional PUT serializes competing writers with the same exact ETag", async () => {
  const { etag } = await seed(text);
  let arrived = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const conflicts = [];
  const port = createPort(
    bucket(async (name, bytes, options) => {
      expect(name).toBe(key);
      expect(options).toEqual({ onlyIf: { etagMatches: etag } });
      if (++arrived === 2) release();
      await barrier;
      const result = await env.SLOTS.put(name, bytes, options);
      conflicts.push(result === null);
      return result;
    }),
  );
  expect(
    (await Promise.all([port.compareAndSwap(etag, text), port.compareAndSwap(etag, next)])).sort(),
  ).toEqual([false, true]);
  expect(conflicts.sort()).toEqual([false, true]);
  expect(await port.compareAndSwap(etag, text)).toBe(false);
  expect(await port.compareAndSwap(`"${etag}"`, text)).toBe(false);
  expect(arrived).toBe(2);
});

test("lost or false PUT acknowledgement never reports success or retries", async () => {
  const { etag } = await seed(text);
  let attempts = 0;
  const liar = createPort(
    bucket(async () => {
      attempts++;
      return { etag: "false-ack" };
    }),
  );
  expect(await liar.compareAndSwap(etag, next)).toBe(false);
  expect(await liar.readRecord()).toEqual({ tag: etag, text });
  const lost = createPort(
    bucket(async (...args) => {
      attempts++;
      await env.SLOTS.put(...args);
      throw new Error("synthetic lost acknowledgement");
    }),
  );
  expect(await lost.compareAndSwap(etag, next)).toBe(false);
  expect((await lost.readRecord()).text).toBe(next);
  expect(await lost.compareAndSwap(etag, next)).toBe(false);
  expect(attempts).toBe(2);
});

test("the native port composes v1 core and v2 journal without sharing the two payload keys", async () => {
  await seed(text);
  const core = createFollowCheckpointWitnessCas(createPort(env.SLOTS));
  expect(await core.prepare(previous, intent)).toBe(true);
  expect(
    await core.finish({ current: intent.next, receipt: { previous, nonce: intent.nonce } }),
  ).toBe(true);
  expect((await core.read()).current).toEqual(intent.next);

  await env.SLOTS.delete(slots);
  const control = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await control.bootstrap();
  const now = await runInDurableObject(control, (i) => i.now());
  const value = JSON.parse(golden.cases[0].checkpoint);
  const wire = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
  value.prepared_at = wire(now - 1000);
  value.covers_after = wire(now - 2 * 86_400_000);
  const ordered = (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v;
  const pending = await control.reservePending(encoder.encode(JSON.stringify(value, ordered)));
  expect(pending.status).toBe("reserved");
  expect(await control.uploadReserved(pending.nonce)).toBe("stored");
  const before = await runInDurableObject(control, (i) => i.state());
  await seed(v2(before.current));
  const slotTags = () => Promise.all(slots.map(async (k) => (await env.SLOTS.head(k)).etag));
  const tags = await slotTags();
  let witnessWrites = 0;
  await runInDurableObject(control, async (i) => {
    const port = createPort(
      bucket((name, body, options) => {
        expect(name).toBe(key);
        witnessWrites++;
        return env.SLOTS.put(name, body, options);
      }),
    );
    i.witness = createFollowCheckpointCleanupWitnessCas(port);
    i.control.now = () => before.reservation.cutoff;
    expect(await i.reconcileReserved(pending.nonce)).toBe("committed");
    expect(await i.witness.readCleanup()).toBeNull();
    expect((await i.witness.read()).phase).toBe("stable");
    expect(i.state().reservation).toBeNull();
    expect(await i.recoverCleanup()).toBe("held");
  });
  const after = await slotTags();
  expect(after[before.reservation.slot]).not.toBe(tags[before.reservation.slot]);
  expect(after[1 - before.reservation.slot]).toBe(tags[1 - before.reservation.slot]);
  expect(witnessWrites).toBe(4);
});
