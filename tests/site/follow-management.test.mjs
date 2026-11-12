import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import vm from "node:vm";
import { mountManagementPage, scopeFacts } from "../../docs/js/follow-management.mjs";
const html = readFileSync(new URL("../../docs/follows/manage.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const token = () => randomUUID() + "." + randomBytes(32).toString("hex");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const key = (company) => JSON.stringify({ kind: "company", company });
const row = (company) => ({
  scope_key: key(company),
  created: "2026-11-12T00:00:00.000Z",
  confirmed_at: null,
});
const json = (value) => new Response(JSON.stringify(value));
async function fixture({ fragment, query = "", historyFails = false, transport, timeoutMs } = {}) {
  let focus, boot, lifecycle;
  const calls = [],
    events = {},
    credential = token();
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.events = {};
      this.disabled = false;
      this.value = "";
    }
    addEventListener(name, fn) {
      this.events[name] = fn;
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren() {
      this.children = [];
    }
    remove() {
      this.parent.children = this.parent.children.filter((child) => child !== this);
    }
    get nextElementSibling() {
      return this.parent.children[this.parent.children.indexOf(this) + 1];
    }
    querySelector(tag) {
      return this.children.find((child) => child.tag === tag);
    }
    setAttribute() {}
    focus() {
      if (!this.disabled) focus = this;
    }
    checkValidity() {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value);
    }
  }
  const ids = ["scopes", "status", "load", "more", "delete", "email", "request", "request-button"];
  const nodes = Object.fromEntries(
    ids.map((id) => [
      id,
      new Node(["load", "more", "delete", "request-button"].includes(id) ? "button" : id),
    ]),
  );
  const document = {
    getElementById: (id) => nodes[id],
    createElement: (tag) => new Node(tag),
    querySelectorAll: () =>
      [...Object.values(nodes), ...nodes.scopes.children.flatMap((n) => n.children)].filter(
        (n) => n.tag === "button",
      ),
    addEventListener: (_, fn) => {
      boot = fn;
    },
  };
  const location = {
    pathname: "/follows/manage.html",
    hash: fragment ?? `#token=${credential}`,
    get href() {
      return "https://internscout.org" + this.pathname + query + this.hash;
    },
  };
  const context = {
    location,
    document,
    addEventListener: (name, fn) => {
      events[name] = fn;
    },
    history: {
      replaceState: () => {
        if (historyFails) throw Error();
        location.hash = "";
        query = "";
      },
    },
    Promise,
    mountManagementPage: (args) => {
      lifecycle = args.lifecycle;
      mountManagementPage({
        ...args,
        timeoutMs,
        transport:
          transport &&
          (async (...args) => {
            calls.push(args);
            return transport(...args);
          }),
      });
    },
  };
  // Only the dynamic import is resolved locally; the actual bootstrap and controller execute.
  vm.runInNewContext(
    script.replace(
      'import("/js/follow-management.mjs")',
      "Promise.resolve({ mountManagementPage })",
    ),
    context,
  );
  assert.equal(calls.length, 0);
  if (!historyFails) assert.equal(location.hash, "");
  boot();
  await tick();
  assert.equal(calls.length, 0);
  return {
    nodes,
    calls,
    credential,
    events,
    location,
    lifecycle,
    focus: () => focus,
    click: async (id) => {
      nodes[id].events.click();
      await tick();
    },
    submit: async () => {
      nodes.request.events.submit({ preventDefault() {} });
      await tick();
    },
    navigate: (hash, fire = true) => {
      location.hash = hash;
      if (fire) events.hashchange();
    },
  };
}
test("no load-time I/O; default transport is unavailable only on explicit action", async () => {
  const f = await fixture();
  await f.click("load");
  assert.match(f.nodes.status.textContent, /unavailable/);
  assert.equal(f.calls.length, 0);
});
test("malformed/query/duplicate/wrong-purpose fragments and failed stripping never admit", async () => {
  const value = token();
  for (const options of [
    { fragment: "" },
    { fragment: `#token=${value}&token=${value}` },
    { query: "?" },
    { query: "?token=x" },
    { fragment: `#token=fd_${value}` },
    { fragment: "#token=" + "a".repeat(5000) },
    { historyFails: true },
  ]) {
    const f = await fixture(options);
    assert.equal(f.nodes.load.disabled, true);
    assert.equal(f.lifecycle.read().token, "");
  }
});
test("pagination sends exact cursor and renders facts as plain text, then removes with focus", async () => {
  const a = row("<img src=x onerror=alert(1)>"),
    b = row("second"),
    seen = [];
  const f = await fixture({
    transport: async (kind, body) => {
      seen.push([kind, body]);
      return kind === "remove"
        ? json({ removed: true })
        : json(body[1] ? { scopes: [b], next: null } : { scopes: [a], next: a.scope_key });
    },
  });
  await f.click("load");
  assert.equal(f.nodes.scopes.children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(f.nodes.more.hidden, false);
  await f.click("more");
  assert.equal(f.nodes.scopes.children.length, 2);
  assert.deepEqual(seen[1], ["list", [f.credential, a.scope_key]]);
  const first = f.nodes.scopes.children[0];
  first.children[2].events.click();
  await tick();
  assert.deepEqual(seen[2], ["remove", [f.credential, a.scope_key]]);
  assert.equal(f.nodes.scopes.children.length, 1);
  assert.equal(f.focus(), f.nodes.scopes.children[0].children[2]);
  assert.equal(f.nodes.status.textContent, "Follow removed.");
});
test("empty authorized list differs from 410 and malformed or repeating pages", async () => {
  for (const [response, text] of [
    [json({ scopes: [], next: null }), "You have no follows"],
    [new Response(null, { status: 410 }), "no longer valid"],
    [json({ scopes: [row("a")], next: "bad" }), "unavailable"],
    [json({ scopes: [row("a"), row("a")], next: null }), "unavailable"],
  ]) {
    const f = await fixture({ transport: async () => response });
    await f.click("load");
    assert(f.nodes.status.textContent.includes(text));
  }
});
test("false or uncertain mutations never claim deletion; exact true clears capability", async () => {
  for (const result of [{ deleted: false }, {}, { deleted: true }]) {
    const f = await fixture({
      transport: async (kind) =>
        json(kind === "list" ? { scopes: [row("a")], next: null } : result),
    });
    await f.click("load");
    await f.click("delete");
    assert.equal(f.nodes.status.textContent.includes("have been deleted"), result.deleted === true);
    if (result.deleted === true) assert.equal(f.lifecycle.read().token, "");
  }
});
test("management request validates email and treats empty 202 generically", async () => {
  const f = await fixture({
    fragment: "",
    transport: async () => new Response(null, { status: 202 }),
  });
  f.nodes.email.value = "bad";
  await f.submit();
  assert.equal(f.calls.length, 0);
  assert.match(f.nodes.status.textContent, /valid email/);
  f.nodes.email.value = "reader@example.test";
  await f.submit();
  assert.deepEqual(f.calls[0].slice(0, 2), ["request", { email: "reader@example.test" }]);
  assert.equal(f.nodes.email.value, "");
  assert.match(f.nodes.status.textContent, /management link is on its way/);
});
test("same-document replacement strips immediately, aborts old result and still requires a click", async () => {
  let resolve;
  const f = await fixture({
    transport: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await f.click("load");
  const old = f.calls[0][2].signal;
  const next = token();
  f.navigate(`#token=${next}`);
  assert.equal(f.location.hash, "");
  assert.equal(old.aborted, true);
  resolve(json({ scopes: [row("old")], next: null }));
  await tick();
  assert.equal(f.nodes.scopes.children.length, 0);
  assert.equal(f.lifecycle.read().token, next);
  assert.equal(f.calls.length, 1);
  f.navigate("#main");
  assert.equal(f.lifecycle.read().token, next);
});
test("pagehide and persisted restore stay inert even with queued hash and stale completion", async () => {
  let resolve;
  const f = await fixture({
    transport: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await f.click("load");
  f.navigate(`#token=${token()}`, false);
  f.events.pagehide();
  resolve(json({ scopes: [row("old")], next: null }));
  await tick();
  f.events.pageshow({ persisted: true });
  assert.equal(f.lifecycle.read().token, "");
  assert.equal(f.location.hash, "");
  assert.equal(f.nodes.load.disabled, true);
  assert.equal(f.nodes.scopes.children.length, 0);
});
test("busy deduplicates; a timed-out noncooperative transport cannot apply later", async () => {
  let resolve;
  const f = await fixture({
    timeoutMs: 1,
    transport: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await f.click("load");
  await new Promise((r) => setTimeout(r, 5));
  assert.match(f.nodes.status.textContent, /unavailable/);
  resolve(json({ scopes: [row("late")], next: null }));
  await tick();
  assert.equal(f.nodes.scopes.children.length, 0);
});
test("scope formatting preserves retained facts; page has no tracking, persistence or live endpoints", () => {
  assert.equal(
    scopeFacts(JSON.stringify({ kind: "search", fields: ["future_field"], states: ["NY"] })),
    "Following: future_field; NY. Other search filters are not included.",
  );
  assert.throws(() => scopeFacts("{}"));
  assert.match(html, /noindex, nofollow/);
  assert.match(html, /no-referrer/);
  assert.doesNotMatch(
    html,
    /localStorage|sessionStorage|count\.js|fetch\(|https:\/\/internscout-api/,
  );
});

test("response decoding is bounded and a stalled body is cancelled and unlocked", async () => {
  for (const body of [new Uint8Array([255]), new Uint8Array(262145)]) {
    const f = await fixture({ transport: async () => new Response(body) });
    await f.click("load");
    assert.match(f.nodes.status.textContent, /unavailable/);
  }
  let cancelled = false;
  const body = new ReadableStream({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  const f = await fixture({ timeoutMs: 1, transport: async () => new Response(body) });
  await f.click("load");
  await new Promise((r) => setTimeout(r, 10));
  assert.match(f.nodes.status.textContent, /unavailable/);
  assert(cancelled);
  assert.equal(body.locked, false);
});

test("an in-flight explicit request cannot be submitted twice", async () => {
  let resolve;
  const f = await fixture({
    transport: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await f.click("load");
  await f.click("load");
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes.load.disabled, true);
  resolve(new Response(null, { status: 503 }));
  await tick();
  assert.match(f.nodes.status.textContent, /unavailable/);
  assert.equal(f.nodes.load.disabled, false);
});
