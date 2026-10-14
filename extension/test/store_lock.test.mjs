// updateStore reads, changes and writes back the whole store. Two at once used to lose one change:
// a site login saved by one job and an answer saved by another left the login out (product review
// 2026-10-13, Codex #4). Storage here answers after a random delay, as chrome.storage does under load.
import test from "node:test";
import assert from "node:assert/strict";

const data = {};
const later = () => new Promise((r) => setTimeout(r, Math.random() * 8));
globalThis.chrome = { storage: { local: {
  async get(k) { await later(); return Object.fromEntries([].concat(k).filter((x) => x in data).map((x) => [x, JSON.parse(JSON.stringify(data[x]))])); },
  async set(o) { await later(); for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
  async remove(k) { for (const x of [].concat(k)) delete data[x]; },
} } };

const { updateStore, loadStore, emptyStore } = await import("../lib/store.js");

test("a new site login and an answer saved at the same moment are both kept", async () => {
  data.store = emptyStore();
  await Promise.all([
    updateStore((s) => { s.accounts.push({ domain: "acme.wd1.myworkdayjobs.com", email: "a@b.edu", password: "x", created: 1 }); }),
    updateStore((s) => { s.answers = [...s.answers, { question: "Why Acme?", answer: "Because." }]; }),
  ]);
  const s = await loadStore();
  assert.equal(s.accounts.length, 1);
  assert.equal(s.answers.length, 1);
});

test("fifty writes at once keep all fifty", async () => {
  data.store = emptyStore();
  await Promise.all(Array.from({ length: 50 }, (_, i) => updateStore(async (s) => {
    await later();
    s.answers = [...s.answers, { question: "q" + i, answer: String(i) }];
  })));
  const s = await loadStore();
  assert.equal(s.answers.length, 50);
  assert.deepEqual(new Set(s.answers.map((a) => a.answer)).size, 50);
});

test("a write that throws does not block the ones after it", async () => {
  data.store = emptyStore();
  await assert.rejects(updateStore(() => { throw new Error("boom"); }));
  await updateStore((s) => { s.answers = [{ question: "q", answer: "a" }]; });
  assert.equal((await loadStore()).answers.length, 1);
});
