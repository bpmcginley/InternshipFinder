import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { countHit } from "../src/visits.js";
import {
  createEmployerPostingRuntime,
  employerCatalogDescriptor,
} from "../src/employer-posting-runtime.js";
const URL = "https://internscout.org/data/employer-posting-keys.json";
let address = 0;
const request = (body, headers = {}) =>
  new Request("https://worker.test/hit", {
    method: "POST",
    headers: {
      Origin: "https://internscout.org",
      "User-Agent": "Mozilla/5.0",
      "CF-Connecting-IP": `2001:db8:1234::${(++address).toString(16)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
const event = (c = "acme") => ({ e: "employer_posting_open", c });
const reply = (url, body, init) =>
  Object.defineProperty(new Response(body, init), "url", { value: url });
async function descriptor(text = '["acme"]', version = "a".repeat(40)) {
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  return { url: URL, version, sha256 };
}
async function fixture(db) {
  await db.batch([
    db.prepare("DELETE FROM employer_posting_counts"),
    db.prepare("DELETE FROM employer_posting_day_caps"),
  ]);
  const at = Date.now();
  let time = at,
    loads = 0;
  const now = () => new Date(at),
    env = {
      EMPLOYER_POSTING_COUNTS_ENABLED: "1",
      EMPLOYER_POSTING_CATALOG: JSON.stringify(await descriptor()),
      ADMIN_TOKEN: "synthetic-admin",
    };
  const fetcher = async (url, options) => {
    loads++;
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    return reply(url, '["acme"]');
  };
  const runtime = createEmployerPostingRuntime({ clock: () => time });
  const count = (f = fetcher, e = env, body = event()) =>
    countHit(db, request(body), body, now(), runtime.service(e, db, f, now));
  const total = async () =>
    (await db.prepare("SELECT sum(n) AS n FROM employer_posting_counts").first()).n || 0;
  const seed = () =>
    db
      .prepare("INSERT INTO employer_posting_day_caps VALUES(?,0)")
      .bind(now().toISOString().slice(0, 10))
      .run();
  return {
    db,
    env,
    now,
    count,
    total,
    seed,
    runtime,
    fetcher,
    loads: () => loads,
    advance: (n) => {
      time += n;
    },
  };
}
export async function routeAndOwnerGates(db) {
  const f = await fixture(db);
  let fetches = 0;
  const noFetch = () => {
    fetches++;
    throw new Error("Unexpected synthetic fetch");
  };
  for (const env of [
    {},
    { EMPLOYER_POSTING_COUNTS_ENABLED: "1" },
    { ...f.env, EMPLOYER_POSTING_COUNTS_ENABLED: true },
  ]) {
    assert.equal(
      (await handle(request(event()), { ...env, DB: db }, null, { fetch: noFetch, now: f.now }))
        .status,
      204,
    );
  }
  for (const patch of [
    { url: "https://other.test/data/employer-posting-keys.json" },
    { version: ["a".repeat(40)] },
    { version: "bad" },
    { sha256: "no" },
    { extra: true },
  ]) {
    const env = {
      ...f.env,
      EMPLOYER_POSTING_CATALOG: JSON.stringify({ ...(await descriptor()), ...patch }),
    };
    assert.equal(employerCatalogDescriptor(env), null);
    assert.equal((await f.count(noFetch, env)).counted, false);
  }
  assert.equal(fetches, 0);
  assert.equal(await f.total(), 0);
  const admin = (token) =>
    new Request("https://worker.test/admin/employer-metrics", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  const forbiddenDb = {
    prepare() {
      throw new Error("Auth must precede data access");
    },
  };
  assert.equal(
    (await handle(admin(), { ...f.env, DB: forbiddenDb }, null, { fetch: noFetch })).status,
    401,
  );
  assert.equal(
    (await handle(admin("wrong"), { ...f.env, DB: forbiddenDb }, null, { fetch: noFetch })).status,
    401,
  );
  const read = async (env = f.env) => {
    const res = await handle(admin(f.env.ADMIN_TOKEN), { ...env, DB: db }, null, {
      fetch: noFetch,
      now: f.now,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    return res.json();
  };
  assert.equal((await read()).organic_posting_readiness.retention, "blocked");
  await f.seed();
  assert.equal((await read()).organic_posting_readiness.retention, "ready");
  const future = new Date(f.now().getTime() + 86400000).toISOString().slice(0, 10);
  await db.prepare("INSERT INTO employer_posting_counts VALUES(?,'future',1)").bind(future).run();
  assert.equal((await read()).organic_posting_readiness.retention, "blocked");
  await db.prepare("DELETE FROM employer_posting_counts WHERE day=?").bind(future).run();
  assert.equal((await read()).organic_posting_readiness.retention, "ready");
  const off = await read({ ADMIN_TOKEN: f.env.ADMIN_TOKEN });
  assert.equal(Object.hasOwn(off, "organic_posting_readiness"), false);
  assert.equal(Object.hasOwn(off, "organic_posting_counts"), false);
  assert.equal(fetches, 0, "admin health never fetches catalog");
  const res = await handle(request(event()), { ...f.env, DB: db }, null, {
    fetch: f.fetcher,
    now: () => new Date(),
  });
  assert.equal(res.status, 204);
  assert.equal(await f.total(), 1);
}
export async function pinnedCacheAndRetention(db) {
  const f = await fixture(db);
  assert.equal((await f.count()).counted, false);
  assert.equal(await f.total(), 0, "no click bootstrap");
  await f.seed();
  assert.equal((await f.count()).counted, true);
  assert.equal(f.loads(), 1);
  assert.equal((await f.count(f.fetcher, f.env, event("unknown"))).counted, false);
  const yesterday = new Date(f.now().getTime() - 86400000).toISOString().slice(0, 10);
  await db.prepare("INSERT INTO employer_posting_day_caps VALUES(?,0)").bind(yesterday).run();
  assert.equal((await f.count()).counted, false);
  await db.prepare("DELETE FROM employer_posting_day_caps WHERE day=?").bind(yesterday).run();
  const expired = new Date(f.now().getTime() - 91 * 86400000).toISOString().slice(0, 10);
  await db.prepare("INSERT INTO employer_posting_counts VALUES(?,'old',1)").bind(expired).run();
  assert.equal((await f.count()).counted, false);
  await db.prepare("DELETE FROM employer_posting_counts WHERE day=?").bind(expired).run();
  const badPin = {
    ...f.env,
    EMPLOYER_POSTING_CATALOG: JSON.stringify({ ...(await descriptor()), sha256: "0".repeat(64) }),
  };
  assert.equal((await f.count(f.fetcher, badPin)).counted, false);
  assert.equal(f.loads(), 2, "new descriptor cannot reuse old membership");
  assert.equal((await f.count()).counted, true);
  assert.equal(f.loads(), 3);
  f.advance(300000);
  assert.equal(
    (
      await f.count(async () => {
        throw new Error("Unavailable");
      })
    ).counted,
    false,
  );
  assert.equal(
    (await f.count()).counted,
    false,
    "failed refresh never uses stale data or bypasses retry delay",
  );
}
export async function boundedPinTransport(db) {
  for (const kind of ["redirect", "partial", "oversize", "bad-utf8", "late-fetch", "late-body"]) {
    const f = await fixture(db);
    await f.seed();
    let cancelled = 0;
    const fetcher = async (url) => {
      if (kind === "redirect") return reply("https://other.test/", '["acme"]');
      if (kind === "partial") return reply(url, '["acme"]', { status: 206 });
      if (kind === "oversize") return reply(url, new Uint8Array(256 * 1024 + 1));
      if (kind === "bad-utf8") return reply(url, new Uint8Array([255]));
      if (kind === "late-fetch") f.advance(5000);
      return reply(
        url,
        new ReadableStream({
          pull(controller) {
            if (kind === "late-body") f.advance(5000);
            controller.enqueue(new TextEncoder().encode('["acme"]'));
          },
          cancel() {
            cancelled++;
          },
        }),
      );
    };
    assert.equal((await f.count(fetcher)).counted, false, kind);
    assert.equal(await f.total(), 0, kind);
    if (kind.startsWith("late")) assert.ok(cancelled > 0, "late body cancelled");
  }
}
export async function reconfigurationFencesPendingLoader(db) {
  const f = await fixture(db);
  await f.seed();
  let release;
  const old = f.count(
    (url) =>
      new Promise((resolve) => {
        release = () => resolve(reply(url, '["acme"]'));
      }),
  );
  for (let i = 0; !release && i < 100; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(release, "admitted request reaches loader");
  const next = {
    ...f.env,
    EMPLOYER_POSTING_CATALOG: JSON.stringify(await descriptor('["acme"]', "b".repeat(40))),
  };
  assert.equal((await f.count(f.fetcher, next)).counted, true);
  release();
  assert.equal((await old).counted, false);
  assert.equal(await f.total(), 1);
}
