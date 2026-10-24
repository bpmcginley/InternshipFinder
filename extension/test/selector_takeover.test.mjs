// 2026-10-23: late asynchronous selector results must not pick, clear, Escape or blur after Take over.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const SRC = readFileSync(new URL("../agent/actions.js", import.meta.url), "utf8");

function fixture() {
  let stopped = false, options = [], onClick = null, onInput = null;
  const effects = { picks: 0, escapes: 0, blurs: 0, inputs: 0, keys: [] };
  class Input {
    constructor() { this.tagName = "INPUT"; this.nodeType = 1; this.attrs = {}; this.isConnected = true; this._value = ""; this.id = ""; this.className = ""; this.textContent = ""; }
    get value() { return this._value; } set value(v) { this._value = v; }
    getAttribute(k) { return this.attrs[k] || null; }
    querySelector() { return null; } querySelectorAll() { return []; }
    closest() { return null; } contains(n) { return n === this; }
    getBoundingClientRect() { return { width: 200, height: 30 }; }
    focus() {} click() { if (onClick) onClick(); }
    dispatchEvent(e) {
      if (e.type === "input") { effects.inputs++; if (onInput) onInput(); }
      if (e.type === "blur" || e.type === "focusout") effects.blurs++;
      if (e.type === "keydown") { effects.keys.push(e.key); if (e.key === "Escape") effects.escapes++; }
      return true;
    }
  }
  const zone = { className: "", querySelector: () => null, querySelectorAll: sel => sel === "*" ? [] : options, classList: { contains: () => false } };
  const input = new Input(); input.parentElement = zone;
  const option = { textContent: "Canada", isConnected: true, className: "", classList: { contains: () => false },
    querySelector: () => null, contains: () => false, getBoundingClientRect: () => ({ width: 200, height: 30 }), dispatchEvent: () => true,
    click() { effects.picks++; input.value = "Canada"; } };
  const doc = { body: zone, querySelector: () => null, getElementById: () => null,
    querySelectorAll: sel => sel === "*" ? [] : options };
  const ctx = vm.createContext({ document: doc, HTMLInputElement: Input, HTMLTextAreaElement: Input, HTMLSelectElement: Input,
    Event, KeyboardEvent: class extends Event { constructor(t, v) { super(t, v); this.key = v.key; } }, MouseEvent: class extends Event {}, FocusEvent: class extends Event {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }), setTimeout, clearTimeout, CSS: { escape: String } });
  ctx.window = ctx; vm.runInContext(SRC, ctx);
  return { A: ctx.ISActions, input, option, effects, stopped: () => stopped,
    stop: () => { stopped = true; }, show: () => { options = [option]; }, onClick: f => { onClick = f; }, onInput: f => { onInput = f; } };
}

for (const stop of [true, false]) test(`React async options ${stop ? "are discarded after takeover" : "still select for a current run"}`, async () => {
  const f = fixture(); let release;
  const pending = new Promise(r => { release = r; });
  const sp = { options: [], loadOptions: () => pending };
  f.input.__reactFiber$test = { memoizedProps: { selectProps: sp, selectOption: o => { f.effects.picks++; sp.value = o; } } };
  const result = f.A.reactSelectPick(f.input, "Canada", f.stopped);
  if (stop) f.stop(); release([{ label: "Canada", value: "CA" }]);
  const r = await result;
  assert.equal(f.effects.picks, stop ? 0 : 1); assert.equal(f.effects.escapes, 0); assert.equal(f.effects.blurs, 0);
  assert.equal(r.ok, !stop); if (stop) assert.equal(r.cancelled, true);
});

for (const stop of [true, false]) test(`ARIA options ${stop ? "do not click after takeover" : "still select normally"}`, async () => {
  const f = fixture();
  f.onClick(() => { setTimeout(() => { if (stop) f.stop(); f.show(); }, 10); });
  const r = await f.A.ariaComboPick(f.input, "Canada", f.stopped);
  assert.equal(f.effects.picks, stop ? 0 : 1); assert.equal(f.effects.escapes, 0);
  assert.equal(r.ok, !stop); if (stop) assert.equal(r.cancelled, true);
});

for (const stop of [true, false]) test(`plain suggestions ${stop ? "do not select or blur after takeover" : "still keep a valid selection"}`, async () => {
  const f = fixture();
  f.onInput(() => { setTimeout(() => { if (stop) f.stop(); f.show(); }, 10); });
  const r = await f.A.typeahead(f.input, "Canada", f.stopped);
  assert.equal(f.effects.picks, stop ? 0 : 1); assert.equal(f.effects.escapes, 0);
  assert.equal(r.ok, !stop); if (stop) { assert.equal(r.cancelled, true); assert.equal(f.effects.blurs, 0); }
});

test("Take over immediately after an allowed suggestion click prevents its delayed blur cleanup", async () => {
  const f = fixture(); f.onInput(() => f.show());
  const click = f.option.click; f.option.click = () => { click(); f.stop(); };
  const r = await f.A.typeahead(f.input, "Canada", f.stopped);
  assert.equal(f.effects.picks, 1); assert.equal(f.effects.blurs, 0); assert.equal(r.cancelled, true);
});

test("React DOM fallback stops before delayed keyboard or Escape cleanup", async () => {
  const f = fixture(); f.onClick(() => setTimeout(f.stop, 10));
  const r = await f.A.reactSelectPick(f.input, "Canada", f.stopped);
  assert.equal(r.cancelled, true); assert.deepEqual(f.effects.keys, []); assert.equal(f.effects.picks, 0);
});

test("a search-library result after takeover never clicks an option or sends Escape", async () => {
  const f = fixture(); f.onInput(() => { f.show(); f.stop(); });
  const r = await f.A.searchSelectPick(f.input, "Canada", f.stopped);
  assert.equal(r.cancelled, true); assert.equal(f.effects.picks, 0); assert.equal(f.effects.escapes, 0);
});
