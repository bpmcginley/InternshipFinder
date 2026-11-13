import { expect, it } from "vitest";
import { inventoryTopupHistory } from "../src/topup-history-inventory.js";

const now = Date.parse("2026-11-12T12:00:00Z"),
  to = now / 1000,
  from = to - 60;
const input = { from, to, livemode: false, apiVersions: ["2026-01-01"] };
const event = (extra = {}) => ({
  object: "event",
  id: "evt_synthetic",
  created: from,
  livemode: false,
  api_version: "2026-01-01",
  type: "refund.created",
  data: { object: { object: "refund", private: "never_return" } },
  ...extra,
});
const page = (data = [], has_more = false) => ({
  object: "list",
  url: "/v1/events",
  data,
  has_more,
});
const response = (value) => new Response(JSON.stringify(value));
const options = (readPage, extra = {}) => ({
  enabled: true,
  clock: () => now,
  requestPolicy: { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" },
  readPage,
  ...extra,
});
const unavailable = { status: "unavailable" };

it("native inventory is default off and returns only bounded redacted classes", async () => {
  let calls = 0;
  const read = async (_, signal, policy) => {
    calls++;
    expect(signal.aborted).toBe(false);
    expect(policy.method).toBe("GET");
    return response(
      page([
        event(),
        event({ id: "evt_two", type: "private_marker.updated", api_version: "private_schema" }),
      ]),
    );
  };
  expect(await inventoryTopupHistory(input, { readPage: read })).toEqual({ status: "disabled" });
  expect(calls).toBe(0);
  const result = await inventoryTopupHistory(input, options(read));
  expect(result).toEqual({
    status: "observed_inventory",
    pages: 1,
    events: 2,
    families: { refund: 1, dispute: 0, charge: 0, other: 1 },
    schemas: [1],
    unknownSchema: 1,
  });
  expect(JSON.stringify(result)).not.toMatch(/private|evt_|never_return/);
});

it("native second-page failure, duplicate equal-time identity and empty continuation return no partial inventory", async () => {
  for (const second of [new Response("invalid"), response(page([event()])), response(page([]))]) {
    let calls = 0;
    expect(
      await inventoryTopupHistory(
        input,
        options(async () => (calls++ ? second : response(page([event()], true)))),
      ),
    ).toEqual(unavailable);
    expect(calls).toBe(2);
  }
});

it("native known-family mismatch, mode and account reject", async () => {
  for (const extra of [
    { data: { object: { object: "customer" } } },
    { livemode: true },
    { account: "acct_synthetic" },
    { context: "ctx_synthetic" },
  ])
    expect(
      await inventoryTopupHistory(
        input,
        options(async () => response(page([event(extra)]))),
      ),
    ).toEqual(unavailable);
});

it("native actual raw byte bounds and UTF-8 reject before counts escape", async () => {
  const raw = JSON.stringify(page([event()])),
    bytes = new TextEncoder().encode(raw);
  expect(
    (
      await inventoryTopupHistory(
        input,
        options(async () => new Response(bytes), { limits: { bodyBytes: bytes.length } }),
      )
    ).events,
  ).toBe(1);
  expect(
    await inventoryTopupHistory(
      input,
      options(async () => new Response(bytes), { limits: { bodyBytes: bytes.length - 1 } }),
    ),
  ).toEqual(unavailable);
  expect(
    await inventoryTopupHistory(
      input,
      options(async () => new Response(new Uint8Array([255]))),
    ),
  ).toEqual(unavailable);
  expect(
    await inventoryTopupHistory(
      input,
      options(
        async () =>
          new Response(raw.replace('"has_more":false', '"has_more":false,"has_more":true')),
      ),
    ),
  ).toEqual(unavailable);
});

it("native late page is canceled after absolute elapsed deadline", async () => {
  let time = now,
    canceled = 0;
  expect(
    await inventoryTopupHistory(
      input,
      options(
        async () => {
          time += 100;
          return new Response(
            new ReadableStream({
              cancel() {
                canceled++;
              },
            }),
          );
        },
        { clock: () => time, limits: { timeoutMs: 50 } },
      ),
    ),
  ).toEqual(unavailable);
  expect(canceled).toBe(1);
});

it("native hanging body cancel cannot prevent deadline completion or late rejection cleanup", async () => {
  let rejectRead,
    canceled = 0;
  const stream = new ReadableStream(
    {
      pull() {
        return new Promise((_, reject) => {
          rejectRead = reject;
        });
      },
      cancel() {
        canceled++;
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  expect(
    await inventoryTopupHistory(
      input,
      options(async () => new Response(stream), { limits: { timeoutMs: 10 } }),
    ),
  ).toEqual(unavailable);
  expect(canceled).toBe(1);
  expect(stream.locked).toBe(false);
  rejectRead(new Error("synthetic late rejection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("native noncooperative late page is discarded after timeout", async () => {
  let resolvePage,
    canceled = 0;
  const pending = new Promise((resolve) => {
    resolvePage = resolve;
  });
  expect(
    await inventoryTopupHistory(
      input,
      options(async () => pending, { limits: { timeoutMs: 10 } }),
    ),
  ).toEqual(unavailable);
  resolvePage(
    new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(canceled).toBe(1);
});
