import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";
import { createFollowCheckpointRuntime } from "../src/follow-checkpoint-runtime.js";
import { createFollowCheckpointPayloadCodec } from "../src/follow-checkpoint-payload.js";

const bounds = { maxBytes: 3_000_000, maxHeaderBytes: 2000, maxControlBytes: 16384 };
const codec = createFollowCheckpointPayloadCodec({
  maxCheckpointBytes: 3_000_000,
  maxPayloadBytes: 2_900_000,
  maxHeaderBytes: 2000,
  maxRows: 30000,
});
const request = (path, method = "GET") =>
  new Request("https://checkpoint.example.test/v1/checkpoint" + path, {
    method,
    headers: {
      Authorization: "Bearer " + "A".repeat(43),
      ...(method === "POST" ? { "Content-Type": "application/octet-stream" } : {}),
    },
    ...(method === "POST" ? { body: new TextEncoder().encode(golden.cases[0].checkpoint) } : {}),
  });

test("runtime absent/off/malformed opt-in touches no supplied dependency", async () => {
  let touched = 0;
  for (const enabled of [undefined, false, 0, 1, "1", "true", null, {}]) {
    const options = { enabled };
    for (const key of ["control", "slots", "codec", "witness", "maxBytes"])
      Object.defineProperty(options, key, {
        get() {
          touched++;
          throw new Error("touched");
        },
      });
    const runtime = createFollowCheckpointRuntime(options);
    expect(await runtime.read(3_000_000)).toEqual({ state: "unavailable" });
    await expect(runtime.reservePending(new ArrayBuffer(1), 3_000_000)).rejects.toThrow(
      "unavailable",
    );
    await expect(runtime.promote(new ArrayBuffer(1), 3_000_000, {})).rejects.toThrow("unavailable");
    expect(await runtime.reservations.reservePending(new Uint8Array([1]))).toEqual({
      status: "held",
    });
    expect(await runtime.reservations.uploadReserved("a".repeat(32))).toBe("held");
    expect(await runtime.reservations.reconcileReserved("a".repeat(32))).toBe("held");
    expect(await runtime.reservations.recoverCleanup()).toBe("held");
  }
  expect(touched).toBe(0);
});

test("native HTTP default-closed runtime preserves existing metadata and physical slots", async () => {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await object.bootstrap();
  const before = await runInDurableObject(object, (i) => {
    const snapshot = i.snapshot();
    i.runtime = createFollowCheckpointRuntime({
      ...bounds,
      codec,
      control: i.control,
      slots: i.slots,
      witness: () => i.witness,
    });
    return snapshot;
  });
  const etags = await Promise.all(
    [0, 1].map(async (slot) => (await env.SLOTS.head(`follow-checkpoint-slot-${slot}`)).etag),
  );
  const response = await object.fetch(request(""));
  expect(response.status).toBe(200);
  expect(response.headers.get("Follow-State")).toBe("unavailable");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
  expect((await object.fetch(request("/stage", "POST"))).status).toBe(503);
  expect(await runInDurableObject(object, (i) => i.snapshot())).toBe(before);
  expect(
    await Promise.all(
      [0, 1].map(async (slot) => (await env.SLOTS.head(`follow-checkpoint-slot-${slot}`)).etag),
    ),
  ).toEqual(etags);
});

test("enabled runtime does not initialize absent metadata or invent a witness", async () => {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  expect(await object.readSnapshot()).toEqual({ state: "unavailable" });
  const response = await object.fetch(request(""));
  expect(response.status).toBe(200);
  expect(response.headers.get("Follow-State")).toBe("unavailable");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
  expect((await object.fetch(request("/stage", "POST"))).status).toBe(503);
  expect(await runInDurableObject(object, (i) => i.state())).toBeNull();
});

test("paired runtime read pins one witness object and closes supplier failure", async () => {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await object.bootstrap();
  const result = await runInDurableObject(object, async (i) => {
    let calls = 0;
    const runtime = createFollowCheckpointRuntime({
      enabled: true,
      ...bounds,
      codec,
      control: i.control,
      slots: i.slots,
      witness: () => {
        if (++calls > 1) throw new Error("provider switched");
        return i.witness;
      },
    });
    const read = await runtime.read(bounds.maxBytes);
    const closed = await runtime.read(bounds.maxBytes);
    return { calls, read, closed };
  });
  expect(result).toEqual({
    calls: 2,
    read: { state: "never_seeded" },
    closed: { state: "unavailable" },
  });
});

test("invalid enabled runtime bounds fail before native witness or object I/O", async () => {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await runInDurableObject(object, (i) => {
    let calls = 0;
    expect(() =>
      createFollowCheckpointRuntime({
        enabled: true,
        ...bounds,
        maxBytes: 8_000_001,
        codec,
        control: i.control,
        slots: i.slots,
        witness: () => {
          calls++;
          throw new Error("must not run");
        },
      }),
    ).toThrow("Invalid checkpoint snapshot dependencies");
    expect(calls).toBe(0);
    expect(i.state()).toBeNull();
  });
});

test("invalid limit and missing metadata never acquire a witness", async () => {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await runInDurableObject(object, async (i) => {
    let calls = 0;
    const runtime = createFollowCheckpointRuntime({
      enabled: true,
      ...bounds,
      codec,
      control: i.control,
      slots: i.slots,
      witness: () => {
        calls++;
        throw new Error("must not run");
      },
    });
    expect(await runtime.read(0)).toEqual({ state: "unavailable" });
    expect(await runtime.read(bounds.maxBytes)).toEqual({ state: "unavailable" });
    expect(calls).toBe(0);
  });
});
