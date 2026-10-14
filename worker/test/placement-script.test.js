// scripts/placement.mjs: argument parsing, the requests it makes, and that it never prints the admin
// token or paid_ref. Runs the real Worker (handle) behind a fake fetch, so the two stay in step.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_API, parseArgs, redact, run, toRequest } from "../scripts/placement.mjs";
import { handle } from "../src/index.js";
import { CHECKS } from "../src/placements.js";
import { NOW, makeEnv } from "./helpers.js";

const TOKEN = "admin-script-secret-0123456789";

// A fake fetch that answers from a real Worker, recording what was sent.
function workerFetch(env) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const req = new Request(url.replace(DEFAULT_API, "https://api.test"), init);
    return handle(req, env, { waitUntil() {} }, { now: () => NOW });
  };
  f.calls = calls;
  return f;
}

async function cli(argv, { env, fetch, token = TOKEN, extraEnv = {} } = {}) {
  const lines = [];
  const code = await run(argv, {
    env: { INTERNSCOUT_ADMIN_TOKEN: token, ...extraEnv }, fetch,
    out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)),
  });
  return { code, text: lines.join("\n") };
}

test("parseArgs and toRequest build the documented calls", () => {
  const create = toRequest(parseArgs(["create", "--lead", "12", "--listing", "3f9c0a1b2c3d4e5f", "--url", "https://x.example/j",
    "--start", "2026-11-01", "--end", "2026-12-01", "--by", "bruce"]));
  assert.deepEqual(create, { method: "POST", path: "/admin/placements", admin: true, body: {
    lead_id: 12, listing_id: "3f9c0a1b2c3d4e5f", apply_url: "https://x.example/j", start: "2026-11-01", end: "2026-12-01", by: "bruce" } });
  assert.deepEqual(toRequest(parseArgs(["on", "p-1", "--ref", "pilot"])),
    { method: "POST", path: "/admin/placements/on", admin: true, body: { id: "p-1", by: "bruce", paid_ref: "pilot" } });
  assert.deepEqual(toRequest(parseArgs(["check", "p-1", "--checks", "a, b", "--unpaid-ok"])).body,
    { id: "p-1", by: "bruce", checks: ["a", "b"], unpaid_ok: true });
  assert.deepEqual(toRequest(parseArgs(["live"])), { method: "GET", path: "/placements", admin: false });
  assert.throws(() => toRequest(parseArgs(["on", "p-1"])), /--ref/);
  assert.throws(() => toRequest(parseArgs(["end"])), /placement id/);
  assert.throws(() => toRequest(parseArgs(["create", "--token", "x"])), /Unknown flag --token/, "the token is never an argument");
  assert.throws(() => toRequest(parseArgs(["create", "--lead", "abc", "--listing", "a", "--url", "u", "--start", "s", "--end", "e"])), /--lead/);
  assert.throws(() => toRequest(parseArgs(["frobnicate"])), /Unknown command/);
});

test("redact drops paid_ref everywhere, including log rows", () => {
  assert.deepEqual(redact({ placements: [{ id: "p", paid_ref: "INV-1", log: [{ before: { paid_ref: "x", id: "p" } }] }] }),
    { placements: [{ id: "p", log: [{ before: { id: "p" } }] }] });
});

test("a full run against the Worker: never prints the token or paid_ref, never sends an Origin", async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  const fetch = workerFetch(env);
  const outputs = [];
  const step = async (argv) => {
    const r = await cli(argv, { fetch });
    outputs.push(r.text);
    assert.equal(r.code, 0, r.text);
    return JSON.parse(r.text);
  };
  const { placement } = await step(["create", "--employer", "Acme", "--listing", "3f9c0a1b2c3d4e5f", "--url", "https://x.example/j",
    "--start", "2026-09-14", "--end", "2026-10-01", "--by", "bruce"]);
  await step(["check", placement.id, "--checks", CHECKS.join(",")]);
  const on = await step(["on", placement.id, "--ref", "INV-SECRET-77"]);
  assert.equal(on.placement.status, "on");
  assert.ok(!("paid_ref" in on.placement));
  const list = await step(["list"]);
  assert.equal(list.placements.length, 1);
  const live = await step(["live"]);
  assert.equal(live.placements[0].id, placement.id);

  const all = outputs.join("\n");
  assert.ok(!all.includes(TOKEN), "the token is never printed");
  assert.ok(!all.includes("INV-SECRET-77"), "paid_ref is never printed");
  for (const { init } of fetch.calls) {
    assert.ok(!("Origin" in init.headers), "no Origin header");
  }
  assert.ok(!fetch.calls.find((c) => c.url.endsWith("/placements") && c.init.method === "GET" && !c.url.includes("/admin/")).init.headers.Authorization,
    "the public read does not send the token");
  assert.ok(fetch.calls.filter((c) => c.url.includes("/admin/")).every((c) => c.init.headers.Authorization === `Bearer ${TOKEN}`));
});

test("errors: missing token, a wrong token, a refusal and a network failure print no token", async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  const fetch = workerFetch(env);
  const none = await cli(["list"], { fetch, token: "" });
  assert.equal(none.code, 2);
  assert.match(none.text, /INTERNSCOUT_ADMIN_TOKEN/);
  assert.equal(fetch.calls.length, 0, "nothing is sent without a token");

  const wrong = await cli(["list"], { fetch, token: "not-the-token" });
  assert.equal(wrong.code, 1);
  assert.match(wrong.text, /HTTP 401/);
  assert.ok(!wrong.text.includes("not-the-token"));

  const bad = await cli(["on", "p-nope", "--ref", "pilot"], { fetch });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /HTTP 404/);

  const boom = async () => { throw new Error(`connect failed with Bearer ${TOKEN}`); };
  const down = await cli(["list"], { fetch: boom });
  assert.equal(down.code, 1);
  assert.ok(!down.text.includes(TOKEN), "even an error that echoes the token is masked");

  const http = await cli(["list"], { fetch, extraEnv: { INTERNSCOUT_API_URL: "http://api.example" } });
  assert.equal(http.code, 1, "plain http is refused for anything but localhost");
  assert.equal(fetch.calls.filter((c) => c.url.startsWith("http://api.example")).length, 0);
});
