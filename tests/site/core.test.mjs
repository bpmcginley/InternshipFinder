// docs/js/core.js runs in the browser with no build step and no exports, so it is loaded here the way
// the page loads it: evaluated against a stand-in `window`, after which it hangs its API on window.IS.
// Kept outside docs/ so the test isn't published with the site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CORE = readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8");

// A fresh copy of core.js for each test, with `fetch` answered by the test.
function loadCore(fetchImpl) {
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = {
    CONFIG: { dataUrl: "./data/", rawDataFallback: "https://raw.example/data/" },
    fetch: fetchImpl, localStorage: store(), sessionStorage: store(),
    addEventListener() {}, postMessage() {}, setTimeout, clearTimeout,
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
const notFound = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
const MAJORS = { majors: [{ name: "Nursing", tags: ["nursing", "health"], related: [] }], fields: ["nursing", "health"] };

test("step 1 says the majors are loading, not that they failed, until the fetch settles", () => {
  const IS = loadCore(() => new Promise(() => {}));
  const loading = IS.majorsNote(null, false);
  assert.match(loading, /^Loading/);
  assert.doesNotMatch(loading, /didn't load/);
  assert.match(IS.majorsNote(null, true), /didn't load/);
  assert.equal(IS.majorsNote(MAJORS, true), null);
  assert.equal(IS.majorsNote(MAJORS, false), null);
});

test("loadMajors stays pending while majors.json is still downloading", async () => {
  // The race: the page held null while this promise was pending and showed the failure text.
  const IS = loadCore(() => new Promise(() => {}));
  const outcome = await Promise.race([
    IS.loadMajors().then(() => "settled"),
    new Promise(r => setTimeout(() => r("pending"), 50)),
  ]);
  assert.equal(outcome, "pending");
});

test("loadMajors resolves null only after every source has failed", async () => {
  const asked = [];
  const IS = loadCore(url => { asked.push(url); return url.startsWith("https://raw.example/") ? Promise.reject(new Error("offline")) : notFound(); });
  assert.equal(await IS.loadMajors(), null);
  assert.equal(asked.length, 2, "tried the site copy and the raw fallback");
});

test("loadMajors falls back to the raw copy when the site's own copy fails", async () => {
  const IS = loadCore(url => url.startsWith("./data/") ? notFound() : ok(MAJORS));
  const m = await IS.loadMajors();
  assert.equal(m.majors[0].name, "Nursing");
  assert.equal(IS.majorsNote(m, true), null);
});
