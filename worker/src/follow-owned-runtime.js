// Dormant composition only. No route, schedule, provider settings or reset authority.
import { createFollowLinkRuntime } from "./follow-link-runtime.js";
import { acquireFollowDeliveryOwner, finishFollowDeliveryOwner } from "./follow-delivery-owner.js";

export function createOwnedFollowLinkRuntime(options = {}) {
  const { enabled = false, db } = options;
  const runtime = createFollowLinkRuntime(options);
  return async (input = {}) => {
    if (enabled !== true) return { status: "disabled" };
    let maxCandidates, maxExpired;
    try {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.getOwnPropertySymbols(input).length
      )
        throw Error();
      const d = Object.getOwnPropertyDescriptors(input);
      if (
        Object.keys(d).length !== 2 ||
        !d.maxCandidates?.enumerable ||
        !Object.hasOwn(d.maxCandidates, "value") ||
        !d.maxExpired?.enumerable ||
        !Object.hasOwn(d.maxExpired, "value")
      )
        throw Error();
      maxCandidates = d.maxCandidates.value;
      maxExpired = d.maxExpired.value;
      if (
        !Number.isSafeInteger(maxCandidates) ||
        maxCandidates < 1 ||
        maxCandidates > 64 ||
        !Number.isSafeInteger(maxExpired) ||
        maxExpired < 1
      )
        throw Error();
    } catch {
      return { status: "unavailable" };
    }
    const acquired = await acquireFollowDeliveryOwner(db);
    if (acquired.status !== "acquired") return acquired;
    let result;
    try {
      result = await runtime({ maxCandidates, maxExpired, continuation: acquired.continuation });
    } catch {
      result = { status: "unavailable" };
    }
    const completed = await finishFollowDeliveryOwner(acquired.ticket, result, {
      maxCandidates,
      maxExpired,
    });
    return completed.status === "ready" ? result : { status: completed.status };
  };
}
