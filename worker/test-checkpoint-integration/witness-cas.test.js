import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { classifyFollowCheckpointWitness as classify } from "../src/follow-checkpoint-witness.js";
import { createFollowCheckpointWitnessCas } from "../src/follow-checkpoint-witness-cas.js";

const slots = ["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"];
const opaque = (digit) => digit.repeat(32);
const witnessState = (current, phase = "stable") => ({ version: 1, phase, current, intent: null });
const successor = (current, digit = "3") => ({
  nonce: opaque(digit),
  next: { ...current, revision: current.revision + 1, token: opaque(digit === "3" ? "4" : "6") },
});
const proof = (previous, intent) => ({
  current: intent.next,
  receipt: { nonce: intent.nonce, previous },
});
const position = ({ current, receipt }) => ({ current, receipt });

async function nativePort(initial) {
  // A second local DO has independent durable storage. Restoring the control fixture does not touch it.
  const id = env.WITNESS.newUniqueId().toString();
  const stub = () => env.WITNESS.get(env.WITNESS.idFromString(id));
  if (initial !== undefined) await stub().seedWitness(initial);
  const faults = { attempts: 0 };
  const port = {
    async readRecord() {
      if (faults.read) throw new Error("synthetic unavailable read");
      const response = await stub().readRecord();
      return response === null ? null : JSON.parse(response);
    },
    async compareAndSwap(tag, text) {
      faults.attempts++;
      const mode = faults.write?.(JSON.parse(text).phase);
      if (mode === "before") throw new Error("synthetic lost request");
      if (mode === "false-true") return true;
      if (mode === "wrong-type") return { success: true };
      const committed = await stub().compareAndSwap(tag, text);
      if (mode === "after") throw new Error("synthetic lost acknowledgement");
      return committed;
    },
  };
  return { object: stub(), port, faults, adapter: () => createFollowCheckpointWitnessCas(port) };
}

async function fixture() {
  await env.SLOTS.delete(slots);
  const control = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await control.bootstrap();
  const before = await runInDurableObject(control, (i) => i.state());
  const store = await nativePort(JSON.stringify(witnessState(before.current)));
  return { control, before, ...store };
}

const change = (state) => {
  state.initialized = true;
  return true;
};

test("strict witness read refuses missing, malformed and noncanonical records without CAS", async () => {
  const previous = { epoch: opaque("1"), revision: 0, token: opaque("2") };
  const closed = witnessState(previous, "closed");
  for (const text of [
    undefined,
    "null",
    "x".repeat(513),
    JSON.stringify(witnessState(previous), null, 2),
    JSON.stringify(witnessState(previous)).replace('"version":1', '"version":1,"version":1'),
    JSON.stringify({ ...witnessState(previous), checkpoint: "synthetic-extra" }),
    JSON.stringify(closed),
  ]) {
    const store = await nativePort(text);
    const adapter = store.adapter();
    expect(await adapter.read()).toEqual(text === JSON.stringify(closed) ? closed : null);
    expect(await adapter.prepare(previous, successor(previous))).toBe(false);
    expect(await adapter.finish(proof(previous, successor(previous)))).toBe(false);
    expect(store.faults.attempts).toBe(0);
  }
});

test("separate native CAS allows one competing prepare and only its exact committed receipt", async () => {
  const previous = { epoch: opaque("1"), revision: 0, token: opaque("2") };
  const store = await nativePort(JSON.stringify(witnessState(previous)));
  const intents = [successor(previous), successor(previous, "5")];
  let reads = 0;
  let release;
  const bothRead = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = createFollowCheckpointWitnessCas({
    ...store.port,
    async readRecord() {
      const row = await store.port.readRecord();
      if (++reads === 2) release();
      await bothRead;
      return row;
    },
  });
  const winners = await Promise.all(intents.map((intent) => adapter.prepare(previous, intent)));
  expect(winners.filter(Boolean)).toHaveLength(1);
  expect(store.faults.attempts).toBe(2);
  const winning = intents[winners.indexOf(true)];
  const losing = intents[winners.indexOf(false)];
  expect(await adapter.finish(proof(previous, losing))).toBe(false);
  expect(await adapter.finish({ current: winning.next, receipt: null })).toBe(false);
  expect(await adapter.finish(proof(previous, winning))).toBe(true);
  expect(await adapter.finish(proof(previous, winning))).toBe(false);
  expect(await adapter.read()).toEqual(witnessState(winning.next));
  expect(store.faults.attempts).toBe(3);
});

test("unavailable CAS, false typed acknowledgement and forged true cannot authorize a mutation", async () => {
  const previous = { epoch: opaque("1"), revision: 0, token: opaque("2") };
  const store = await nativePort(JSON.stringify(witnessState(previous)));
  for (const fault of ["before", "wrong-type", "false-true"]) {
    store.faults.write = () => fault;
    expect(await store.adapter().prepare(previous, successor(previous))).toBe(false);
    expect(await store.adapter().read()).toEqual(witnessState(previous));
  }
  store.faults.read = true;
  expect(await store.adapter().read()).toBeNull();
  expect(await store.adapter().prepare(previous, successor(previous))).toBe(false);
  expect(store.faults.attempts).toBe(3);
});

test("lost prepare acknowledgement leaves an ambiguous predecessor with no SQLite mutation or effect", async () => {
  const { control, before, adapter, faults } = await fixture();
  faults.write = (phase) => (phase === "prepared" ? "after" : null);
  await runInDurableObject(control, async (i) => {
    i.witness = adapter();
    let effects = 0;
    expect(await i.control.change(change, () => ++effects === 1)).toBe("held");
    expect(effects).toBe(0);
    expect(i.state()).toEqual(before);
    expect(classify(await i.witness.read(), position(before))).toBe("ambiguous_predecessor");
    expect(await i.control.recoverAcknowledgement()).toBe("held");
    expect(await i.control.admitted()).toBeNull();
  });
  expect(faults.attempts).toBe(1);
});

test("prepared receipt survives independent evictions and witnesses rollback with identical R2 slots", async () => {
  const { control, object, before, adapter, faults } = await fixture();
  const slotTags = () => Promise.all(slots.map(async (key) => (await env.SLOTS.head(key)).etag));
  const tags = await slotTags();
  faults.write = (phase) => (phase === "stable" ? "before" : null);
  const committed = await runInDurableObject(control, async (i) => {
    i.witness = adapter();
    expect(await i.control.change(change)).toBe("held");
    expect(await i.control.admitted()).toBeNull();
    expect(classify(await i.witness.read(), position(i.state()))).toBe("recover_ack");
    return i.state();
  });
  expect(committed.current.revision).toBe(before.current.revision + 1);
  await evictDurableObject(control);
  await evictDurableObject(object);
  faults.write = undefined;
  await runInDurableObject(control, async (i) => {
    expect(await i.control.admitted()).toBeNull();
    i.witness = adapter();
    expect(await i.control.recoverAcknowledgement()).toBe("recovered");
    expect(await i.control.admitted()).toEqual(committed);
    i.save(before); // Simulates restoring only the control database. No provider PITR is called.
    expect(classify(await i.witness.read(), position(i.state()))).toBe("rollback");
    expect(await i.control.admitted()).toBeNull();
    expect(await i.control.change(change)).toBe("held");
  });
  expect(await slotTags()).toEqual(tags);
  expect(faults.attempts).toBe(3);
});

test("lost stable acknowledgement requires a fresh read and never retries the CAS", async () => {
  const { control, adapter, faults } = await fixture();
  faults.write = (phase) => (phase === "stable" ? "after" : null);
  await runInDurableObject(control, async (i) => {
    i.witness = adapter();
    expect(await i.control.change(change)).toBe("held");
    expect(await i.control.recoverAcknowledgement()).toBe("held");
    expect(await i.control.admitted()).toEqual(i.state());
  });
  expect(faults.attempts).toBe(2);
});

test("the core-only adapter holds expiry cleanup before a physical slot write", async () => {
  const { control } = await fixture();
  const now = await runInDurableObject(control, (i) => i.now());
  const pending = JSON.parse(golden.cases[0].checkpoint);
  const wire = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
  pending.prepared_at = wire(now - 1000);
  pending.covers_after = wire(now - 2 * 86_400_000);
  const sorted = (entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry;
  const raw = new TextEncoder().encode(JSON.stringify(pending, (_, entry) => sorted(entry)));
  const reserved = await control.reservePending(raw);
  expect(reserved.status).toBe("reserved");
  const before = await runInDurableObject(control, (i) => i.state());
  const { adapter, faults } = await nativePort(JSON.stringify(witnessState(before.current)));
  const fence = await env.SLOTS.head(slots[before.reservation.slot]);
  await runInDurableObject(control, async (i) => {
    i.witness = adapter();
    i.control.now = () => before.reservation.cutoff;
    expect(await i.reconcileReserved(reserved.nonce)).toBe("held");
    expect(i.state()).toEqual(before);
    expect(classify(await i.witness.read(), position(before))).toBe("ambiguous_predecessor");
    expect(await i.recoverCleanup()).toBe("held");
  });
  expect((await env.SLOTS.head(slots[before.reservation.slot])).etag).toBe(fence.etag);
  expect(faults.attempts).toBe(1);
});
