// Unmounted composition. The caller owns cadence, durable serialization and continuation.
import { expireFollowManagementRequests } from "./follow-retention.js";
import { runFollowLinkDispatch } from "./follow-link-dispatch.js";
import { createFollowEmailTransport } from "./follow-email-transport.js";
import { validFollowSendCap } from "./follow-send-budget.js";
const fail = () => {
  throw new Error("Follow link runtime unavailable");
};
const unavailable = () => ({ status: "unavailable" });
function data(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const result = Object.create(null);
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!d.enumerable || !Object.hasOwn(d, "value")) fail();
    result[key] = d.value;
  }
  return result;
}
function policySnapshot(supply) {
  const value = supply();
  if (value && typeof value.then === "function") {
    void Promise.resolve(value).catch(() => {});
    fail();
  }
  const p = data(value);
  if (p.sending === false) return { sending: false };
  if (p.sending !== true || !validFollowSendCap(p.cap)) fail();
  const confirmation = data(p.confirmation),
    management = data(p.management),
    presentation = data(management.presentation);
  if (
    typeof confirmation.present !== "function" ||
    typeof management.buildLinks !== "function" ||
    typeof presentation.from !== "string" ||
    !presentation.from.length ||
    presentation.from.length > 512 ||
    typeof presentation.postalAddress !== "string" ||
    !presentation.postalAddress.length ||
    presentation.postalAddress.length > 500 ||
    !Array.isArray(presentation.origins) ||
    !presentation.origins.length ||
    presentation.origins.length > 16
  )
    fail();
  const origins = [];
  for (let i = 0; i < presentation.origins.length; i++) {
    const v = Object.getOwnPropertyDescriptor(presentation.origins, i)?.value;
    if (typeof v !== "string" || !v.length || v.length > 2000) fail();
    origins.push(v);
  }
  return {
    sending: true,
    cap: p.cap,
    present: confirmation.present,
    buildLinks: management.buildLinks,
    from: presentation.from,
    postalAddress: presentation.postalAddress,
    origins,
  };
}
const same = (a, b) =>
  a.sending === b.sending &&
  a.cap === b.cap &&
  a.present === b.present &&
  a.buildLinks === b.buildLinks &&
  a.from === b.from &&
  a.postalAddress === b.postalAddress &&
  JSON.stringify(a.origins) === JSON.stringify(b.origins);

export function createFollowLinkRuntime({
  enabled = false,
  db,
  email,
  policy,
  clock = () => new Date(),
  transportTimeoutMs = 10000,
} = {}) {
  let busy = false,
    held = false,
    transport;
  return async (input = {}) => {
    if (enabled !== true) return { status: "disabled" };
    if (busy) return { status: "busy" };
    let maxCandidates, maxExpired, continuation;
    try {
      ({ maxCandidates, maxExpired, continuation } = data(input));
    } catch {
      return unavailable();
    }
    if (
      typeof policy !== "function" ||
      typeof clock !== "function" ||
      !Number.isSafeInteger(maxCandidates) ||
      maxCandidates < 1 ||
      maxCandidates > 64 ||
      !Number.isSafeInteger(maxExpired) ||
      maxExpired < 1 ||
      !Number.isInteger(transportTimeoutMs) ||
      transportTimeoutMs < 1 ||
      transportTimeoutMs > 10000
    )
      return unavailable();
    busy = true;
    try {
      const selected = policySnapshot(policy),
        resume = structuredClone(continuation);
      if (selected.sending && !held && !transport) {
        const send = email?.send;
        if (typeof send !== "function") fail();
        transport = createFollowEmailTransport({
          enabled: true,
          email: { send: (message) => Reflect.apply(send, email, [message]) },
          timeoutMs: transportTimeoutMs,
        });
      }
      const cleanup = await expireFollowManagementRequests(db, {
        enabled: true,
        maxRows: maxExpired,
      });
      if (cleanup.status !== "maintained") return unavailable();
      if (!selected.sending) return { status: "maintained", cleanup };
      if (held) return { status: "held", cleanup };
      const current = () => {
        if (!same(selected, policySnapshot(policy))) fail();
      };
      current();
      const result = await runFollowLinkDispatch({
        enabled: true,
        db,
        cap: selected.cap,
        maxCandidates,
        continuation: resume,
        clock: () => {
          current();
          return clock();
        },
        confirmation: { present: selected.present },
        management: {
          buildLinks: selected.buildLinks,
          presentation: {
            from: selected.from,
            postalAddress: selected.postalAddress,
            origins: selected.origins,
          },
        },
        transport: (envelope) => {
          // Preserve the delivery helper's final fence: no await before the reused adapter.
          try {
            current();
            return transport(envelope).catch(() => {
              held = true;
              fail();
            });
          } catch {
            held = true;
            return Promise.reject(new Error("Follow link runtime unavailable"));
          }
        },
      });
      if (result.status === "uncertain") held = true;
      return { status: result.status, cleanup, dispatch: result };
    } catch {
      return unavailable();
    } finally {
      busy = false;
    }
  };
}
