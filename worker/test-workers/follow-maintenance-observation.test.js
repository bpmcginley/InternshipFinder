import { expect, it, vi } from "vitest";
import { createFollowMaintenanceObservation } from "../src/follow-maintenance-observation.js";

const aggregate = (extra = {}) => ({
  status: "pass-complete",
  durationMs: 10,
  d1Calls: 8,
  ...extra,
});

it("has no default sink and does not inspect input while disabled", async () => {
  const read = vi.fn(() => {
    throw Error("No input access");
  });
  const input = Object.defineProperty({}, "status", { get: read });
  expect(await createFollowMaintenanceObservation()(input)).toEqual({ status: "disabled" });
  expect(read).not.toHaveBeenCalled();
  for (const recorder of [null, false, {}, "sink"]) {
    expect(await createFollowMaintenanceObservation(recorder)(input)).toEqual({
      status: "unavailable",
    });
  }
  expect(read).not.toHaveBeenCalled();
});

it("reports only fixed statuses and bounded exact numeric data", async () => {
  const records = [],
    observe = createFollowMaintenanceObservation((record) => records.push(record));
  for (const status of ["pass-complete", "partial", "unavailable"]) {
    expect(await observe(aggregate({ status }))).toEqual({ status: "reported" });
  }
  for (const [durationMs, d1Calls] of [
    [0, 0],
    [30001, 48],
    [Number.MAX_SAFE_INTEGER, 48],
  ]) {
    expect(await observe(aggregate({ durationMs, d1Calls }))).toEqual({ status: "reported" });
  }
  expect(records).toHaveLength(6);
  for (const record of records) {
    expect(Reflect.ownKeys(record)).toEqual(["status", "durationMs", "d1Calls"]);
    expect(Object.isFrozen(record)).toBe(true);
  }
  const plain = Object.assign(Object.create(null), aggregate());
  expect(await observe(plain)).toEqual({ status: "reported" });
});

it("rejects malformed numbers, identities and unexpected outcome strings without recording", async () => {
  const recorder = vi.fn(),
    observe = createFollowMaintenanceObservation(recorder);
  for (const value of [
    -1,
    1.5,
    NaN,
    Infinity,
    "1",
    true,
    1n,
    new Number(1),
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(await observe(aggregate({ durationMs: value }))).toEqual({ status: "unavailable" });
    expect(await observe(aggregate({ d1Calls: value }))).toEqual({ status: "unavailable" });
  }
  for (const status of [
    "accepted",
    "disabled",
    "unknown@example.test",
    {},
    ["partial"],
    new String("partial"),
  ]) {
    expect(await observe(aggregate({ status }))).toEqual({ status: "unavailable" });
  }
  expect(await observe(aggregate({ d1Calls: 49 }))).toEqual({ status: "unavailable" });
  for (const extra of [
    { email: "synthetic@example.test" },
    { scope: "scope" },
    { detail: {} },
    { token: "synthetic" },
  ]) {
    expect(await observe(aggregate(extra))).toEqual({ status: "unavailable" });
  }
  expect(recorder).not.toHaveBeenCalled();
});

it("requires exact own data descriptors without invoking accessors or coercions", async () => {
  const recorder = vi.fn(),
    read = vi.fn(),
    observe = createFollowMaintenanceObservation(recorder);
  const getter = Object.defineProperty(aggregate(), "status", { enumerable: true, get: read });
  const hidden = Object.defineProperty(aggregate(), "durationMs", { enumerable: false, value: 10 });
  const inherited = Object.create(
    { status: "partial" },
    {
      durationMs: { value: 10, enumerable: true },
      d1Calls: { value: 1, enumerable: true },
    },
  );
  const symbol = Object.defineProperty(aggregate(), Symbol("detail"), { value: "private" });
  const coercion = aggregate({ durationMs: { valueOf: read } });
  for (const input of [
    null,
    undefined,
    [],
    "partial",
    {},
    getter,
    hidden,
    inherited,
    symbol,
    coercion,
  ]) {
    expect(await observe(input)).toEqual({ status: "unavailable" });
  }
  expect(read).not.toHaveBeenCalled();
  expect(recorder).not.toHaveBeenCalled();
});

it("detaches and freezes the aggregate before an asynchronous recorder settles", async () => {
  let complete, captured;
  const input = aggregate();
  const observed = createFollowMaintenanceObservation((record) => {
    captured = record;
    return new Promise((resolve) => {
      complete = resolve;
    });
  })(input);
  input.status = "private";
  input.durationMs = -1;
  expect(captured).toEqual(aggregate());
  expect(() => {
    captured.status = "changed";
  }).toThrow();
  complete({ email: "discarded@example.test" });
  expect(await observed).toEqual({ status: "reported" });
});

it("contains synchronous throws, rejected promises and thenable failures once without details", async () => {
  for (const failure of [
    () => {
      throw Error("synthetic sensitive detail");
    },
    () => Promise.reject({ token: "synthetic sensitive detail" }),
    () =>
      Object.defineProperty({}, "then", {
        get() {
          throw Error("synthetic detail");
        },
      }),
  ]) {
    const recorder = vi.fn(failure);
    expect(await createFollowMaintenanceObservation(recorder)(aggregate())).toEqual({
      status: "unavailable",
    });
    expect(recorder).toHaveBeenCalledTimes(1);
  }
});

it("does not invent a timeout for a pending recorder", async () => {
  let complete;
  const observation = createFollowMaintenanceObservation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  )(aggregate());
  let finished = false;
  observation.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  complete();
  expect(await observation).toEqual({ status: "reported" });
});
