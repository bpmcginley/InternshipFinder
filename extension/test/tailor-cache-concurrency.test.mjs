import { test } from "node:test";
import assert from "node:assert/strict";
import { readTailored, writeTailored, clearTailored } from "../lib/tailor_cache.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// Chrome returns independent snapshots, unlike a fake that shares a mutable object.
function storage() {
  let data = {};
  return {
    get: async (key) => structuredClone({ [key]: data[key] }),
    set: async (value) => {
      Object.assign(data, structuredClone(value));
    },
    remove: async (key) => {
      delete data[key];
    },
    raw: () => structuredClone(data),
  };
}

test("two successful writes from the same initial cache retain both results", async () => {
  const store = storage();
  await Promise.all([
    writeTailored("first", { summary: "one" }, store),
    writeTailored("second", { summary: "two" }, store),
  ]);
  assert.deepEqual(await readTailored("first", store), { summary: "one" });
  assert.deepEqual(await readTailored("second", store), { summary: "two" });
});

test("clear is ordered with writes while reads remain independent", async () => {
  const store = storage(),
    entered = deferred(),
    release = deferred();
  const set = store.set,
    remove = store.remove;
  let removals = 0;
  store.remove = async (key) => {
    removals++;
    await remove(key);
  };
  store.set = async (value) => {
    entered.resolve();
    await release.promise;
    await set(value);
  };
  const first = writeTailored("before", { summary: "one" }, store);
  await entered.promise;
  const clear = clearTailored(store);
  const last = writeTailored("after", { summary: "two" }, store);
  assert.equal(await readTailored("before", store), null);
  assert.equal(removals, 0, "clear waits for the earlier write");
  release.resolve();
  await Promise.all([first, clear, last]);
  assert.deepEqual(Object.keys(store.raw().tailor_cache), ["after"]);
});

for (const method of ["get", "set", "remove"])
  test(`failed ${method} does not reject or strand the next mutation`, async () => {
    const store = storage(),
      original = store[method];
    let fail = true;
    store[method] = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("synthetic storage failure");
      }
      return original(...args);
    };
    const failed = method === "remove" ? clearTailored(store) : writeTailored("failed", {}, store);
    const next = writeTailored("next", { summary: "survives" }, store);
    await Promise.all([failed, next]);
    assert.deepEqual(await readTailored("next", store), { summary: "survives" });
  });

test("concurrent same-millisecond writes preserve the twelve-entry tie rule", async () => {
  const store = storage(),
    now = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeTailored(`key${i}`, { i }, store)));
  } finally {
    Date.now = now;
  }
  assert.deepEqual(
    Object.keys(store.raw().tailor_cache),
    Array.from({ length: 12 }, (_, i) => `key${i + 8}`),
  );
});

test("actual tailoring repeats hit both cached results without another model request", async () => {
  const store = storage(),
    entered = deferred(),
    release = deferred(),
    secondCall = deferred();
  const previousChrome = globalThis.chrome,
    previousFetch = globalThis.fetch;
  const set = store.set;
  let cacheWrites = 0,
    calls = 0;
  store.set = async (value) => {
    if (value.tailor_cache && ++cacheWrites === 1) {
      entered.resolve();
      await release.promise;
    }
    await set(value);
  };
  globalThis.chrome = { storage: { local: store } };
  globalThis.fetch = async () => {
    if (++calls === 2) secondCall.resolve();
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };
  try {
    const { tailorResume } = await import("../background/tailor.js");
    const profile = {
      ai: { provider: "anthropic", apiKey: "synthetic" },
      settings: { tailor_resume: "review", ai_mode: "balanced" },
      profile: {
        facts: { first_name: "Sample", last_name: "Student" },
        goals: { career: "" },
        voice: { summary: "" },
        experience: [],
        education: [],
        projects: [],
        skills: { technical: [], tools: [], soft: [] },
      },
      files: {},
    };
    const job = (title) => ({
      company: "Synthetic Lab",
      title,
      description: "Synthetic posting",
      run_id: title,
    });
    const first = tailorResume(profile, job("first"));
    await entered.promise;
    const second = tailorResume(profile, job("second"));
    await secondCall.promise; // Provider work is not held by the first cache write.
    await new Promise((done) => setImmediate(done));
    release.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 2);
    for (const [i, title] of ["first", "second"].entries()) {
      const repeat = await tailorResume(profile, job(title));
      assert.equal(repeat.reused, true);
      assert.equal(repeat.cost_usd, 0);
      assert.deepEqual(repeat.file, results[i].file);
    }
    assert.equal(calls, 2);
  } finally {
    release.resolve();
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});
