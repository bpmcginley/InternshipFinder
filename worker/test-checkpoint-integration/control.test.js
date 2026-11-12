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
    for (const effect of [false, 0, "", {}, []])
      expect(await i.control.change(() => true, effect)).toBe("held");
    expect(i.snapshot()).toBe(before);
    expect((await i.witness.read()).phase).toBe("stable");
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

test("unknown prepare acknowledgement cannot run an effect or write SQLite", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.snapshot();
    let effects = 0;
    i.witness.prepare = async () => ({ status: "unknown" });
    expect(
      await i.control.change(
        (state) => {
          state.initialized = true;
          return true;
        },
        async () => {
          effects++;
          return true;
        },
      ),
    ).toBe("held");
    expect(effects).toBe(0);
    expect(i.snapshot()).toBe(before);
  });
});

test("external effect cannot mutate the privately captured successor or predecessor", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.state();
    expect(
      await i.control.change(
        (state) => {
          state.initialized = true;
          return true;
        },
        async (previous, intent) => {
          previous.current.token = "0".repeat(32);
          intent.next.token = "0".repeat(32);
          intent.nonce = "0".repeat(32);
          return true;
        },
      ),
    ).toBe("committed");
    const external = await i.witness.read();
    expect(external.phase).toBe("stable");
    expect(external.current).toEqual(i.state().current);
    expect(i.state().receipt.previous).toEqual(before.current);
    expect(i.state().receipt.nonce).not.toBe("0".repeat(32));
  });
});

for (const port of ["effect", "finish", "recovery"])
  test(`unknown ${port} acknowledgement never reports a committed operation`, async () => {
    const object = await fixture();
    await runInDurableObject(object, async (i) => {
      const before = i.snapshot(),
        action = (state) => {
          state.initialized = true;
          return true;
        };
      if (port === "effect") {
        expect(await i.control.change(action, async () => ({ status: "unknown" }))).toBe("held");
        expect(i.snapshot()).toBe(before);
      } else {
        const finish = i.witness.finish.bind(i.witness);
        if (port === "recovery") {
          i.witness.failFinish = "before";
          expect(await i.control.change(action)).toBe("held");
          i.witness.failFinish = null;
        }
        i.witness.finish = async (control) => {
          await finish(control);
          return { status: "unknown" };
        };
        expect(
          await (port === "finish" ? i.control.change(action) : i.control.recoverAcknowledgement()),
        ).toBe("held");
        expect(await i.control.admitted()).toEqual(i.state());
      }
    });
  });

test("witness mutation of argument copies cannot change the private CAS or receipt", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.state(),
      prepare = i.witness.prepare.bind(i.witness),
      finish = i.witness.finish.bind(i.witness);
    i.witness.prepare = async (previous, intent) => {
      const result = await prepare(previous, intent);
      previous.token = "0".repeat(32);
      intent.next.token = "0".repeat(32);
      intent.nonce = "0".repeat(32);
      return result;
    };
    i.witness.finish = async (control) => {
      const result = await finish(control);
      control.current.token = "0".repeat(32);
      control.receipt.previous.token = "0".repeat(32);
      return result;
    };
    expect(
      await i.control.change((state) => {
        state.initialized = true;
        return true;
      }),
    ).toBe("committed");
    expect(i.state().receipt.previous).toEqual(before.current);
    expect((await i.witness.read()).current).toEqual(i.state().current);
  });
});

for (const recover of [false, true])
  test(`one pinned witness owns the complete operation (recovery=${recover})`, async () => {
    const object = await fixture();
    await runInDurableObject(object, async (i) => {
      const action = (state) => {
        state.initialized = true;
        return true;
      };
      if (recover) {
        i.witness.failFinish = "before";
        expect(await i.control.change(action)).toBe("held");
        i.witness.failFinish = null;
      }
      const first = i.witness,
        second = new WitnessDouble(i.state().current),
        other = await second.read();
      let lookups = 0;
      const control = new FollowCheckpointControl(i.ctx.storage, {
        witness: () => (++lookups === 1 ? first : second),
      });
      expect(await (recover ? control.recoverAcknowledgement() : control.change(action))).toBe(
        recover ? "recovered" : "committed",
      );
      expect(lookups).toBe(1);
      expect((await first.read()).current).toEqual(i.state().current);
      expect(await second.read()).toEqual(other);
    });
  });

test("failed witness supplier keeps admission, change and recovery closed", async () => {
  const object = await fixture();
  await runInDurableObject(object, async (i) => {
    const before = i.snapshot(),
      control = new FollowCheckpointControl(i.ctx.storage, {
        witness: () => {
          throw new Error("synthetic supplier unavailable");
        },
      });
    expect(await control.admitted()).toBeNull();
    expect(await control.change(() => true)).toBe("held");
    expect(await control.recoverAcknowledgement()).toBe("held");
    expect(i.snapshot()).toBe(before);
  });
});

for (const rejectAt of [1, 2])
  test(`rejecting async predicate at evaluation ${rejectAt} is consumed without writes`, async () => {
    const object = await fixture();
    await runInDurableObject(object, async (i) => {
      const before = i.snapshot();
      let calls = 0;
      const outcome = await i.control.change((state) => {
        state.initialized = true;
        return ++calls === rejectAt
          ? Promise.reject(new Error("synthetic rejected predicate"))
          : true;
      });
      expect(outcome).toBe(rejectAt === 1 ? "stale" : "held");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(rejectAt);
      expect(i.snapshot()).toBe(before);
      expect((await i.witness.read()).phase).toBe(rejectAt === 1 ? "stable" : "prepared");
    });
  });
