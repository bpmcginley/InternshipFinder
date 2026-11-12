import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { WitnessDouble } from "./worker.js";
import { FollowCheckpointControl } from "../src/follow-checkpoint-control.js";

async function fixture() {
  await env.SLOTS.delete(["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"]);
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await object.bootstrap();
  return object;
}

test("source control does not initialize missing authority or accept absent witness", async () => {
  const object = env.CHECKPOINT.get(env.CHECKPOINT.newUniqueId());
  await runInDurableObject(object, async (i) => {
    expect(i.control.capture().raw).toBeUndefined();
    expect(await i.control.admitted()).toBeNull();
    expect(await i.control.change(() => true)).toBe("held");
    expect(await i.control.recoverAcknowledgement()).toBe("held");
    expect(i.control.state()).toBeNull();
  });
});

test("source transaction repeats its predicate at fresh SQLite UTC and exposes exact receipt", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.control.capture(),
      calls = [];
    i.beforeCommit = () => new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      await i.control.change((state, now) => {
        calls.push(now);
        state.initialized = true;
        return true;
      }),
    ).toBe("committed");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeGreaterThan(calls[0]);
    const state = i.control.state(),
      previous = JSON.parse(before.raw).current;
    expect(state.current.revision).toBe(previous.revision + 1);
    expect(state.receipt.previous).toEqual(previous);
    expect(await i.control.admitted()).toEqual(state);
    expect(i.control.capture().raw).not.toContain('"rows"');
  });
});

test("source stale predicate and revision exhaustion never prepare external ownership", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.snapshot();
    expect(await i.control.change(() => false)).toBe("stale");
    expect(
      await i.control.change(async (draft) => {
        draft.initialized = true;
        return true;
      }),
    ).toBe("stale");
    expect(i.snapshot()).toBe(before);
    const state = i.state();
    state.current.revision = Number.MAX_SAFE_INTEGER;
    i.save(state);
    i.witness = new WitnessDouble(state.current);
    const witness = await i.witness.read();
    expect(await i.control.change(() => true)).toBe("held");
    expect(i.state()).toEqual(state);
    expect(await i.witness.read()).toEqual(witness);
  });
});

test("source concurrent changes preserve one ownership transition", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.state();
    const action = (state) => {
      state.initialized = true;
      return true;
    };
    const outcomes = await Promise.all([i.control.change(action), i.control.change(action)]);
    expect(outcomes.filter((v) => v === "committed")).toHaveLength(1);
    expect(outcomes.filter((v) => v === "held")).toHaveLength(1);
    expect(i.state().current.revision).toBe(before.current.revision + 1);
  });
});

test("source write rollback keeps prepared witness closed", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.snapshot();
    i.ctx.storage.sql.exec(
      "CREATE TRIGGER fail_control BEFORE INSERT ON control BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    expect(
      await i.control.change((state) => {
        state.initialized = true;
        return true;
      }),
    ).toBe("held");
    expect(i.snapshot()).toBe(before);
    expect((await i.witness.read()).phase).toBe("prepared");
    expect(await i.control.recoverAcknowledgement()).toBe("held");
  });
});

test("cold source acknowledgement recovery needs the exact external successor receipt", async () => {
  const object = await fixture();
  const saved = await runInDurableObject(object, async (i) => {
    i.witness.failFinish = "before";
    expect(
      await i.control.change((state) => {
        state.initialized = true;
        return true;
      }),
    ).toBe("held");
    return { state: i.state(), witness: await i.witness.read() };
  });
  await evictDurableObject(object);
  await runInDurableObject(object, async (i) => {
    expect(await i.control.admitted()).toBeNull();
    const witness = new WitnessDouble(saved.witness.current);
    witness.value = saved.witness;
    i.witness = witness;
    expect(await i.control.recoverAcknowledgement()).toBe("recovered");
    expect(i.state()).toEqual(saved.state);
    expect(await i.control.recoverAcknowledgement()).toBe("held");
  });
});

test("source rejects invalid ports and noninteger database time", async () => {
  expect(() => new FollowCheckpointControl({}, { witness: () => null })).toThrow(TypeError);
  const object = await fixture();
  await runInDurableObject(object, (i) => {
    const storage = {
      transactionSync: (fn) => i.ctx.storage.transactionSync(fn),
      sql: {
        exec: (sql, ...args) =>
          sql.startsWith("SELECT CAST")
            ? { one: () => ({ now: NaN }) }
            : i.ctx.storage.sql.exec(sql, ...args),
      },
    };
    const control = new FollowCheckpointControl(storage, { witness: () => i.witness });
    expect(() => control.capture()).toThrow("Checkpoint clock unavailable");
  });
});
