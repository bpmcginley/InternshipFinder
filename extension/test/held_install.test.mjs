// U1 and U2 (2026-10-14 UX audit): the internscout.org tabs open at install get the bridge, and the
// postings a student picked before setup are kept and offered once setup is done.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const data = {};
globalThis.chrome = { runtime: {}, storage: { local: {
  async get(k) { return typeof k === "string" ? { [k]: data[k] } : Object.fromEntries([].concat(k).map((x) => [x, data[x]])); },
  async set(o) { for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
  async remove(k) { for (const x of [].concat(k)) delete data[x]; },
}, session: {} } };

const held = await import("../background/held.js");
const install = await import("../background/install.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const index = read("background/index.js");
const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 864e5;

// ---------- U1 ----------
test("U1: the bridge's pages come from the manifest, and its match is the host access (no new permission)", () => {
  const m = install.bridgeMatches(manifest);
  assert.ok(m.includes("https://internscout.org/*"));
  assert.ok(!manifest.host_permissions.some((h) => h.includes("internscout.org")), "the install prompt is unchanged");
  assert.ok(manifest.permissions.includes("scripting") && manifest.permissions.includes("tabs"));
  assert.equal(manifest.version, "0.5.6", "no version bump in this change");
});

test("U1: every open dashboard tab gets the bridge and gives up what the offer bar remembered; one failure stops nothing", async () => {
  const calls = [];
  const tabs = { query: async (q) => { calls.push(["query", q.url]); return [{ id: 1 }, { id: 2 }, { id: 3, discarded: true }, { id: 4 }]; } };
  const scripting = { executeScript: async ({ target, files, func, args }) => {
    calls.push(["exec", target.tabId, files ? files[0] : func.name, args && args[0]]);
    if (target.tabId === 2) throw new Error("Cannot access contents of the page");
    if (func) return [{ result: target.tabId === 1 ? '{"url":"x"}' : null }];
    return [{}];
  } };
  const r = await install.connectOpenTabs({ tabs, scripting, manifest });
  assert.deepEqual(r, { connected: 2, wanted: ['{"url":"x"}'] });
  assert.deepEqual(calls[0], ["query", install.bridgeMatches(manifest)]);
  assert.deepEqual(calls.filter((c) => c[0] === "exec").map((c) => c.slice(1)), [
    [1, "bridge/bridge.js", undefined], [1, "takeWantedInPage", "internscout.wanted"],
    [2, "bridge/bridge.js", undefined],
    [4, "bridge/bridge.js", undefined], [4, "takeWantedInPage", "internscout.wanted"],
  ]);
});

test("U1: the page-side reader takes the remembered posting once and survives blocked storage", () => {
  const store = new Map([["internscout.wanted", "v"]]);
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k) };
  assert.equal(install.takeWantedInPage("internscout.wanted"), "v");
  assert.equal(install.takeWantedInPage("internscout.wanted"), null);
  globalThis.localStorage = { getItem() { throw new Error("SecurityError"); } };
  assert.equal(install.takeWantedInPage("internscout.wanted"), null);
  delete globalThis.localStorage;
});

test("U1: wired to install only, never to an update (the old bridge there still answers)", () => {
  const block = index.slice(index.indexOf("chrome.runtime.onInstalled.addListener"), index.indexOf("chrome.runtime.onStartup"));
  assert.match(block, /if \(reason === "install"\) \{\s*connectOpenTabs\(\)/);
  assert.match(block, /wantedJob\(w\)/, "what the page remembered is checked before it is kept");
});

// The bridge in a stand-in page: two copies in one page answer once; a dead copy is replaced.
function page() {
  const listeners = [], posted = [];
  const win = { addEventListener: (t, f) => t === "message" && listeners.push(f), postMessage: (m) => posted.push(m) };
  const ctx = { window: win, location: { origin: "https://internscout.org" },
    document: { documentElement: { dataset: {} }, addEventListener() {} }, posted, listeners };
  ctx.globalThis = ctx;
  win.window = win;
  vm.createContext(ctx);
  return ctx;
}
function runBridge(ctx, runtime) {
  ctx.chrome = { runtime };
  vm.runInContext(read("bridge/bridge.js"), ctx);
}
const liveRuntime = (sent) => ({ id: "ext", getManifest: () => ({ version: "0.5.6" }), lastError: null,
  connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage: (m) => sent.push(m) }) });

test("U1: a second copy of the bridge in the same page does nothing while the first is live", () => {
  const ctx = page(), sent = [];
  runBridge(ctx, liveRuntime(sent));
  runBridge(ctx, liveRuntime(sent));
  assert.equal(ctx.listeners.length, 1, "one listener for the page's requests");
  assert.equal(ctx.posted.filter((m) => m.__internscout === "hello").length, 1);
});

test("U1: a copy that finds a dead one retires it, so only the new one answers", () => {
  const ctx = page(), sent = [];
  const dead = { id: undefined, getManifest() { throw new Error("Extension context invalidated"); } };
  runBridge(ctx, { ...liveRuntime(sent), id: "old" });
  ctx.chrome.runtime.id = undefined;    // the old extension context goes away
  Object.assign(ctx.chrome.runtime, dead);
  ctx.listeners[0]({ source: ctx.window, data: { __internscout: "req", id: 1, msg: { type: "ping" } } });
  assert.ok(ctx.posted.some((m) => m.__internscout === "gone"), "the old copy is dead now");
  runBridge(ctx, liveRuntime(sent));
  assert.equal(ctx.listeners.length, 2);
  const req = { source: ctx.window, data: { __internscout: "req", id: 7, msg: { type: "ping" } } };
  ctx.posted.length = 0;
  for (const f of ctx.listeners) f(req);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ reqId: 7, msg: { type: "ping" } }], "the new copy relays it");
  assert.deepEqual(ctx.posted.filter((m) => m.__internscout === "res" || m.__internscout === "gone"), [], "the retired copy says nothing");
});

// ---------- U2 ----------
const wanted = (over = {}) => JSON.stringify({ url: "https://acme.wd1.myworkdayjobs.com/en-US/job/123", company: " Acme ", title: "Data  Intern", at: NOW - DAY, ...over });

test("U2: a remembered posting is kept only when it is recent, https and on a site Auto-Apply covers", () => {
  assert.deepEqual(held.wantedJob(wanted(), NOW), { id: null, apply_url: "https://acme.wd1.myworkdayjobs.com/en-US/job/123", company: "Acme", title: "Data Intern", location: "", description: "" });
  for (const bad of [
    wanted({ url: "https://evil.example/apply" }), wanted({ url: "http://acme.wd1.myworkdayjobs.com/job/1" }),
    wanted({ url: "javascript:alert(1)" }), wanted({ at: NOW - 4 * DAY }), wanted({ at: NOW + DAY }), wanted({ at: "soon" }),
    "not json", "null", "[]", JSON.stringify({ url: "https://x.greenhouse.io/" + "a".repeat(5000), at: NOW }), 42,
  ]) assert.equal(held.wantedJob(bad, NOW), null, String(bad).slice(0, 60));
  const long = held.wantedJob(wanted({ company: "C".repeat(500), title: "<b>T</b>" }), NOW);
  assert.equal(long.company.length, 120);
  assert.equal(long.title, "<b>T</b>", "kept as text; every page that shows it escapes it");
});

test("U2: postings picked before setup are kept once each, newest last, capped, and forgotten after two weeks", async () => {
  for (const k of Object.keys(data)) delete data[k];
  const job = (n, over = {}) => ({ id: n, apply_url: `https://boards.greenhouse.io/acme/jobs/${n}`, company: "Acme", title: `Intern ${n}`, description: "d".repeat(9000), tabId: 9, ...over });
  assert.equal(await held.holdJobs([job(1), job(2), { apply_url: "ftp://x" }, null, "x"], "dashboard", NOW), 2);
  assert.equal(await held.holdJobs([job(1, { title: "Intern 1 again" })], "dashboard", NOW + 1), 2);
  let list = await held.heldJobs(NOW + 2);
  assert.deepEqual(list.map((j) => j.title), ["Intern 2", "Intern 1 again"]);
  assert.equal(list[0].description.length, 6000);
  assert.equal(list[0].tabId, undefined, "a page can't point a job at a tab");
  assert.deepEqual(held.heldSummary(list), [{ company: "Acme", title: "Intern 2", host: "boards.greenhouse.io" }, { company: "Acme", title: "Intern 1 again", host: "boards.greenhouse.io" }]);
  assert.deepEqual(await held.heldJobs(NOW + 15 * DAY), [], "two weeks later they are gone");
  await held.holdJobs(Array.from({ length: 130 }, (_, i) => job(i + 10)), "dashboard", NOW);
  assert.equal((await held.heldJobs(NOW)).length, held.HELD_MAX);
  const taken = await held.takeHeld(NOW);
  assert.equal(taken.length, held.HELD_MAX);
  assert.equal(taken[0].from, undefined);
  assert.deepEqual(await held.heldJobs(NOW), [], "taken once");
});

test("U2: the setup page's sentence names the postings plainly", () => {
  assert.equal(held.heldLine([]), "");
  assert.equal(held.heldLine([{ company: "Acme", title: "Data Intern" }]), "Before setup you picked a posting to Auto-Apply: Acme, Data Intern.");
  assert.equal(held.heldLine([{ company: "", title: "", host: "x.icims.com" }, { company: "Beta", title: "" }, { company: "C", title: "T" }]),
    "Before setup you picked 3 postings to Auto-Apply: a posting on x.icims.com; Beta; and 1 more.");
});

test("U2: enqueue before setup keeps the jobs; only the extension's own pages can start or see them", () => {
  const enqueue = index.slice(index.indexOf('case "enqueue"'), index.indexOf('case "get_queue"'));
  assert.match(enqueue, /holdJobs\(Array\.isArray\(m\.jobs\)/);
  assert.match(enqueue, /return \{ error: "setup_required", held \}/);
  const allowed = index.slice(index.indexOf("const PAGE_ALLOWED"), index.indexOf("]);", index.indexOf("const PAGE_ALLOWED")));
  for (const t of ["held:get", "held:start", "held:clear", "auth:accept_offer", "auth:offer_status"]) assert.ok(!allowed.includes(`"${t}"`), t);
  const start = index.slice(index.indexOf('case "held:start"'), index.indexOf('case "held:clear"'));
  assert.match(start, /if \(!s\.settings\.onboarded \|\| !hasKey\(s\) \|\| resumeReviewPending\(s\)\) return \{ error: "setup_required" \}/);
  assert.match(start, /addJobs\(await takeHeld\(\)\)/);
});

test("U2: the setup page offers them only after setup, and starts them only on the student's press", () => {
  const onb = read("onboarding/onboarding.js");
  const draw = onb.slice(onb.indexOf("async function drawHeld"), onb.indexOf("// Both finish buttons"));
  assert.match(draw, /type: "held:get"/);
  assert.match(draw, /\$\("#heldgo"\)\.addEventListener\("click"[\s\S]*type: "held:start"/);
  assert.match(draw, /\$\("#heldno"\)\.addEventListener\("click"[\s\S]*type: "held:clear"/);
  assert.equal(onb.split('type: "held:start"').length, 2, "started from that one button only");
  assert.match(onb, /if \(S\.settings\.onboarded\) drawHeld\(\);/);
});
