// The employer buy page, /employers/buy/ (docs/employers/buy/index.html and docs/js/buy.js, added
// 2026-10-19; worker/ORDERS.md). The pure parts on window.ISBuy (search, role rules, packages, prices from
// /employer/config, dates, availability, the address-bar states, the order body), then the page itself
// against a small stand-in DOM and a stubbed fetch: closed unless the Worker says enabled, an order from
// search to "Check your email", and the pages Stripe and the email links come back to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const SRC = read("docs/js/buy.js");
const PAGE = read("docs/employers/buy/index.html");
const EMPLOYERS = read("docs/employers/index.html");
const API = "https://internscout-api.bpmcginley.workers.dev";

// The config this page expects from GET /employer/config (prices in cents).
// The shape worker/API.md documents for GET /employer/config.
const CFG = { enabled: true, prices: { one: { roles: 1, cents: 2900, public_body_cents: 1500 }, three: { roles: 3, cents: 6900, public_body_cents: 3500 } }, days: 30, field_cap: 5, max_start_days: 90, terms_version: "2026-10-19" };
const plain = (v) => JSON.parse(JSON.stringify(v));

function pure() {
  const ctx = { URL, URLSearchParams };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx.ISBuy;
}
const B = pure();

// ---------- pure parts ----------

test("loads without a page and exposes its helpers, touching no DOM", () => {
  assert.equal(typeof B.searchEmployers, "function");
  assert.equal(B.API, API);
});

test("the employer index keeps only usable entries, and a shard is one safe character", () => {
  const idx = B.prepareIndex({ employers: [
    { k: "acme", n: "Acme Corp", c: 3, s: "a" },
    { k: "bad", n: "Bad Shard", c: 1, s: "../x" },
    { k: "", n: "No key", c: 1, s: "n" },
    { k: "nn", n: "  ", c: 1, s: "n" },
    { k: "3m", n: "3M", c: 2, s: "3" },
    null,
  ] });
  assert.deepEqual(plain(idx.map((e) => e.k)), ["acme", "3m"]);
  assert.deepEqual(plain(B.prepareIndex(null)), []);
});

test("company search: start of name first, then a word, then anywhere; more open roles first", () => {
  const idx = B.prepareIndex({ employers: [
    { k: "bank-of-x", n: "Bank of X", c: 2, s: "b" },
    { k: "x-bank", n: "X Bank", c: 1, s: "x" },
    { k: "bankrate", n: "Bankrate", c: 9, s: "b" },
    { k: "citibank", n: "Citibank", c: 50, s: "c" },
    { k: "pg", n: "Procter & Gamble", c: 4, s: "p" },
    { k: "nestle", n: "Nestlé", c: 4, s: "n" },
  ] });
  assert.deepEqual(plain(B.searchEmployers(idx, "bank").map((e) => e.n)), ["Bankrate", "Bank of X", "X Bank", "Citibank"]);
  assert.deepEqual(plain(B.searchEmployers(idx, "procter and").map((e) => e.k)), ["pg"]);
  assert.deepEqual(plain(B.searchEmployers(idx, "NESTLE").map((e) => e.k)), ["nestle"]);
  assert.deepEqual(plain(B.searchEmployers(idx, "  ")), []);
  assert.equal(B.searchEmployers(idx, "a", 2).length, 2);
});

test("an employer's roles come from its shard by key, sorted by title", () => {
  const shard = { roles: [
    { id: 3, k: "acme", t: "Zeta Intern" }, { id: 1, k: "acme", t: "alpha Intern" }, { id: 2, k: "acmex", t: "Other" }, { id: 4, k: "acme", t: "" }, { k: "acme", t: "No id" },
  ] };
  assert.deepEqual(plain(B.rolesFor(shard, "acme").map((r) => r.id)), [1, 3]);
  assert.deepEqual(plain(B.rolesFor({}, "acme")), []);
});

test("a role whose posting doesn't say it is paid can be picked only by a nonprofit or public body", () => {
  assert.equal(B.canPick({ unpaid: false }, false).ok, true);
  const no = B.canPick({ unpaid: true }, false);
  assert.equal(no.ok, false);
  assert.match(no.reason, /doesn't say this role is paid.*nonprofit or a public body/);
  assert.equal(B.canPick({ unpaid: true }, true).ok, true);
});

test("one role or three; two explains itself, with both prices from the config", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(B.packageFor), [null, "one", null, "three", null]);
  const two = B.pickMessage(2, CFG, false);
  assert.match(two, /two roles/);
  assert.match(two, /\$29/);
  assert.match(two, /\$69/);
  assert.match(B.pickMessage(2, CFG, true), /\$15.*\$35/);
  assert.match(B.pickMessage(4, CFG, false), /most is three\. Untick 1\./);
  assert.match(B.pickMessage(3, CFG, false), /\$69 for 30 days each/);
});

test("prices are read from the config in cents, standard or nonprofit, in any of the accepted shapes", () => {
  assert.equal(B.priceCents(CFG, "one", false), 2900);
  assert.equal(B.priceCents(CFG, "three", true), 3500);
  const nested = { prices: { one: { standard: 2900, public_body: 1500 }, three: { standard: 6900, public_body: 3500 } } };
  assert.equal(B.priceCents(nested, "three", false), 6900);
  assert.equal(B.priceCents(nested, "one", true), 1500);
  const byKind = { prices: { standard: { one: 2900, three: 6900 }, public_body: { one: 1500, three: 3500 } } };
  assert.equal(B.priceCents(byKind, "one", true), 1500);
  assert.equal(B.priceCents({ prices: { one: "2900" } }, "one", false), null);
  assert.equal(B.priceCents(CFG, "two", false), null);
  assert.equal(B.money(2900), "$29");
  assert.equal(B.money(1234), "$12.34");
  assert.equal(B.priceLine(CFG, false), "One role: $29 for 30 days. Three roles: $69, 30 days each.");
  assert.equal(B.priceLine({ ...CFG, prices: { one: 3100, three: 7000, one_public: 1600, three_public: 3600 } }, true), "One role: $16 for 30 days. Three roles: $36, 30 days each.");
  assert.equal(B.buttonText(CFG, "one", false, ""), "Order for $29");
  assert.equal(B.buttonText(CFG, "three", true, ""), "Order for $35");
  assert.equal(B.buttonText(CFG, null, false, ""), "Order");
  assert.equal(B.buttonText(CFG, "one", false, "PILOT1"), "Order with pilot code");
});

test("the page sells nothing unless the config is enabled and complete", () => {
  assert.equal(B.configOk(CFG), true);
  assert.equal(B.configOk({ ...CFG, enabled: false }), false);
  assert.equal(B.configOk({ ...CFG, enabled: "true" }), false);
  assert.equal(B.configOk({ ...CFG, prices: { one: 2900, three: 6900 } }), false);
  assert.equal(B.configOk({ ...CFG, days: 0 }), false);
  assert.equal(B.configOk({ ...CFG, terms_version: "" }), false);
  assert.equal(B.configOk(null), false);
});

test("dates: whole days across months, years and leap days; the run and the approval rule", () => {
  assert.equal(B.addDays("2026-10-19", 30), "2026-11-18");
  assert.equal(B.addDays("2026-12-20", 30), "2027-01-19");
  assert.equal(B.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(B.validIso("2026-02-30"), false);
  assert.equal(B.validIso("2026-2-3"), false);
  assert.equal(B.fmtDate("2026-11-03"), "November 3, 2026");
  const r = B.startRange(CFG, new Date(2026, 9, 19, 23, 30));
  assert.deepEqual(plain(r), { min: "2026-10-19", max: "2027-01-17" });
  assert.equal(B.inRange("2026-10-18", r), false);
  assert.equal(B.inRange("2027-01-17", r), true);
  assert.equal(B.inRange("2027-01-18", r), false);
  const run = B.runText("2026-11-03", 30);
  assert.match(run, /^Runs November 3, 2026 to December 3, 2026 \(30 days\)\./);
  assert.match(run, /If our review finishes after the start day, the 30 days start from the day we approve it/);
});

test("availability: fits, or the full fields and the first day they have room", () => {
  const out = { roles: [{ id: 1, fits: true }, { id: 2, fits: false, full: ["swe", "data"], next_start: "2026-12-01" }, { id: 4, fits: false, full: ["finance"] }] };
  const a = B.readAvailability(out, [1, 2, 3, 4]);
  assert.deepEqual(plain(a.map((x) => [x.known, x.fits])), [[true, true], [true, false], [false, null], [true, false]]);
  assert.equal(B.availText(a[0]), "Fits: there's room from this start day.");
  assert.equal(B.availText(a[1]), "Paid listings in Software and Data are full until December 1, 2026.");
  assert.equal(B.availText(a[2]), "");
  assert.equal(B.availText(a[3]), "Paid listings in Finance are full on these dates.");
  // Keyed by id, with full_fields, and a bad date is dropped.
  const k = B.readAvailability({ 7: { fits: false, full_fields: "other", next_start: "soon" } }, ["7"]);
  assert.deepEqual(plain(k[0]), { id: "7", known: true, listed: true, fits: false, full: ["other"], taken: false, next_start: null });
});

test("address-bar states, with ids and tokens checked for shape", () => {
  assert.deepEqual(plain(B.landingState("?order=ord_1&t=abc-DEF_9")), { kind: "confirm", order: "ord_1", token: "abc-DEF_9" });
  assert.deepEqual(plain(B.landingState("?credit=cr1&t=tok")), { kind: "credit", credit: "cr1", token: "tok" });
  assert.deepEqual(plain(B.landingState("?paid=ord_1")), { kind: "paid", order: "ord_1" });
  assert.deepEqual(plain(B.landingState("?cancelled=1")), { kind: "cancelled" });
  assert.deepEqual(plain(B.landingState("")), { kind: "buy" });
  assert.equal(B.landingState("?order=ord_1").kind, "badlink");
  assert.equal(B.landingState("?order=ord_1&t=<script>").kind, "badlink");
  assert.equal(B.landingState("?credit=cr1").kind, "badlink");
  assert.equal(B.hasToken({ kind: "paid" }), false);
  assert.equal(B.hasToken({ kind: "confirm" }), true);
});

test("server errors go to the field the Worker names", () => {
  assert.equal(B.errorTarget("email"), "email");
  assert.equal(B.errorTarget("pilot_code"), "pilot");
  assert.equal(B.errorTarget("roles"), "roles");
  assert.equal(B.errorTarget("terms"), "terms");
  assert.equal(B.errorTarget("start"), "start");
  assert.equal(B.errorTarget("toString"), null);
  assert.equal(B.errorTarget("nope"), null);
  assert.equal(B.serverMessage({ message: "Use your company email." }), "Use your company email.");
  assert.equal(B.serverMessage({ error: "full" }), "full");
  assert.equal(B.serverMessage({}), "");
});

test("the order body has exactly the fields the Worker reads", () => {
  const body = B.orderBody({ name: "Ann", email: "ann@acme.com", company: "Acme", publicBody: false, shard: "a",
    roles: [{ id: 11 }, { id: 12 }, { id: 13 }], start: "2026-11-03", cfg: CFG, pilot: "", website: "" });
  assert.deepEqual(plain(body), { name: "Ann", email: "ann@acme.com", company: "Acme", public_body: false, package: "three", shard: "a",
    roles: [11, 12, 13], start: "2026-11-03", terms: true, pilot_code: "", website: "" });
});

test("only a Stripe checkout address is followed, and only http(s) posting links are shown", () => {
  assert.equal(B.safeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_1"), "https://checkout.stripe.com/c/pay/cs_test_1");
  for (const u of ["http://checkout.stripe.com/x", "https://evil.example/stripe.com", "https://stripe.com.evil.example/", "javascript:alert(1)", "", null]) assert.equal(B.safeCheckoutUrl(u), null, String(u));
  assert.equal(B.httpUrl("https://jobs.acme.com/1"), "https://jobs.acme.com/1");
  assert.equal(B.httpUrl("javascript:alert(1)"), null);
});

test("the credit offer reads cents and any choice already made", () => {
  assert.deepEqual(plain(B.readCredit({ amount_cents: 1450, title: "Intern", company: "Acme" })), { cents: 1450, title: "Intern", company: "Acme", choice: null, code: "" });
  assert.deepEqual(plain(B.readCredit({ amount: 900, choice: "credit", code: "ABC" })), { cents: 900, title: "", company: "", choice: "credit", code: "ABC" });
});

// ---------- the page, against a stand-in DOM ----------

class El {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.doc = doc; this.attrs = {}; this.children = []; this.listeners = {}; this.hidden = false; this.value = ""; this.checked = false; this.disabled = false; this._text = ""; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { throw new Error("innerHTML used"); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev = {}) { ev.preventDefault = () => { ev.defaultPrevented = true; }; (this.listeners[t] || []).forEach((f) => f(ev)); return ev; }
  focus() { this.doc.activeElement = this; }
  all(pred, out = []) { for (const c of this.children) if (c instanceof El) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  querySelector(sel) { assert.equal(sel, "input:not([disabled])"); return this.all((n) => n.tagName === "INPUT" && !n.disabled)[0] || null; }
  get elements() { return new Proxy({}, { get: (_, k) => this.doc.getElementById(k) }); }
}

const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

function page({ search = "", routes = {} } = {}) {
  const byId = new Map(), calls = [], replaced = [], assigned = [];
  const doc = { activeElement: null };
  Object.assign(doc, {
    getElementById: (id) => { if (!byId.has(id)) { const e = new El("div", doc); e.id = id; byId.set(id, e); } return byId.get(id); },
    createElement: (t) => new El(t, doc),
    createTextNode: (s) => ({ textContent: String(s) }),
    querySelectorAll: () => [],
  });
  // Elements the page starts with hidden, as in the HTML.
  for (const id of ["closed", "landing", "order", "roles-box", "step2", "step3", "sent", "co-list"]) doc.getElementById(id).hidden = true;
  const fetch = (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
    for (const [pat, fn] of Object.entries(routes)) if (url.startsWith(pat)) return fn(url, init);
    return Promise.reject(new Error("offline"));
  };
  const ctx = {
    document: doc, fetch, URL, URLSearchParams, setTimeout: (f) => { f(); return 1; }, clearTimeout() {},
    location: { search, pathname: "/employers/buy/", assign: (u) => assigned.push(u) },
    history: { replaceState: (_, __, u) => replaced.push(u) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { $: doc.getElementById, doc, calls, replaced, assigned };
}

test("closed: no config, a failed call or enabled false shows only the not-open note", async () => {
  for (const routes of [{}, { [API + "/employer/config"]: () => reply(200, { ...CFG, enabled: false }) }, { [API + "/employer/config"]: () => reply(500, {}) }]) {
    const p = page({ routes });
    await tick();
    assert.equal(p.$("closed").hidden, false);
    assert.equal(p.$("order").hidden, true);
    assert.equal(p.$("boot").hidden, true);
    assert.ok(!p.calls.some((c) => c.url.includes("/data/roles/")), "the role index isn't even loaded");
  }
});

test("an order: search, pick three roles (an unpaid one only as a nonprofit), a day that fits, details, then Check your email", async () => {
  const today = B.isoLocal(new Date());
  const shard = { roles: [
    { id: 11, k: "acme", co: "Acme", t: "Data Intern", loc: "Boston, MA", u: "https://jobs.acme.com/11", f: ["data"], unpaid: false },
    { id: 12, k: "acme", co: "Acme", t: "<b>Bold</b> Intern", loc: ["Remote"], u: "javascript:alert(1)", f: [], unpaid: false },
    { id: 13, k: "acme", co: "Acme", t: "Volunteer Intern", loc: "", u: "https://jobs.acme.com/13", f: ["swe"], unpaid: true },
    { id: 99, k: "other", co: "Other", t: "Not Acme", f: [] },
  ] };
  let order;
  const p = page({ routes: {
    [API + "/employer/config"]: () => reply(200, CFG),
    "/data/roles/index.json": () => reply(200, { generated: "x", employers: [{ k: "acme", n: "Acme <Robotics>", c: 3, s: "a" }, { k: "acorn", n: "Acorn", c: 1, s: "a" }] }),
    "/data/roles/a.json": () => reply(200, shard),
    [API + "/employer/availability"]: (url) => {
      const q = new URL(url).searchParams;
      const full = q.get("start") === today;   // field "data" is full today, with room from five days on
      return reply(200, { roles: q.get("ids").split(",").map((id) => id === "11" && full ? { id: 11, fits: false, full: ["data"], next_start: B.addDays(today, 5) } : { id: Number(id), fits: true }) });
    },
    [API + "/employer/order"]: (url, init) => { order = JSON.parse(init.body); return reply(200, { ok: true }); },
  } });
  const { $ } = p;
  await tick();
  assert.equal($("order").hidden, false);
  assert.equal($("prices").textContent, "One role: $29 for 30 days. Three roles: $69, 30 days each.");
  assert.equal($("start").min, today);
  assert.equal($("start").max, B.addDays(today, 90));
  assert.equal($("co-q").disabled, false);

  // Type-ahead and keyboard choice.
  $("co-q").value = "acm";
  $("co-q").fire("input");
  assert.equal($("co-list").hidden, false);
  assert.equal($("co-q").getAttribute("aria-expanded"), "true");
  assert.match($("co-list").textContent, /Acme <Robotics>3 open roles/);
  $("co-q").fire("keydown", { key: "ArrowDown" });
  assert.equal($("co-q").getAttribute("aria-activedescendant"), "co-opt-0");
  const enter = $("co-q").fire("keydown", { key: "Enter" });
  assert.ok(enter.defaultPrevented, "Enter chooses a company and never sends the form");
  await tick();
  assert.equal($("company").value, "Acme <Robotics>", "company prefilled from the employer name");
  assert.equal($("roles-legend").textContent, "Open roles at Acme <Robotics>");
  const boxes = $("role-list").all((n) => n.tagName === "INPUT");
  assert.equal(boxes.length, 3, "only this employer's roles");
  const labels = $("role-list").all((n) => n.tagName === "LABEL").map((n) => n.textContent);
  assert.deepEqual(labels, ["<b>Bold</b> Intern", "Data Intern", "Volunteer Intern"], "titles go in as text");
  const links = $("role-list").all((n) => n.tagName === "A").map((n) => n.href);
  assert.deepEqual(links, ["https://jobs.acme.com/11", "https://jobs.acme.com/13"], "no javascript: link");
  const [bold, data, vol] = boxes;
  assert.equal(vol.disabled, true, "an unpaid role can't be picked without the nonprofit box");
  assert.match($("role-list").textContent, /Only a nonprofit or a public body can buy a paid listing for it/);
  assert.equal($("step2").hidden, false);

  // Two roles explain themselves.
  bold.checked = true; bold.fire("change");
  data.checked = true; data.fire("change");
  assert.match($("pick-msg").textContent, /two roles/);
  assert.equal($("send").textContent, "Order");

  // The nonprofit box switches the prices and lets the unpaid role be picked.
  $("pub").checked = true; $("pub").fire("change");
  assert.equal($("prices").textContent, "One role: $15 for 30 days. Three roles: $35, 30 days each.");
  const vol2 = $("role-list").all((n) => n.tagName === "INPUT")[2];
  assert.equal(vol2.disabled, false);
  vol2.checked = true; vol2.fire("change");
  assert.equal($("send").textContent, "Order for $35");
  await tick();
  assert.match($("avail").textContent, /Paid listings in Data are full until/);
  const use = $("avail").all((n) => n.tagName === "BUTTON")[0];
  assert.ok(use, "a button to use the first day that fits");
  use.fire("click");
  assert.equal($("start").value, B.addDays(today, 5));
  assert.match($("run").textContent, /^Runs .* \(30 days\)\. If our review finishes after the start day/);

  await tick();
  assert.match($("avail").textContent, /Data Intern: Fits/);

  // Empty details stop the send and focus the first one.
  $("order").fire("submit");
  assert.equal($("name-err").hidden, false);
  assert.equal($("terms-err").hidden, false);
  assert.equal($("start-err").hidden, true);
  assert.equal(p.doc.activeElement, $("name"));
  assert.equal(order, undefined);

  $("name").value = "Ann Lee"; $("email").value = "ann@acme.com"; $("terms").checked = true; $("pilot").value = " ";
  $("order").fire("submit");
  await tick();
  assert.deepEqual(order, { name: "Ann Lee", email: "ann@acme.com", company: "Acme <Robotics>", public_body: true, package: "three", shard: "a",
    roles: [12, 11, 13], start: B.addDays(today, 5), terms: true, pilot_code: "", website: "" });
  assert.equal($("sent").hidden, false);
  assert.equal($("sent-text").textContent, "We sent a link to ann@acme.com. It works for 48 hours.");
});

test("an order that fits is sent once with the Worker's fields, and the 400 message lands on its field", async () => {
  const today = B.isoLocal(new Date());
  const sent = [];
  let answer = () => reply(400, { field: "email", message: "Use your company email address, not a free one." });
  const p = page({ routes: {
    [API + "/employer/config"]: () => reply(200, CFG),
    "/data/roles/index.json": () => reply(200, { employers: [{ k: "acme", n: "Acme", c: 1, s: "a" }] }),
    "/data/roles/a.json": () => reply(200, { roles: [{ id: "r1", k: "acme", t: "Intern", f: ["data"], u: "https://a.example/1" }] }),
    [API + "/employer/availability"]: () => reply(200, { roles: [{ id: "r1", fits: true }] }),
    [API + "/employer/order"]: (url, init) => { sent.push(JSON.parse(init.body)); return answer(); },
  } });
  const { $ } = p;
  await tick();
  $("co-q").value = "acme"; $("co-q").fire("input");
  $("co-q").fire("keydown", { key: "Enter" });   // a single match is chosen with Enter
  await tick();
  const [box] = $("role-list").all((n) => n.tagName === "INPUT");
  box.checked = true; box.fire("change");
  await tick();
  assert.match($("avail").textContent, /Intern: Fits/);
  $("name").value = "Ann"; $("email").value = "ann@gmail.com"; $("terms").checked = true;
  $("website").value = "";
  assert.equal($("send").textContent, "Order for $29");
  $("order").fire("submit");
  await tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { name: "Ann", email: "ann@gmail.com", company: "Acme", public_body: false, package: "one", shard: "a", roles: ["r1"],
    start: today, terms: true, pilot_code: "", website: "" });
  assert.equal($("email-err").textContent, "Use your company email address, not a free one.");
  assert.equal($("email").getAttribute("aria-invalid"), "true");
  assert.equal(p.doc.activeElement, $("email"));
  assert.equal($("send").disabled, false);

  answer = () => reply(200, { ok: true });
  $("email").value = "ann@acme.com";
  $("order").fire("submit");
  await tick();
  assert.equal($("order").hidden, true);
  assert.equal($("sent").hidden, false);
  assert.equal($("sent-text").textContent, "We sent a link to ann@acme.com. It works for 48 hours.");
});

test("the email link confirms, drops the token from the address bar and goes only to Stripe", async () => {
  const p = page({ search: "?order=o1&t=tok1", routes: { [API + "/employer/order/confirm"]: () => reply(200, { url: "https://checkout.stripe.com/c/pay/cs_1" }) } });
  assert.deepEqual(p.replaced, ["/employers/buy/"]);
  assert.equal(p.$("landing-h").textContent, "Confirming your email");
  await tick();
  assert.deepEqual(p.calls.map((c) => [c.method, c.url, c.body]), [["POST", API + "/employer/order/confirm", { order: "o1", token: "tok1" }]]);
  assert.deepEqual(p.assigned, ["https://checkout.stripe.com/c/pay/cs_1"]);
  assert.equal(p.$("order").hidden, true);

  const evil = page({ search: "?order=o1&t=tok1", routes: { [API + "/employer/order/confirm"]: () => reply(200, { url: "https://evil.example/" }) } });
  await tick();
  assert.deepEqual(evil.assigned, []);
  assert.equal(evil.$("landing-h").textContent, "We couldn't confirm this link");

  const pilot = page({ search: "?order=o1&t=tok1", routes: { [API + "/employer/order/confirm"]: () => reply(200, { done: "pilot" }) } });
  await tick();
  assert.equal(pilot.$("landing-h").textContent, "Your pilot is booked");
  assert.match(pilot.$("landing-body").textContent, /usually within 2 business days/);

  const expired = page({ search: "?order=o1&t=tok1", routes: { [API + "/employer/order/confirm"]: () => reply(410, { message: "This link has expired." }) } });
  await tick();
  assert.match(expired.$("landing-body").textContent, /This link has expired\./);
});

test("paid and cancelled say what happens next; neither calls the Worker", async () => {
  const paid = page({ search: "?paid=o1" });
  await tick();
  assert.equal(paid.$("landing-h").textContent, "Payment received");
  assert.match(paid.$("landing-body").textContent, /We review every paid listing before it goes live, usually within 2 business days\. You'll get an email/);
  assert.match(paid.$("landing-body").textContent, /If we can't run it, you get a full refund\./);
  const cancelled = page({ search: "?cancelled=1" });
  await tick();
  assert.equal(cancelled.$("landing-h").textContent, "Nothing was charged");
  assert.match(cancelled.$("landing-body").textContent, /still works for 48 hours/);
  assert.deepEqual([...paid.calls, ...cancelled.calls], []);
  assert.deepEqual(paid.replaced, []);
});

test("the credit link offers a refund or a code, then shows the code", async () => {
  const p = page({ search: "?credit=c1&t=tok2", routes: {
    [API + "/employer/credit?"]: () => reply(200, { credit: "c-1", status: "offered", amount: 1450, unused_days: 15, role: { title: "Data Intern", company: "Acme" }, choose_by: "2026-11-30" }),
    [API + "/employer/credit"]: () => reply(200, { choice: "credit", code: "IS-7QX2" }),
  } });
  assert.deepEqual(p.replaced, ["/employers/buy/"]);
  await tick();
  assert.equal(p.calls[0].url, API + "/employer/credit?credit=c1&t=tok2");
  const body = p.$("landing-body");
  assert.match(body.textContent, /Data Intern at Acme closed early.*worth \$14\.50/);
  const [refund, credit] = body.all((n) => n.tagName === "BUTTON");
  assert.equal(refund.textContent, "Refund $14.50");
  assert.equal(credit.textContent, "Get a code worth $14.50");
  credit.fire("click");
  await tick();
  assert.deepEqual(p.calls[1], { url: API + "/employer/credit", method: "POST", body: { credit: "c1", token: "tok2", choice: "credit" } });
  assert.equal(p.$("landing-h").textContent, "Your code");
  assert.match(body.textContent, /IS-7QX2/);
});

// ---------- the HTML ----------

const noComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

test("buy page: noindex, labelled fields, the honeypot, the terms box and live status regions", () => {
  assert.match(PAGE, /<meta name="robots" content="noindex"\/>/);
  assert.match(PAGE, /<main id="buy">/);
  assert.match(PAGE, /<div class="hp" aria-hidden="true"><label for="website">Website<\/label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"\/><\/div>/);
  const terms = noComments(PAGE).match(/<label class="check" for="terms"><input type="checkbox" id="terms"[^>]*\/> <span>([\s\S]*?)<\/span><\/label>/);
  assert.ok(terms, "the terms checkbox");
  assert.equal(terms[1].replace(/<[^>]+>/g, ""), "I accept the InternScout terms, including the section for employers, for my company, and I am allowed to accept them for it.");
  assert.match(terms[1], /href="\/terms\.html"/);
  assert.match(terms[1], /href="\/terms\.html#employers"/);
  for (const id of ["co-q", "start", "name", "email", "company", "pilot"]) assert.match(PAGE, new RegExp(`<label for="${id}">`), id);
  assert.match(PAGE, /We are a nonprofit or a public body/);
  assert.match(PAGE, /id="co-q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="co-list"/);
  assert.match(PAGE, /<ul id="co-list" role="listbox"/);
  for (const id of ["pick-msg", "co-msg", "avail", "run"]) assert.match(PAGE, new RegExp(`id="${id}"[^>]*aria-live="polite"`), id);
  assert.match(PAGE, /id="status" role="alert"/);
  assert.match(PAGE, /<script defer src="\/js\/buy\.js\?v=\d{8}[^"]*"><\/script>/);
  assert.match(PAGE, /<script defer src="\/js\/count\.js"><\/script>/);
});

test("buy page and script: no hard-coded prices, no innerHTML, no em dashes", () => {
  const visible = noComments(PAGE);
  assert.doesNotMatch(visible, /\$\d/, "prices come from /employer/config");
  assert.doesNotMatch(SRC.replace(/^\s*\/\/.*$/gm, ""), /\$(15|29|35|69)\b|\b(1500|2900|3500|6900)\b/);
  assert.doesNotMatch(SRC, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  for (const [name, s] of [["page", PAGE], ["buy.js", SRC]]) assert.doesNotMatch(s, /[\u2013\u2014]/, name);
  assert.match(visible, /No bidding/);
  assert.match(visible, /at most one paid listing, and when several fit, each has the same chance/);
});

test("employers page: final prices, the buy link hidden until the config says enabled, the form kept", () => {
  const visible = noComments(EMPLOYERS);
  assert.doesNotMatch(visible, /Planned price|There's nothing to buy yet/);
  assert.match(visible, /<li>Price: \$29 per role for 30 days, or \$69 for three roles, 30 days each\. Nonprofits, government and public university programs: \$15, or \$35 for three\./);
  assert.match(EMPLOYERS, /<!-- was: <li>Planned price:/);
  assert.match(visible, /<p id="buy-link" hidden><a class="cta" href="\/employers\/buy\/">Buy a paid listing<\/a><\/p>/);
  assert.match(EMPLOYERS, /fetch\("https:\/\/internscout-api\.bpmcginley\.workers\.dev\/employer\/config"\)[\s\S]{0,200}c\.enabled === true\) document\.getElementById\("buy-link"\)\.hidden = false/);
  assert.match(visible, /<form class="lead" id="lead"/);
  assert.match(EMPLOYERS, /\/employer-interest"/);
  assert.doesNotMatch(visible, /[\u2013\u2014]/);
});

test("reads the Worker's documented shapes: flat prices still work, taken and unlisted roles, credit status", () => {
  assert.equal(B.priceCents({ prices: { one: 2900, three: 6900, one_public: 1500, three_public: 3500 } }, "three", true), 3500);
  assert.equal(B.priceCents(CFG, "one", false), 2900);
  assert.equal(B.priceCents(CFG, "three", true), 3500);
  const [taken, gone] = B.readAvailability({ roles: [{ id: "a", listed: true, fits: false, taken: true, next_start: "2026-12-01" }, { id: "b", listed: false }] }, ["a", "b"]);
  assert.match(B.availText(taken), /already has a paid listing/);
  assert.match(B.availText(taken), /December 1, 2026/);
  assert.equal(gone.fits, false);
  assert.match(B.availText(gone), /isn't in today's listings/);
  assert.equal(B.readCredit({ status: "credit", amount: 900, code: "X1", role: { title: "T", company: "C" } }).choice, "credit");
  assert.equal(B.readCredit({ status: "offered", amount: 900 }).choice, null);
  assert.equal(B.readCredit({ done: "refund", amount: 900 }).choice, "refund");
});
