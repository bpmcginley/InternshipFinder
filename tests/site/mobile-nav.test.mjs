import { installCore } from "./core-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function harness() {
  const storage = new Map(),
    effects = [],
    refs = [];
  const document = {
    documentElement: { dataset: {} },
    activeElement: null,
    listeners: {},
    addEventListener(k, fn) {
      this.listeners[k] = fn;
    },
    removeEventListener(k) {
      delete this.listeners[k];
    },
    getElementById: () => destination,
  };
  const summary = {
      focus() {
        document.activeElement = summary;
      },
    },
    link = {
      href: "https://example.test/?state=all#listings",
      focus() {
        document.activeElement = link;
      },
    },
    destination = {
      focus() {
        document.activeElement = destination;
      },
    },
    details = { open: false },
    nav = { contains: (el) => el === link },
    box = {
      querySelector: (s) => ({ details, summary, nav, "nav a": link })[s],
      contains: (el) => el === summary || el === link,
    },
    mq = {
      matches: true,
      addEventListener(k, fn) {
        this.change = fn;
      },
      removeEventListener() {
        this.change = null;
      },
    };
  const React = {
    Fragment: "fragment",
    memo: (f) => f,
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat().filter((x) => x != null && x !== false),
    }),
    useMemo: (f) => f(),
    useRef: () => {
      const ref = { current: refs.length ? null : box };
      refs.push(ref);
      return ref;
    },
    useEffect: (fn) => effects.push(fn),
  };
  const ctx = {
    React,
    URLSearchParams,
    URL,
    CONFIG: {},
    location: { origin: "https://example.test", pathname: "/", search: "?state=all" },
    matchMedia: () => mq,
    addEventListener() {},
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    document,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  installCore(ctx);
  const app = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
  vm.runInContext(
    app.replace(
      'ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
      "window.components = { SiteNav };",
    ),
    ctx,
  );
  const tree = ctx.components.SiteNav({ children: "links" }),
    cleanup = effects[0]();
  return { tree, cleanup, document, summary, link, destination, details, box, mq };
}

test("native disclosure controls the sibling site navigation without menu roles", () => {
  const H = harness(),
    details = H.tree.children[0],
    summary = details.children[0];
  assert.equal(details.type, "details");
  assert.equal(summary.type, "summary");
  assert.equal(summary.props["aria-controls"], "site-links");
  assert.equal(summary.children[0], "Menu");
  assert.equal(H.tree.props.role, undefined);
  assert.equal(H.tree.children[1], "links");
});
test("Escape closes an open phone disclosure and returns focus to its summary", () => {
  const H = harness();
  H.details.open = true;
  H.document.activeElement = H.link;
  let stopped = 0;
  H.tree.props.onKeyDown({ key: "Escape", stopPropagation: () => stopped++ });
  assert.equal(H.details.open, false);
  assert.equal(H.document.activeElement, H.summary);
  assert.equal(stopped, 1);
  H.document.activeElement = H.link;
  H.tree.props.onKeyDown({ key: "Escape" });
  assert.equal(H.document.activeElement, H.link);
});
test("Tab out closes without taking focus from the new destination; inside focus stays open", () => {
  const H = harness();
  H.details.open = true;
  H.tree.props.onBlur({ currentTarget: H.box, relatedTarget: H.link });
  assert.equal(H.details.open, true);
  H.document.activeElement = H.destination;
  H.tree.props.onBlur({ currentTarget: H.box, relatedTarget: H.destination });
  assert.equal(H.details.open, false);
  assert.equal(H.document.activeElement, H.destination);
});
test("resize never leaves the summary or a collapsed link holding invisible focus", () => {
  const H = harness();
  H.details.open = true;
  H.document.activeElement = H.summary;
  H.mq.matches = false;
  H.mq.change();
  assert.equal(H.details.open, false);
  assert.equal(H.document.activeElement, H.link);
  H.mq.matches = true;
  H.mq.change();
  assert.equal(H.document.activeElement, H.summary);
  H.cleanup();
  assert.equal(H.mq.change, null);
  assert.equal(H.document.listeners.pointerdown, undefined);
});
test("same-page link activation closes and focuses its destination without cancelling navigation", () => {
  const H = harness();
  H.details.open = true;
  H.tree.props.onClick({ target: { closest: () => H.link } });
  assert.equal(H.details.open, false);
  assert.equal(H.document.activeElement, H.destination);
});
test("outside pointer closes while leaving the browser's default pointer action intact", () => {
  const H = harness();
  H.details.open = true;
  H.document.activeElement = H.link;
  H.document.listeners.pointerdown({ target: H.destination });
  assert.equal(H.details.open, false);
  assert.equal(H.document.activeElement, H.summary);
  H.details.open = true;
  H.document.listeners.pointerdown({ target: H.link });
  assert.equal(H.details.open, true);
});

test("breakpoint blur can precede the resize callback without losing focus recovery", () => {
  const H = harness();
  H.document.body = {};
  H.document.activeElement = H.summary;
  H.tree.props.onFocus({ target: H.summary });
  H.tree.props.onBlur({
    currentTarget: H.box,
    relatedTarget: null,
    target: { getClientRects: () => [] },
  });
  H.document.activeElement = H.document.body;
  H.mq.matches = false;
  H.mq.change();
  assert.equal(H.document.activeElement, H.link);
});
test("modified activation and explicit new-tab links retain the original menu and focus", () => {
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey", "target"]) {
    const H = harness();
    H.details.open = true;
    H.document.activeElement = H.link;
    if (modifier === "target") H.link.target = "_blank";
    H.tree.props.onClick({
      target: { closest: () => H.link },
      ...(modifier === "target" ? {} : { [modifier]: true }),
    });
    assert.equal(H.details.open, true);
    assert.equal(H.document.activeElement, H.link);
  }
});

test("genuine outside blur clears remembered focus before a later breakpoint change", () => {
  const H = harness();
  H.document.body = {};
  H.tree.props.onFocus({ target: H.summary });
  H.tree.props.onBlur({
    currentTarget: H.box,
    relatedTarget: null,
    target: { getClientRects: () => [{}] },
  });
  H.document.activeElement = H.document.body;
  H.mq.matches = false;
  H.mq.change();
  assert.equal(H.document.activeElement, H.document.body);
  H.tree.props.onFocus({ target: H.link });
  H.document.listeners.pointerdown({ target: H.destination });
  H.document.activeElement = H.document.body;
  H.mq.matches = true;
  H.mq.change();
  assert.equal(H.document.activeElement, H.document.body);
});
