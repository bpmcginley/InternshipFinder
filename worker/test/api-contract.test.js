import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";
import { fileURLToPath } from "node:url";
import { AUTH, ROUTES, SPECIAL_ROUTES } from "../src/api-contract.js";
import { generateApi } from "../scripts/generate-api.mjs";
import { handle } from "../src/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
const key = (method, path) => `${method} ${path.split("?")[0].replace(/\/+$/, "") || "/"}`;
const declared = new Set(ROUTES.map((r) => key(r.method, r.path)));

test("the contract contains every exact router case, with auth and descriptive shapes", () => {
  const served = [],
    prefixes = new Set();
  walk(
    parse(read("worker/src/index.js"), { ecmaVersion: "latest", sourceType: "module" }),
    (node) => {
      if (node.type === "SwitchCase" && node.test?.type === "Literal") {
        const match = /^([A-Z]+) (\/.*)$/.exec(String(node.test.value));
        if (match) served.push(key(match[1], match[2]));
      }
      if (
        node.type === "CallExpression" &&
        name(node.callee.object) === "path" &&
        name(node.callee.property) === "startsWith"
      )
        prefixes.add(node.arguments[0].value);
    },
  );
  assert.equal(declared.size, ROUTES.length, "duplicate contract route");
  assert.deepEqual([...declared].sort(), served.sort());
  assert.deepEqual(
    [...prefixes].sort(),
    [
      ...new Set(SPECIAL_ROUTES.filter((r) => r.path !== "*").map((r) => r.path.slice(0, -1))),
    ].sort(),
  );
  for (const route of [...ROUTES, ...SPECIAL_ROUTES]) {
    for (const auth of route.auth.split(" + ")) assert.ok(Object.hasOwn(AUTH, auth), auth);
    assert.ok(route.request && route.response && route.gate);
  }
});

test("global preflight, media delegation and fallback are explicit, without changing routing", async () => {
  const source = read("worker/src/index.js");
  assert.match(source, /path\.startsWith\("\/social-video\/"\)\)\s*return socialVideo/);
  assert.match(
    source,
    /request\.method === "OPTIONS"\s*\? new Response\(null, \{ status: 204 \}\)/,
  );
  assert.deepEqual(
    SPECIAL_ROUTES.map((r) => [r.method, r.path]),
    [
      ["OPTIONS", "*"],
      ["GET", "/social-video/*"],
      ["HEAD", "/social-video/*"],
      ["*", "*"],
    ],
  );
  const never = async () => assert.fail("contract transport probes must not fetch");
  for (const [method, path, status] of [
    ["OPTIONS", "/unknown", 204],
    ["GET", "/unknown", 404],
    ["POST", "/social-video/2026-11-10-field.mp4", 405],
  ]) {
    const response = await handle(
      new Request(`https://api.test${path}`, { method }),
      {},
      undefined,
      { fetch: never },
    );
    assert.equal(response.status, status);
  }
  const head = await handle(
    new Request("https://api.test/social-video/2026-11-10-field.mp4", { method: "HEAD" }),
    {},
    undefined,
    {
      fetch: async (_url, options) => {
        assert.equal(options.method, "HEAD");
        return new Response(null, { headers: { "Content-Length": "1" } });
      },
    },
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("generated API markdown is current", () => {
  assert.equal(read("worker/API.md"), generateApi());
});

// Static source inventory with explicit adapters for the current indirect transports.
// It does not execute client code or claim arbitrary JavaScript data-flow analysis.
function walk(node, visit, parents = []) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit, [...parents, node]);
    else if (value && typeof value === "object") walk(value, visit, [...parents, node]);
  }
}
const name = (node) =>
  node?.type === "Identifier" ? node.name : node?.type === "Literal" ? node.value : null;
const called = (node) =>
  node?.callee?.type === "Identifier"
    ? node.callee.name
    : node?.callee?.type === "MemberExpression" &&
        ["fetch", "fetchImpl", "sendBeacon"].includes(name(node.callee.property))
      ? name(node.callee.property)
      : null;
const property = (node, key) => node?.properties?.find((p) => name(p.key) === key)?.value;
const BASE = "https://worker-contract.test";
const UNKNOWN = "<computed>";

function scriptsIn(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => {
      const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
      const value = type ? (type[1] ?? type[2] ?? type[3]).trim().toLowerCase() : "";
      return [
        "",
        "module",
        "text/javascript",
        "application/javascript",
        "text/ecmascript",
        "application/ecmascript",
      ].includes(value);
    })
    .map((m) => m[2])
    .join("\n");
}

function clientSources(directory) {
  const out = [];
  for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, item.name).replaceAll("\\", "/");
    if (item.isDirectory()) {
      if (!["vendor", "test", "data", "node_modules"].includes(item.name))
        out.push(...clientSources(path));
    } else if (/\.(js|html)$/.test(item.name) && !/\.min\.js$|pdf_fonts\.js$/.test(item.name)) {
      const text = read(path);
      const source = item.name.endsWith(".html") ? scriptsIn(text) : text;
      out.push(parseClient(path, source));
    }
  }
  return out;
}

function strings(node, client, parents = [], billingKinds = [], depth = 0) {
  if (!node || depth > 12) return [UNKNOWN];
  const next = (child) => strings(child, client, parents, billingKinds, depth + 1);
  const combine = (left, right) => left.flatMap((a) => right.map((b) => a + b));
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node.type === "Identifier") {
    if (node.name === "WORKER_URL") return [BASE];
    if (
      node.name === "url" &&
      client.path === "extension/background/gemini.js" &&
      parents.some((p) => p.type === "FunctionDeclaration" && p.id.name === "callWorker")
    )
      return [BASE];
    if (
      node.name === "kind" &&
      client.path === "docs/js/core.js" &&
      parents.some((p) => p.type === "FunctionDeclaration" && p.id.name === "billingUrl")
    )
      return billingKinds;
    return client.constants.has(node.name) ? next(client.constants.get(node.name)) : [UNKNOWN];
  }
  if (node.type === "MemberExpression" && name(node.property) === "workerUrl") return [BASE];
  if (node.type === "CallExpression" && called(node) === "workerBase") return [BASE];
  if (
    node.type === "CallExpression" &&
    name(node.callee.property) === "replace" &&
    name(node.callee.object?.property) === "workerUrl"
  )
    return [BASE];
  if (node.type === "BinaryExpression" && node.operator === "+")
    return combine(next(node.left), next(node.right));
  if (node.type === "ConditionalExpression")
    return [...next(node.consequent), ...next(node.alternate)];
  if (node.type === "TemplateLiteral") {
    let values = [node.quasis[0].value.cooked];
    for (let i = 0; i < node.expressions.length; i++)
      values = combine(values, next(node.expressions[i])).map(
        (v) => v + node.quasis[i + 1].value.cooked,
      );
    return values;
  }
  return [UNKNOWN];
}

function methodOf(init, client) {
  if (!init) return "GET";
  assert.equal(init.type, "ObjectExpression", `unresolved request options in ${client.path}`);
  assert.ok(
    !init.properties.some((p) => p.type === "SpreadElement"),
    `computed request options in ${client.path}`,
  );
  const methods = property(init, "method") ? strings(property(init, "method"), client) : ["GET"];
  assert.equal(methods.length, 1);
  assert.match(methods[0], /^(GET|HEAD|POST|PUT|DELETE|OPTIONS)$/);
  return methods[0];
}

function workerCalls(client, billingKinds) {
  const found = [];
  for (const { node, parents } of client.calls) {
    const callee = called(node),
      args = node.arguments;
    if (callee === "call" && client.path === "docs/js/buy.js") {
      const methods = strings(args[0], client),
        paths = strings(args[1], client);
      assert.ok(methods.length === 1 && /^(GET|POST)$/.test(methods[0]));
      for (const path of paths) {
        assert.ok(!path.split("?")[0].includes(UNKNOWN));
        found.push(key(methods[0], path));
      }
    } else if (callee === "workerFetch") {
      for (const path of strings(args[0], client)) {
        assert.ok(
          !path.split("?")[0].includes(UNKNOWN),
          `computed workerFetch path in ${client.path}`,
        );
        found.push(key(methodOf(args[1], client), path));
      }
    } else if (["fetch", "fetchImpl", "sendBeacon"].includes(callee)) {
      const targets = strings(args[0], client, parents, billingKinds);
      // auth.workerFetch forwards the path and init; its callers are checked above.
      const forwarding =
        client.path === "extension/lib/auth.js" &&
        parents.some((p) => p.type === "FunctionDeclaration" && p.id.name === "workerFetch");
      if (forwarding) continue;
      let mentionsWorker = false;
      walk(args[0], (part) => {
        if (part.type === "Identifier" && ["WORKER_URL", "workerBase"].includes(part.name))
          mentionsWorker = true;
        if (part.type === "MemberExpression" && name(part.property) === "workerUrl")
          mentionsWorker = true;
        if (
          part.type === "Identifier" &&
          client.constants.has(part.name) &&
          strings(client.constants.get(part.name), client).some((value) =>
            /\.workers\.dev/.test(value),
          )
        )
          mentionsWorker = true;
        if (
          part.type === "Literal" &&
          typeof part.value === "string" &&
          /\.workers\.dev/.test(part.value)
        )
          mentionsWorker = true;
      });
      if (mentionsWorker && targets.every((target) => target === UNKNOWN))
        assert.fail(`unresolved Worker target in ${client.path}`);
      for (const target of targets) {
        if (!(target.startsWith(BASE) || /^https:\/\/[^/]+\.workers\.dev(?:\/|$)/.test(target)))
          continue;
        assert.ok(
          !target.split("?")[0].includes(UNKNOWN),
          `unresolved Worker target in ${client.path}`,
        );
        found.push(
          key(
            callee === "sendBeacon" ? "POST" : methodOf(args[1], client),
            new URL(target).pathname,
          ),
        );
      }
    }
  }
  return found;
}

function parseClient(path, source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const calls = [],
    constants = new Map(),
    functions = new Map();
  const workerExpression = (expression) =>
    strings(expression, { path, constants }).some(
      (value) => value.startsWith(BASE) || /^https:\/\/[^/]+\.workers\.dev(?:\/|$)/.test(value),
    );
  walk(ast, (node, parents) => {
    if (node.type === "CallExpression") calls.push({ node, parents });
    if (node.type === "FunctionDeclaration") functions.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const prior = constants.get(node.id.name);
      assert.ok(
        !prior || !(workerExpression(prior) || workerExpression(node.init)),
        `ambiguous Worker binding in ${path}`,
      );
      constants.set(node.id.name, node.init);
    }
  });
  return { path, calls, constants, functions };
}

test("all current site and extension Worker calls are covered, including wrappers and inline scripts", () => {
  const sources = [...clientSources("docs"), ...clientSources("extension")];
  const billing = sources.flatMap((client) =>
    client.calls
      .filter(({ node }) => called(node) === "billing")
      .flatMap(({ node }) => strings(node.arguments[0], client)),
  );
  assert.ok(
    billing.length && !billing.includes(UNKNOWN),
    "billing actions require statically resolvable names",
  );
  const byPath = new Map(sources.map((client) => [client.path, client]));
  const auth = byPath.get("extension/lib/auth.js"),
    buy = byPath.get("docs/js/buy.js");
  const forwarding = auth.calls.filter(({ parents }) =>
    parents.includes(auth.functions.get("workerFetch")),
  );
  const fetch = forwarding.find(({ node }) => called(node) === "fetch").node;
  assert.equal(fetch.arguments[0].type, "TemplateLiteral");
  assert.deepEqual(fetch.arguments[0].expressions.map(name), ["WORKER_URL", "path"]);
  assert.ok(
    fetch.arguments[1].properties.some(
      (p) => p.type === "SpreadElement" && name(p.argument) === "init",
    ),
  );
  const buyForward = buy.calls.find(
    ({ node, parents }) =>
      called(node) === "requestJson" && parents.includes(buy.functions.get("call")),
  ).node;
  assert.equal(buyForward.arguments[0].type, "BinaryExpression");
  assert.equal(name(buyForward.arguments[0].left), "API");
  assert.equal(name(buyForward.arguments[0].right), "path");
  const options = buyForward.arguments[1];
  assert.equal(options.type, "ConditionalExpression");
  assert.equal(options.test.operator, "===");
  assert.equal(name(options.test.left), "method");
  assert.equal(options.test.right.value, "GET");
  assert.equal(property(options.consequent, "method").value, "GET");
  assert.equal(property(options.alternate, "method").value, "POST");
  const workerTransport = sources.flatMap((client) =>
    client.calls
      .filter(({ node }) => called(node) === "callWorker")
      .map(({ node }) => strings(property(node.arguments[0], "url"), client)),
  );
  assert.ok(
    workerTransport.length &&
      workerTransport.every((urls) => urls.length === 1 && urls[0] === BASE),
  );
  const found = sources.flatMap((client) => workerCalls(client, [...new Set(billing)]));
  for (const route of found) assert.ok(declared.has(route), `undocumented client call: ${route}`);
  for (const route of [
    "POST /hit",
    "POST /employer-interest",
    "POST /billing/portal",
    "POST /billing/checkout",
    "PUT /profile",
    "POST /ai",
  ])
    assert.ok(found.includes(route), `indirect client inventory missed ${route}`);
});

test("AST inventory handles nested literals and rejects unknown routes or computed Worker paths", () => {
  const client = parseClient(
    "new.js",
    'fetch(`${WORKER_URL}/unlisted`, {method: "POST", body: `${`${1}`}`})',
  );
  assert.deepEqual(workerCalls(client, []), ["POST /unlisted"]);
  assert.deepEqual(
    workerCalls(parseClient("new.js", "fetch(`${WORKER_URL}/config?cursor=${cursor}`)"), []),
    ["GET /config"],
  );
  assert.ok(!declared.has(workerCalls(client, [])[0]));
  assert.throws(
    () => workerCalls(parseClient("new.js", "fetch(`${WORKER_URL}${arbitrary}`)"), []),
    /unresolved Worker target/,
  );
  assert.throws(
    () => workerCalls(parseClient("new.js", 'fetch(new URL("/config", WORKER_URL))'), []),
    /unresolved Worker target/,
  );
  assert.throws(
    () =>
      parseClient(
        "new.js",
        '(()=>{const API="https://api.workers.dev/unlisted";fetch(API)})();' +
          '(()=>{const API="https://api.workers.dev/config";fetch(API)})();',
      ),
    /ambiguous Worker binding/,
  );
  assert.deepEqual(
    workerCalls(
      parseClient("new.js", '// fetch(`${WORKER_URL}/ignored`)\nconst example="fetch()";'),
      [],
    ),
    [],
  );
});

test("inline script inventory excludes JSON-LD and import maps, including unquoted types", () => {
  const source = scriptsIn(
    '<script type="application/ld+json">{"not":"JavaScript"}</script>' +
      '<script type=importmap>{"imports":{}}</script>' +
      '<script type="module">fetch(`${WORKER_URL}/config`)</script>',
  );
  assert.deepEqual(workerCalls(parseClient("inline.html", source), []), ["GET /config"]);
});
