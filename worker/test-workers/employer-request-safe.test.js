import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { countHit } from "../src/visits.js";
import {
  createRequestSafeEmployerPostingCatalog,
  createRequestScopedEmployerPostingCounter,
  EMPLOYER_POSTING_EVENT,
} from "../src/employer-posting-counts.js";
import {
  EMPLOYER_COUNT_SCHEMA,
  EMPLOYER_DAY_CAP_SCHEMA,
} from "../test-support/employer-posting-counts.js";

it("local D1 request-scoped services share parsed membership without sharing refresh I/O", async () => {
  const db = env.DB;
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS employer_posting_counts"),
    db.prepare("DROP TABLE IF EXISTS employer_posting_day_caps"),
  ]);
  await db.batch([db.prepare(EMPLOYER_COUNT_SCHEMA), db.prepare(EMPLOYER_DAY_CAP_SCHEMA)]);
  let clock = Date.parse("2027-02-01T12:00:00Z"),
    loads = 0,
    release;
  const now = () => new Date(clock),
    cache = createRequestSafeEmployerPostingCatalog({ maxBytes: 64, now: () => clock });
  const body = { e: EMPLOYER_POSTING_EVENT, c: "acme" };
  const req = new Request("https://local.test/hit", {
    headers: {
      Origin: "https://internscout.org",
      "User-Agent": "Mozilla/5.0",
      "CF-Connecting-IP": "192.0.2.199",
    },
  });
  const service = (load) => {
    const counter = createRequestScopedEmployerPostingCounter({ db, cache, load, now });
    return async (receipt) => {
      if (!(await counter.cleanup())) return false;
      return counter.countAdmitted(receipt);
    };
  };
  const first = countHit(
    db,
    req,
    body,
    now(),
    service(() => {
      loads++;
      return new Promise((resolve) => {
        release = resolve;
      });
    }),
  );
  // Wait for real D1 cleanup to finish and the owner to enter its local loader.
  for (let i = 0; !release && i < 1000; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(typeof release).toBe("function");
  expect(
    await countHit(
      db,
      req,
      body,
      now(),
      service(() => {
        throw Error("Competing loader invoked");
      }),
    ),
  ).toEqual({ counted: false });
  release(new Response('["acme"]'));
  expect(await first).toEqual({ counted: true });
  expect(
    await countHit(
      db,
      req,
      body,
      now(),
      service(() => {
        throw Error("Cache not reused");
      }),
    ),
  ).toEqual({ counted: true });
  expect(loads).toBe(1);
  expect(await db.prepare("SELECT n FROM employer_posting_counts").first("n")).toBe(2);
  expect(await db.prepare("SELECT n FROM employer_posting_day_caps").first("n")).toBe(2);
  clock += 300000;
  expect(
    await countHit(
      db,
      req,
      body,
      now(),
      service(() => new Response('["acme","acme"]')),
    ),
  ).toEqual({ counted: false });
  expect(await db.prepare("SELECT n FROM employer_posting_counts").first("n")).toBe(2);
  clock += 5000;
  expect(
    await countHit(
      db,
      req,
      body,
      now(),
      service(() => new Response('["acme"]')),
    ),
  ).toEqual({ counted: true });
  // An admitted receipt must not survive a UTC boundary, even after successful new-day cleanup.
  let captured;
  await countHit(db, req, body, now(), (receipt) => {
    captured = receipt;
    return false;
  });
  clock = Date.parse("2027-02-02T00:00:00Z");
  const later = createRequestScopedEmployerPostingCounter({
    db,
    cache,
    load: () => {
      throw Error("Expired admission loaded catalog");
    },
    now,
  });
  expect(await later.cleanup()).toBe(true);
  expect(await later.countAdmitted(captured)).toBe(false);
  expect(await db.prepare("SELECT SUM(n) AS n FROM employer_posting_counts").first("n")).toBe(3);
});
