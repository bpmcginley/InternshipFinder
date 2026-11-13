import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { handle } from "../src/index.js";
import { followUnsubscribePreview } from "../src/follow-unsubscribe-preview.js";

const TOKEN = `10000000-0000-4000-8000-000000000001.${"a".repeat(64)}`;
const path = "/follows/unsubscribe";
const target = `https://preview.example.test${path}?token=${TOKEN}`;
const html = await (await followUnsubscribePreview(new Request(target))).text();
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function browser({ query = `?token=${TOKEN}`, hash = "", historyFailure = false, fetch } = {}) {
  const events = {},
    timers = new Map(),
    calls = [],
    order = [];
  const elements = Object.fromEntries(
    ["unsubscribe", "status"].map((id) => [
      id,
      {
        textContent: "",
        disabled: true,
        handlers: {},
        addEventListener(name, fn) {
          this.handlers[name] = fn;
        },
      },
    ]),
  );
  const location = { pathname: path, search: query, hash };
  let ready;
  const context = {
    location,
    AbortController,
    history: {
      replaceState(state, title, url) {
        order.push("clear");
        assert.equal(url, path);
        if (historyFailure) throw Error("synthetic");
        location.search = "";
        location.hash = "";
        location.pathname = path;
      },
    },
    addEventListener: (name, fn) => {
      events[name] = fn;
    },
    document: {
      addEventListener(name, fn) {
        assert.equal(name, "DOMContentLoaded");
        ready = fn;
      },
      getElementById: (id) => elements[id],
    },
    setTimeout(fn, ms) {
      assert.equal(ms, 12000);
      timers.set(1, fn);
      return 1;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      order.push("post");
      calls.push({ url, options });
      return fetch ? fetch(url, options) : new Response(null, { status: 204 });
    },
  };
  vm.runInNewContext(script, context);
  assert.deepEqual(order, ["clear"], "history clears before DOM or transport");
  assert.equal(calls.length, 0);
  ready();
  return {
    elements,
    location,
    events,
    timers,
    calls,
    order,
    click: () => elements.unsubscribe.handlers.click(),
  };
}

test("preview GET has identical static HTML and hashes, zero DB access or credential reflection", async () => {
  let touches = 0;
  const env = {
    get DB() {
      touches++;
      assert.fail("GET must not touch D1 binding");
    },
  };
  for (const query of [
    "",
    `?token=${TOKEN}`,
    "?token=invalid",
    "?token=x&token=y",
    "?secret=<script>",
  ]) {
    const response = await handle(
      new Request(`https://preview.example.test${path}${query}`),
      env,
      undefined,
      {
        fetch: () => assert.fail("No transport"),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), html);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(response.headers.has("set-cookie"), false);
    const csp = response.headers.get("content-security-policy");
    for (const kind of ["script", "style"]) {
      const text = html.match(new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`))[1];
      assert.ok(
        csp.includes(`${kind}-src 'sha256-${createHash("sha256").update(text).digest("base64")}'`),
      );
    }
    assert.ok(csp.includes("connect-src 'self'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  }
  assert.equal(touches, 0);
  assert.equal(html.includes(TOKEN), false);
  assert.doesNotMatch(
    html,
    /<script[^>]+src=|<link|<img|localStorage|sessionStorage|document\.cookie|console\./,
  );
});

test("HEAD and near preview paths stay inert", async () => {
  const db = { prepare: () => assert.fail("No D1") };
  for (const [method, url] of [
    ["HEAD", target],
    ["GET", target.replace("unsubscribe?", "unsubscribe/?")],
    ["GET", target.replace("unsubscribe?", "unsubscribe/extra?")],
  ]) {
    assert.equal((await handle(new Request(url, { method }), { DB: db })).status, 404);
  }
});

test("explicit click makes one existing one-click POST without ambient credentials", async () => {
  const b = browser();
  assert.equal(b.location.search, "");
  assert.equal(b.elements.unsubscribe.disabled, false);
  await b.click();
  await b.click();
  assert.equal(b.calls.length, 1);
  const { url, options } = b.calls[0];
  assert.equal(url, `${path}?token=${TOKEN}`);
  for (const [key, value] of Object.entries({
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    mode: "same-origin",
    referrerPolicy: "no-referrer",
    body: "List-Unsubscribe=One-Click",
  }))
    assert.equal(options[key], value);
  assert.equal(options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(
    b.elements.status.textContent,
    "If this link matched an email subscription, it has been unsubscribed.",
  );
  assert.equal(b.elements.unsubscribe.disabled, true);
  assert.equal(b.timers.size, 0);
});

test("malformed query, fragment, and failed history replacement cannot send", async () => {
  for (const options of [
    { query: "" },
    { query: "?token=invalid" },
    { query: `?token=fd_${TOKEN}` },
    { query: `?token=${TOKEN}&extra=1` },
    { query: `?token=${TOKEN}&token=${TOKEN}` },
    { query: `?%74oken=${TOKEN}` },
    { query: `?token=${TOKEN.toUpperCase()}` },
    { hash: "#token" },
    { historyFailure: true },
  ]) {
    const b = browser(options);
    await b.click();
    assert.equal(b.calls.length, 0);
    assert.equal(b.elements.unsubscribe.disabled, true);
    assert.equal(b.elements.status.textContent, "This link is invalid.");
  }
});

test("timeout and failure never retry or display a late success", async () => {
  let resolve;
  const b = browser({
    fetch: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const pending = b.click();
  await b.click();
  assert.equal(b.calls.length, 1);
  b.timers.get(1)();
  assert.equal(b.calls[0].options.signal.aborted, true);
  resolve(new Response(null, { status: 204 }));
  await pending;
  assert.equal(
    b.elements.status.textContent,
    "Email follows are unavailable. Please try again later.",
  );
  await b.click();
  assert.equal(b.calls.length, 1);
  for (const fetch of [
    async () => {
      throw Error("synthetic");
    },
    async () => new Response("ignored", { status: 503 }),
  ]) {
    const failed = browser({ fetch });
    await failed.click();
    await failed.click();
    assert.equal(failed.calls.length, 1);
    assert.equal(failed.elements.status.textContent, b.elements.status.textContent);
  }
});

test("navigation retires in-memory authority and suppresses an in-flight result", async () => {
  for (const name of ["pagehide", "popstate", "pageshow", "hashchange"]) {
    const b = browser();
    b.location.hash = "#new";
    b.events[name]({ persisted: true });
    await b.click();
    assert.equal(b.calls.length, 0);
    assert.equal(b.location.hash, "");
  }
  let resolve;
  const b = browser({
    fetch: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const pending = b.click();
  b.events.pagehide();
  resolve(new Response(null, { status: 204 }));
  await pending;
  assert.equal(b.elements.status.textContent, "This link is invalid.");
  assert.equal(b.calls[0].options.signal.aborted, true);
});
