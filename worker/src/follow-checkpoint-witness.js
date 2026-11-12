const OPAQUE_ID = /^[a-f0-9]{32}$/;
const ZERO_ID = "0".repeat(32);

function fields(value, keys) {
  if (!value || typeof value !== "object") return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const record = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !Object.hasOwn(property, "value")) return null;
    record[key] = property.value;
  }
  return record;
}

function opaqueId(value) {
  return typeof value === "string" && OPAQUE_ID.test(value) && value !== ZERO_ID;
}

function position(value) {
  const record = fields(value, ["epoch", "revision", "token"]);
  return record && opaqueId(record.epoch) && opaqueId(record.token) &&
    record.epoch !== record.token && Number.isSafeInteger(record.revision) &&
    record.revision >= 0 && !Object.is(record.revision, -0) ? record : null;
}

function samePosition(a, b) {
  return a.epoch === b.epoch && a.revision === b.revision && a.token === b.token;
}

function successor(previous, next, nonce) {
  return opaqueId(nonce) && previous.epoch === next.epoch &&
    next.revision === previous.revision + 1 && next.token !== previous.token &&
    nonce !== previous.epoch && nonce !== previous.token && nonce !== next.token;
}

function readWitness(value) {
  const record = fields(value, ["version", "phase", "current", "intent"]);
  if (record?.version !== 1) return null;
  const current = position(record.current);
  if (!current) return null;
  if (record.phase === "stable" || record.phase === "closed")
    return record.intent === null ? { phase: record.phase, current } : null;
  if (record.phase !== "prepared") return null;
  const intent = fields(record.intent, ["nonce", "next"]);
  const next = position(intent?.next);
  return next && successor(current, next, intent.nonce)
    ? { phase: "prepared", current, next, nonce: intent.nonce }
    : null;
}

function readControl(value) {
  const record = fields(value, ["current", "receipt"]);
  const current = position(record?.current);
  if (!current) return null;
  if (record.receipt === null) return { current, receipt: null };
  const receipt = fields(record.receipt, ["nonce", "previous"]);
  const previous = position(receipt?.previous);
  return previous && successor(previous, current, receipt.nonce)
    ? { current, receipt: { previous, nonce: receipt.nonce } }
    : null;
}

/** Offline classification of one external witness read and one control snapshot. */
export function classifyFollowCheckpointWitness(witness, control) {
  try {
    const external = readWitness(witness);
    if (!external) return "unavailable";
    if (external.phase === "closed") return "closed";
    const local = readControl(control);
    if (!local) return "unavailable";
    if (external.phase === "stable") {
      if (samePosition(local.current, external.current)) return "current";
      return local.current.epoch === external.current.epoch &&
        local.current.revision < external.current.revision ? "rollback" : "mismatch";
    }
    if (samePosition(local.current, external.current)) return "ambiguous_predecessor";
    if (samePosition(local.current, external.next) &&
      local.receipt?.nonce === external.nonce &&
      samePosition(local.receipt.previous, external.current))
      return "recover_ack";
    return "mismatch";
  } catch {
    return "unavailable";
  }
}
