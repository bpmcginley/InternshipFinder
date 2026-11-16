import test from "node:test";
import assert from "node:assert/strict";
import { decideTopup } from "../src/topup-decisions.js";

const prior = (patch = {}) => ({
  deleted: false,
  fullRefund: false,
  loss: false,
  held: false,
  heldDisputeIds: patch.held ? ["dispute-a"] : [],
  ...patch,
});
const snapshot = (patch = {}) => ({
  capturedAmount: 325,
  currency: "usd",
  refundsComplete: true,
  disputesComplete: true,
  refunds: [],
  disputes: [],
  previous: prior(),
  ...patch,
});
const refund = (status, amount = 325, id = "refund-a") => ({ id, status, amount, currency: "usd" });
const dispute = (status, amount = 100, id = "dispute-a") => ({
  id,
  status,
  amount,
  currency: "usd",
});
const disposition = (patch) => decideTopup(snapshot(patch)).disposition;

test("top-up successful refunds count distinct IDs and the full captured amount including tax", () => {
  assert.equal(disposition({ refunds: [refund("succeeded", 300)] }), "available");
  assert.equal(
    disposition({ refunds: [refund("succeeded", 300), refund("succeeded", 300)] }),
    "available",
  );
  const complete = [refund("succeeded", 300), refund("succeeded", 25, "refund-b")];
  assert.equal(disposition({ refunds: complete }), "revoked");
  assert.equal(disposition({ refunds: [...complete, ...complete].reverse() }), "revoked");
  assert.equal(decideTopup(snapshot({ refunds: complete })).fullRefundSeen, true);
  for (const status of ["pending", "requires_action", "failed", "canceled"]) {
    assert.equal(disposition({ refunds: [refund(status)] }), "available");
    assert.equal(
      disposition({ refunds: [refund("succeeded", 300), refund(status, 25, "refund-b")] }),
      "available",
    );
  }
});

test("top-up pending refund progression uses current state, not previous event versions", () => {
  for (const status of ["pending", "failed", "canceled", "requires_action", "succeeded"]) {
    assert.equal(
      disposition({ refunds: [refund(status)] }),
      status === "succeeded" ? "revoked" : "available",
    );
  }
  assert.equal(disposition({ refunds: [refund("pending"), refund("succeeded")] }), "retry");
  assert.equal(
    disposition({ refunds: [refund("succeeded", 200), refund("succeeded", 200, "refund-b")] }),
    "retry",
  );
});

test("top-up formal disputes hold the purchase at amounts below, at or above capture", () => {
  for (const status of [
    "needs_response",
    "under_review",
    "appeal_needs_response",
    "appeal_under_review",
  ]) {
    for (const amount of [1, 100, 325, 326])
      assert.equal(disposition({ disputes: [dispute(status, amount)] }), "held");
  }
  for (const status of ["warning_needs_response", "warning_under_review"]) {
    assert.equal(disposition({ disputes: [dispute(status)] }), "available");
    assert.equal(
      disposition({ previous: prior({ held: true }), disputes: [dispute(status)] }),
      "retry",
    );
  }
});

test("top-up verified favorable outcomes release a hold only without another blocker", () => {
  for (const status of ["won", "warning_closed", "prevented"]) {
    const good = dispute(status);
    assert.equal(
      disposition({ previous: prior({ held: true }), disputes: [good, good] }),
      "available",
    );
    assert.equal(
      disposition({
        previous: prior({ held: true }),
        disputes: [good, dispute("under_review", 1, "other")],
      }),
      "held",
    );
    assert.equal(
      disposition({
        previous: prior({ held: true }),
        disputes: [good, dispute("lost", 1, "other")],
      }),
      "revoked",
    );
    assert.equal(
      disposition({
        previous: prior({ held: true }),
        disputes: [good],
        refunds: [refund("succeeded")],
      }),
      "revoked",
    );
    assert.equal(
      disposition({ previous: prior({ held: true, deleted: true }), disputes: [good] }),
      "revoked",
    );
  }
  assert.equal(disposition({ previous: prior({ held: true }) }), "retry");
});

test("top-up loss is sticky across appeals and favorable outcomes; manual restoration is required", () => {
  const lost = decideTopup(
    snapshot({ disputes: [dispute("lost"), dispute("under_review", 1, "other")] }),
  );
  assert.equal(lost.disposition, "revoked");
  assert.equal(lost.lossSeen, true);
  for (const status of [
    "appeal_needs_response",
    "appeal_under_review",
    "won",
    "warning_closed",
    "prevented",
  ]) {
    const after = decideTopup(
      snapshot({ previous: prior({ loss: true }), disputes: [dispute(status)] }),
    );
    assert.equal(after.disposition, "revoked");
    assert.equal(after.manualReview, true);
  }
  assert.equal(
    disposition({ previous: prior({ fullRefund: true }), disputes: [dispute("won")] }),
    "revoked",
  );
});

test("top-up every governing hold must resolve; unrelated wins cannot release or replace it", () => {
  const previous = prior({ held: true });
  for (const status of ["won", "under_review"]) {
    const other = dispute(status, 100, "other");
    assert.equal(disposition({ previous, disputes: [other] }), "retry");
    assert.equal(
      disposition({ previous, disputes: [dispute("warning_under_review"), other] }),
      "retry",
    );
  }
  const both = prior({ held: true, heldDisputeIds: ["dispute-a", "other"] });
  const state = snapshot({
    previous: both,
    disputes: [dispute("won"), dispute("under_review", 100, "other")],
  });
  const decision = decideTopup(state);
  assert.equal(decision.disposition, "held");
  assert.deepEqual(decision.heldDisputeIds, ["other"]);
  assert.deepEqual(decideTopup({ ...state, disputes: state.disputes.toReversed() }), decision);
  assert.equal(disposition({ previous: both, disputes: [dispute("won")] }), "retry");
  assert.equal(
    disposition({ previous: both, disputes: [dispute("won"), dispute("prevented", 100, "other")] }),
    "available",
  );
  for (const heldDisputeIds of [[], null, [null]])
    assert.equal(disposition({ previous: prior({ held: true, heldDisputeIds }) }), "retry");
});

test("top-up durable terminal facts survive incomplete provider reads and precedence is stable", () => {
  const refundedAfterLoss = decideTopup(
    snapshot({ previous: prior({ loss: true }), refunds: [refund("succeeded")] }),
  );
  assert.equal(refundedAfterLoss.reason, "full_refund");
  assert.equal(refundedAfterLoss.lossSeen, true);
  assert.equal(refundedAfterLoss.fullRefundSeen, true);
  for (const previous of [
    prior({ deleted: true }),
    prior({ fullRefund: true }),
    prior({ loss: true }),
  ]) {
    assert.equal(
      disposition({ previous, refundsComplete: false, disputesComplete: false }),
      "revoked",
    );
  }
  assert.equal(
    decideTopup(snapshot({ previous: prior({ deleted: true, fullRefund: true, loss: true }) }))
      .reason,
    "deleted",
  );
  assert.equal(
    decideTopup(snapshot({ refunds: [refund("succeeded")], disputes: [dispute("lost")] })).reason,
    "full_refund",
  );
});

test("top-up unknown, incomplete or inconsistent snapshots cannot release or authorize a grant", () => {
  const cases = [
    { refundsComplete: false },
    { disputesComplete: false },
    { refundsComplete: "true" },
    { refunds: null },
    { disputes: null },
    { capturedAmount: 0 },
    { capturedAmount: 3.25 },
    { capturedAmount: Number.MAX_SAFE_INTEGER + 1 },
    { currency: "USD" },
    { refunds: [refund("unknown")] },
    { disputes: [dispute("closed")] },
    { refunds: [{ ...refund("succeeded"), currency: "cad" }] },
    { disputes: [{ ...dispute("won"), currency: "cad" }] },
    { refunds: [refund("succeeded", 326)] },
    { disputes: [dispute("won", 0)] },
    { refunds: [{ ...refund("succeeded"), id: "" }] },
    { disputes: [null] },
    { refunds: [refund("succeeded", 100), refund("succeeded", 101)] },
    { disputes: [dispute("won"), dispute("under_review")] },
  ];
  for (const patch of cases) {
    for (const held of [false, true]) {
      const result = decideTopup(snapshot({ previous: prior({ held }), ...patch }));
      assert.equal(result.disposition, "retry");
      assert.deepEqual(Object.keys(result).sort(), ["disposition", "reason"]);
    }
  }
  for (const previous of [null, {}, prior({ loss: "false" })])
    assert.equal(disposition({ previous }), "retry");
  assert.equal(decideTopup(null).disposition, "retry");
});

test("top-up refund sum cannot overflow a safe integer", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(
    disposition({
      capturedAmount: max,
      refunds: [refund("succeeded", max - 1), refund("succeeded", 1, "other")],
    }),
    "revoked",
  );
  assert.equal(
    disposition({
      capturedAmount: max,
      refunds: [refund("succeeded", max), refund("succeeded", 1, "other")],
    }),
    "retry",
  );
});

test("top-up decision is pure and independent of record order", () => {
  const value = snapshot({
    previous: prior({ held: true }),
    refunds: [refund("succeeded", 100), refund("pending", 200, "other")],
    disputes: [dispute("won"), dispute("warning_closed", 25, "other")],
  });
  const before = structuredClone(value);
  for (const list of [value.refunds, value.disputes]) {
    list.forEach(Object.freeze);
    Object.freeze(list);
  }
  Object.freeze(value.previous);
  Object.freeze(value);
  const expected = decideTopup(value);
  assert.deepEqual(
    decideTopup(
      snapshot({
        ...before,
        refunds: before.refunds.toReversed(),
        disputes: before.disputes.toReversed(),
      }),
    ),
    expected,
  );
  assert.deepEqual(value, before);
  assert.equal(expected.disposition, "available");
});
