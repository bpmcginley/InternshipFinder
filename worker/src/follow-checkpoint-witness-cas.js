// Dormant adapter for one externally versioned, strongly consistent metadata record.
import { classifyFollowCheckpointWitness as classify } from "./follow-checkpoint-witness.js";

const MAX_CHARS = 512;
const TAG = /^[A-Za-z0-9_-]{1,128}$/;
const position = ({ epoch, revision, token }) => ({ epoch, revision, token });
const stable = (current) => ({ version: 1, phase: "stable", current, intent: null });

function canonical(value) {
  return JSON.stringify({
    version: 1,
    phase: value.phase,
    current: position(value.current),
    intent:
      value.intent === null
        ? null
        : { nonce: value.intent.nonce, next: position(value.intent.next) },
  });
}

// readRecord returns {tag,text}. A successful CAS replaces exactly that version once.
// The tag must never be reused. Reads and CAS must be linearizable across process restarts.
export function createFollowCheckpointWitnessCas({ readRecord, compareAndSwap }) {
  if (typeof readRecord !== "function" || typeof compareAndSwap !== "function")
    throw new TypeError("Invalid checkpoint witness dependencies");

  async function load() {
    const row = await readRecord();
    if (!row || Reflect.ownKeys(row).length !== 2) return null;
    const tag = Object.getOwnPropertyDescriptor(row, "tag");
    const text = Object.getOwnPropertyDescriptor(row, "text");
    if (
      !tag?.enumerable ||
      !text?.enumerable ||
      typeof tag.value !== "string" ||
      !TAG.test(tag.value) ||
      typeof text.value !== "string" ||
      text.value.length > MAX_CHARS
    )
      return null;
    const value = JSON.parse(text.value);
    const status = classify(value, { current: value?.current, receipt: null });
    if (
      !["current", "ambiguous_predecessor", "closed"].includes(status) ||
      text.value !== canonical(value)
    )
      return null;
    return { tag: tag.value, text: text.value, value };
  }

  async function replace({ tag }, text) {
    if ((await compareAndSwap(tag, text)) !== true) return false;
    const result = await load();
    return Boolean(result && result.tag !== tag && result.text === text);
  }

  async function read() {
    try {
      return (await load())?.value ?? null;
    } catch {
      return null;
    }
  }

  async function prepare(previous, intent) {
    try {
      const proposed = { version: 1, phase: "prepared", current: previous, intent };
      if (classify(proposed, { current: previous, receipt: null }) !== "ambiguous_predecessor")
        return false;
      const text = canonical(proposed);
      const before = { current: position(previous), receipt: null };
      const current = await load();
      if (classify(current?.value, before) !== "current") return false;
      return await replace(current, text);
    } catch {
      return false;
    }
  }

  async function finish(control) {
    try {
      const next = stable(Object.getOwnPropertyDescriptor(control, "current")?.value);
      if (classify(next, control) !== "current" || !control.receipt) return false;
      const text = canonical(next);
      const proof = {
        current: position(control.current),
        receipt: { nonce: control.receipt.nonce, previous: position(control.receipt.previous) },
      };
      const current = await load();
      if (classify(current?.value, proof) !== "recover_ack") return false;
      return await replace(current, text);
    } catch {
      return false;
    }
  }

  return { read, prepare, finish };
}
