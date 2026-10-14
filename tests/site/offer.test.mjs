// The Auto-Apply offer in docs/js/offer.js, run against a stand-in browser with a fixed clock: when it
// shows, what it says and links to, what it counts, and every case where it must stay hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const OFFER = readFileSync(new URL("../../docs/js/offer.js", import.meta.url), "utf8");
const STORE = "https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi";
const T0 = Date.UTC(2026, 9, 13, 15, 0, 0);
const DAY = 864e5;
const CHROME = { mobile: false, brands: [{ brand: "Not=A?Brand", version: "24" }, { brand: "Chromium", version: "140" }, { brand: "Google Chrome", version: "140" }] };

function storage(map = new Map()) {
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };

// A small DOM: enough for what offer.js builds (elements, attributes, text, listeners, focus).
class El {
  constructor(tag, doc) { this.tag = tag; this.doc = doc; this.attrs = {}; this.children = []; this.listeners = {}; this.parentNode = null; this.textContent = ""; this.style = {}; this.rect = { top: 0, bottom: 0, height: 0 }; }
  getBoundingClientRect() { return this.rect; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev = {}) { (this.listeners[t] || []).forEach((f) => f(ev)); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  focus() { this.doc.activeElement = this; }
  get text() { return this.textContent + this.children.map((c) => c.text).join(""); }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find && c.find(pred); if (f) return f; } return null; }
}

function load({ ua = CHROME, touch = false, media = true, attr = false, local = storage(), session = storage(), now = T0, config, queue } = {}) {
  const doc = { activeElement: null, listeners: {} }, docL = {};
  const winListeners = {};
  Object.assign(doc, {
    documentElement: new El("html", doc), head: new El("head", doc), body: new El("body", doc),
    createElement: (t) => new El(t, doc),
    createTextNode: (s) => ({ text: String(s), parentNode: null }),
    // Every listener of a type runs, in order (offer.js has two click listeners since 2026-10-14, U2).
    // was: addEventListener: (t, f) => { doc.listeners[t] = f; },
    addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); doc.listeners[t] = (ev) => docL[t].forEach((g) => g(ev)); },
  });
  if (attr) doc.documentElement.setAttribute("data-internscout", "0.9.0");
  const clock = { now };
  const FakeDate = class extends Date { static now() { return clock.now; } };
  const ctx = {
    document: doc, navigator: ua ? { userAgentData: ua } : {}, localStorage: local, sessionStorage: session,
    addEventListener: (t, f) => { winListeners[t] = f; }, Date: FakeDate, Number, String, JSON, Math,
    scrolled: [], scrollBy(x, y) { ctx.scrolled.push(y); },
  };
  if (media) ctx.matchMedia = (q) => ({ matches: touch && q === "(pointer:coarse) and (hover:none)" });
  if (config) ctx.CONFIG = config;
  if (queue) ctx.ISCountQ = queue;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(OFFER, ctx);
  const posting = ({ cls = "go", aa = true } = {}) => {
    const a = new El("a", doc);
    a.setAttribute("href", "https://acme.wd1.myworkdayjobs.com/job/1");
    if (aa) a.setAttribute("data-aa", "");
    a.closest = (sel) => (sel.split(",").some((s) => s.trim() === `a.${cls}[href]`) ? a : null);
    return a;
  };
  // A click on a posting link, as the browser would deliver it; prevented says if anything stopped it.
  const open = (link = posting()) => {
    const ev = { target: link, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    doc.listeners.click(ev);
    return ev;
  };
  const bar = () => doc.body.children.find((c) => c.getAttribute && c.getAttribute("class") === "is-offer") || null;
  // Inside the context, `window` is its global proxy, not the object passed in.
  const message = (data) => winListeners.message({ source: vm.runInContext("window", ctx), data });
  const counted = () => (ctx.ISCountQ && typeof ctx.ISCountQ.length === "number" ? [...ctx.ISCountQ] : []);
  return { ctx, doc, clock, posting, open, bar, message, counted, local, session };
}

test("opening a posting Auto-Apply fills, in desktop Chrome without the extension, shows the offer once", () => {
  const r = load();
  const ev = r.open();
  assert.equal(ev.prevented, false, "the posting opens exactly as before");
  assert.equal(ev.stopped, undefined);
  const b = r.bar();
  assert.ok(b, "the bar is on the page");
  assert.equal(b.getAttribute("role"), "status");
  assert.equal(b.text.replace(/\s+/g, " ").trim(),
    // was: "Applying? Auto-Apply can fill in this application ..." (U6: worded for coming back to the tab).
    "Back from the posting? Next time, Auto-Apply can fill in an application like this one from your resume. You check it and press Submit yourself." +
    "When you add it, Chrome will say it can “Read and change your data on a number of websites” and “Read your browsing history”. " +
    "That is how it fills in job application sites and finds the application tab.Add to Chrome, freeDismiss");
  const go = b.find((n) => n.tag === "a");
  assert.equal(go.getAttribute("href"), STORE + "?utm_source=apply-offer");
  assert.equal(go.getAttribute("target"), "_blank");
  assert.equal(go.getAttribute("rel"), "noopener");
  const no = b.find((n) => n.tag === "button");
  assert.equal(no.getAttribute("type"), "button");
  assert.deepEqual(r.counted(), ["apply_offer_shown"]);
  assert.equal(r.session.map.get("internscout.applyoffer.shown"), "1");
  assert.equal(r.doc.head.children.length, 1, "its styles are added once, when it first shows");
  // A second posting on the same page load: still the one bar, counted once.
  r.open();
  assert.equal(r.doc.body.children.length, 1);
  assert.deepEqual(r.counted(), ["apply_offer_shown"]);
});

test("at most once a browser session, even if it was never dismissed", () => {
  const session = storage();
  load({ session }).open();
  const next = load({ session, now: T0 + 60000 });
  next.open();
  assert.equal(next.bar(), null);
  assert.deepEqual(next.counted(), []);
});

test("dismissing it hides it for 14 days, then it can show again", () => {
  const local = storage();
  const r = load({ local });
  r.open();
  r.bar().find((n) => n.tag === "button").fire("click");
  assert.equal(r.bar(), null);
  assert.equal(local.map.get("internscout.applyoffer.dismissed"), String(T0));
  r.open();
  assert.equal(r.bar(), null, "not again on this page");
  const day13 = load({ local, now: T0 + 13 * DAY });
  day13.open();
  assert.equal(day13.bar(), null);
  const day15 = load({ local, now: T0 + 15 * DAY });
  day15.open();
  assert.ok(day15.bar());
});

test("Escape on the bar dismisses it and puts focus back on the posting link", () => {
  const local = storage();
  const r = load({ local });
  const link = r.posting();
  r.open(link);
  const no = r.bar().find((n) => n.tag === "button");
  no.focus();
  r.bar().fire("keydown", { key: "Tab" });
  assert.ok(r.bar(), "other keys do nothing");
  r.bar().fire("keydown", { key: "Escape" });
  assert.equal(r.bar(), null);
  assert.equal(r.doc.activeElement, link);
  assert.equal(local.map.get("internscout.applyoffer.dismissed"), String(T0));
});

test("pressing its store link counts apply_offer_click and closes it for 14 days too", () => {
  const local = storage();
  const r = load({ local, queue: [] });
  r.open();
  r.bar().find((n) => n.tag === "a").fire("click");
  assert.deepEqual(r.counted(), ["apply_offer_shown", "apply_offer_click"]);
  assert.equal(r.bar(), null);
  assert.equal(local.map.get("internscout.applyoffer.dismissed"), String(T0));
});

test("its counts go through count.js once that has loaded", () => {
  const sent = [];
  const r = load({ queue: { push: (e) => sent.push(e) } });
  r.open();
  assert.deepEqual(sent, ["apply_offer_shown"]);
});

test("the dashboard's store address is used when it is a Web Store link", () => {
  const r = load({ config: { extensionStoreUrl: STORE + "-x" } });
  r.open();
  assert.equal(r.bar().find((n) => n.tag === "a").getAttribute("href"), STORE + "-x?utm_source=apply-offer");
  const bad = load({ config: { extensionStoreUrl: "javascript:alert(1)" } });
  bad.open();
  assert.equal(bad.bar().find((n) => n.tag === "a").getAttribute("href"), STORE + "?utm_source=apply-offer");
});

test("only posting links whose application Auto-Apply fills", () => {
  const r = load();
  r.open(r.posting({ aa: false }));
  assert.equal(r.bar(), null, "a posting on a site it can't fill");
  r.open(r.posting({ cls: "aa" }));
  assert.equal(r.bar(), null, "any other link");
  r.open(r.posting({ cls: "open-link" }));
  assert.ok(r.bar(), "the dashboard's posting link");
});

test("hidden wherever the extension is there or can't be added", () => {
  const cases = {
    "phone or tablet (touch only)": { touch: true },
    "no matchMedia to tell": { media: false },
    "Firefox or Safari (no client hints)": { ua: null },
    "a mobile Chromium": { ua: { ...CHROME, mobile: true } },
    "mobile not stated": { ua: { brands: CHROME.brands } },
    "not a Chromium brand": { ua: { mobile: false, brands: [{ brand: "Not=A?Brand", version: "24" }] } },
    "the extension's bridge marked the page": { attr: true },
    "local storage blocked": { local: blocked },
    "session storage blocked": { session: blocked },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const r = load(opts);
    r.open();
    assert.equal(r.bar(), null, name);
    assert.deepEqual(r.counted(), [], name);
  }
  for (const brand of ["Microsoft Edge", "Chromium"]) {
    const r = load({ ua: { mobile: false, brands: [{ brand, version: "140" }] } });
    r.open();
    assert.ok(r.bar(), brand);
  }
});

test("any message from the extension's bridge counts as installed, the page's own requests do not", () => {
  for (const kind of ["hello", "gone", "res", "push"]) {
    const r = load();
    r.message({ __internscout: kind });
    r.open();
    assert.equal(r.bar(), null, kind);
  }
  const r = load();
  r.message({ __internscout: "req", id: 1, msg: { type: "ping" } });
  r.message({ other: true });
  r.open();
  assert.ok(r.bar());
});

test("the copy stays plain: no dashes, exclamation marks or hype, and it says the student submits", () => {
  const r = load();
  r.open();
  const text = r.bar().text;
  assert.match(text, /press Submit yourself/);
  assert.match(text, /Add to Chrome, free/);
  assert.doesNotMatch(text, /[–—!]|instantly|seconds|effortless|supercharge|AI-powered|magic|apply for you|submits? for you/i);
});

test("the dashboard loads it and marks the posting links it can fill", () => {
  const index = readFileSync(new URL("../../docs/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
  assert.match(index, /<script defer src="js\/offer\.js"><\/script>/);
  assert.match(app, /className: "open-link", href: r\.apply_url, target: "_blank", rel: "noopener", "data-aa": SUPPORTED_ATS\.has\(r\.ats\) \? "" : undefined/);
  // The same posting links count.js counts as posting_click.
  const count = readFileSync(new URL("../../docs/js/count.js", import.meta.url), "utf8");
  assert.ok(count.includes('t.closest("a.go[href], a.open-link[href]")'));
  assert.ok(OFFER.includes('var POSTING = "a.go[href], a.open-link[href]";'));
});

// WCAG 2.4.11 (2026-10-14): while the bar shows, a focused link never sits under it.
test("while the bar shows, the page's scroll padding clears it, and a focus under it is scrolled up", () => {
  const r = load();
  r.doc.documentElement.style.scrollPaddingBottom = "10px";
  r.doc.body.appendChild = function (c) { c.parentNode = this; this.children.push(c); c.rect = { top: 820, bottom: 884, height: 64 }; return c; };
  r.open();
  assert.equal(r.doc.documentElement.style.scrollPaddingBottom, "88px", "the bar's height plus its 16px gap and a little room");
  // A link under the bar takes focus (a click or a script): the page scrolls it clear.
  const link = r.posting();
  link.rect = { top: 840, bottom: 860, height: 20 };
  r.doc.listeners.focusin({ target: link });
  assert.deepEqual(r.ctx.scrolled, [48]);
  // A link above the bar is left alone, and so is the bar's own button.
  const up = r.posting();
  up.rect = { top: 100, bottom: 120, height: 20 };
  r.doc.listeners.focusin({ target: up });
  r.doc.listeners.focusin({ target: r.bar().find((n) => n.tag === "button") });
  assert.deepEqual(r.ctx.scrolled, [48]);
  // Gone with the bar: the page's own padding comes back.
  r.bar().find((n) => n.tag === "button").fire("click");
  assert.equal(r.doc.documentElement.style.scrollPaddingBottom, "10px");
});

test("the bar uses the shared tokens: the large radius, the pop-up shadow and one primary button", () => {
  assert.match(OFFER, /border-radius:var\(--r-lg,8px\)/);
  assert.match(OFFER, /box-shadow:var\(--shadow-pop,/);
  assert.doesNotMatch(OFFER, /rgba\(20,20,20/, "the old fixed shadow vanished on a dark page");
  assert.match(OFFER, /\.is-offer \.is-offer-go\{[^}]*background:var\(--accent,/);
  assert.match(OFFER, /\.is-offer button\{[^}]*border:0;[^}]*background:transparent;[^}]*color:var\(--accent,/);
});

// ---------- U6 (2026-10-14): worded for coming back to the tab, and ready for Chrome's dialog ----------
test("the bar names the company on the posting's own row, on the dashboard and on a landing page", () => {
  for (const [rowTag, nameNode] of [["tr", "span"], ["li", "a"]]) {
    const r = load();
    const row = r.doc.createElement(rowTag);
    const co = r.doc.createElement(nameNode);
    co.setAttribute("class", "co");
    // The first child is the name; a landing page's "New" badge comes after it inside .co.
    const name = { textContent: "  Acme\n Robotics " };
    co.firstChild = name;
    row.querySelector = (sel) => (sel === ".co" ? co : null);
    const link = r.posting();
    const own = link.closest;
    link.closest = (sel) => (sel === "tr, li.job" ? row : own(sel));
    r.open(link);
    assert.match(r.bar().text, /^Back from Acme Robotics\? Next time, Auto-Apply can fill in an application like this one/);
  }
});

test("without a readable company it says Back from the posting, and it always prepares for Chrome's permission dialog", () => {
  const r = load();
  r.open();
  const t = r.bar().text;
  assert.match(t, /^Back from the posting\?/);
  assert.match(t, /Read and change your data on a number of websites/);
  assert.match(t, /Read your browsing history/);
  assert.doesNotMatch(t, /Applying\?|this application from/);
});

// U2 (2026-10-14): the posting a student wanted is remembered for the extension to offer after setup.
const rowWith = (company, title) => ({ querySelector: (sel) => (sel === ".co" ? { textContent: ` ${company}
` } : sel === ".role" ? { textContent: title } : null) });

test("pressing the bar's store link remembers the posting it was shown for", () => {
  const local = storage();
  const r = load({ local });
  const link = r.posting();
  link.href = link.getAttribute("href");   // a real link's href property is the full address
  const row = rowWith("Acme Corp", "Software  Intern");
  const own = link.closest;
  link.closest = (sel) => (sel === "tr, li.job" ? row : own(sel));
  r.open(link);
  assert.equal(local.map.get("internscout.wanted"), undefined, "opening the posting alone remembers nothing");
  const go = r.bar().find((n) => n.tag === "a");
  go.closest = (sel) => (sel === ".is-offer-go" ? go : null);
  r.doc.listeners.click({ target: go });
  assert.deepEqual(JSON.parse(local.map.get("internscout.wanted")),
    { url: "https://acme.wd1.myworkdayjobs.com/job/1", company: "Acme Corp", title: "Software Intern", at: T0 });
});

test("a landing page's Auto-Apply this link remembers that row's posting, unless the extension is there", () => {
  for (const attr of [false, true]) {
    const local = storage();
    const r = load({ local, attr });
    const go = new El("a", r.doc);
    go.href = "https://boards.greenhouse.io/acme/jobs/2";
    const job = { querySelector: (sel) => (sel === "a.go[data-aa][href]" ? go : sel === ".co" ? { textContent: "Acme" } : sel === ".role" ? { textContent: "Data Intern" } : null) };
    go.closest = (sel) => (sel === "tr, li.job" ? job : null);
    const aa = { closest: (sel) => (sel === "a.aa" ? aa : sel === "li.job" ? job : null) };
    r.doc.listeners.click({ target: aa, preventDefault() { throw new Error("must not stop the link"); } });
    if (attr) assert.equal(local.map.get("internscout.wanted"), undefined);
    else assert.deepEqual(JSON.parse(local.map.get("internscout.wanted")), { url: "https://boards.greenhouse.io/acme/jobs/2", company: "Acme", title: "Data Intern", at: T0 });
  }
});

test("a remembered posting the extension never read is deleted once it is older than three days, or unreadable", () => {
  const KEY = "internscout.wanted";
  const keep = (at) => new Map([[KEY, JSON.stringify({ url: "https://x.example/1", company: "Acme", title: "Intern", at })]]);
  const fresh = keep(T0 - 2 * DAY);
  load({ local: storage(fresh) });
  assert.ok(fresh.has(KEY), "two days old: kept");
  const stale = keep(T0 - 3 * DAY - 1);
  load({ local: storage(stale) });
  assert.ok(!stale.has(KEY), "over three days old: deleted");
  for (const bad of ["not json", JSON.stringify({ url: "https://x.example/1" }), JSON.stringify({ at: "soon" })]) {
    const m = new Map([[KEY, bad]]);
    load({ local: storage(m) });
    assert.ok(!m.has(KEY), `unreadable (${bad}): deleted`);
  }
  const other = new Map([["internscout.applyoffer.dismissed", String(T0)]]);
  load({ local: storage(other) });
  assert.ok(other.has("internscout.applyoffer.dismissed"), "other keys untouched");
  assert.doesNotThrow(() => load({ local: blocked }), "blocked storage is fine");
});
