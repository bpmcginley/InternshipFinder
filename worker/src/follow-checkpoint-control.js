// Dormant metadata authority. Initialization and provider selection are external release gates.
import { classifyFollowCheckpointWitness as classify } from "./follow-checkpoint-witness.js";

const copy = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const position = (state) => ({ current: state.current, receipt: state.receipt });
const id = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");

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
    const before = this.state(),
      witness = this.witness();
    if (!before || !witness) return null;
    try {
      if (
        classify(await witness.read(), position(before)) !== "current" ||
        !equal(before, this.state())
      )
        return null;
      return before;
    } catch {
      return null;
    }
  }
  // Trusted synchronous action is evaluated twice. External effects never run inside SQLite.
  async change(action, effect = null) {
    const before = await this.admitted();
    if (!before || before.current.revision === Number.MAX_SAFE_INTEGER) return "held";
    if (action(copy(before), this.now()) !== true) return "stale";
    const witness = this.witness();
    const intent = {
      nonce: id(),
      next: {
        epoch: before.current.epoch,
        revision: before.current.revision + 1,
        token: id(),
      },
    };
    try {
      if (!(await witness.prepare(before.current, intent))) return "held";
      if (effect && !(await effect(before, intent))) return "held";
      if (this.beforeCommit) await this.beforeCommit();
      const committed = this.storage.transactionSync(() => {
        const state = this.state();
        if (!equal(state, before) || action(state, this.now()) !== true) return false;
        state.current = intent.next;
        state.receipt = { nonce: intent.nonce, previous: before.current };
        this.#save(state);
        return true;
      });
      if (!committed) return "held"; // A prepared predecessor cannot be automatically aborted.
      if (!(await witness.finish(position(this.state())))) return "held";
      return (await this.admitted()) ? "committed" : "held";
    } catch {
      return "held";
    }
  }
  async recoverAcknowledgement() {
    const state = this.state(),
      witness = this.witness();
    if (!state || !witness) return "held";
    try {
      if (
        classify(await witness.read(), position(state)) !== "recover_ack" ||
        !equal(state, this.state())
      )
        return "held";
      if (!(await witness.finish(position(state)))) return "held";
      return (await this.admitted()) ? "recovered" : "held";
    } catch {
      return "held";
    }
  }
}
