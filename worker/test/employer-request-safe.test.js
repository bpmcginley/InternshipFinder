import test from "node:test";
import assert from "node:assert/strict";
import { createRequestSafeEmployerCatalogCache } from "../src/employer-catalog-cache.js";
import {
  createEmployerPostingCounter,
  createEmployerMinuteBudget,
  EMPLOYER_POSTING_EVENT,
} from "../src/employer-posting-counts.js";
import { countHit, DAY_CAP } from "../src/visits.js";
import { fakeD1 } from "./helpers.js";
const event = { e: EMPLOYER_POSTING_EVENT, c: "acme" };
const parse = (text) => {
  const keys = JSON.parse(text);
  return (key) => keys.includes(key);
};
const response = () => new Response('["acme"]');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function cacheFixture(over = {}) {
  let clock = 0,
    next = 0;
  const timers = new Map(),
    cancelled = [];
  const cache = createRequestSafeEmployerCatalogCache({
    parse,
    maxBytes: 64,
    now: () => clock,
    schedule: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    cancel: (id) => {
      cancelled.push(id);
      timers.delete(id);
    },
    ...over,
  });
  return {
    cache,
    timers,
    cancelled,
    set: (v) => {
      clock = v;
    },
  };
}
test("request-safe refresh competitors neither wait nor touch owner I/O; parsed unknown still caches", async () => {
  const f = cacheFixture(),
    wait = deferred();
  let loads = 0,
    signal;
  const owner = f.cache.has("missing", (s) => {
    loads++;
    signal = s;
    return wait.promise;
  });
  assert.equal(
    await f.cache.has("acme", () => {
      throw Error("competitor loader");
    }),
    false,
  );
  assert.equal(loads, 1);
  assert.equal(signal.aborted, false);
  assert.equal(f.cancelled.length, 0);
  wait.resolve(response());
  assert.equal(await owner, false);
  assert.equal(
    await f.cache.has("acme", () => {
      throw Error("no refresh");
    }),
    true,
  );
  assert.equal(f.cancelled.length, 1);
});
test("late request cannot replace a newer cache or cancel its timer", async () => {
  const f = cacheFixture(),
    wait = deferred();
  let signal;
  const old = f.cache.has("acme", (s) => {
    signal = s;
    return wait.promise;
  });
  f.set(5000);
  assert.equal(await f.cache.has("acme", response), false);
  assert.equal(signal.aborted, false);
  assert.equal(f.cancelled.length, 0);
  f.set(10000);
  assert.equal(await f.cache.has("new", () => new Response('["new"]')), true);
  wait.resolve(response());
  assert.equal(await old, false);
  assert.equal(await f.cache.has("new"), true);
  assert.equal(await f.cache.has("acme"), false);
});
test("five minute hard expiry starts at load start, lease and rollback fail closed", async () => {
  const f = cacheFixture(),
    wait = deferred();
  const first = f.cache.match("acme", () => wait.promise);
  f.set(4000);
  wait.resolve(response());
  const lease = await first;
  assert.equal(lease(299999), true);
  f.set(300000);
  assert.equal(lease(300000), false);
  assert.equal(await f.cache.has("acme", () => new Response("bad")), false);
  f.set(304999);
  assert.equal(
    await f.cache.has("acme", () => {
      throw Error("backoff");
    }),
    false,
  );
  f.set(305000);
  assert.equal(await f.cache.has("acme", response), true);
  f.set(304999);
  assert.equal(await f.cache.has("acme"), false);
  f.set(310000);
  assert.equal(await f.cache.has("acme", response), true);
});
test("owner timeout alone aborts its signal; malformed and oversized refreshes retain no stale data", async () => {
  const f = cacheFixture();
  let signal;
  const owner = f.cache.has("acme", (s) => {
    signal = s;
    return new Promise(() => {});
  });
  f.set(5000);
  f.timers.get(1)();
  assert.equal(await owner, false);
  assert.equal(signal.aborted, true);
  for (const [at, load] of [
    [10000, () => new Response("x".repeat(65))],
    [15000, () => new Response("[]", { status: 503 })],
    [20000, () => new Response(new Uint8Array([255]))],
  ]) {
    f.set(at);
    assert.equal(await f.cache.has("acme", load), false);
  }
  f.set(25000);
  assert.equal(await f.cache.has("acme", response), true);
});
function dbFixture() {
  const db = fakeD1();
  return {
    ...db,
    prepare(sql) {
      const wrap = (s) => ({
        ...s,
        bind: (...args) => wrap(s.bind(...args)),
        run: () => (/^\s*SELECT\b/i.test(sql) ? s.all() : s.run()),
      });
      return wrap(db.prepare(sql));
    },
  };
}
const request = (ip, headers = {}) =>
  new Request("https://api.test/hit", {
    headers: {
      Origin: "https://internscout.org",
      "User-Agent": "Mozilla/5.0",
      "CF-Connecting-IP": ip,
      ...headers,
    },
  });
test("organic seam is off by default; shared checks and exact body precede service and budgets", async () => {
  const db = dbFixture(),
    at = new Date("2027-01-01T00:00:00Z");
  let calls = 0;
  const service = () => {
      calls++;
      return true;
    },
    req = request("192.0.2.180");
  assert.deepEqual(await countHit(db, req, event, at), { counted: false });
  await assert.rejects(
    countHit(db, request("192.0.2.180", { Origin: "https://other.test" }), event, at, service),
    { status: 403 },
  );
  assert.deepEqual(
    await countHit(db, request("192.0.2.180", { "User-Agent": "Googlebot" }), event, at, service),
    { counted: false },
  );
  for (const body of [
    { ...event, p: "/" },
    { ...event, s: "paid" },
    { ...event, c: " bad" },
  ])
    assert.deepEqual(await countHit(db, req, body, at, service), { counted: false });
  assert.equal(calls, 0);
  for (let i = 0; i < 30; i++)
    assert.deepEqual(await countHit(db, req, event, at, service), { counted: true });
  assert.deepEqual(await countHit(db, req, event, at, service), { counted: false });
  assert.equal(calls, 30);
  assert.deepEqual(await countHit(db, req, { p: "/" }, at), { counted: true });
});
test("organic budget runs once before cleanup; receipts cannot replay or bypass time/cap health", async () => {
  const db = dbFixture();
  let at = new Date("2027-01-01T01:00:00Z"),
    cleanups = 0,
    captured;
  const counter = createEmployerPostingCounter({ db, keys: ["acme"], now: () => at });
  const service = async (receipt) => {
    captured = receipt;
    cleanups++;
    await counter.cleanup();
    return counter.countAdmitted(receipt);
  };
  for (let i = 0; i < 30; i++)
    assert.deepEqual(await countHit(db, request("192.0.2.181"), event, at, service), {
      counted: true,
    });
  assert.deepEqual(await countHit(db, request("192.0.2.181"), event, at, service), {
    counted: false,
  });
  assert.equal(cleanups, 30);
  assert.equal(await counter.countAdmitted(captured), false);
  assert.equal(await counter.countAdmitted({ company: "acme", at: at.getTime() }), false);
  await countHit(db, request("192.0.2.182"), event, at, (receipt) => {
    captured = receipt;
    return false;
  });
  at = new Date("2027-01-02T01:00:00Z");
  await counter.cleanup();
  assert.equal(await counter.countAdmitted(captured), false);
  assert.equal(await db.prepare("SELECT SUM(n) AS n FROM employer_posting_counts").first("n"), 30);
});
test("legacy limiter and global visit cap do not consume organic budget; organic never spends paid/events", async () => {
  const db = dbFixture(),
    at = new Date("2027-01-03T01:00:00Z"),
    req = request("192.0.2.183");
  for (let i = 0; i < 30; i++) await countHit(db, req, { e: "install_view", p: "/" }, at);
  assert.deepEqual(await countHit(db, req, { p: "/" }, at), { counted: false });
  assert.deepEqual(await countHit(db, req, event, at, () => true), { counted: true });
  await db
    .prepare("INSERT INTO visit_counts(day,page,source,views,visits) VALUES(?,?,?,?,?)")
    .bind("2027-01-03", "dashboard", "direct", DAY_CAP, DAY_CAP)
    .run();
  assert.deepEqual(await countHit(db, request("192.0.2.184"), { p: "/" }, at), { counted: false });
  assert.deepEqual(await countHit(db, request("192.0.2.184"), event, at, () => true), {
    counted: true,
  });
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM placement_counts").first("n"), 0);
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM event_counts WHERE event = ?")
      .bind(event.e)
      .first("n"),
    0,
  );
  assert.deepEqual(
    await countHit(db, request("192.0.2.185"), event, at, () => {
      throw Error("unavailable");
    }),
    { counted: false },
  );
});

test("paid placement caps and organic budget are independent", async () => {
  const db = dbFixture(),
    at = new Date("2027-01-04T01:00:00Z"),
    req = request("192.0.2.186");
  await db
    .prepare(
      `INSERT INTO placements(id,employer,listing_id,apply_url,start_day,end_day,status,created,created_by,updated,updated_by)
    VALUES('p-fixture','Fixture','abcdef0123456789','https://example.test/job','2027-01-01','2027-02-01','on','2027-01-01','fixture','2027-01-01','fixture')`,
    )
    .run();
  for (let i = 0; i < 30; i++)
    assert.deepEqual(await countHit(db, req, event, at, () => true), { counted: true });
  assert.deepEqual(await countHit(db, req, { s: "p-fixture", e: "open", p: "/" }, at), {
    counted: true,
  });
  await db.prepare("UPDATE placement_counts SET n = 50000").run();
  assert.deepEqual(
    await countHit(db, request("192.0.2.187"), { s: "p-fixture", e: "open", p: "/" }, at),
    { counted: false },
  );
  assert.deepEqual(await countHit(db, request("192.0.2.187"), event, at, () => true), {
    counted: true,
  });
  assert.equal(await db.prepare("SELECT n FROM placement_counts").first("n"), 50000);
});

test("receipt method replacement cannot replay and its constructor cannot mint admission", async () => {
  const db = dbFixture(),
    at = new Date("2027-01-05T12:00:00Z");
  const counter = createEmployerPostingCounter({ db, keys: ["acme"], now: () => at });
  await counter.cleanup();
  let receipt;
  await countHit(db, request("192.0.2.188"), event, at, (value) => {
    receipt = value;
    return false;
  });
  try {
    receipt.take = () => ({ company: "acme", at: at.getTime() });
  } catch {
    /* Frozen token rejects mutation. */
  }
  assert.equal(await counter.countAdmitted(receipt), true);
  assert.equal(await counter.countAdmitted(receipt), false, "overridden take must not replay");
  const minted = new receipt.constructor("acme", at.getTime());
  assert.equal(
    await counter.countAdmitted(minted),
    false,
    "reachable constructor must not mint admission",
  );
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Reflect.ownKeys(receipt), []);
  assert.equal(await db.prepare("SELECT n FROM employer_posting_counts").first("n"), 1);
});

test("receipt constructor cannot bypass the exhausted organic budget", async () => {
  const db = dbFixture(),
    at = new Date("2027-01-06T12:00:00Z");
  const counter = createEmployerPostingCounter({ db, keys: ["acme"], now: () => at });
  await counter.cleanup();
  let receipt;
  for (let i = 0; i < 30; i++)
    await countHit(db, request("192.0.2.189"), event, at, (value) => {
      receipt = value;
      return false;
    });
  assert.deepEqual(await countHit(db, request("192.0.2.189"), event, at, () => true), {
    counted: false,
  });
  assert.equal(await counter.countAdmitted(new receipt.constructor("acme", at.getTime())), false);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM employer_posting_counts").first("n"), 0);
});

test("HMAC limiter preserves concurrent exact caps using a non-extractable isolate key", async () => {
  const usedKeys = new Set(),
    inputs = [],
    signatures = [];
  const budget = createEmployerMinuteBudget({
    subtle: {
      generateKey: (...args) => crypto.subtle.generateKey(...args),
      sign: async (...args) => {
        usedKeys.add(args[1]);
        inputs.push(new TextDecoder().decode(args[2]));
        const out = await crypto.subtle.sign(...args);
        signatures.push(Buffer.from(out).toString("hex"));
        return out;
      },
    },
  });
  const at = new Date("2027-03-01T00:00:00Z");
  assert.equal(
    (await Promise.all(Array.from({ length: 40 }, () => budget("192.0.2.210", at)))).filter(Boolean)
      .length,
    30,
  );
  assert.equal(usedKeys.size, 1);
  const key = [...usedKeys][0];
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", key));
  assert.equal(new Set(signatures).size, 1);
  assert.equal(await budget("192.0.2.211", at), true);
  assert.equal(await budget("192.0.2.210", new Date(at.getTime() + 60000)), true);
  assert.notEqual(signatures.at(-1), signatures[0]);
  assert.equal(await budget("192.0.2.212", at), false);
  assert.match(inputs[0], /^\d+:192\.0\.2\.210$/);
});
test("HMAC limiter rejects crypto/clock errors and an older-minute digest finishing late", async () => {
  let release,
    entered = false,
    first = true;
  const budget = createEmployerMinuteBudget({
    subtle: {
      generateKey: (...args) => crypto.subtle.generateKey(...args),
      sign: async (...args) => {
        if (first) {
          first = false;
          entered = true;
          await new Promise((r) => {
            release = r;
          });
        }
        return crypto.subtle.sign(...args);
      },
    },
  });
  const at = new Date("2027-03-02T00:00:00Z"),
    old = budget("192.0.2.210", at);
  for (let i = 0; !entered && i < 1000; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(entered, true);
  assert.equal(await budget("192.0.2.211", new Date(at.getTime() + 60000)), true);
  release();
  assert.equal(await old, false);
  assert.equal(await budget("192.0.2.210", at), false);
  assert.equal(await budget("192.0.2.210", new Date(NaN)), false);
  class BrokenClock extends Date {
    getTime() {
      throw Error("clock unavailable");
    }
  }
  assert.equal(await budget("192.0.2.210", new BrokenClock()), false);
  assert.deepEqual(
    await countHit(null, request("192.0.2.210"), event, new BrokenClock(), () => {
      throw Error("service must not run");
    }),
    { counted: false },
  );
  for (const subtle of [
    {
      generateKey: () => {
        throw Error("key unavailable");
      },
    },
    { generateKey: async () => ({ extractable: true, type: "secret" }) },
    {
      generateKey: (...args) => crypto.subtle.generateKey(...args),
      sign: () => {
        throw Error("sign unavailable");
      },
    },
    {
      generateKey: (...args) => crypto.subtle.generateKey(...args),
      sign: async () => new ArrayBuffer(1),
    },
  ])
    assert.equal(await createEmployerMinuteBudget({ subtle })("192.0.2.210", at), false);
});
