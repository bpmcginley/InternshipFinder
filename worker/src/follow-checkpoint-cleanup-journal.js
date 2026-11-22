import { classifyFollowCheckpointWitness as classify } from "./follow-checkpoint-witness.js";

const ID = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const ETAG = /^[A-Za-z0-9_-]{1,128}$/;
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const position = ({ epoch, revision, token }) => ({ epoch, revision, token });

function fields(value, keys) {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length)
    return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !Object.hasOwn(property, "value")) return null;
    result[key] = property.value;
  }
  return result;
}

const receipt = ({ previous, nonce, next }) => ({ current: next, receipt: { previous, nonce } });

export const cleanupMatchesWitness = (witness, journal) =>
  classify(witness, receipt(journal.transition)) === "recover_ack";

export function canonicalCleanupJournal(value) {
  const journal = fields(value, [
    "version",
    "kind",
    "transition",
    "beforeHash",
    "reservation",
    "cutoff",
    "sourceEtag",
    "planned",
    "forwarded",
  ]);
  if (journal?.version !== 1 || journal.kind !== "expired-reservation") return null;
  const transition = fields(journal.transition, ["previous", "nonce", "next"]);
  const reservation = fields(journal.reservation, [
    "slot",
    "nonce",
    "payloadSha",
    "digest",
    "starts",
    "expires",
    "cutoff",
  ]);
  const planned = fields(journal.planned, ["kind", "nonce", "sha256", "bytes"]);
  if (
    !transition ||
    !reservation ||
    !planned ||
    !matches(journal.beforeHash, SHA) ||
    !matches(journal.sourceEtag, ETAG) ||
    typeof journal.forwarded !== "boolean" ||
    (reservation.slot !== 0 && reservation.slot !== 1) ||
    Object.is(reservation.slot, -0) ||
    !matches(reservation.nonce, ID) ||
    !matches(reservation.payloadSha, SHA) ||
    !matches(reservation.digest, SHA) ||
    ![reservation.starts, reservation.expires, reservation.cutoff].every(time) ||
    reservation.cutoff <= reservation.starts ||
    reservation.cutoff > reservation.expires ||
    journal.cutoff !== reservation.cutoff ||
    planned.kind !== "tombstone" ||
    !matches(planned.nonce, ID) ||
    planned.nonce === reservation.nonce ||
    planned.sha256 !== EMPTY_SHA ||
    planned.bytes !== 0 ||
    Object.is(planned.bytes, -0) ||
    !cleanupMatchesWitness(
      {
        version: 1,
        phase: "prepared",
        current: transition.previous,
        intent: { nonce: transition.nonce, next: transition.next },
      },
      { transition },
    )
  )
    return null;
  return {
    ...journal,
    transition: {
      previous: position(transition.previous),
      nonce: transition.nonce,
      next: position(transition.next),
    },
    reservation,
    planned,
  };
}

// The caller independently verifies the current slot evidence before requesting a new plan.
export function canBindCleanup(previous, next) {
  if (previous === null) return !next.forwarded;
  const {
    sourceEtag: priorEtag,
    planned: priorPlan,
    forwarded: wasForwarded,
    ...before
  } = previous;
  const { sourceEtag, planned, forwarded, ...after } = next;
  if (!equal(before, after)) return false;
  if (forwarded) return !wasForwarded && priorEtag === sourceEtag && equal(priorPlan, planned);
  return priorPlan.nonce !== planned.nonce && (!wasForwarded || priorEtag !== sourceEtag);
}
