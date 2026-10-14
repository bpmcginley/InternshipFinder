// The first-screen file (P2) and deferred React (P1). data/first.json is written by the backend export
// (export_static.first_screen); the dashboard paints from it before the state files arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const CORE = read("docs/js/core.js");
const FIX = JSON.parse(read("tests/site/fixtures/first_screen.json"));

function loadCore(fetchImpl) {
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = {
    CONFIG: { dataUrl: "./data/", rawDataFallback: "https://raw.example/data/" },
    fetch: fetchImpl, localStorage: store(), sessionStorage: store(),
    addEventListener() {}, postMessage() {}, setTimeout, clearTimeout,
    AbortController, TextDecoder, URLSearchParams,
    location: { origin: "https://internscout.org", pathname: "/", search: "", hash: "" },
    document: { documentElement: { dataset: {} } },
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  return ctx.IS;
}
const ok = body => Promise.resolve({ ok: true, status: 200, json: async () => body });
const INDEX = { generated_at: "now", files: { MA: { file: "listings/MA.json", open: 2 } }, first: { file: "first.json", keys: ["MA", "remote"], sort: "new", rows: 1 } };
const noProfile = IS => x => IS.score(x, { p: null, direct: new Set(), related: new Set(), keys: new Set(), anywhere: true });

test("the dashboard's newest-first order is the order the export writes first.json in", () => {
  const IS = loadCore(() => new Promise(() => {}));
  const first = new Set(["MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "remote"]);
  const rows = FIX.rows.filter(x => x.status === "open" && [...IS.shardKeys(x)].some(k => first.has(k)));
  IS.sortRows(rows, "new", noProfile(IS), null);
  assert.deepEqual(rows.map(x => x.id), FIX.expected_all);
});

test("the first-screen rows go in first, once, and the state file's copies of them are ignored", async () => {
  const asked = [];
  const IS = loadCore(url => {
    asked.push(url.replace(/\?.*/, ""));
    if (url.includes("index.json")) return ok(INDEX);
    if (url.includes("first.json")) return ok([{ id: "a", title: "From first", status: "open" }]);
    return ok([{ id: "a", title: "From MA", status: "open" }, { id: "b", title: "Only in MA", status: "open" }]);
  });
  const store = IS.createStore(); await store.init();
  assert.equal(await store.primer(), true);
  assert.equal(await store.primer(), true);
  assert.deepEqual([...store.all()].map(x => x.id), ["a"]);
  await store.ensure(["MA"]);
  assert.deepEqual([...store.all()].map(x => [x.id, x.title]), [["a", "From first"], ["b", "Only in MA"]]);
  assert.equal(asked.filter(u => u.endsWith("first.json")).length, 1);
  assert.equal(asked.find(u => u.endsWith("first.json")), "./data/first.json");
});

test("no first-screen file, or one that fails, changes nothing", async () => {
  const noFirst = loadCore(url => url.includes("index.json") ? ok({ ...INDEX, first: undefined }) : ok([{ id: "b", status: "open" }]));
  const s1 = noFirst.createStore(); await s1.init();
  assert.equal(await s1.primer(), false);
  await s1.ensure(["MA"]); assert.deepEqual([...s1.all()].map(x => x.id), ["b"]);

  const broken = loadCore(url => url.includes("index.json") ? ok(INDEX) : url.includes("first.json")
    ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) : ok([{ id: "b", status: "open" }]));
  const s2 = broken.createStore({ retryDelayMs: 0 }); await s2.init();
  assert.equal(await s2.primer(), false);
  await s2.ensure(["MA"]); assert.deepEqual([...s2.all()].map(x => x.id), ["b"]);
});

test("the dashboard uses the first-screen file only for the list it was written for", () => {
  const app = read("docs/js/app.js");
  assert.match(app, /const prime = !p && !everything && scope\.all && !qKeys\.length && f\.sort === "new";/);
  assert.match(app, /if \(prime\) \{ await st\.primer\(\); if \(!live\) return; paint\(\); \}\s*const bad = await st\.ensure\(plan\.first/);
});

test("React is deferred, ahead of core.js and app.js, so the static hero paints first (P1)", () => {
  const html = read("docs/index.html");
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => ({ src: m[1], tag: m[0] }));
  const at = s => tags.findIndex(t => t.src.includes(s));
  for (const s of ["react.production", "react-dom.production", "js/core.js", "js/app.js"]) assert.match(tags[at(s)].tag, /\sdefer\b/, s);
  assert.ok(at("/react@") < at("/react-dom@") && at("/react-dom@") < at("js/core.js") && at("js/core.js") < at("js/app.js"));
  // No inline script may call React before the deferred ones have run.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
  assert.doesNotMatch(inline, /\bReact(DOM)?\./);
});

// Once the pipeline has written first.json, it must be the top of the first-visit list built from the
// state files it was taken from (the same export, so the same commit).
test("the committed first.json is the top of the first-visit list", { skip: !existsSync(new URL("../../docs/data/first.json", import.meta.url)) }, () => {
  const IS = loadCore(() => new Promise(() => {}));
  const index = JSON.parse(read("docs/data/listings/index.json"));
  const first = JSON.parse(read("docs/data/first.json"));
  const byId = new Map();
  for (const k of index.first.keys) if (index.files[k]) for (const x of JSON.parse(read("docs/data/" + index.files[k].file))) if (!byId.has(x.id)) byId.set(x.id, x);
  const rows = [...byId.values()].filter(x => x.status === "open");
  IS.sortRows(rows, "new", noProfile(IS), null);
  const key = x => [x.posted_at ? 1 : 0, x.posted_at || "", x.first_seen || ""].join("|");
  // Ties at the edge may fall either way; the keys must match position by position.
  assert.deepEqual(first.map(key), rows.slice(0, first.length).map(key));
  assert.equal(first.length, index.first.rows);
});
