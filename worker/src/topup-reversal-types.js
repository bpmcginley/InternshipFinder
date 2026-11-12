// Shared existing reversal families. No new event semantics.
const eventObjects = new Map([
  ...["refund.created", "refund.updated", "refund.failed", "charge.refund.updated"].map((t) => [
    t,
    "refund",
  ]),
  ["charge.refunded", "charge"],
  ...["created", "updated", "closed", "funds_withdrawn", "funds_reinstated"].map((t) => [
    "charge.dispute." + t,
    "dispute",
  ]),
]);
export const topupReversalObject = (type) => eventObjects.get(type);
