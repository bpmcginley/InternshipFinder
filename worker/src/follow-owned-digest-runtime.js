// Unmounted, one candidate per shared acquisition. No schedule or provider defaults.
import { acquireFollowDeliveryOwner, finishFollowDigestOwner } from "./follow-delivery-owner.js";
import { runFollowDeliveryTick } from "./follow-delivery-tick.js";
import { createFollowEmailTransport } from "./follow-email-transport.js";
import { validFollowSendCap } from "./follow-send-budget.js";
import { captureFollowDigestRelatedLimits } from "./follow-digest-prepare.js";
const fail = () => {
  throw new Error("Follow digest runtime unavailable");
};
function snapshot(supply) {
  const value = supply();
  if (value && typeof value.then === "function") {
    void Promise.resolve(value).catch(() => {});
    fail();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const d = Object.getOwnPropertyDescriptors(value);
  if (Object.values(d).some((p) => !p.enumerable || !Object.hasOwn(p, "value"))) fail();
  if (d.sending?.value === false) return { sending: false };
  if (
    d.sending?.value !== true ||
    !validFollowSendCap(d.cap?.value) ||
    typeof d.present?.value !== "function" ||
    (d.buildLinks && d.buildLinks.value !== null && typeof d.buildLinks.value !== "function")
  )
    fail();
  return {
    sending: true,
    cap: d.cap.value,
    present: d.present.value,
    buildLinks: d.buildLinks?.value ?? null,
  };
}
export function createOwnedFollowDigestRuntime(options = {}) {
  // Capture each option once, especially DB identity across ownership and dispatch.
  const {
    enabled = false,
    db,
    email,
    policy,
    key,
    catalog,
    limits,
    loadSnapshot,
    clock = () => new Date(),
    transportTimeoutMs = 10000,
  } = options;
  return async () => {
    if (enabled !== true) return { status: "disabled" };
    let selected, transport, related;
    try {
      if (
        typeof policy !== "function" ||
        typeof clock !== "function" ||
        typeof loadSnapshot !== "function" ||
        !Number.isInteger(transportTimeoutMs) ||
        transportTimeoutMs < 1 ||
        transportTimeoutMs > 10000
      )
        fail();
      selected = snapshot(policy);
      if (!selected.sending) return { status: "disabled" };
      const descriptor = Object.getOwnPropertyDescriptor(options, "relatedLimits");
      if (
        (descriptor && (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) ||
        (!descriptor && "relatedLimits" in options)
      )
        fail();
      related = captureFollowDigestRelatedLimits(descriptor?.value);
      transport = createFollowEmailTransport({
        enabled: true,
        email,
        timeoutMs: transportTimeoutMs,
      });
    } catch {
      return { status: "unavailable" };
    }
    const acquired = await acquireFollowDeliveryOwner(db);
    if (acquired.status !== "acquired") return acquired;
    let result;
    try {
      const current = () => {
        const p = snapshot(policy);
        if (
          p.sending !== true ||
          p.cap !== selected.cap ||
          p.present !== selected.present ||
          p.buildLinks !== selected.buildLinks
        )
          fail();
      };
      current();
      result = await runFollowDeliveryTick({
        db,
        key,
        catalog,
        limits,
        relatedLimits: related,
        loadSnapshot,
        cap: selected.cap,
        present: selected.present,
        buildLinks: selected.buildLinks,
        maxCandidates: 1,
        clock: () => {
          current();
          return clock();
        },
        // Preserve the final consent fence: invoke the adapter synchronously.
        transport: (envelope) => {
          current();
          return transport(envelope);
        },
      });
    } catch {
      result = { status: "unavailable" };
    }
    const completed = await finishFollowDigestOwner(acquired.ticket, result);
    return completed.status === "ready" ? result : { status: completed.status };
  };
}
