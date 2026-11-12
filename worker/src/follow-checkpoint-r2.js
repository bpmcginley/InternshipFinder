// Dormant storage primitive only. A separate control authority must fence visibility and cleanup.
const KEYS = ["follow-checkpoint-slot-0", "follow-checkpoint-slot-1"];
const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
const digest = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const etag = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validSlot = (slot) => slot === 0 || slot === 1;

export function createFollowCheckpointR2Slots(bucket, { maxPayloadBytes, maxEnvelopeBytes }) {
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 1 ||
    !Number.isSafeInteger(maxEnvelopeBytes) ||
    maxEnvelopeBytes < maxPayloadBytes + 256
  )
    throw new TypeError("Invalid checkpoint bounds");
  const prepared = new WeakMap();

  async function prepare(payload, kind = "payload") {
    if (!(payload instanceof Uint8Array) || payload.byteLength > maxPayloadBytes) return null;
    // Copy before the first await; caller mutation cannot change the committed identity.
    const copy = new Uint8Array(payload);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const sha256 = await digest(copy);
    const header = { v: 1, kind, nonce, sha256, bytes: copy.byteLength };
    const prefix = encoder.encode(JSON.stringify(header) + "\n");
    const body = new Uint8Array(prefix.length + copy.length);
    body.set(prefix);
    body.set(copy, prefix.length);
    const receipt = Object.freeze({ kind, nonce, sha256, bytes: copy.length });
    prepared.set(receipt, body);
    return receipt;
  }

  async function read(slot) {
    if (!validSlot(slot)) return { status: "invalid" };
    let reader;
    try {
      const object = await bucket.get(KEYS[slot]);
      if (!object) return { status: "missing" }; // Not proof an uncertain write cannot arrive.
      reader = object.body.getReader();
      if (
        !etag(object.etag) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 1 ||
        object.size > maxEnvelopeBytes
      )
        throw new Error();
      const chunks = [];
      let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || length + value.length > object.size)
          throw new Error();
        length += value.length;
        if (value.length) chunks.push(value);
      }
      if (length !== object.size) throw new Error();
      const body = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
      const end = body.indexOf(10);
      if (end < 0 || end > 255) throw new Error();
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        body.subarray(0, end),
      );
      const header = JSON.parse(text);
      const { v, kind, nonce, sha256, bytes } = header;
      if (
        v !== 1 ||
        !["payload", "tombstone"].includes(kind) ||
        typeof nonce !== "string" ||
        !/^[a-f0-9]{32}$/.test(nonce) ||
        typeof sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > maxPayloadBytes ||
        (kind === "tombstone" && bytes !== 0) ||
        text !== JSON.stringify({ v, kind, nonce, sha256, bytes })
      )
        throw new Error();
      const payload = body.slice(end + 1);
      if (payload.length !== bytes || (await digest(payload)) !== sha256) throw new Error();
      return { status: "present", etag: object.etag, kind, nonce, sha256, payload };
    } catch {
      return { status: "unavailable" };
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* No raw storage errors escape. */
        }
      }
    }
  }

  async function write(slot, expectedEtag, receipt) {
    const body = prepared.get(receipt);
    if (!validSlot(slot) || (expectedEtag !== null && !etag(expectedEtag)) || !body)
      return { status: "invalid" };
    // One attempt per envelope. Uncertainty requires explicit read/reconciliation, never retry.
    prepared.delete(receipt);
    try {
      const object = await bucket.put(KEYS[slot], body, {
        onlyIf: expectedEtag === null ? { etagDoesNotMatch: "*" } : { etagMatches: expectedEtag },
      });
      if (object === null) return { status: "conflict" };
      if (!etag(object?.etag)) return { status: "uncertain" };
      const current = await read(slot);
      if (
        current.status !== "present" ||
        current.etag !== object.etag ||
        current.nonce !== receipt.nonce ||
        current.sha256 !== receipt.sha256 ||
        current.kind !== receipt.kind
      )
        return { status: "uncertain" };
      return { status: "stored", etag: current.etag };
    } catch {
      return { status: "uncertain" };
    }
  }

  return {
    prepare: (bytes) => prepare(bytes),
    tombstone: () => prepare(new Uint8Array(), "tombstone"),
    read,
    write,
  };
}
