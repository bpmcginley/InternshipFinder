import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../docs/js/count.js", import.meta.url), "utf8");
function load({
  flag = "1",
  host = "internscout.org",
  path = "/internships/test/",
  search = "",
  webdriver = false,
  off = false,
  frame = false,
  prerender = false,
  encoder = true,
  beacon = true,
  reject = false,
  throws = false,
} = {}) {
  const sent = [],
    listeners = new Map(),
    storage = new Map(off ? [["internscout.nocount", "1"]] : []);
  const ctx = {
    location: { hostname: host, pathname: path, search },
    navigator: {
      webdriver,
      sendBeacon: beacon
        ? (url, blob) => {
            sent.push({ url, body: JSON.parse(blob.text) });
            if (throws) throw Error("synthetic queue failure");
            return !reject;
          }
        : undefined,
    },
    document: {
      referrer: "https://example.test/private-ref",
      prerendering: prerender,
      currentScript:
        flag === null
          ? null
          : { getAttribute: (name) => (name === "data-employer-posting-counts" ? flag : null) },
      addEventListener: (type, fn) => {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      },
    },
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Blob: class {
      constructor(parts) {
        this.text = parts.join("");
      }
    },
    URL,
    URLSearchParams,
    TextEncoder: encoder ? TextEncoder : undefined,
  };
  ctx.window = ctx;
  ctx.top = frame ? {} : ctx;
  vm.runInNewContext(source, ctx);
  return {
    ctx,
    sent,
    bodies: () => sent.filter((x) => x.body.e === "employer_posting_open").map((x) => x.body),
    click(a, over = {}) {
      const event = { type: "click", button: 0, isTrusted: true, target: a, ...over };
      for (const fn of listeners.get(event.type) || []) fn(event);
    },
  };
}
function link(
  key = "example",
  {
    href = "https://jobs.example.test/one",
    cls = "go",
    paid = false,
    placement = false,
    excluded = false,
    rel = "nofollow noopener",
  } = {},
) {
  const attrs = { href, rel, "data-employer-key": key };
  return {
    matches: () => (cls === "go" || cls === "open-link") && href !== null && key !== null,
    getAttribute: (name) => attrs[name] ?? null,
    closest(selector) {
      if (selector === "a[href]") return this;
      if (selector === ".paid, [data-placement], [data-employer-posting-exclude]")
        return paid || placement || excluded ? {} : null;
      if (selector === ".paid") return paid ? {} : null;
      if (selector === "[data-placement]") return null;
      if (selector === "a.go[href], a.open-link[href]")
        return cls === "go" || cls === "open-link" ? this : null;
      return null;
    },
  };
}

test("explicit attribute only: missing and near-match values do not activate capture", () => {
  for (const flag of [null, "", "true", "0", "1 "]) {
    const r = load({ flag, search: "?employer_posting_counts=1" });
    r.click(link());
    assert.deepEqual(r.bodies(), []);
    assert(r.sent.some((x) => x.body.p)); // Legacy page view is unchanged.
  }
});
test("no employer request on load; one exact body per employer, no URL or attribution", () => {
  const r = load({ search: "?utm_source=synthetic&utm_campaign=private-search" });
  assert.deepEqual(r.bodies(), []);
  r.click(link("example"));
  r.click(link("example", { href: "https://jobs.example.test/two" }));
  r.click(link("other", { cls: "open-link" }));
  assert.deepEqual(r.bodies(), [
    { e: "employer_posting_open", c: "example" },
    { e: "employer_posting_open", c: "other" },
  ]);
  assert.equal(r.sent.filter((x) => x.body.e === "posting_click").length, 1);
});
test("automation, opt-out, off-site, widget, frame and missing browser API stay excluded", () => {
  for (const options of [
    { webdriver: true },
    { off: true },
    { search: "?nocount=1" },
    { host: "localhost" },
    { path: "/widget/" },
    { path: "/widget.html" },
    { frame: true },
    { encoder: false },
    { beacon: false },
  ]) {
    const r = load(options);
    r.click(link());
    assert.deepEqual(r.bodies(), [], JSON.stringify(options));
  }
  const r = load({ off: true, search: "?nocount=0" });
  r.click(link());
  assert.equal(r.bodies().length, 1);
});
test("only trusted activation: primary, keyboard-like and middle clicks share deduplication", () => {
  const r = load();
  r.click(link("script"), { isTrusted: false });
  r.click(link("right"), { type: "auxclick", button: 2 });
  r.click(link("keyboard"), { detail: 0 });
  r.click(link("middle"), { type: "auxclick", button: 1 });
  r.click(link("middle"));
  r.click(link("modified"), { ctrlKey: true });
  assert.deepEqual(
    r.bodies().map((x) => x.c),
    ["keyboard", "middle", "modified"],
  );
});
test("prerender never sends employer events until the document is activated", () => {
  const r = load({ prerender: true });
  r.click(link());
  assert.deepEqual(r.bodies(), []);
  r.ctx.document.prerendering = false;
  r.click(link());
  assert.equal(r.bodies().length, 1);
});
test("paid, sponsored, explicit exclusion, saved-only and Auto-Apply links do not count", () => {
  const r = load();
  for (const options of [
    { paid: true },
    { placement: true },
    { rel: "NoFollow SPONSORED noopener" },
    { excluded: true },
    { cls: "aa" },
  ])
    r.click(link("excluded", options));
  r.click(link(null, { cls: "open-link" })); // Saved-only fallback has no release annotation.
  r.click(link("organic", { href: "https://jobs.example.test/same-paid-role" }));
  assert.deepEqual(r.bodies(), [{ e: "employer_posting_open", c: "organic" }]);
});
test("invalid keys are rejected, UTF-8 bounds match Worker, and Set keys are literal", () => {
  const r = load();
  for (const key of ["", " x", "x ", "x\n", "\u007f", "\ud800", "é".repeat(101), "x".repeat(201)])
    r.click(link(key));
  for (const key of ["é".repeat(100), "😀".repeat(50), "__proto__", "constructor"])
    r.click(link(key));
  assert.equal(r.bodies().length, 4);
});
test("only valid absolute HTTP posting destinations can carry the annotation", () => {
  const r = load();
  for (const href of [
    null,
    "/install.html",
    "javascript:bad",
    "https://:secret@jobs.example.test/",
    "https://@jobs.example.test/",
    "https://jobs.example.test:bad/",
    "https://jobs.example.test/\\bad",
    "https://jobs.example.test/\nbad",
  ])
    r.click(link("bad", { href }));
  r.click(link("ok", { href: "http://jobs.example.test/" }));
  assert.deepEqual(r.bodies(), [{ e: "employer_posting_open", c: "ok" }]);
});
test("beacon refusal and exceptions are not retried; a fresh page may count again", () => {
  for (const options of [{ reject: true }, { throws: true }]) {
    const r = load(options);
    r.click(link());
    r.click(link());
    assert.equal(r.bodies().length, 1);
  }
  const fresh = load();
  fresh.click(link());
  assert.equal(fresh.bodies().length, 1);
});
test("local membership is bounded by the approved catalog maximum", () => {
  const r = load();
  for (let i = 0; i < 10001; i++) r.click(link("employer " + i));
  assert.equal(r.bodies().length, 10000);
});
