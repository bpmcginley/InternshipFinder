// Dormant reservation lifecycle. The caller supplies qualified control, witness and slot ports.
import { classifyFollowCheckpointWitness as classify } from "./follow-checkpoint-witness.js";
import { fingerprintFollowCheckpointControl } from "./follow-checkpoint-control.js";
import {
  canonicalCleanupJournal,
  cleanupMatchesWitness,
} from "./follow-checkpoint-cleanup-journal.js";

const DAY = 86_400_000;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const copy = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const position = (state) => ({ current: state.current, receipt: state.receipt });
const live = (record, now) => record && record.starts <= now && now < record.expires;

function reservationProof({ reservation: r }) {
  return {
    slot: r.slot,
    nonce: r.nonce,
    payloadSha: r.payloadSha,
    digest: r.digest,
    starts: r.starts,
    expires: r.expires,
    cutoff: r.cutoff,
  };
}

function validCutoff(state, r) {
  if (
    !Number.isSafeInteger(r?.starts) ||
    !Number.isSafeInteger(r?.expires) ||
    !Number.isSafeInteger(r?.cutoff) ||
    r.cutoff <= r.starts ||
    r.cutoff > r.expires
  )
    return false;
  try {
    const prior = JSON.parse(r.header).predecessor;
    if (prior.checkpoint_sha256 === null) return !state.initialized && r.cutoff === r.expires;
    if (!state.accepted) return state.initialized; // The captured deadline survives retirement.
    const accepted = JSON.parse(state.accepted.header);
    return (
      prior.commit === accepted.accepted_commit &&
      prior.public_tree === accepted.public_tree &&
      prior.checkpoint_sha256 === state.accepted.digest &&
      r.cutoff === Math.min(r.expires, state.accepted.expires)
    );
  } catch {
    return false;
  }
}

function predecessorMatches(state, record, now) {
  const prior = JSON.parse(record.header).predecessor;
  if (!state.accepted) return !state.initialized && prior.checkpoint_sha256 === null;
  const accepted = JSON.parse(state.accepted.header);
  return (
    live(state.accepted, now) &&
    prior.commit === accepted.accepted_commit &&
    prior.public_tree === accepted.public_tree &&
    prior.checkpoint_sha256 === state.accepted.digest
  );
}

export async function describeFollowCheckpoint(codec, raw, phase, slot) {
  const parts = await codec.split(raw, phase),
    header = decoder.decode(parts.header);
  const stamp = JSON.parse(header)[phase === "pending" ? "prepared_at" : "accepted_at"];
  const floor = Date.parse(stamp.slice(0, -4) + "Z");
  return {
    parts,
    record: {
      slot,
      header,
      digest: parts.checkpointSha256,
      payloadSha: parts.payloadSha256,
      starts: floor + (stamp.slice(-4, -1) === "000" ? 0 : 1),
      expires: floor + (phase === "pending" ? DAY : 7 * DAY),
    },
  };
}

export function createFollowCheckpointReservation({
  enabled = false,
  control,
  slots,
  codec,
  witness,
} = {}) {
  if (
    enabled === true &&
    [
      control?.admitted,
      control?.state,
      control?.now,
      control?.change,
      control?.recoverAcknowledgement,
      control?.commitExpiredReservationCleanup,
      slots?.read,
      slots?.prepare,
      slots?.write,
      slots?.tombstone,
      codec?.split,
      codec?.reassemble,
      witness,
    ].some((fn) => typeof fn !== "function")
  )
    throw new TypeError("Invalid checkpoint reservation dependencies");

  const uploads = new Map(); // Single-use receipts stay in memory and disappear on eviction.
  const admitted = () => (enabled === true ? control.admitted() : null);

  async function inspectStageReservation(digest) {
    const state = await admitted();
    if (!state) return { status: "held" };
    const r = state.reservation;
    if (!r) return { status: "none" };
    return r.digest === digest ? { status: "reservation", nonce: r.nonce } : { status: "held" };
  }

  async function reservePending(raw) {
    const before = await admitted();
    if (!before || before.pending || before.reservation || before.retired)
      return { status: "held" };
    const slot = before.accepted ? 1 - before.accepted.slot : 0;
    const entry = await describeFollowCheckpoint(codec, raw, "pending", slot);
    const fence = await slots.read(slot);
    if (fence.status !== "present" || fence.kind !== "tombstone") return { status: "held" };
    const prepared = await slots.prepare(entry.parts.payload);
    if (!prepared) return { status: "held" };
    const reservation = {
      ...entry.record,
      cutoff: Math.min(entry.record.expires, before.accepted?.expires ?? entry.record.expires),
      nonce: prepared.nonce,
      fenceEtag: fence.etag,
      fenceNonce: fence.nonce,
    };
    const result = await control.change((state, now) => {
      if (
        !equal(state, before) ||
        !validCutoff(state, reservation) ||
        now >= reservation.cutoff ||
        !live(reservation, now) ||
        !predecessorMatches(state, reservation, now)
      )
        return false;
      state.reservation = reservation;
      return true;
    });
    if (result !== "committed") return { status: result };
    uploads.set(prepared.nonce, prepared);
    return { status: "reserved", nonce: prepared.nonce };
  }

  async function uploadReserved(nonce) {
    const state = await admitted(),
      r = state?.reservation,
      prepared = uploads.get(nonce);
    if (
      !r ||
      r.nonce !== nonce ||
      !prepared ||
      !validCutoff(state, r) ||
      control.now() >= r.cutoff ||
      !live(r, control.now()) ||
      !predecessorMatches(state, r, control.now())
    )
      return "held";
    uploads.delete(nonce); // Consume before the conditional write, including an ambiguous result.
    return (await slots.write(r.slot, r.fenceEtag, prepared)).status;
  }

  async function forwardCleanup(port, journal, receipt) {
    if (journal.forwarded || !equal(receipt, journal.planned)) return { status: "held" };
    if ((await port?.bindCleanup?.(journal, { ...journal, forwarded: true })) !== true)
      return { status: "held" };
    return slots.write(journal.reservation.slot, journal.sourceEtag, receipt);
  }

  async function reconcileReserved(nonce) {
    const before = await admitted(),
      r = before?.reservation;
    if (!r || r.nonce !== nonce || !validCutoff(before, r)) return "held";
    const object = await slots.read(r.slot);
    if (object.status !== "present") return "held";
    const payload =
      object.kind === "payload" && object.nonce === r.nonce && object.sha256 === r.payloadSha;
    const fence =
      object.kind === "tombstone" && object.etag === r.fenceEtag && object.nonce === r.fenceNonce;
    if (!payload && !fence) return "held";
    const eligible = (state, now) =>
      now < r.cutoff && live(r, now) && predecessorMatches(state, r, now);
    if (eligible(before, control.now())) {
      if (!payload) return "uncertain"; // An absent payload is not proof the PUT never arrived.
      await codec.reassemble(object.payload, encoder.encode(r.header), "pending", r.digest);
      return control.change((state, now) => {
        if (!equal(state, before) || !eligible(state, now)) return false;
        const { fenceEtag, fenceNonce, cutoff, ...record } = r;
        state.pending = { ...record, etag: object.etag };
        state.reservation = null;
        return true;
      });
    }
    const expired = (now) => now >= r.cutoff;
    if (!expired(control.now())) return "held";
    uploads.delete(nonce);
    const port = witness();
    return control.change(
      (state, now) => {
        if (!equal(state, before) || !expired(now)) return false;
        state.reservation = null;
        return true;
      },
      async (previous, intent) => {
        const receipt = await slots.tombstone();
        const journal = {
          version: 1,
          kind: "expired-reservation",
          transition: { previous: previous.current, ...intent },
          beforeHash: await fingerprintFollowCheckpointControl(previous),
          reservation: reservationProof(previous),
          cutoff: r.cutoff,
          sourceEtag: object.etag,
          planned: copy(receipt),
          forwarded: false,
        };
        if ((await port?.bindCleanup?.(null, journal)) !== true) return false;
        return (await forwardCleanup(port, journal, receipt)).status === "stored";
      },
    );
  }

  async function recoverCleanup(allowFresh = true) {
    if (enabled !== true) return "held";
    try {
      const before = control.state(),
        port = witness(),
        external = await port?.read();
      const authority = classify(external, position(before ?? {}));
      if (authority === "recover_ack") return control.recoverAcknowledgement();
      if (authority !== "ambiguous_predecessor") return "held";
      const journal = canonicalCleanupJournal(await port?.readCleanup?.()),
        r = before?.reservation;
      if (
        !r ||
        !validCutoff(before, r) ||
        !journal ||
        !cleanupMatchesWitness(external, journal) ||
        journal.beforeHash !== (await fingerprintFollowCheckpointControl(before)) ||
        !equal(journal.reservation, reservationProof(before)) ||
        journal.cutoff !== r.cutoff ||
        control.now() < journal.cutoff ||
        journal.planned.nonce === r.fenceNonce ||
        !equal(before, control.state())
      )
        return "held";
      const object = await slots.read(r.slot);
      if (object.status !== "present") return "held";
      if (
        object.kind === "tombstone" &&
        object.nonce === journal.planned.nonce &&
        object.sha256 === journal.planned.sha256 &&
        journal.forwarded
      )
        return control.commitExpiredReservationCleanup(before, external, journal);
      const payload =
        object.kind === "payload" && object.nonce === r.nonce && object.sha256 === r.payloadSha;
      const originalFence =
        object.kind === "tombstone" && object.nonce === r.fenceNonce && object.etag === r.fenceEtag;
      if (
        !allowFresh ||
        (!payload && !originalFence) ||
        (journal.forwarded && (!payload || object.etag === journal.sourceEtag))
      )
        return "held";
      // The old condition is dead, or the journal proves it was never forwarded.
      const receipt = await slots.tombstone();
      const next = {
        ...journal,
        sourceEtag: object.etag,
        planned: copy(receipt),
        forwarded: false,
      };
      if (
        !equal(before, control.state()) ||
        control.now() < journal.cutoff ||
        (await port.bindCleanup(journal, next)) !== true
      )
        return "held";
      if ((await forwardCleanup(port, next, receipt)).status !== "stored") return "held";
      return recoverCleanup(false);
    } catch {
      return "held";
    }
  }

  return {
    inspectStageReservation,
    reservePending,
    uploadReserved,
    reconcileReserved,
    recoverCleanup,
  };
}
