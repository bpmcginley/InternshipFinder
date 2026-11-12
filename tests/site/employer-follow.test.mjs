import test from "node:test";
import assert from "node:assert/strict";
import { mountCompanyFollow } from "../../docs/js/follow-company.mjs";
import { FOLLOW_COPY, normalizeFollowEmail } from "../../docs/js/app/follow-form.mjs";

function fixture(options = {}) {
  const events = new Map(),
    calls = [];
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.ownerDocument = doc;
      this.isConnected = true;
      this.childNodes = [];
      this.attrs = {};
      this.style = {};
      this.events = new Map();
      this.value = "";
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    getAttribute(k) {
      return this.attrs[k] ?? null;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    append(...nodes) {
      this.childNodes.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.childNodes = nodes;
    }
    addEventListener(k, f) {
      this.events.set(k, f);
    }
    removeEventListener(k) {
      this.events.delete(k);
    }
    focus() {
      doc.activeElement = this;
    }
    fire(k, e = {}) {
      return this.events.get(k)?.({ preventDefault() {}, ...e });
    }
  }
  const doc = {
    createElement: (tag) => new Element(tag),
    getElementById: () => null,
    documentElement: {},
  };
  const root = new Element("section");
  root.setAttribute("data-follow-company-key", options.key ?? "fixture");
  root.setAttribute("data-follow-company-label", "Fixture <Labs>");
  let observer;
  const browser = {
    document: doc,
    Date,
    performance,
    AbortController,
    setTimeout,
    clearTimeout,
    MutationObserver: class {
      constructor(fn) {
        observer = fn;
      }
      observe() {}
      disconnect() {}
    },
    addEventListener(k, f) {
      events.set(k, f);
    },
    removeEventListener(k) {
      events.delete(k);
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 202 });
    },
  };
  const control = mountCompanyFollow(browser, root, options);
  const [toggle, form] = root.childNodes,
    [label, helper, submit, status] = form?.childNodes || [],
    email = label?.childNodes[0];
  return {
    browser,
    doc,
    root,
    control,
    toggle,
    form,
    email,
    helper,
    submit,
    status,
    calls,
    mutate: () => observer(),
    hide: () => events.get("pagehide")?.(),
  };
}

test("invalid marker is inert; pure shared normalization and approved copy stay exact", () => {
  for (const key of ["", " bad", "x".repeat(201), "bad\nkey"])
    assert.equal(fixture({ key }).control, null);
  assert.equal(normalizeFollowEmail(" A@B.TEST "), "a@b.test");
  for (const value of [null, "bad", "x\n@y.test", "x".repeat(255) + "@a.test"])
    assert.equal(normalizeFollowEmail(value), null);
  assert.equal(FOLLOW_COPY.submitLabel, "Email me new internships");
});

test("keyboard open/error/close uses text nodes and exact shared words, without an automatic request", async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.equal(f.toggle.textContent, "Email me when Fixture <Labs> posts an internship");
  f.toggle.fire("click");
  assert.equal(f.doc.activeElement, f.email);
  assert.equal(f.form.hidden, false);
  f.email.value = "invalid";
  await f.form.fire("submit");
  assert.equal(f.status.textContent, FOLLOW_COPY.email);
  assert.equal(f.calls.length, 0);
  f.form.fire("keydown", { key: "Escape" });
  assert.equal(f.form.hidden, true);
  assert.equal(f.email.value, "");
  assert.equal(f.doc.activeElement, f.toggle);
});

test("real reused transport sends anonymous exact scope, only explicit empty202 succeeds", async () => {
  const f = fixture();
  f.toggle.fire("click");
  f.email.value = "Synthetic@Example.test";
  await f.form.fire("submit");
  assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.calls[0].url).pathname, "/follows/signup");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    email: "synthetic@example.test",
    link: false,
    scope: { kind: "company", company: "fixture" },
  });
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.equal(f.calls[0].init.referrerPolicy, "no-referrer");
  assert.equal(f.status.textContent, FOLLOW_COPY.accepted);
  assert.equal(f.doc.activeElement, f.status);
  f.browser.fetch = async () => new Response("{}", { status: 200 });
  f.email.value = "synthetic@example.test";
  await f.form.fire("submit");
  assert.equal(f.status.textContent, FOLLOW_COPY.unavailable);
});

test("single flight and busy Escape preserve request; changed/detached/pagehide results are discarded", async () => {
  for (const action of ["key", "label", "detached", "pagehide"]) {
    let settle,
      signal,
      count = 0;
    const f = fixture({
      request: async (_input, opts) => {
        count++;
        signal = opts.signal;
        return new Promise((r) => (settle = r));
      },
    });
    f.toggle.fire("click");
    f.email.value = "synthetic@example.test";
    const pending = f.form.fire("submit");
    await f.form.fire("submit");
    f.form.fire("keydown", { key: "Escape" });
    assert.equal(count, 1);
    assert.equal(f.form.hidden, false);
    if (action === "key") f.root.setAttribute("data-follow-company-key", "other");
    if (action === "label") f.root.setAttribute("data-follow-company-label", "Other");
    if (action === "detached") f.root.isConnected = false;
    if (action === "pagehide") f.hide();
    else f.mutate();
    assert.equal(signal.aborted, true);
    settle({ status: "accepted" });
    await pending;
    assert.equal(f.root.childNodes.length, 0);
    assert.equal(f.email.value, "");
    assert.notEqual(f.status.textContent, FOLLOW_COPY.accepted);
  }
});
