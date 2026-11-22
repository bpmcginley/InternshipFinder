import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { createFollowCheckpointCleanupWitnessCas as adapter } from "../src/follow-checkpoint-witness-cas.js";

const slotKeys = ["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"];
const opaque = (digit, n = 32) => digit.repeat(n);
const stable = (current) => ({ version: 1, phase: "stable", current, intent: null });
const envelope = (witness, cleanup = null) => JSON.stringify({ version: 2, witness, cleanup });
const emptySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function nativePort(text) {
  const id = env.WITNESS.newUniqueId().toString();
  const stub = () => env.WITNESS.get(env.WITNESS.idFromString(id));
  await stub().seedWitness(text);
  const fault = { mode: null, attempts: 0 };
  const port = {
    readRecord: async () => JSON.parse(await stub().readRecord()),
    async compareAndSwap(tag, replacement) {
      fault.attempts++;
      const record = JSON.parse(replacement);
      if (fault.mode === "finish-before" && record.witness.phase === "stable") throw new Error();
      const stored = await stub().compareAndSwap(tag, replacement);
      if (fault.mode === "bind-after" && record.cleanup?.forwarded === false) throw new Error();
      if (fault.mode === "forward-after" && record.cleanup?.forwarded) throw new Error();
      if (fault.mode === "finish-after" && record.witness.phase === "stable") throw new Error();
      return stored;
    },
  };
  return { port, fault, object: stub(), witness: () => adapter(port) };
}

const previous = { epoch: opaque("1"), revision: 1, token: opaque("2") };
const intent = { nonce: opaque("3"), next: { ...previous, revision: 2, token: opaque("4") } };
const control = { current: intent.next, receipt: { previous, nonce: intent.nonce } };
const journal = {
  version: 1,
  kind: "expired-reservation",
  transition: { previous, ...intent },
  beforeHash: opaque("a", 64),
  reservation: {
    slot: 0,
    nonce: opaque("5"),
    payloadSha: opaque("b", 64),
    digest: opaque("c", 64),
    starts: 1000,
    expires: 4000,
    cutoff: 3000,
  },
  cutoff: 3000,
  sourceEtag: "first",
  planned: { kind: "tombstone", nonce: opaque("6"), sha256: emptySha, bytes: 0 },
  forwarded: false,
};

test("cleanup requires the exact canonical v2 envelope and rejects unbound or malformed journals", async () => {
  const prepared = { version: 1, phase: "prepared", current: previous, intent };
  for (const raw of [
    JSON.stringify(stable(previous)),
    envelope({ ...stable(previous), phase: "closed" }, journal),
    envelope(prepared, { ...journal, cutoff: 2999 }),
    envelope(prepared, { ...journal, writerId: "synthetic" }),
    envelope(prepared, { ...journal, transition: { ...journal.transition, nonce: opaque("7") } }),
    envelope(prepared, journal).replace('"version":2', '"version":2,"version":2'),
    "x".repeat(2049),
  ]) {
    const { witness, fault } = await nativePort(raw);
    expect(await witness().read()).toBeNull();
    expect(await witness().readCleanup()).toBeNull();
    expect(await witness().bindCleanup(null, journal)).toBe(false);
    expect(await witness().finish(control)).toBe(false);
    expect(fault.attempts).toBe(0);
  }
});

test("exact journal CAS binds one plan and preserves immutable evidence through forwarding and replan", async () => {
  const { witness, port, fault } = await nativePort(envelope(stable(previous)));
  const w = witness();
  const competing = { ...journal, planned: { ...journal.planned, nonce: opaque("7") } };
  expect(await w.prepare(previous, intent)).toBe(true);
  const results = await Promise.all([w.bindCleanup(null, journal), w.bindCleanup(null, competing)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const selected = results[0] ? journal : competing;
  const forwarded = { ...selected, forwarded: true };
  const planned = { ...selected.planned, nonce: opaque("8") };
  expect(await w.readCleanup()).toEqual(selected);
  expect(await w.finish(control)).toBe(false);
  expect(await w.bindCleanup(null, forwarded)).toBe(false);
  expect(await w.bindCleanup(selected, { ...forwarded, planned })).toBe(false);
  expect(await w.bindCleanup(selected, forwarded)).toBe(true);
  expect(await w.bindCleanup(forwarded, { ...selected, planned })).toBe(false);
  const replan = { ...selected, planned, sourceEtag: "second" };
  expect(await w.bindCleanup(forwarded, { ...replan, beforeHash: opaque("d", 64) })).toBe(false);
  expect(await w.bindCleanup(forwarded, replan)).toBe(true);
  expect(await w.bindCleanup(forwarded, replan)).toBe(false);
  expect(await w.bindCleanup(replan, { ...replan, forwarded: true })).toBe(true);
  const beforeFinish = fault.attempts;
  fault.mode = "finish-after";
  expect(await w.finish(control)).toBe(false);
  expect(JSON.parse((await port.readRecord()).text)).toEqual(
    JSON.parse(envelope(stable(intent.next))),
  );
  expect(await w.finish(control)).toBe(false);
  expect(fault.attempts).toBe(beforeFinish + 1);
});

async function pendingFixture() {
  await env.SLOTS.delete(slotKeys);
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await object.bootstrap();
  const now = await runInDurableObject(object, (i) => i.now());
  const value = JSON.parse(golden.cases[0].checkpoint);
  const wire = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
  value.prepared_at = wire(now - 1000);
  value.covers_after = wire(now - 2 * 86_400_000);
  const ordered = (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]]),
        )
      : v;
  const pending = await object.reservePending(
    new TextEncoder().encode(JSON.stringify(value, ordered)),
  );
  expect(pending.status).toBe("reserved");
  expect(await object.uploadReserved(pending.nonce)).toBe("stored");
  const before = await runInDurableObject(object, (i) => i.state());
  const key = slotKeys[before.reservation.slot];
  const external = await nativePort(envelope(stable(before.current)));
  return { object, before, pending, key, external };
}

test.each([
  ["bind-after", false, 0, 1],
  ["forward-after", true, 0, 0],
  ["put-after", true, 1, 1],
  ["finish-before", true, 1, 1],
])(
  "actual native cleanup holds a lost %s acknowledgement without repeating a physical PUT",
  async (mode, forwarded, initialWrites, totalWrites) => {
    const { object, before, pending, key, external } = await pendingFixture();
    const oldTag = (await env.SLOTS.head(key)).etag;
    external.fault.mode = mode;
    let writes = 0;
    const mount = (i) => {
      i.witness = external.witness();
      i.control.now = () => before.reservation.cutoff;
      const write = i.slots.write;
      i.slots.write = async (...args) => {
        writes++;
        const result = await write(...args);
        if (external.fault.mode === "put-after" && result.status === "stored")
          return { status: "uncertain" };
        return result;
      };
    };
    await runInDurableObject(object, async (i) => {
      mount(i);
      expect(await i.reconcileReserved(pending.nonce)).toBe("held");
      expect(await i.witness.readCleanup()).toMatchObject({
        forwarded,
        cutoff: before.reservation.cutoff,
      });
    });
    const afterTag = (await env.SLOTS.head(key)).etag;
    const blocked = mode === "forward-after";
    expect(afterTag === oldTag).toBe(initialWrites === 0);
    expect(writes).toBe(initialWrites);
    await evictDurableObject(object);
    await evictDurableObject(external.object);
    external.fault.mode = null;
    await runInDurableObject(object, async (i) => {
      mount(i);
      expect(await i.recoverCleanup()).toBe(blocked ? "held" : "recovered");
      expect((await i.witness.read()).phase).toBe(blocked ? "prepared" : "stable");
      expect((await i.witness.readCleanup()) === null).toBe(!blocked);
      expect(i.state().reservation === null).toBe(!blocked);
      expect(await i.recoverCleanup()).toBe("held");
    });
    expect(writes).toBe(totalWrites);
    expect((await env.SLOTS.head(key)).etag === afterTag).toBe(totalWrites === initialWrites);
  },
);
