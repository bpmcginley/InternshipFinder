// Dormant metadata authority. Initialization and provider selection are external release gates.
import { classifyFollowCheckpointWitness as classify } from "./follow-checkpoint-witness.js";
import {
  canonicalCleanupJournal,
  cleanupMatchesWitness,
} from "./follow-checkpoint-cleanup-journal.js";

const copy = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const position = (state) => ({ current: state.current, receipt: state.receipt });
function synchronousTrue(result) {
  if (result === true) return true;
  // Never await or accept async predicates, but consume their possible rejection.
  void Promise.prototype.then.call(Promise.resolve(result), undefined, () => {});
  return false;
}
const id = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");

export async function fingerprintFollowCheckpointControl(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}

export class FollowCheckpointControl {
  constructor(storage, { witness, beforeCommit = null }) {
    if (
      typeof storage?.sql?.exec !== "function" ||
      typeof storage?.transactionSync !== "function" ||
      typeof witness !== "function" ||
      (beforeCommit !== null && typeof beforeCommit !== "function")
    )
      throw new TypeError("Invalid checkpoint control dependencies");
    this.storage = storage;
    this.witness = witness;
    this.beforeCommit = beforeCommit;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL)",
    );
  }
  now() {
    const now = this.storage.sql
      .exec("SELECT CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER) AS now")
      .one().now;
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Checkpoint clock unavailable");
    return now;
  }
  snapshot() {
    return this.storage.sql.exec("SELECT metadata FROM control WHERE id=1").toArray()[0]?.metadata;
  }
  capture() {
    return this.storage.transactionSync(() => ({ raw: this.snapshot(), now: this.now() }));
  }
  state() {
    const raw = this.snapshot();
    return raw ? JSON.parse(raw) : null;
  }
  #save(state) {
    this.storage.sql.exec("INSERT OR REPLACE INTO control VALUES(1,?)", JSON.stringify(state));
  }
  async admitted() {
    try {
      return await this.#admitted(this.witness());
    } catch {
      return null;
    }
  }
  async #admitted(witness) {
    try {
      const before = this.state();
      if (
        !before ||
        !witness ||
        classify(await witness.read(), position(before)) !== "current" ||
        !equal(before, this.state())
      )
        return null;
      return before;
    } catch {
      return null;
    }
  }
  // Trusted synchronous action is evaluated twice. External ports receive isolated copies.
  async change(action, effect = null) {
    try {
      if (typeof action !== "function" || (effect !== null && typeof effect !== "function"))
        return "held";
      const witness = this.witness(),
        before = await this.#admitted(witness);
      if (!before || before.current.revision === Number.MAX_SAFE_INTEGER) return "held";
      if (!synchronousTrue(action(copy(before), this.now()))) return "stale";
      const intent = {
        nonce: id(),
        next: {
          epoch: before.current.epoch,
          revision: before.current.revision + 1,
          token: id(),
        },
      };
      if ((await witness.prepare(copy(before.current), copy(intent))) !== true) return "held";
      if (effect && (await effect(copy(before), copy(intent))) !== true) return "held";
      if (this.beforeCommit) await this.beforeCommit();
      const committed = this.storage.transactionSync(() => {
        const state = this.state();
        if (!equal(state, before) || !synchronousTrue(action(state, this.now()))) return false;
        state.current = intent.next;
        state.receipt = { nonce: intent.nonce, previous: before.current };
        this.#save(state);
        return true;
      });
      if (!committed) return "held"; // A prepared predecessor cannot be automatically aborted.
      if ((await witness.finish(copy(position(this.state())))) !== true) return "held";
      return (await this.#admitted(witness)) ? "committed" : "held";
    } catch {
      return "held";
    }
  }
  // The reservation engine has verified the exact committed tombstone before calling this.
  async commitExpiredReservationCleanup(expected, observedWitness, observedJournal) {
    try {
      const before = copy(expected),
        external = copy(observedWitness),
        journal = canonicalCleanupJournal(observedJournal),
        witness = this.witness();
      if (
        !before?.reservation ||
        !journal?.forwarded ||
        classify(external, position(before)) !== "ambiguous_predecessor" ||
        !cleanupMatchesWitness(external, journal) ||
        !Object.entries(journal.reservation).every(
          ([key, value]) => before.reservation[key] === value,
        ) ||
        journal.beforeHash !== (await fingerprintFollowCheckpointControl(before)) ||
        !equal(before, this.state()) ||
        !equal(await witness?.read(), external) ||
        !equal(await witness?.readCleanup?.(), journal)
      )
        return "held";
      const committed = this.storage.transactionSync(() => {
        const state = this.state();
        if (!equal(state, before) || this.now() < journal.cutoff) return false;
        const { next, nonce, previous } = journal.transition;
        state.reservation = null;
        state.current = next;
        state.receipt = { nonce, previous };
        this.#save(state);
        return true;
      });
      return committed ? await this.recoverAcknowledgement() : "held";
    } catch {
      return "held";
    }
  }
  async recoverAcknowledgement() {
    try {
      const state = this.state(),
        witness = this.witness();
      if (
        !state ||
        !witness ||
        classify(await witness.read(), position(state)) !== "recover_ack" ||
        !equal(state, this.state())
      )
        return "held";
      if ((await witness.finish(copy(position(state)))) !== true) return "held";
      return (await this.#admitted(witness)) ? "recovered" : "held";
    } catch {
      return "held";
    }
  }
}
