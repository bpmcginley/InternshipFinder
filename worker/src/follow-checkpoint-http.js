const DIGEST = /^[a-f0-9]{64}$/;
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const RAW_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PREFIX = "/v1/checkpoint";
const BINARY = "application/octet-stream";
const COMMON = ["covers_after", "index_sha256", "public_tree", "rows", "shard_sha256", "version"];
const PREDECESSOR = ["checkpoint_sha256", "commit", "public_tree"];

function response(status, body = null, headers) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function fields(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function gitPair(commit, tree) {
  return matches(GIT, commit) && matches(GIT, tree) && commit.length === tree.length;
}

function instant(value) {
  if (!matches(UTC, value) || value.startsWith("0000")) return false;
  const prefix = value.slice(0, -4) + "Z";
  const ms = Date.parse(prefix);
  return Number.isFinite(ms) && new Date(ms).toISOString() === prefix;
}

function rawInstant(value) {
  return matches(RAW_TIME, value) && !value.endsWith("-00:00")
    && instant(value.slice(0, 19) + ".000000Z");
}

function predecessor(value) {
  return fields(value, PREDECESSOR) && gitPair(value.commit, value.public_tree)
    && (value.checkpoint_sha256 === null || matches(DIGEST, value.checkpoint_sha256));
}

function canonical(value) {
  return JSON.stringify(value, (_, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
      : entry);
}

function checkpoint(raw, stage) {
  let text, record;
  try {
    text = decoder.decode(raw);
    record = JSON.parse(text);
  } catch {
    return false;
  }
  const extra = stage
    ? ["candidate_commit", "candidate_tree", "predecessor", "prepared_at"]
    : ["accepted_commit", "accepted_at"];
  if (!fields(record, [...COMMON, ...extra]) || record.version !== 1
    || !instant(record.covers_after) || !record.covers_after.endsWith("000Z")
    || !matches(DIGEST, record.index_sha256)
    || !Array.isArray(record.rows)) return false;
  if (stage ? (!predecessor(record.predecessor)
    || !gitPair(record.candidate_commit, record.candidate_tree)
    || !gitPair(record.candidate_commit, record.public_tree) || !instant(record.prepared_at))
    : (!gitPair(record.accepted_commit, record.public_tree) || !instant(record.accepted_at))) return false;

  const shards = record.shard_sha256;
  if (!shards || typeof shards !== "object" || Array.isArray(shards)) return false;
  const keys = Object.keys(shards);
  if (!keys.length || keys.some((key) =>
    !/^(?:[A-Z]{2}|Canada|remote)$/.test(key) || !matches(DIGEST, shards[key]))) return false;
  let last = "";
  for (const row of record.rows) {
    if (!Array.isArray(row) || row.length !== 4
      || !matches(/^[a-f0-9]{16}$/, row[0]) || row[0] <= last
      || !rawInstant(row[1])
      || !["observed_by", "verified_utc"].includes(row[2]) || !instant(row[3])) return false;
    last = row[0];
  }
  return canonical(record) === text;
}

async function role(request, writer, operator) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return null;
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(match[1]));
  const decode = (hex) => Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
  const isWriter = crypto.subtle.timingSafeEqual(hash, decode(writer));
  const isOperator = crypto.subtle.timingSafeEqual(hash, decode(operator));
  return isWriter ? "writer" : isOperator ? "operator" : null;
}

function length(request) {
  const header = request.headers.get("Content-Length");
  if (header === null) return null;
  return /^(?:0|[1-9]\d{0,15})$/.test(header) && Number.isSafeInteger(Number(header))
    ? Number(header) : -1;
}

async function readBody(request, maxBytes, declared) {
  if (!request.body || declared === 0) return { status: 400 };
  if (declared > maxBytes) return { status: 413 };
  const reader = request.body.getReader();
  const bytes = new Uint8Array(declared ?? maxBytes);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || size + value.byteLength > bytes.byteLength) {
        void reader.cancel().catch(() => {});
        return { status: declared === null ? 413 : 400 };
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return size && (declared === null || declared === size)
      ? { bytes: bytes.slice(0, size).buffer } : { status: 400 };
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
}

function promotionHeaders(request, generation) {
  const raw = request.headers.get("Follow-Predecessor") ?? "";
  const checkedAt = request.headers.get("Follow-Checked-At");
  if (raw.length > 194 || !matches(DIGEST, generation) || !instant(checkedAt)) return null;
  const [commit, public_tree, digest, ...rest] = raw.split(":");
  const previous = { commit, public_tree, checkpoint_sha256: digest === "-" ? null : digest };
  return rest.length === 0 && predecessor(previous) ? { predecessor: previous, generation, checkedAt } : null;
}

function load(record, maxBytes) {
  if (!record || !["active", "expired", "never_seeded", "unavailable"].includes(record.state)) return response(503);
  const { accepted, pending, state } = record;
  if ((state === "active") !== (accepted !== undefined)
    || [accepted, pending].some((body) => body !== undefined
      && (!(body instanceof ArrayBuffer) || !body.byteLength || body.byteLength > maxBytes))) return response(503);
  return response(200, new Blob([accepted ?? "", pending ?? ""]), {
    "Content-Type": BINARY,
    "Follow-State": state,
    "Follow-Accepted-Bytes": String(accepted?.byteLength ?? 0),
    "Follow-Pending-Bytes": String(pending?.byteLength ?? 0),
  });
}

function outcome(value, allowed) {
  if (!allowed.includes(value)) return response(503);
  return response(value === "stale" ? 409 : 200, JSON.stringify({ status: value }), {
    "Content-Type": "application/json",
  });
}

/** Detached HTTP handler. Caller supplies trusted limits, credential digests and one private store. */
export async function handleFollowCheckpoint(request, { openStore, maxBytes, writer, operator }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 8_000_000
    || !matches(DIGEST, writer) || !matches(DIGEST, operator) || writer === operator) return response(503);
  try {
    const access = await role(request, writer, operator);
    if (!access) return response(401);
    const url = new URL(request.url);
    const operation = [PREFIX, PREFIX + "/stage", PREFIX + "/promote", PREFIX + "/reject"].indexOf(url.pathname);
    if (url.protocol !== "https:" || operation < 0 || url.href.includes("?")) return response(404);
    if (request.method !== (operation === 0 ? "GET" : "POST")) return response(405);
    if (operation === 1 && access !== "writer") return response(403);

    const declared = length(request);
    const generation = request.headers.get("Follow-Pending-Generation");
    if (operation === 0 || operation === 3) {
      if (request.body || (declared !== null && declared !== 0)) return response(400);
      if (operation === 0) return load(await openStore().read(maxBytes), maxBytes);
      if (!matches(DIGEST, generation)) return response(400);
      const rejected = await openStore().rejectPending(generation);
      if (typeof rejected !== "boolean") return response(503);
      return outcome(rejected ? "rejected" : "stale", ["rejected", "stale"]);
    }

    if (declared === -1 || request.headers.get("Content-Encoding")) return response(400);
    if (request.headers.get("Content-Type") !== BINARY) return response(415);
    const stage = operation === 1;
    const promotion = stage ? null : promotionHeaders(request, generation);
    if (!stage && !promotion) return response(400);
    const { status, bytes } = await readBody(request, maxBytes, declared);
    if (status) return response(status);
    if (!checkpoint(bytes, stage)) return response(400);
    return stage
      ? outcome(await openStore().reservePending(bytes, maxBytes), ["pending", "already_pending", "stale"])
      : outcome(await openStore().promote(bytes, maxBytes, promotion), ["promoted", "already_promoted", "stale"]);
  } catch {
    return response(503);
  }
}
