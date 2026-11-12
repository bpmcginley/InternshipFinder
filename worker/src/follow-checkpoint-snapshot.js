// Dormant paired read only. The caller supplies one synchronous SQLite snapshot/time capture
// and independently qualified witness/slot transports. No provider or initialization fallback.
import { classifyFollowCheckpointWitness as classify } from "./follow-checkpoint-witness.js";

const DAY = 86_400_000;
const encoder = new TextEncoder();
const unavailable = () => ({ state: "unavailable" });
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const sha = /^[a-f0-9]{64}$/;
const nonce = /^[a-f0-9]{32}$/;
const etag = /^[A-Za-z0-9_-]{1,128}$/;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const fields = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const canonical = (value) =>
  JSON.stringify(value, (_, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((k) => [k, entry[k]]),
        )
      : entry,
  );
const live = (record, now) => record && record.starts <= now && now < record.expires;

function record(value, phase, maxHeaderBytes) {
  if (value === null) return null;
  const replay = phase === "accepted" && Object.hasOwn(value, "generation");
  const keys = ["slot", "header", "digest", "payloadSha", "starts", "expires", "nonce", "etag"];
  if (replay) keys.push("generation", "replayUntil");
  if (Object.hasOwn(value, "promotionKey")) {
    if (!replay || !matches(sha, value.promotionKey)) throw new Error();
    keys.push("promotionKey");
  }
  if (
    !fields(value, keys) ||
    ![0, 1].includes(value.slot) ||
    !matches(sha, value.digest) ||
    !matches(sha, value.payloadSha) ||
    !matches(nonce, value.nonce) ||
    !matches(etag, value.etag) ||
    typeof value.header !== "string" ||
    value.header.length > maxHeaderBytes ||
    encoder.encode(value.header).length > maxHeaderBytes
  )
    throw new Error();
  const header = JSON.parse(value.header);
  const names =
    phase === "pending"
      ? ["predecessor", "candidate_commit", "candidate_tree", "public_tree", "prepared_at"]
      : ["accepted_commit", "public_tree", "accepted_at"];
  if (!fields(header, names) || canonical(header) !== value.header) throw new Error();
  const stamp = header[phase === "pending" ? "prepared_at" : "accepted_at"];
  if (!matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/, stamp) || stamp.startsWith("0000"))
    throw new Error();
  const aligned = stamp.slice(0, -4) + "Z",
    floor = Date.parse(aligned);
  if (
    !integer(floor) ||
    new Date(floor).toISOString() !== aligned ||
    value.starts !== floor + (stamp.slice(-4, -1) === "000" ? 0 : 1) ||
    value.expires !== floor + (phase === "pending" ? DAY : 7 * DAY)
  )
    throw new Error();
  const ids =
    phase === "pending"
      ? [header.candidate_commit, header.candidate_tree, header.public_tree]
      : [header.accepted_commit, header.public_tree];
  if (phase === "pending") {
    const prior = header.predecessor;
    if (
      !fields(prior, ["commit", "public_tree", "checkpoint_sha256"]) ||
      (prior.checkpoint_sha256 !== null && !matches(sha, prior.checkpoint_sha256))
    )
      throw new Error();
    ids.push(prior.commit, prior.public_tree);
  }
  if (
    ids.some(
      (id) => !matches(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, id) || id.length !== ids[0].length,
    ) ||
    (replay &&
      (!matches(sha, value.generation) ||
        !integer(value.replayUntil) ||
        value.replayUntil <= value.starts ||
        value.replayUntil > value.expires))
  )
    throw new Error();
  return { ...value, parsed: header };
}

export function createFollowCheckpointSnapshotReader({
  capture,
  readWitness,
  slots,
  codec,
  maxBytes,
  maxHeaderBytes,
  maxControlBytes,
}) {
  if (
    typeof capture !== "function" ||
    typeof readWitness !== "function" ||
    typeof slots?.read !== "function" ||
    typeof codec?.reassemble !== "function" ||
    [maxBytes, maxHeaderBytes, maxControlBytes].some((n) => !integer(n) || !n) ||
    maxBytes > 8_000_000 ||
    maxControlBytes > 64 * 1024 ||
    maxHeaderBytes > maxControlBytes
  )
    throw new TypeError("Invalid checkpoint snapshot dependencies");
  return async function read(limit) {
    try {
      if (!integer(limit) || !limit || limit > maxBytes) return unavailable();
      const before = capture();
      if (
        !integer(before?.now) ||
        typeof before.raw !== "string" ||
        before.raw.length > maxControlBytes ||
        encoder.encode(before.raw).length > maxControlBytes
      )
        return unavailable();
      const state = JSON.parse(before.raw);
      if (
        !fields(state, [
          "current",
          "receipt",
          "initialized",
          "pending",
          "accepted",
          "reservation",
          "retired",
        ]) ||
        typeof state.initialized !== "boolean" ||
        state.reservation !== null
      )
        return unavailable();
      const control = { current: state.current, receipt: state.receipt };
      if (classify(await readWitness(), control) !== "current") return unavailable();
      const accepted = record(state.accepted, "accepted", maxHeaderBytes);
      const pending = record(state.pending, "pending", maxHeaderBytes);
      if (accepted && !state.initialized) return unavailable();
      if (pending) {
        const prior = pending.parsed.predecessor;
        if (
          accepted
            ? pending.slot === accepted.slot ||
              pending.nonce === accepted.nonce ||
              prior.commit !== accepted.parsed.accepted_commit ||
              prior.public_tree !== accepted.parsed.public_tree ||
              prior.checkpoint_sha256 !== accepted.digest
            : state.initialized
              ? prior.checkpoint_sha256 === null
              : prior.checkpoint_sha256 !== null
        )
          return unavailable();
      }
      if (state.retired !== null) {
        const r = state.retired;
        if (
          !fields(r, ["slot", "etag", "nonce", "expires"]) ||
          ![0, 1].includes(r.slot) ||
          !matches(etag, r.etag) ||
          !matches(nonce, r.nonce) ||
          !integer(r.expires) ||
          [accepted, pending].some((v) => v && v.slot === r.slot)
        )
          return unavailable();
      }
      const result = {
        state:
          accepted && live(accepted, before.now)
            ? "active"
            : state.initialized
              ? "expired"
              : "never_seeded",
      };
      const active = [];
      for (const [phase, value] of [
        ["accepted", accepted],
        ["pending", pending],
      ]) {
        if (!value) continue;
        if (before.now < value.starts) return unavailable();
        if (!live(value, before.now)) continue;
        const object = await slots.read(value.slot);
        if (
          object?.status !== "present" ||
          object.kind !== "payload" ||
          object.etag !== value.etag ||
          object.nonce !== value.nonce ||
          object.sha256 !== value.payloadSha
        )
          return unavailable();
        const decoded = await codec.reassemble(
          object.payload,
          encoder.encode(value.header),
          phase,
          value.digest,
        );
        if (
          !(decoded?.bytes instanceof Uint8Array) ||
          !decoded.bytes.length ||
          decoded.bytes.length > limit
        )
          return unavailable();
        result[phase] = new Uint8Array(decoded.bytes).buffer;
        active.push(value);
      }
      if (classify(await readWitness(), control) !== "current") return unavailable();
      // This synchronous caller transaction is the release point. No await follows it.
      const final = capture();
      if (
        final?.raw !== before.raw ||
        !integer(final.now) ||
        final.now < before.now ||
        active.some((value) => !live(value, final.now))
      )
        return unavailable();
      return result;
    } catch {
      return unavailable();
    }
  };
}
