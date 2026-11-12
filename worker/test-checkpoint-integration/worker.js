// Test-only protocol rehearsal. No production entry point or selected witness provider.
import { DurableObject } from "cloudflare:workers";
import { FollowCheckpointControl } from "../src/follow-checkpoint-control.js";
import {
  createFollowCheckpointReservation,
  describeFollowCheckpoint,
} from "../src/follow-checkpoint-reservation.js";
import { createFollowCheckpointSnapshotReader } from "../src/follow-checkpoint-snapshot.js";
import { createFollowCheckpointStage } from "../src/follow-checkpoint-stage.js";
import { createFollowCheckpointPromotion } from "../src/follow-checkpoint-promotion.js";
import { handleFollowCheckpoint } from "../src/follow-checkpoint-http.js";
import { createFollowCheckpointR2Slots } from "../src/follow-checkpoint-r2.js";
import { createFollowCheckpointPayloadCodec } from "../src/follow-checkpoint-payload.js";
import { classifyFollowCheckpointWitness as classify } from "../src/follow-checkpoint-witness.js";

const DAY = 86_400_000;
const encoder = new TextEncoder();
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

// Independent native witness for the CAS adapter tests. No production storage is selected.
export class CheckpointWitnessCasFixture extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS witness (id INTEGER PRIMARY KEY, tag TEXT, text TEXT)",
    );
  }
  seedWitness(text) {
    this.ctx.storage.sql.exec("INSERT INTO witness VALUES(1,'1',?)", text);
  }
  readRecord() {
    const row = this.ctx.storage.sql.exec("SELECT tag,text FROM witness WHERE id=1").toArray()[0];
    return row ? JSON.stringify({ tag: row.tag, text: row.text }) : null;
  }
  compareAndSwap(tag, text) {
    return (
      this.ctx.storage.sql.exec(
        "UPDATE witness SET tag=CAST(CAST(tag AS INTEGER)+1 AS TEXT),text=? WHERE id=1 AND tag=?",
        text,
        tag,
      ).rowsWritten === 1
    );
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
    this.control = new FollowCheckpointControl(ctx.storage, {
      witness: () => this.witness,
      beforeCommit: () => this.beforeCommit?.(),
    });
    // Witness is injected by the local test; restart without it must fail closed.
    this.witness = null;
    // Mirror prepared receipts only for the synthetic delayed-PUT probes.
    this.uploads = new Map();
    this.reservations = createFollowCheckpointReservation({
      enabled: true,
      control: this.control,
      codec,
      slots: {
        read: (slot) => this.slots.read(slot),
        tombstone: () => this.slots.tombstone(),
        prepare: async (bytes) => {
          const receipt = await this.slots.prepare(bytes);
          if (receipt) this.uploads.set(receipt.nonce, receipt);
          return receipt;
        },
        write: async (slot, etag, receipt) => {
          if (receipt.kind === "payload") {
            this.uploads.delete(receipt.nonce);
            if (this.beforeUpload) await this.beforeUpload();
          } else if (this.beforeCleanupPut) await this.beforeCleanupPut();
          return this.slots.write(slot, etag, receipt);
        },
      },
      witness: () => {
        const current = this.witness;
        return (
          current && {
            read: () => current.read(),
            readCleanup: () => current.readCleanup?.(),
            bindCleanup: async (expected, next) => {
              const bound = await current.bindCleanup?.(expected, next);
              if (bound === true && expected === null) {
                this.uploads.delete(next.reservation.nonce);
                if (this.beforeReservationCleanup) await this.beforeReservationCleanup();
              }
              return bound;
            },
          }
        );
      },
    });
  }
  now() {
    return this.control.now();
  }
  snapshot() {
    return this.control.snapshot();
  }
  state() {
    return this.control.state();
  }
  save(state) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO control VALUES(1,?)", JSON.stringify(state));
  }
  admitted() {
    return this.control.admitted();
  }
  readSnapshot(maxBytes = 3_000_000) {
    return createFollowCheckpointSnapshotReader({
      capture: () =>
        this.ctx.storage.transactionSync(() => ({ raw: this.snapshot(), now: this.now() })),
      readWitness: () => this.witness?.read(),
      slots: this.slots,
      codec,
      maxBytes: 3_000_000,
      maxHeaderBytes: 2000,
      maxControlBytes: 16384,
    })(maxBytes);
  }
  inspectStageReservation(digest) {
    return this.reservations.inspectStageReservation(digest);
  }
  stageSnapshot(body, limit = 3_000_000) {
    return createFollowCheckpointStage({
      codec,
      maxBytes: 3_000_000,
      inspect: (digest) => this.inspectStageReservation(digest),
      read: (size) => this.readSnapshot(size),
      reserve: (bytes) => this.reservePending(bytes),
      upload: (nonce) => this.uploadReserved(nonce),
      reconcile: (nonce) => this.reconcileReserved(nonce),
    })(body, limit);
  }
  promoteSnapshot(body, limit, options) {
    return createFollowCheckpointPromotion({
      codec,
      maxBytes: 3_000_000,
      capture: () =>
        this.ctx.storage.transactionSync(() => ({ raw: this.snapshot(), now: this.now() })),
      read: (size) => this.readSnapshot(size),
      change: (action) => this.change(action),
    })(body, limit, options);
  }
  async fetch(request) {
    const hash = async (text) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))), (v) =>
        v.toString(16).padStart(2, "0"),
      ).join("");
    return handleFollowCheckpoint(request, {
      openStore: () => ({
        read: (maxBytes) => this.readSnapshot(maxBytes),
        reservePending: (body, maxBytes) => this.stageSnapshot(body, maxBytes),
        promote: (body, maxBytes, options) => this.promoteSnapshot(body, maxBytes, options),
      }),
      maxBytes: 3_000_000,
      writer: await hash("A".repeat(43)),
      operator: await hash("B".repeat(43)),
    });
  }
  descriptor(raw, phase, slot) {
    return describeFollowCheckpoint(codec, raw, phase, slot);
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
  reservePending(raw) {
    return this.reservations.reservePending(raw);
  }
  uploadReserved(nonce) {
    return this.reservations.uploadReserved(nonce);
  }
  reconcileReserved(nonce) {
    return this.reservations.reconcileReserved(nonce);
  }
  recoverCleanup() {
    return this.reservations.recoverCleanup();
  }
  change(action, effect = null) {
    return this.control.change(action, effect);
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
  recoverAcknowledgement() {
    return this.control.recoverAcknowledgement();
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
