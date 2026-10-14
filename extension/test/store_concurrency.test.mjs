import test from "node:test";
import assert from "node:assert/strict";

let data = {}, lockTail = Promise.resolve();
const requests = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
  request(name, callback) {
    requests.push(name);
    const next = lockTail.then(callback, callback);
    lockTail = next.catch(() => {});
    return next;
  },
} } });
globalThis.chrome = { runtime: { id: "fixture-extension" }, storage: { local: {
  async get(keys) { await new Promise((r) => setTimeout(r, 5)); return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
  async set(value) { await new Promise((r) => setTimeout(r, 5)); Object.assign(data, structuredClone(value)); },
  async remove(keys) { for (const k of keys) delete data[k]; },
} } };
// Separate module instances represent extension pages and the service worker: a
// module-local queue alone would not serialize these three callers.
const worker = await import("../lib/store.js?context=worker");
const page = await import("../lib/store.js?context=page");
const panel = await import("../lib/store.js?context=panel");

test("cross-context store mutations preserve credentials, learned answers, and profile edits", async () => {
  data = { store: worker.emptyStore() };
  await Promise.all([
    worker.updateStore(async (s) => { await new Promise((r) => setTimeout(r, 15)); s.accounts.push({ domain: "example.test", password: "fixture" }); }),
    page.updateStore((s) => { s.profile.facts.phone = "page-number"; }),
    panel.updateStore((s) => { s.profile.extra["Question"] = "Learned answer"; }),
  ]);
  assert.equal(data.store.accounts.length, 1);
  assert.equal(data.store.profile.facts.phone, "page-number");
  assert.equal(data.store.profile.extra.Question, "Learned answer");
  assert.ok(requests.every((name) => name === "internscout-store"), "keep the lock shared with older open extension pages");
});

test("concurrent first-load migration cannot reset a subsequent update", async () => {
  data = { internscout: { first_name: "Legacy student" } };
  await Promise.all([
    page.loadStore(),
    worker.updateStore((s) => { s.accounts.push({ domain: "example.test" }); }),
    panel.loadStore(),
  ]);
  assert.equal(data.store.profile.facts.first_name, "Legacy student");
  assert.equal(data.store.accounts.length, 1);
  assert.equal(data.internscout, undefined);
});

test("a rejected mutation releases the lock and leaves the previous store intact", async () => {
  data = { store: worker.emptyStore() };
  await assert.rejects(worker.updateStore((s) => { s.profile.facts.phone = "discard"; throw new Error("fixture failure"); }), /fixture failure/);
  await page.updateStore((s) => { s.profile.facts.first_name = "Next edit"; });
  assert.equal(data.store.profile.facts.phone, "");
  assert.equal(data.store.profile.facts.first_name, "Next edit");
});
