import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { mountBuy } from "../../docs/js/buy/entry.mjs";

const source = name => readFileSync(new URL(`../../docs/js/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const classic = source("buy.js");
const entry = `/js/buy-modules/${"a".repeat(64)}/entry.mjs`;
const tokenRoute = "?order=fixture-order&t=fixture-token";
const tick = () => new Promise(resolve => setImmediate(resolve));

function boot({ search = tokenRoute, marker = entry, noModule = true, scrub = true } = {}) {
  const trace = [], elements = new Map(), timers = new Map(), calls = [];
  let script, timer = 0;
  function element() {
    return { children: [], appendChild(node) { this.children.push(node); }, focus() {}, setAttribute() {} };
  }
  const location = { search, pathname: "/employers/buy/" };
  const document = {
    getElementById(id) {
      if (id === "buy-native-entry") return marker ? { getAttribute: () => marker } : null;
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement(tag) { return tag === "script" && noModule ? { noModule: false } : element(); },
    createTextNode(textContent) { return { textContent }; },
    head: { appendChild(node) { trace.push(["module", location.search]); script = node; } },
  };
  const context = vm.createContext({
    document, location, URL, URLSearchParams,
    history: { replaceState(_state, _title, path) {
      trace.push(["strip", path]);
      if (!scrub) throw Error("synthetic history failure");
      location.search = "";
    } },
    setTimeout(callback, delay) { const id = ++timer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      const path = new URL(url).pathname;
      calls.push([options.method, path, options.body ? JSON.parse(options.body) : null]);
      trace.push(["request", location.search]);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ done: "pilot" }) });
    },
  });
  context.window = context;
  const executeClassic = () => vm.runInContext(classic, context);
  executeClassic();
  return {
    calls, trace, script, executeClassic,
    heading: () => elements.get("landing-h")?.textContent,
    timeout() { [...timers.values()].find(value => value.delay === 2000)?.callback(); },
  };
}

const expected = [["POST", "/employer/order/confirm", { order: "fixture-order", token: "fixture-token" }]];

test("native checkout scrubs first, then claims the first confirmation once", async () => {
  const page = boot();
  assert.deepEqual(page.trace, [["strip", "/employers/buy/"], ["module", ""]]);
  assert.equal(page.script.src, entry);
  assert.equal(page.script.referrerPolicy, "no-referrer");
  assert.deepEqual(page.calls, []);
  assert.equal(page.heading(), "Confirming your email");
  await tick();
  assert.deepEqual(page.calls, expected);
  assert.equal(page.heading(), "Confirming your email");
  page.executeClassic();
  page.script.startCheckout(mountBuy);
  page.script.onload();
  page.script.onerror();
  page.script.startCheckout(mountBuy);
  page.timeout();
  await tick();
  assert.deepEqual(page.calls, expected);
  assert.deepEqual(page.trace.at(-1), ["request", ""]);
  assert.equal(page.heading(), "Your pilot is booked");
});

for (const signal of ["onerror", "onload", "timeout"]) test(`a ${signal} without native claim uses classic once`, async () => {
  const page = boot();
  if (signal === "timeout") page.timeout();
  else page.script[signal]();
  page.script.startCheckout(mountBuy);
  page.script.onload();
  page.script.onerror();
  await tick();
  assert.deepEqual(page.calls, expected);
  assert.equal(page.heading(), "Your pilot is booked");
});

for (const options of [
  { marker: null }, { noModule: false }, { scrub: false }, { marker: "https://elsewhere.example/entry.mjs" },
]) test(`classic compatibility keeps one request ${JSON.stringify(options)}`, async () => {
  const page = boot(options);
  page.executeClassic();
  await tick();
  assert.equal(page.script, undefined);
  assert.deepEqual(page.calls, expected);
  assert.equal(page.trace.filter(([event]) => event === "strip").length, 1);
  assert.equal(page.heading(), "Your pilot is booked");
});

test("a native error after claiming cannot start the classic checkout", async () => {
  const page = boot();
  assert.throws(() => page.script.startCheckout((...args) => {
    mountBuy(...args);
    throw Error("synthetic error after native startup");
  }), /synthetic error/);
  page.script.onerror();
  await tick();
  assert.deepEqual(page.calls, expected);
});

test("static return states render immediately without any module or API request", async () => {
  for (const [search, title] of [
    ["?paid=fixture-order", "Payment received"],
    ["?cancelled=1", "Nothing was charged"],
    ["?order=fixture-order", "This link doesn't look complete"],
  ]) {
    const page = boot({ search });
    assert.equal(page.heading(), title);
    assert.equal(page.script, undefined);
    await tick();
    assert.deepEqual(page.calls, []);
  }
});

test("native order and landing bodies match the classic fallback", () => {
  const start = classic.indexOf("  function start(state, request, ui) {\n");
  const orderEnd = classic.indexOf("  // ----- the pages Stripe and our emails link to -----", start);
  const landing = classic.indexOf("  function landing(state, request, ui) {\n", orderEnd);
  const end = classic.indexOf("})(typeof window", landing);
  assert(start > 0 && orderEnd > start && landing > orderEnd && end > landing);
  function body(from, to) {
    return classic.slice(from, to).split("\n").slice(1).join("\n").trimEnd()
      .replace(/^  /gm, "") + "\n";
  }
  const order = body(start, orderEnd).replace('  if (state.kind !== "buy") { landing(state, request, ui); return; }\n\n', "");
  assert(source("buy/order-form.mjs").endsWith(order));
  assert(source("buy/landing.mjs").endsWith(body(landing, end)));
});
