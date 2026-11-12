import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import golden from "../test/fixtures/follow-checkpoint-payload.json";

const DAY = 86_400_000,
  encoder = new TextEncoder();
const stamp = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
const bytes = (value) =>
  encoder.encode(
    JSON.stringify(value, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
    ),
  );
const hash = async (raw) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
async function seed({ old = true, expiry = false, retire = false } = {}) {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  const pending = JSON.parse(golden.cases[0].checkpoint),
    accepted = JSON.parse(golden.cases[1].checkpoint);
  const now = Date.now();
  for (const value of [pending, accepted]) {
    value.covers_after = stamp(now - 10 * DAY);
    for (const row of value.rows) {
      row[1] = stamp(now - 9 * DAY);
      row[3] = stamp(now - 9 * DAY);
    }
  }
  accepted.accepted_at = stamp(retire ? now - 7 * DAY + 6000 : now - DAY);
  const prior = old ? bytes(accepted) : null;
  if (old)
    pending.predecessor = {
      commit: accepted.accepted_commit,
      public_tree: accepted.public_tree,
      checkpoint_sha256: await hash(prior),
    };
  await object.bootstrap(prior);
  const nativeNow = await object.now();
  pending.prepared_at = stamp(expiry ? nativeNow - DAY + 6000 : nativeNow - 1000);
  const raw = bytes(pending),
    reserved = await object.reservePending(raw);
  expect(reserved.status).toBe("reserved");
  expect(await object.uploadReserved(reserved.nonce)).toBe("stored");
  expect(await object.reconcileReserved(reserved.nonce)).toBe("committed");
  return { object, pending: raw, accepted: prior };
}

test("paired source reader supplies exact authenticated HTTP framing and phase bytes", async () => {
  const { object, pending, accepted } = await seed();
  const result = await object.readSnapshot();
  expect(result.state).toBe("active");
  expect(new Uint8Array(result.accepted)).toEqual(accepted);
  expect(new Uint8Array(result.pending)).toEqual(pending);
  for (const phase of ["accepted", "pending"])
    expect(new Uint8Array(result[phase])).toEqual((await object.read(phase)).bytes);
  const request = (authorization) =>
    new Request("https://checkpoint.example.test/v1/checkpoint", {
      headers: { Authorization: authorization },
    });
  expect((await object.fetch(request("Bearer " + "C".repeat(43)))).status).toBe(401);
  const response = await object.fetch(request("Bearer " + "A".repeat(43)));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Follow-Accepted-Bytes")).toBe(String(accepted.length));
  expect(response.headers.get("Follow-Pending-Bytes")).toBe(String(pending.length));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array([...accepted, ...pending]),
  );
  expect(await object.readSnapshot(accepted.length - 1)).toEqual({ state: "unavailable" });
});

for (const fault of [
  "reservation",
  "malformed",
  "clock",
  "header-time",
  "slot",
  "witness",
  "closed",
  "prepared",
  "missing",
])
  test(`paired snapshot refuses ${fault} without partial bodies`, async () => {
    const { object } = await seed();
    await runInDurableObject(object, async (instance) => {
      const state = instance.state();
      if (fault === "reservation") state.reservation = {};
      if (fault === "malformed") state.initialized = "true";
      if (fault === "header-time") state.pending.expires++;
      if (fault === "slot") state.pending.slot = state.accepted.slot;
      if (fault === "missing") instance.ctx.storage.sql.exec("DELETE FROM control");
      else instance.save(state);
      if (fault === "clock") {
        let calls = 0;
        const now = instance.now();
        instance.control.now = () => now - calls++;
      }
      if (fault === "witness") instance.witness = null;
      if (fault === "closed") instance.witness.value.phase = "closed";
      if (fault === "prepared")
        await instance.witness.prepare(state.current, {
          nonce: crypto.randomUUID().replaceAll("-", ""),
          next: {
            ...state.current,
            revision: state.current.revision + 1,
            token: crypto.randomUUID().replaceAll("-", ""),
          },
        });
      expect(await instance.readSnapshot()).toEqual({ state: "unavailable" });
    });
  });

for (const fault of ["control", "witness", "object", "expiry"])
  test(`paired snapshot fences ${fault} during the second native slot read`, async () => {
    const { object } = await seed({ expiry: fault === "expiry" });
    await runInDurableObject(object, async (instance) => {
      const read = instance.slots.read,
        original = instance.state();
      instance.slots.read = async (slot) => {
        const result = await read(slot);
        if (slot === original.pending.slot) {
          if (fault === "control") {
            const changed = instance.state();
            changed.current.revision++;
            instance.save(changed);
          }
          if (fault === "witness") instance.witness.value.phase = "closed";
          if (fault === "object") result.nonce = "0".repeat(32);
          if (fault === "expiry")
            while (instance.now() < original.pending.expires)
              await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return result;
      };
      expect(await instance.readSnapshot()).toEqual({ state: "unavailable" });
      if (fault === "expiry")
        expect(instance.now()).toBeGreaterThanOrEqual(original.pending.expires);
    });
  });

test("missing control is unavailable, while attested first-generation pending is never seeded", async () => {
  const { object, pending } = await seed({ old: false });
  const result = await object.readSnapshot();
  expect(result.state).toBe("never_seeded");
  expect(result.accepted).toBeUndefined();
  expect(new Uint8Array(result.pending)).toEqual(pending);
  await runInDurableObject(object, async (instance) => {
    instance.witness = null;
    const response = await instance.fetch(
      new Request("https://checkpoint.example.test/v1/checkpoint", {
        headers: { Authorization: "Bearer " + "A".repeat(43) },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Follow-State")).toBe("unavailable");
    expect(response.headers.get("Follow-Accepted-Bytes")).toBe("0");
    expect(response.headers.get("Follow-Pending-Bytes")).toBe("0");
    expect(await response.text()).toBe("");
  });
});

test("paired read preserves live pending after predecessor retirement and physical cleanup", async () => {
  const { object, pending } = await seed({ retire: true });
  await runInDurableObject(object, async (instance) => {
    const expiry = instance.state().accepted.expires;
    while (instance.now() < expiry) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await instance.retireExpired("accepted")).toBe("committed");
    expect(await instance.cleanupRetired()).toBe("committed");
    const result = await instance.readSnapshot();
    expect(result.state).toBe("expired");
    expect(result.accepted).toBeUndefined();
    expect(new Uint8Array(result.pending)).toEqual(pending);
    expect(new Uint8Array(result.pending)).toEqual((await instance.read("pending")).bytes);
  });
});
