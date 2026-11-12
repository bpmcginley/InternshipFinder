import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../../docs/follows/action.html", import.meta.url), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const credential = (purpose) =>
  (purpose === "delete-request" ? "fd_" : "") +
  randomUUID() +
  "." +
  randomBytes(32).toString("hex");
function fixture({
  purpose = "confirm",
  token = credential(purpose),
  fragment,
  query = "",
  response = async () => ({ status: 204 }),
  historyFails = false,
} = {}) {
  const nodes = Object.fromEntries(
    ["action-title", "explanation", "action", "status"].map((id) => [
      id,
      {
        textContent: "",
        hidden: id === "action",
        disabled: true,
        addEventListener(_, callback) {
          this.click = callback;
        },
      },
    ]),
  );
  const events = {},
    calls = [],
    timers = new Map();
  let boot,
    cleared = false;
  const context = {
    location: {
      pathname: "/follows/action.html",
      search: query,
      hash: fragment ?? `#purpose=${purpose}&token=${token}`,
    },
    history: {
      replaceState(state, title, path) {
        if (historyFails) throw new Error();
        assert.equal(path, "/follows/action.html");
        assert.equal(state, null);
        cleared = true;
      },
    },
    document: {
      addEventListener(_, callback) {
        boot = callback;
      },
      getElementById: (id) => nodes[id],
    },
    addEventListener: (event, callback) => {
      events[event] = callback;
    },
    URLSearchParams,
    AbortController,
    setTimeout: (callback) => {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  };
  vm.runInNewContext(source, context);
  assert.equal(calls.length, 0);
  if (!historyFails) assert(cleared, "strip before DOM boot");
  boot();
  assert.equal(calls.length, 0);
  return { nodes, calls, events, timers, token };
}

for (const purpose of ["confirm", "delete-request"])
  test(`${purpose} only posts the exact bearer after explicit action`, async () => {
    const { nodes, calls, token, timers } = fixture({ purpose });
    assert.equal(nodes.action.hidden, false);
    await nodes.action.click();
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, `https://internscout-api.bpmcginley.workers.dev/follows/${purpose}`);
    assert.equal(init.method, "POST");
    assert.equal(init.body, token);
    assert.equal(init.headers["Content-Type"], "text/plain");
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(nodes.action.disabled, true);
    assert.equal(timers.size, 0);
    assert.match(
      nodes.status.textContent,
      purpose === "confirm"
        ? /^Your follows are active\.$/
        : /^If this link matched a pending request/,
    );
    await nodes.action.click();
    assert.equal(calls.length, 1);
  });

test("malformed, query, duplicate, oversized and wrong-purpose links remain inert", () => {
  const token = credential("confirm");
  for (const options of [
    { fragment: "" },
    { fragment: "#purpose=confirm" },
    { fragment: "#" + "x".repeat(181) },
    { purpose: "unknown" },
    { purpose: "delete-request", token },
    { purpose: "confirm", token: "fd_" + token },
    { fragment: `#purpose=confirm&token=${token}&purpose=confirm` },
    { fragment: `#purpose=confirm&token=${token}&extra=1` },
    { token: token + "\n" },
    { query: "?token=" + token },
    { historyFails: true },
  ]) {
    const { nodes, calls } = fixture(options);
    assert.equal(nodes.action.hidden, true);
    assert.equal(nodes.action.disabled, true);
    assert.match(nodes.status.textContent, /^This link is invalid/);
    assert.equal(calls.length, 0);
  }
});

test("busy requests deduplicate; generic retry requires another explicit click", async () => {
  let resolve;
  const f = fixture({
    response: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const pending = f.nodes.action.click();
  await f.nodes.action.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes.action.disabled, true);
  resolve({ status: 503 });
  await pending;
  assert.equal(f.nodes.action.disabled, false);
  assert.equal(
    f.nodes.status.textContent,
    "Email follows are unavailable. Please try again later.",
  );
  const retry = f.nodes.action.click();
  resolve({ status: 204 });
  await retry;
  assert.equal(f.calls.length, 2);
});

test("expiry and malformed outcomes do not expose a response body or repeat action", async () => {
  for (const status of [400, 410]) {
    const f = fixture({
      response: async () => ({
        status,
        text() {
          throw new Error("must not read");
        },
      }),
    });
    await f.nodes.action.click();
    assert.equal(f.nodes.action.disabled, true);
    assert.match(
      f.nodes.status.textContent,
      status === 410 ? /^This link has expired/ : /^This link is invalid/,
    );
  }
});

test("network failure and abort are generic; leaving clears the in-memory capability", async () => {
  const f = fixture({
    response: async () => {
      throw new Error("private detail");
    },
  });
  await f.nodes.action.click();
  assert.equal(f.nodes.action.disabled, false);
  assert(!f.nodes.status.textContent.includes("private detail"));
  f.events.pagehide();
  f.events.pageshow({ persisted: true });
  await f.nodes.action.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes.action.disabled, true);
});

test("absolute client timeout aborts a pending request without automatically retrying", async () => {
  let resolve;
  const f = fixture({
    response: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const pending = f.nodes.action.click();
  [...f.timers.values()][0]();
  assert.equal(f.calls[0].init.signal.aborted, true);
  resolve({ status: 503 });
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes.action.disabled, false);
});

test("page is noindex, self-contained and has no storage, analytics or implicit form submission", () => {
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert(!/<(?:script|link|img)\b[^>]*(?:src|href)=/i.test(html));
  assert(
    !/localStorage|sessionStorage|document\.cookie|console\.|<form|count\.js|beacon/.test(html),
  );
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert(html.indexOf("history.replaceState") < html.indexOf("DOMContentLoaded"));
});
