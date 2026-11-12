// Test-only protocol rehearsal. No production entry point or selected witness provider.
import { DurableObject } from "cloudflare:workers";
import { createFollowCheckpointR2Slots } from "../src/follow-checkpoint-r2.js";
import { createFollowCheckpointPayloadCodec } from "../src/follow-checkpoint-payload.js";
import { classifyFollowCheckpointWitness as classify } from "../src/follow-checkpoint-witness.js";

const DAY = 86_400_000;
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const fingerprint = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
const reservationProof = (state) => {
  const r = state.reservation;
  return {
    slot: r.slot,
    nonce: r.nonce,
    payloadSha: r.payloadSha,
    digest: r.digest,
    starts: r.starts,
    expires: r.expires,
    cutoff: r.cutoff,
  };
};
const cutoff = (state) => state.reservation.cutoff;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const copy = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
const codec = createFollowCheckpointPayloadCodec({
  maxCheckpointBytes: 3_000_000,
  maxPayloadBytes: 2_900_000,
  maxHeaderBytes: 2000,
  maxRows: 30000,
});
const live = (record, now) => record && record.starts <= now && now < record.expires;
const validCutoff = (state, r) => {
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
};
const position = (state) => ({ current: state.current, receipt: state.receipt });

// This injected test double is deliberately outside the SQLite snapshot restored by tests.
export class WitnessDouble {
  constructor(current) {
    this.value = { version: 1, phase: "stable", current: copy(current), intent: null };
    this.cleanup = null;
  }
  async read() {
    return copy(this.value);
  }
  async prepare(previous, intent) {
    if (this.failPrepare === "before") throw new Error("injected unavailable witness");
    if (this.value?.phase !== "stable" || !equal(this.value.current, previous)) return false;
    this.value = { version: 1, phase: "prepared", current: copy(previous), intent: copy(intent) };
    if (this.failPrepare === "after") throw new Error("injected lost prepare acknowledgement");
    return true;
  }
  async readCleanup() {
    return copy(this.cleanup);
  }
  async bindCleanup(expected, next) {
    if (
      !equal(this.cleanup, expected) ||
      this.value.phase !== "prepared" ||
      !equal(next.transition, { previous: this.value.current, ...this.value.intent })
    )
      return false;
    this.cleanup = copy(next); // Simulated external atomic CAS, outside restored SQLite.
    return true;
  }
  async finish(control) {
    if (this.failFinish === "before") throw new Error("injected lost finalization acknowledgement");
    if (classify(this.value, control) !== "recover_ack") return false;
    this.value = { version: 1, phase: "stable", current: copy(control.current), intent: null };
    this.cleanup = null;
    if (this.failFinish === "after") throw new Error("injected lost stable acknowledgement");
    return true;
  }
}

export class CheckpointIntegration extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.slots = createFollowCheckpointR2Slots(env.SLOTS, {
      maxPayloadBytes: 2_900_000,
      maxEnvelopeBytes: 2_900_256,
    });
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL)",
    );
    // Witness is injected by the local test; restart without it must fail closed.
    this.witness = null;
    this.uploads = new Map(); // Single-use upload bodies never enter SQLite or survive eviction.
  }
  now() {
    return this.ctx.storage.sql
      .exec("SELECT CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER) AS now")
      .one().now;
  }
  snapshot() {
    return this.ctx.storage.sql.exec("SELECT metadata FROM control WHERE id=1").toArray()[0]
      ?.metadata;
  }
  state() {
    const raw = this.snapshot();
    return raw ? JSON.parse(raw) : null;
  }
  save(state) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO control VALUES(1,?)", JSON.stringify(state));
  }
  async admitted() {
    const before = this.state();
    if (!before || !this.witness) return null;
    try {
      if (
        classify(await this.witness.read(), position(before)) !== "current" ||
        !equal(before, this.state())
      )
        return null;
      return before;
    } catch {
      return null;
    }
  }
  async descriptor(raw, phase, slot) {
    const parts = await codec.split(raw, phase),
      header = JSON.parse(decoder.decode(parts.header));
    const stamp = header[phase === "pending" ? "prepared_at" : "accepted_at"];
    const floor = Date.parse(stamp.slice(0, -4) + "Z");
    return {
      parts,
      record: {
        slot,
        header: decoder.decode(parts.header),
        digest: parts.checkpointSha256,
        payloadSha: parts.payloadSha256,
        starts: floor + (stamp.slice(-4, -1) === "000" ? 0 : 1),
        expires: floor + (phase === "pending" ? DAY : 7 * DAY),
      },
    };
  }
  // Only the already-accepted predecessor and initial fencing keys are trusted fixture seeds.
  async bootstrap(oldBytes = null) {
    if (this.state()) throw new Error("fixture already initialized");
    const old = oldBytes ? await this.descriptor(oldBytes, "accepted", 1) : null;
    const state = {
      current: { epoch: id(), revision: 0, token: id() },
      receipt: null,
      initialized: Boolean(oldBytes),
      pending: null,
      reservation: null,
      accepted: null,
      retired: null,
    };
    for (const slot of [0, 1]) {
      const fence = await this.slots.write(slot, null, await this.slots.tombstone());
      if (fence.status !== "stored") throw new Error("fixture slot occupied");
      const entry = slot === 1 ? old : null;
      if (!entry) continue;
      const prepared = await this.slots.prepare(entry.parts.payload);
      const put = await this.slots.write(slot, fence.etag, prepared);
      if (put.status !== "stored") throw new Error("fixture payload unavailable");
      state.accepted = {
        ...entry.record,
        nonce: prepared.nonce,
        etag: put.etag,
      };
    }
    this.save(state);
    this.witness = new WitnessDouble(state.current);
    return position(state);
  }
  async initialize(pendingBytes, oldBytes = null) {
    await this.bootstrap(oldBytes);
    const reserved = await this.reservePending(pendingBytes);
    if (reserved.status !== "reserved") throw new Error("fixture reservation refused");
    if ((await this.uploadReserved(reserved.nonce)) !== "stored")
      throw new Error("fixture upload uncertain");
    if ((await this.reconcileReserved(reserved.nonce)) !== "committed")
      throw new Error("fixture staging refused");
    return position(this.state());
  }
  predecessorMatches(state, record, now) {
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
  async reservePending(raw) {
    const before = await this.admitted();
    if (!before || before.pending || before.reservation || before.retired)
      return { status: "held" };
    const slot = before.accepted ? 1 - before.accepted.slot : 0;
    const entry = await this.descriptor(raw, "pending", slot);
    const fence = await this.slots.read(slot);
    if (fence.status !== "present" || fence.kind !== "tombstone") return { status: "held" };
    const prepared = await this.slots.prepare(entry.parts.payload);
    const reservation = {
      ...entry.record,
      cutoff: Math.min(entry.record.expires, before.accepted?.expires ?? entry.record.expires),
      nonce: prepared.nonce,
      fenceEtag: fence.etag,
      fenceNonce: fence.nonce,
    };
    const result = await this.change((state, now) => {
      if (
        !equal(state, before) ||
        !validCutoff(state, reservation) ||
        now >= reservation.cutoff ||
        !live(reservation, now) ||
        !this.predecessorMatches(state, reservation, now)
      )
        return false;
      state.reservation = reservation;
      return true;
    });
    if (result !== "committed") return { status: result };
    this.uploads.set(prepared.nonce, prepared);
    return { status: "reserved", nonce: prepared.nonce };
  }
  async uploadReserved(nonce) {
    const state = await this.admitted(),
      r = state?.reservation;
    const prepared = this.uploads.get(nonce);
    if (
      !r ||
      r.nonce !== nonce ||
      !prepared ||
      !validCutoff(state, r) ||
      this.now() >= r.cutoff ||
      !live(r, this.now()) ||
      !this.predecessorMatches(state, r, this.now())
    )
      return "held";
    this.uploads.delete(nonce); // No retry after an ambiguous result or a process restart.
    if (this.beforeUpload) await this.beforeUpload();
    const result = await this.slots.write(r.slot, r.fenceEtag, prepared);
    return result.status;
  }
  async reconcileReserved(nonce) {
    const before = await this.admitted(),
      r = before?.reservation;
    if (!r || r.nonce !== nonce || !validCutoff(before, r)) return "held";
    const object = await this.slots.read(r.slot);
    if (object.status !== "present") return "held";
    const payload =
      object.kind === "payload" && object.nonce === r.nonce && object.sha256 === r.payloadSha;
    const fence =
      object.kind === "tombstone" && object.etag === r.fenceEtag && object.nonce === r.fenceNonce;
    if (!payload && !fence) return "held";
    const eligible = (state, now) =>
      now < r.cutoff && live(r, now) && this.predecessorMatches(state, r, now);
    if (eligible(before, this.now())) {
      if (!payload) return "uncertain"; // A negative read cannot establish that PUT completed.
      await codec.reassemble(object.payload, encoder.encode(r.header), "pending", r.digest);
      return this.change((state, now) => {
        if (!equal(state, before) || !eligible(state, now)) return false;
        const { fenceEtag, fenceNonce, cutoff, ...record } = r;
        state.pending = { ...record, etag: object.etag };
        state.reservation = null;
        return true;
      });
    }
    const expired = (now) => now >= r.cutoff;
    if (!expired(this.now())) return "held"; // Unavailable eligibility is not proof of expiry.
    // Replacing the exact fence also prevents an earlier in-flight conditional PUT from committing.
    this.uploads.delete(nonce);
    return this.change(
      (state, now) => {
        if (!equal(state, before) || !expired(now)) return false;
        state.reservation = null;
        return true;
      },
      async (previous, intent) => {
        const receipt = await this.slots.tombstone();
        const journal = {
          version: 1,
          kind: "expired-reservation",
          transition: { previous: previous.current, ...intent },
          beforeHash: await fingerprint(previous),
          reservation: reservationProof(previous),
          cutoff: cutoff(previous),
          sourceEtag: object.etag,
          planned: copy(receipt),
          forwarded: false,
        };
        if (!(await this.witness.bindCleanup(null, journal))) return false;
        if (this.beforeReservationCleanup) await this.beforeReservationCleanup();
        return (await this.forwardCleanup(journal, receipt)).status === "stored";
      },
    );
  }
  async forwardCleanup(journal, receipt) {
    if (journal.forwarded || !equal(receipt, journal.planned)) return { status: "held" };
    // This durable flag is conservative even if execution stops before the actual invocation.
    if (!(await this.witness.bindCleanup(journal, { ...journal, forwarded: true })))
      return { status: "held" };
    if (this.beforeCleanupPut) await this.beforeCleanupPut();
    return this.slots.write(journal.reservation.slot, journal.sourceEtag, receipt);
  }
  async recoverCleanup(allowFresh = true) {
    try {
      const before = this.state(),
        external = await this.witness?.read();
      if (classify(external, position(before ?? {})) === "recover_ack")
        return this.recoverAcknowledgement();
      const journal = await this.witness?.readCleanup(),
        r = before?.reservation;
      if (
        !r ||
        !validCutoff(before, r) ||
        classify(external, position(before)) !== "ambiguous_predecessor" ||
        journal?.version !== 1 ||
        journal.kind !== "expired-reservation" ||
        !equal(journal.transition, { previous: external.current, ...external.intent }) ||
        journal.beforeHash !== (await fingerprint(before)) ||
        !equal(journal.reservation, reservationProof(before)) ||
        journal.cutoff !== cutoff(before) ||
        !Number.isFinite(journal.cutoff) ||
        this.now() < journal.cutoff ||
        typeof journal.forwarded !== "boolean" ||
        typeof journal.sourceEtag !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(journal.sourceEtag) ||
        !equal(journal.planned, {
          kind: "tombstone",
          nonce: journal.planned?.nonce,
          sha256: EMPTY_SHA,
          bytes: 0,
        }) ||
        typeof journal.planned.nonce !== "string" ||
        !/^[a-f0-9]{32}$/.test(journal.planned.nonce) ||
        journal.planned.nonce === r.nonce ||
        journal.planned.nonce === r.fenceNonce ||
        !equal(before, this.state())
      )
        return "held";
      const object = await this.slots.read(r.slot);
      if (object.status !== "present") return "held";
      if (
        object.kind === "tombstone" &&
        object.nonce === journal.planned.nonce &&
        object.sha256 === EMPTY_SHA &&
        journal.forwarded
      ) {
        // Only this predetermined cleanup may complete a prepared predecessor. Never abort it.
        if (
          !equal(await this.witness.read(), external) ||
          !equal(await this.witness.readCleanup(), journal)
        )
          return "held";
        const committed = this.ctx.storage.transactionSync(() => {
          const state = this.state();
          if (!equal(state, before) || this.now() < journal.cutoff) return false;
          state.reservation = null;
          state.current = journal.transition.next;
          state.receipt = {
            nonce: journal.transition.nonce,
            previous: journal.transition.previous,
          };
          this.save(state);
          return true;
        });
        if (!committed) return "held";
        return this.recoverAcknowledgement();
      }
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
      // A prior attempted condition is dead, or sidecar CAS proves it was never forwarded.
      // Generate a NEW one-use envelope. No receipt reconstruction or raw PUT replay.
      const receipt = await this.slots.tombstone();
      const next = {
        ...journal,
        sourceEtag: object.etag,
        planned: copy(receipt),
        forwarded: false,
      };
      if (
        !equal(before, this.state()) ||
        this.now() < journal.cutoff ||
        !(await this.witness.bindCleanup(journal, next))
      )
        return "held";
      if ((await this.forwardCleanup(next, receipt)).status !== "stored") return "held";
      return this.recoverCleanup(false);
    } catch {
      return "held";
    }
  }
  async change(action, effect = null) {
    const before = await this.admitted();
    if (!before) return "held";
    if (!action(copy(before), this.now())) return "stale";
    const intent = {
      nonce: id(),
      next: { epoch: before.current.epoch, revision: before.current.revision + 1, token: id() },
    };
    try {
      if (!(await this.witness.prepare(before.current, intent))) return "held";
      if (effect && !(await effect(before, intent))) return "held";
      if (this.beforeCommit) await this.beforeCommit(); // Explicit local failure/delay hook.
      const committed = this.ctx.storage.transactionSync(() => {
        const state = this.state();
        if (!equal(state, before) || !action(state, this.now())) return false;
        state.current = intent.next;
        state.receipt = { nonce: intent.nonce, previous: before.current };
        this.save(state);
        return true;
      });
      if (!committed) return "held"; // Prepared predecessor cannot be auto-aborted safely.
      if (!(await this.witness.finish(position(this.state())))) return "held";
      return (await this.admitted()) ? "committed" : "held";
    } catch {
      return "held";
    }
  }
  async read(phase) {
    if (phase !== "pending" && phase !== "accepted") return { status: "held" };
    const state = await this.admitted(),
      record = state?.[phase];
    if (!live(record, this.now())) return { status: state ? "expired" : "held" };
    const object = await this.slots.read(record.slot);
    if (
      object.status !== "present" ||
      object.kind !== "payload" ||
      object.etag !== record.etag ||
      object.nonce !== record.nonce ||
      object.sha256 !== record.payloadSha
    )
      return { status: "held" };
    let result;
    try {
      result = await codec.reassemble(
        object.payload,
        encoder.encode(record.header),
        phase,
        record.digest,
      );
    } catch {
      return { status: "held" };
    }
    if (this.beforeReadRelease) await this.beforeReadRelease();
    const current = await this.admitted();
    if (!equal(state, current) || !live(current?.[phase], this.now())) return { status: "held" };
    return { status: "current", bytes: result.bytes };
  }
  async promote(acceptedBytes, generation) {
    const proposed = await this.descriptor(acceptedBytes, "accepted", 0);
    const before = await this.admitted();
    if (!before) return "held";
    const header = JSON.parse(proposed.record.header);
    const target = (record) => {
      const h = JSON.parse(record.header);
      return h.accepted_commit + h.public_tree;
    };
    if (
      before.accepted?.generation === generation &&
      target(before.accepted) === target(proposed.record)
    )
      return live(before.accepted, this.now()) && this.now() < before.accepted.replayUntil
        ? "already_promoted"
        : "stale";
    const pending = before.pending;
    if (
      !pending ||
      pending.digest !== generation ||
      (await this.read("pending")).status !== "current" ||
      proposed.record.payloadSha !== pending.payloadSha ||
      before.retired
    )
      return "stale";
    const prior = JSON.parse(pending.header);
    if (header.public_tree !== prior.public_tree || header.accepted_at < prior.prepared_at)
      return "stale";
    const predecessor = prior.predecessor;
    if (before.accepted) {
      const old = JSON.parse(before.accepted.header);
      if (
        predecessor.commit !== old.accepted_commit ||
        predecessor.public_tree !== old.public_tree ||
        predecessor.checkpoint_sha256 !== before.accepted.digest
      )
        return "stale";
    } else if (before.initialized || predecessor.checkpoint_sha256 !== null) return "stale";
    return this.change((state, now) => {
      if (
        !equal(state, before) ||
        !live(state.pending, now) ||
        !live(proposed.record, now) ||
        (state.accepted && !live(state.accepted, now))
      )
        return false;
      if (state.accepted)
        state.retired = {
          slot: state.accepted.slot,
          etag: state.accepted.etag,
          nonce: state.accepted.nonce,
          expires: state.accepted.expires,
        };
      state.accepted = {
        ...proposed.record,
        slot: pending.slot,
        nonce: pending.nonce,
        etag: pending.etag,
        generation,
        replayUntil: Math.min(pending.expires, state.accepted?.expires ?? pending.expires),
      };
      state.pending = null;
      state.initialized = true;
      return true;
    });
  }
  async recoverAcknowledgement() {
    const state = this.state();
    if (!state || !this.witness) return "held";
    try {
      if (
        classify(await this.witness.read(), position(state)) !== "recover_ack" ||
        !equal(state, this.state())
      )
        return "held";
      if (!(await this.witness.finish(position(state)))) return "held";
      return (await this.admitted()) ? "recovered" : "held";
    } catch {
      return "held";
    }
  }
  async retireExpired(phase) {
    if (phase !== "pending" && phase !== "accepted") return "held";
    return this.change((state, now) => {
      const record = state[phase];
      if (!record || state.retired || now < record.expires) return false;
      state.retired = {
        slot: record.slot,
        etag: record.etag,
        nonce: record.nonce,
        expires: record.expires,
      };
      state[phase] = null;
      return true;
    });
  }
  async cleanupRetired() {
    const before = await this.admitted(),
      retired = before?.retired;
    if (!retired) return "held";
    return this.change(
      (state) => {
        if (!equal(state, before)) return false;
        state.retired = null;
        return true;
      },
      async () => {
        const result = await this.slots.write(
          retired.slot,
          retired.etag,
          await this.slots.tombstone(),
        );
        return result.status === "stored";
      },
    );
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
