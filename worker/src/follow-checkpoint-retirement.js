// Logical metadata retirement only. Physical tombstones and provider retention stay external.
import { validateFollowCheckpointRecord as record } from "./follow-checkpoint-snapshot.js";
const encoder = new TextEncoder();
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const matches = (re, v) => typeof v === "string" && re.test(v);
const fields = (v, keys) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys;
const fail = () => {
  throw new Error("Follow checkpoint retirement unavailable");
};

export function createFollowCheckpointRetirement({ control, maxControlBytes, maxHeaderBytes }) {
  if (
    [control?.capture, control?.change].some((v) => typeof v !== "function") ||
    !integer(maxControlBytes) ||
    !maxControlBytes ||
    maxControlBytes > 65536 ||
    !integer(maxHeaderBytes) ||
    !maxHeaderBytes ||
    maxHeaderBytes > maxControlBytes
  )
    throw new TypeError("Invalid checkpoint retirement dependencies");
  function capture() {
    const before = control.capture();
    if (
      !integer(before?.now) ||
      typeof before.raw !== "string" ||
      before.raw.length > maxControlBytes ||
      encoder.encode(before.raw).length > maxControlBytes
    )
      fail();
    const state = JSON.parse(before.raw);
    if (
      !fields(state, "accepted,current,initialized,pending,receipt,reservation,retired") ||
      typeof state.initialized !== "boolean"
    )
      fail();
    const accepted = record(state.accepted, "accepted", maxHeaderBytes);
    const pending = record(state.pending, "pending", maxHeaderBytes);
    if (accepted && !state.initialized) fail();
    let reservation = null;
    if (state.reservation !== null) {
      const r = state.reservation;
      if (
        !fields(
          r,
          "cutoff,digest,expires,fenceEtag,fenceNonce,header,nonce,payloadSha,slot,starts",
        ) ||
        !matches(/^[a-f0-9]{32}$/, r.fenceNonce) ||
        !integer(r.cutoff) ||
        r.cutoff <= r.starts ||
        r.cutoff > r.expires ||
        pending
      )
        fail();
      const { fenceEtag, fenceNonce, cutoff, ...rest } = r;
      reservation = record({ ...rest, etag: fenceEtag }, "pending", maxHeaderBytes);
      if (
        accepted
          ? cutoff !== Math.min(r.expires, accepted.expires)
          : !state.initialized && cutoff !== r.expires
      )
        fail();
    }
    for (const candidate of [pending, reservation]) {
      if (!candidate) continue;
      const p = candidate.parsed.predecessor;
      if (
        accepted
          ? candidate.slot === accepted.slot ||
            candidate.nonce === accepted.nonce ||
            p.commit !== accepted.parsed.accepted_commit ||
            p.public_tree !== accepted.parsed.public_tree ||
            p.checkpoint_sha256 !== accepted.digest
          : state.initialized
            ? p.checkpoint_sha256 === null
            : p.checkpoint_sha256 !== null
      )
        fail();
    }
    if (state.retired !== null) {
      const r = state.retired;
      if (
        !fields(r, "etag,expires,nonce,slot") ||
        ![0, 1].includes(r.slot) ||
        !matches(/^[A-Za-z0-9_-]{1,128}$/, r.etag) ||
        !matches(/^[a-f0-9]{32}$/, r.nonce) ||
        !integer(r.expires) ||
        [accepted, pending, reservation].some((v) => v && v.slot === r.slot)
      )
        fail();
    }
    if ([accepted, pending, reservation].some((v) => v && before.now < v.starts)) fail();
    return { ...before, state };
  }
  async function retire(phase, generation) {
    try {
      const before = capture();
      const result = await control.change((state, now) => {
        if (!integer(now) || now < before.now) fail();
        if (JSON.stringify(state) !== before.raw) fail();
        const r = state[phase];
        if (
          !r ||
          state.retired ||
          (generation === undefined
            ? now < r.expires
            : r.digest !== generation || now < r.starts || now >= r.expires)
        )
          return false;
        state.retired = { slot: r.slot, etag: r.etag, nonce: r.nonce, expires: r.expires };
        state[phase] = null;
        return true;
      });
      return ["committed", "stale"].includes(result) ? result : "held";
    } catch {
      return "held";
    }
  }
  return {
    retireExpired: (phase) =>
      ["pending", "accepted"].includes(phase) ? retire(phase) : Promise.resolve("held"),
    async rejectPending(generation) {
      if (!matches(/^[a-f0-9]{64}$/, generation)) return fail();
      const result = await retire("pending", generation);
      if (result === "held") return fail();
      return result === "committed";
    },
  };
}
