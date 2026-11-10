import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../../docs/widget/builder.js", import.meta.url), "utf8");
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
function builder({ query = "?field=civil", fields = ["civil", "swe"], fail = false, copyFails = false } = {}) {
  const elements = new Map(), copied = [], requests = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: id === "limit" ? "8" : "", disabled: true, children: [],
      events: {}, addEventListener(event, fn) { this.events[event] = fn; }, appendChild(child) { this.children.push(child); },
      focus() { this.focused = true; }, select() { this.selected = true; } });
    return elements.get(id);
  };
  vm.runInNewContext(script, { document: { getElementById: get, createElement: () => ({}) },
    location: { search: query }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { clipboard: { async writeText(value) { if (copyFails) throw new Error("denied"); copied.push(value); } } },
    fetch: async url => { requests.push(url); if (fail) throw new Error("offline"); return { ok: true, json: async () => ({ fields }) }; } });
  return { get, copied, requests };
}

test("builder preselects a real field and emits escaped iframe code with a matching preview", async () => {
  const b = builder(); await tick();
  assert.equal(b.get("field").value, "civil");
  assert.equal(b.get("field").disabled, false);
  assert.equal(b.get("preview").src, "./?field=civil&limit=8");
  assert.match(b.get("snippet").value, /https:\/\/internscout.org\/widget\/\?field=civil&amp;limit=8/);
  b.get("limit").value = "12"; b.get("limit").events.change();
  assert.match(b.get("snippet").value, /limit=12/);
  await b.get("copy").events.click();
  assert.deepEqual(b.copied, [b.get("snippet").value]);
  assert.equal(b.get("copy-status").textContent, "Code copied.");
  assert.deepEqual(b.requests, ["../data/majors.json"]);
});

test("untrusted preselection cannot inject markup or select an unknown field", async () => {
  const b = builder({ query: "?field=%22%3E%3Cscript%3E" }); await tick();
  assert.equal(b.get("field").value, "");
  assert.equal(b.get("preview").src, "./?limit=8");
  assert.match(b.get("field-status").textContent, /unavailable/);
  assert.doesNotMatch(b.get("snippet").value, /script/);
});

test("failed or malformed field data leaves a clear all-fields fallback", async () => {
  for (const options of [{ fail: true }, { fields: ['civil', '"><img>'] }, { fields: [] }]) {
    const b = builder(options); await tick();
    assert.equal(b.get("field").disabled, true);
    assert.match(b.get("field-status").textContent, /code shows all fields/);
    assert.equal(b.get("field").children.length, 0);
  }
});

test("clipboard denial focuses and selects code for manual copying", async () => {
  const b = builder({ copyFails: true }); await tick(); await b.get("copy").events.click();
  assert.equal(b.get("snippet").focused, true);
  assert.equal(b.get("snippet").selected, true);
  assert.match(b.get("copy-status").textContent, /copy command/);
});
