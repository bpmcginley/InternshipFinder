import assert from "node:assert/strict";
import { classifyFollowCheckpointWitness as classify } from "../src/follow-checkpoint-witness.js";

const id = (character) => character.repeat(32);
const previous = { epoch: id("a"), revision: 7, token: id("b") };
const next = { epoch: previous.epoch, revision: 8, token: id("c") };
const intent = { nonce: id("d"), next };
const receipt = { nonce: intent.nonce, previous };
const state = (current, receipt = null) => ({ current, receipt });
const witness = (phase, current, intent = null) => ({ version: 1, phase, current, intent });
const stable = witness("stable", previous);
const prepared = witness("prepared", previous, intent);

export function stableRequiresExactCurrentControl() {
  assert.equal(classify(stable, state({ ...previous })), "current");
  assert.equal(classify(witness("stable", next), state(next, receipt)), "current");
  assert.equal(classify(stable, state(next, receipt)), "mismatch");
  assert.equal(classify(stable, state({ ...previous, token: id("e") })), "mismatch");
  assert.equal(classify(stable, state({ ...previous, epoch: id("e"), revision: 6 })), "mismatch");
}

export function preparedReceiptCanRecoverOnlyTheExactAcknowledgement() {
  assert.equal(classify(prepared, state(next, receipt)), "recover_ack");
  assert.equal(classify(prepared, state(next)), "mismatch");
  assert.equal(classify(prepared, state(next, { ...receipt, nonce: id("e") })), "mismatch");
  assert.equal(
    classify(prepared, state(next, { ...receipt, previous: { ...previous, token: id("e") } })),
    "mismatch",
  );
  const wrongNext = { ...next, token: id("f") };
  assert.equal(classify(prepared, state(wrongNext, receipt)), "mismatch");
}

export function preparedPredecessorRemainsAmbiguous() {
  assert.equal(classify(prepared, state(previous)), "ambiguous_predecessor");
  const earlier = { ...previous, revision: 6, token: id("e") };
  assert.equal(
    classify(prepared, state(previous, { nonce: id("f"), previous: earlier })),
    "ambiguous_predecessor",
  );
}

export function closedAndMissingEvidenceHoldWithoutReadingControl() {
  let inspected = false;
  const unreadable = new Proxy({}, {
    getPrototypeOf() {
      inspected = true;
      throw new Error("synthetic unavailable control");
    },
  });
  assert.equal(classify(witness("closed", previous), unreadable), "closed");
  assert.equal(classify(null, unreadable), "unavailable");
  assert.equal(inspected, false);
  assert.equal(classify(stable, undefined), "unavailable");
  assert.equal(classify(stable, unreadable), "unavailable");
  assert.equal(inspected, true);
}

export function simulatedPromotionRollbackKeepsIdenticalSlotEtags() {
  const slots = { first: "synthetic-etag-a", second: "synthetic-etag-b" };
  const before = { control: state(previous), slots: { ...slots } };
  const promoted = { control: state(next, receipt), slots: { ...slots } };
  const after = witness("stable", next);
  assert.equal(classify(prepared, before.control), "ambiguous_predecessor");
  assert.equal(classify(prepared, promoted.control), "recover_ack");
  assert.equal(classify(after, promoted.control), "current");
  assert.deepEqual(before.slots, promoted.slots);
  assert.equal(classify(after, before.control), "rollback");
  assert.equal(classify(after, state({ ...previous, revision: 0 })), "rollback");
}

export function malformedAndExtraFieldsFailClosed() {
  const hidden = { ...stable };
  Object.defineProperty(hidden, "ignored", { value: true });
  const symbol = { ...stable, [Symbol("extra")]: true };
  const inherited = Object.create(stable);
  let getterCalled = false;
  const accessor = { ...stable };
  Object.defineProperty(accessor, "current", {
    enumerable: true,
    get() { getterCalled = true; return previous; },
  });
  for (const malformed of [
    [],
    {},
    hidden,
    symbol,
    inherited,
    accessor,
    { ...stable, version: 2 },
    { ...stable, phase: "unknown" },
    { ...stable, intent },
    { ...stable, current: { ...previous, token: "e".repeat(40) } },
    { ...stable, current: { ...previous, token: "E".repeat(32) } },
    { ...stable, current: { ...previous, token: "0".repeat(32) } },
    { ...stable, current: { ...previous, token: previous.epoch } },
    { ...stable, current: { ...previous, revision: "7" } },
    { ...stable, current: { ...previous, revision: -0 } },
    { ...stable, current: { ...previous, revision: 1.5 } },
    { ...stable, current: { ...previous, revision: Number.MAX_SAFE_INTEGER + 1 } },
    { ...stable, current: { ...previous, candidate_commit: "fixture" } },
    { ...stable, rows: [] },
  ]) assert.equal(classify(malformed, state(previous)), "unavailable");
  assert.equal(getterCalled, false);
  assert.equal(classify(stable, { ...state(previous), payload: [] }), "unavailable");
  assert.equal(classify(stable, state(previous, { ...receipt, extra: true })), "unavailable");
  assert.equal(classify(stable, state(previous, receipt)), "unavailable");
}

export function invalidPreparedSuccessorsCannotBeRecovered() {
  for (const value of [
    { nonce: next.token, next },
    { nonce: previous.epoch, next },
    { nonce: previous.token, next },
    { nonce: intent.nonce, next: { ...next, epoch: id("f") } },
    { nonce: intent.nonce, next: { ...next, token: previous.token } },
    { nonce: intent.nonce, next: { ...next, revision: previous.revision } },
    { nonce: intent.nonce, next: { ...next, revision: next.revision + 1 } },
    { nonce: intent.nonce, next: { ...next, rows: [] } },
  ]) assert.equal(classify(witness("prepared", previous, value), state(next, receipt)), "unavailable");
}
