// Dormant HTTP stage composition. Ports own native CAS, witness and one-use upload receipts.
const unavailable = () => {
  throw new Error("Follow checkpoint staging unavailable");
};
const nonce = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const sameBytes = (body, expected) =>
  body instanceof ArrayBuffer &&
  body.byteLength === expected.byteLength &&
  new Uint8Array(body).every((value, i) => value === expected[i]);

export function createFollowCheckpointStage({
  codec,
  inspect,
  read,
  reserve,
  upload,
  reconcile,
  maxBytes,
}) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8_000_000 ||
    [codec?.split, inspect, read, reserve, upload, reconcile].some((fn) => typeof fn !== "function")
  )
    throw new TypeError("Invalid checkpoint staging dependencies");
  return async function stage(body, limit) {
    try {
      if (
        !(body instanceof ArrayBuffer) ||
        !body.byteLength ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > maxBytes ||
        body.byteLength > limit
      )
        return unavailable();
      // Copy before validation awaits. Original timestamps and exact bytes are never regenerated.
      const bytes = new Uint8Array(new Uint8Array(body));
      const parts = await codec.split(bytes, "pending");
      if (
        typeof parts?.checkpointSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(parts.checkpointSha256)
      )
        return unavailable();
      const observed = async () => {
        const snapshot = await read(limit);
        if (!snapshot || !["active", "expired", "never_seeded"].includes(snapshot.state))
          return unavailable();
        // An expired predecessor cannot authorize another stage or its replay.
        if (snapshot.state === "expired") return "stale";
        if (snapshot.pending !== undefined)
          return sameBytes(snapshot.pending, bytes) ? "already_pending" : "stale";
        return null;
      };
      const recover = async (id) => {
        if (!nonce(id)) return unavailable();
        try {
          await reconcile(id);
        } catch {
          /* Read the qualified outcome after a lost acknowledgement. */
        }
        return (await observed()) ?? unavailable();
      };
      // This trusted projection admits only a current witness and this exact canonical digest.
      // A subsequent request can reconcile, but never reacquires or replays the upload receipt.
      const receipt = await inspect(parts.checkpointSha256);
      if (receipt?.status === "reservation") return await recover(receipt.nonce);
      if (receipt?.status !== "none") return unavailable();
      const prior = await observed();
      if (prior) return prior;
      const owned = await reserve(bytes);
      if (owned?.status !== "reserved") {
        const current = await observed();
        if (current) return current;
        return owned?.status === "stale" ? "stale" : unavailable();
      }
      if (!nonce(owned.nonce)) return unavailable();
      try {
        await upload(owned.nonce);
      } catch {
        /* Never retry an ambiguous physical write. */
      }
      const result = await recover(owned.nonce);
      return result === "already_pending" ? "pending" : result;
    } catch {
      return unavailable();
    }
  };
}
