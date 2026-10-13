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
  constructor(tag, doc) { this.tag = tag; this.doc = doc; this.attrs = {}; this.children = []; this.listeners = {}; this.parentNode = null; this.textContent = ""; }
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
  const doc = { activeElement: null, listeners: {} };
  const winListeners = {};
  Object.assign(doc, {
    documentElement: new El("html", doc), head: new El("head", doc), body: new El("body", doc),
    createElement: (t) => new El(t, doc),
    createTextNode: (s) => ({ text: String(s), parentNode: null }),
    addEventListener: (t, f) => { doc.listeners[t] = f; },
  });
  if (attr) doc.documentElement.setAttribute("data-internscout", "0.9.0");
  const clock = { now };
  const FakeDate = class extends Date { static now() { return clock.now; } };
  const ctx = {
    document: doc, navigator: ua ? { userAgentData: ua } : {}, localStorage: local, sessionStorage: session,
    addEventListener: (t, f) => { winListeners[t] = f; }, Date: FakeDate, Number, String, JSON,
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
    "Applying? Auto-Apply can fill in this application from your resume. You check it and press Submit yourself.Add to Chrome, freeDismiss");
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
