// 2026-10-23: employer totals measure anonymous page-load steps, never purchases or unique people.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (file) => readFileSync(new URL("../../" + file, import.meta.url), "utf8");
const COUNT = read("docs/js/count.js"), BUY = read("docs/js/buy.js");
const entries = ["hero", "packages", "contact", "nav", "employer", "footer", "report"];
const entry = (position) => ({ nodeType: 1, getAttribute: (key) => key === "data-employer-entry" ? position : null });

function counter({ elements = [], path = "/", host = "internscout.org", webdriver = false, off = false, observer = true } = {}) {
  const bodies = [], listeners = {}, observed = new Set();
  let intersect, mutation;
  const ctx = { URL, URLSearchParams, JSON,
    location: { hostname: host, pathname: path, search: "?company=private-company&order=private-order&t=private-token" },
    navigator: { webdriver, sendBeacon: (_url, blob) => { bodies.push(JSON.parse(blob.text)); return true; } },
    Blob: class { constructor(parts) { this.text = parts.join(""); } },
    localStorage: { getItem: () => off ? "1" : null },
    document: { body: {}, referrer: "", addEventListener: (name, fn) => { listeners[name] = fn; }, querySelectorAll: () => elements },
  };
  if (observer) {
    ctx.IntersectionObserver = class {
      constructor(callback) { intersect = callback; }
      observe(el) { observed.add(el); }
      unobserve(el) { observed.delete(el); }
    };
    ctx.MutationObserver = class { constructor(callback) { mutation = callback; } observe() {} };
  }
  ctx.window = ctx;
  vm.createContext(ctx); vm.runInContext(COUNT, ctx);
  return { ctx, bodies, observed,
    expose: (target, ratio) => intersect([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    mount: (addedNodes, removedNodes = []) => mutation([{ addedNodes, removedNodes }]),
    click: (position) => {
      const a = { ...entry(position), href: "/employers/buy/?company=private-company", closest: () => null };
      listeners.click({ target: { closest: (selector) => selector === "a[href]" ? a : null } });
    },
  };
}

test("employer views require visibility, handle later mounts, and count once per fixed position", () => {
  const hero = entry("hero"), secondHero = entry("hero"), bad = entry("someone@company.example");
  const r = counter({ elements: [hero, bad] });
  assert.deepEqual(r.bodies.filter((x) => x.e), []);
  assert.equal(r.observed.has(bad), false);
  r.expose(hero, 0.24); assert.deepEqual(r.bodies.filter((x) => x.e), []);
  r.expose(hero, 0.25); r.expose(hero, 1);
  r.mount([secondHero]); r.expose(secondHero, 1);
  const footer = entry("footer"); r.mount([footer]); r.mount([], [footer]);
  assert.equal(r.observed.has(footer), false);
  r.mount([footer]); r.expose(footer, 0.5);
  assert.deepEqual(r.bodies.filter((x) => x.e).map((x) => x.e), ["employer_view_hero", "employer_view_footer"]);
});

test("only seven employer positions emit clicks, with fixed page paths and no query or form values", () => {
  const r = counter({ path: "/internships/at/private-company/" });
  for (const position of entries) { r.click(position); r.click(position); }
  r.click("someone@company.example"); r.click("employer_paid");
  const events = r.bodies.filter((x) => x.e);
  assert.deepEqual(events.map((x) => x.e), entries.map((x) => "employer_click_" + x));
  assert.ok(events.every((x) => x.p === "/internships/" && Object.keys(x).sort().join(",") === "e,p"));
  assert.doesNotMatch(JSON.stringify(events), /private|someone|company\.example|paid/);
  const buy = counter({ path: "/employers/buy/" }); buy.ctx.ISCount("employer_order_submit");
  assert.deepEqual(buy.bodies.filter((x) => x.e), [{ e: "employer_order_submit", p: "/employers/buy/" }]);
});

test("employer counts preserve local, webdriver and owner opt-out suppression; no observer means no view claim", () => {
  for (const opts of [{ host: "localhost" }, { webdriver: true }, { off: true }]) {
    const r = counter(opts); r.ctx.ISCount("employer_order_submit");
    assert.deepEqual(r.bodies, []);
  }
  const r = counter({ elements: [entry("hero")], observer: false }); r.click("hero");
  assert.deepEqual(r.bodies.filter((x) => x.e).map((x) => x.e), ["employer_click_hero"]);
});

class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.doc = doc; this.attrs = {}; this.children = []; this.listeners = {}; this.value = ""; this.checked = false; this._text = ""; }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map((x) => x.textContent).join(""); }
  set innerHTML(_value) { throw new Error("No HTML interpolation allowed"); }
  appendChild(node) { this.children.push(node); return node; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { event.preventDefault = () => {}; for (const fn of this.listeners[type] || []) fn(event); }
  focus() { this.doc.activeElement = this; }
  all(test) { return this.children.flatMap((node) => node instanceof Element ? [...(test(node) ? [node] : []), ...node.all(test)] : []); }
  querySelector() { return this.all((x) => x.tagName === "INPUT" && !x.disabled)[0] || null; }
  get elements() { return new Proxy({}, { get: (_target, key) => this.doc.getElementById(key) }); }
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const CFG = { enabled: true, prices: { one: { cents: 2900, public_body_cents: 1500 }, three: { cents: 6900, public_body_cents: 3500 } }, days: 30, field_cap: 5, max_start_days: 90, terms_version: "2026-10-19" };
function buyPage(search = "", enabled = true, countThrows = false) {
  const nodes = new Map(), calls = [], events = [], redirects = [];
  const doc = { getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Element("div", doc)); return nodes.get(id); },
    createElement: (tag) => new Element(tag, doc), createTextNode: (text) => ({ textContent: String(text) }), querySelectorAll: () => [] };
  const ctx = { document: doc, URL, URLSearchParams, ISCount: (event) => { if (countThrows) throw new Error("Counter unavailable"); events.push(event); },
    location: { search, pathname: "/employers/buy/", assign: (url) => redirects.push(url) },
    history: { replaceState() {} }, setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body });
      const data = url.endsWith("/employer/config") ? { ...CFG, enabled }
        : url === "/data/roles/index.json" ? { employers: [{ k: "acme & partners", n: "Acme <Partners>", c: 1, s: "a" }] }
        : url === "/data/roles/a.json" ? { roles: [{ id: "r1", k: "acme & partners", t: "Intern", f: ["data"], u: "https://example.com/job" }] }
        : url.includes("/employer/availability") ? { roles: [{ id: "r1", fits: true }] } : { ok: true };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(BUY, ctx);
  return { $: doc.getElementById, ctx, calls, events, redirects };
}

test("exact public company keys safely prefill roles, without selecting roles or starting an order", async () => {
  const p = buyPage("?company=acme%20%26%20partners"); await flush();
  assert.equal(p.$("co-q").value, "Acme <Partners>");
  assert.equal(p.$("company").value, "Acme <Partners>");
  const boxes = p.$("role-list").all((x) => x.tagName === "INPUT");
  assert.equal(boxes.length, 1); assert.equal(boxes[0].checked, false);
  assert.deepEqual(p.events, ["employer_buy_open", "employer_company_prefill"]);
  assert.ok(p.calls.every((x) => x.method === "GET")); assert.deepEqual(p.redirects, []);
  for (const search of ["?company=unknown", "?company=../secret", "?company=%3Cscript%3E", "?company=ACME%20%26%20PARTNERS"]) {
    const invalid = buyPage(search); await flush();
    assert.equal(invalid.$("co-q").value, "");
    assert.ok(!invalid.calls.some((x) => x.url === "/data/roles/a.json"));
    assert.deepEqual(invalid.events, ["employer_buy_open"]);
  }
  const closed = buyPage("?company=acme%20%26%20partners", false); await flush();
  assert.deepEqual(closed.events, []);
});

test("buy steps distinguish valid submission intent from a purchase and never pass typed values", async () => {
  const p = buyPage(); await flush();
  p.$("co-q").value = "Acme"; p.$("co-q").fire("input"); p.$("co-q").fire("keydown", { key: "Enter" }); await flush();
  const box = p.$("role-list").all((x) => x.tagName === "INPUT")[0]; box.checked = true; box.fire("change"); await flush();
  p.$("order").fire("submit");
  assert.ok(!p.events.includes("employer_order_submit"), "invalid fields do not count as submit intent");
  p.$("name").value = "Private Name"; p.$("email").value = "private@company.example"; p.$("terms").checked = true;
  p.$("order").fire("submit"); await flush();
  assert.ok(p.events.includes("employer_company_pick") && p.events.includes("employer_roles_pick") && p.events.includes("employer_order_submit"));
  assert.doesNotMatch(JSON.stringify(p.events), /Private|private@|Acme|r1|paid|pilot|verified/);
  assert.equal(p.calls.filter((x) => x.method === "POST").length, 1);
  assert.deepEqual(p.redirects, []);
});

test("unavailable analytics never blocks company prefill, role choice or a validated order", async () => {
  const p = buyPage("?company=acme%20%26%20partners", true, true); await flush();
  assert.equal(p.$("co-q").value, "Acme <Partners>");
  const box = p.$("role-list").all((x) => x.tagName === "INPUT")[0];
  box.checked = true; box.fire("change"); await flush();
  p.$("name").value = "Private Name"; p.$("email").value = "private@company.example"; p.$("terms").checked = true;
  p.$("order").fire("submit"); await flush();
  assert.equal(p.calls.filter((x) => x.method === "POST").length, 1);
  assert.deepEqual(p.events, []); assert.deepEqual(p.redirects, []);
});
