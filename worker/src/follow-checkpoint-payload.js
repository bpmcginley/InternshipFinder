// Pure byte codec only. Git/source provenance, active lifetime and visibility remain caller duties.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const common = ["version", "covers_after", "index_sha256", "shard_sha256", "rows"];
const headers = {
  pending: ["predecessor", "candidate_commit", "candidate_tree", "public_tree", "prepared_at"],
  accepted: ["accepted_commit", "public_tree", "accepted_at"],
};
const sha = /^[a-f0-9]{64}$/;
const git = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const rawTime =
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
const matches = (pattern, value) =>
  typeof value === "string" && value.match(pattern)?.[0] === value;
const reject = () => {
  throw new TypeError("Invalid checkpoint codec input");
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const fields = (value, names) =>
  object(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const pick = (value, names) => Object.fromEntries(names.map((name) => [name, value[name]]));
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}
const canonical = (value) => JSON.stringify(ordered(value));
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
function instant(value) {
  if (!matches(utc, value) || value.startsWith("0000")) reject();
  const aligned = value.slice(0, -4) + "Z";
  if (new Date(aligned).toISOString() !== aligned) reject();
}
function validatePayload(value, maxRows) {
  if (
    !fields(value, common) ||
    value.version !== 1 ||
    !matches(sha, value.index_sha256) ||
    !object(value.shard_sha256) ||
    !Object.keys(value.shard_sha256).length ||
    !Array.isArray(value.rows) ||
    value.rows.length > maxRows
  )
    reject();
  instant(value.covers_after);
  if (!value.covers_after.endsWith("000Z")) reject();
  for (const [key, hash] of Object.entries(value.shard_sha256))
    if (!matches(/^(?:[A-Z]{2}|Canada|remote)$/, key) || !matches(sha, hash)) reject();
  let previous = "";
  for (const row of value.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 4 ||
      !matches(/^[a-f0-9]{16}$/, row[0]) ||
      row[0] <= previous ||
      !matches(rawTime, row[1]) ||
      !["observed_by", "verified_utc"].includes(row[2])
    )
      reject();
    instant(row[1].slice(0, 19) + ".000000Z");
    instant(row[3]);
    previous = row[0];
  }
}
function validateHeader(value, phase) {
  if (!Object.hasOwn(headers, phase) || !fields(value, headers[phase])) reject();
  const ids =
    phase === "pending"
      ? [value.candidate_commit, value.candidate_tree, value.public_tree]
      : [value.accepted_commit, value.public_tree];
  if (phase === "pending") {
    const prior = value.predecessor;
    if (
      !fields(prior, ["commit", "public_tree", "checkpoint_sha256"]) ||
      (prior.checkpoint_sha256 !== null && !matches(sha, prior.checkpoint_sha256))
    )
      reject();
    ids.push(prior.commit, prior.public_tree);
  }
  if (ids.some((id) => !matches(git, id) || id.length !== ids[0].length)) reject();
  instant(value[phase === "pending" ? "prepared_at" : "accepted_at"]);
}

export function createFollowCheckpointPayloadCodec({
  maxCheckpointBytes,
  maxPayloadBytes,
  maxHeaderBytes,
  maxRows,
}) {
  if (
    [maxCheckpointBytes, maxPayloadBytes, maxHeaderBytes, maxRows].some(
      (v) => !Number.isSafeInteger(v) || v < 1,
    )
  )
    reject();
  function parse(raw, limit) {
    if (!(raw instanceof Uint8Array) || !raw.byteLength || raw.byteLength > limit) reject();
    const bytes = new Uint8Array(raw);
    const text = decoder.decode(bytes);
    const value = JSON.parse(text);
    return { bytes, text, value };
  }
  function encode(value, limit) {
    // Validated fields are ASCII, so length is the exact UTF-8 byte count before allocation.
    const text = canonical(value);
    if (text.length > limit) reject();
    return encoder.encode(text);
  }
  function checked(payload, header, phase) {
    validatePayload(payload, maxRows);
    validateHeader(header, phase);
    if (payload.covers_after >= header[phase === "pending" ? "prepared_at" : "accepted_at"])
      reject();
  }
  async function split(raw, phase) {
    if (!Object.hasOwn(headers, phase)) reject();
    const { bytes, text, value } = parse(raw, maxCheckpointBytes);
    if (!fields(value, [...common, ...headers[phase]])) reject();
    const payload = pick(value, common),
      header = pick(value, headers[phase]);
    checked(payload, header, phase);
    if (canonical(value) !== text) reject();
    const payloadBytes = encode(payload, maxPayloadBytes),
      headerBytes = encode(header, maxHeaderBytes);
    return {
      payload: payloadBytes,
      header: headerBytes,
      checkpointSha256: await digest(bytes),
      payloadSha256: await digest(payloadBytes),
    };
  }
  async function reassemble(payloadRaw, headerRaw, phase, expectedSha256) {
    if (!matches(sha, expectedSha256)) reject();
    const payload = parse(payloadRaw, maxPayloadBytes),
      header = parse(headerRaw, maxHeaderBytes);
    checked(payload.value, header.value, phase);
    if (canonical(payload.value) !== payload.text || canonical(header.value) !== header.text)
      reject();
    const bytes = encode({ ...payload.value, ...header.value }, maxCheckpointBytes);
    const sha256 = await digest(bytes);
    if (sha256 !== expectedSha256) reject();
    return { bytes, sha256 };
  }
  // Catch parsing/date failures without exposing checkpoint content or source identifiers.
  const guarded =
    (operation) =>
    async (...args) => {
      try {
        return await operation(...args);
      } catch {
        return reject();
      }
    };
  return { split: guarded(split), reassemble: guarded(reassemble) };
}
