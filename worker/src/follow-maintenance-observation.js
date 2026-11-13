// Dormant aggregate port. No sink, logging, storage, clock or scheduler authority.
const statuses = new Set(["pass-complete", "partial", "unavailable"]);
const keys = "d1Calls,durationMs,status";
const invalid = () => {
  throw new Error("Invalid maintenance observation");
};

function snapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const names = Reflect.ownKeys(input);
  if (
    names.length !== 3 ||
    names.some((key) => typeof key !== "string") ||
    names.sort().join(",") !== keys
  )
    invalid();
  const descriptors = Object.fromEntries(
    names.map((key) => [key, Object.getOwnPropertyDescriptor(input, key)]),
  );
  if (
    names.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))
  )
    invalid();
  const status = descriptors.status.value;
  const durationMs = descriptors.durationMs.value;
  const d1Calls = descriptors.d1Calls.value;
  if (
    !statuses.has(status) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    !Number.isSafeInteger(d1Calls) ||
    d1Calls < 0 ||
    d1Calls > 48
  )
    invalid();
  return Object.freeze({ status, durationMs, d1Calls });
}

// Attach independently after work settles; never await a recorder within a
// mutation/deadline or final transport fence. A recorder may remain pending.
export function createFollowMaintenanceObservation(recorder) {
  return async (input) => {
    if (recorder === undefined) return { status: "disabled" };
    if (typeof recorder !== "function") return { status: "unavailable" };
    try {
      const observation = snapshot(input);
      await recorder(observation);
      // Fulfilment means the callback completed, not durable storage or retention coverage.
      return { status: "reported" };
    } catch {
      // No error/input/return-value echo and no retry of an uncertain recording.
      return { status: "unavailable" };
    }
  };
}
