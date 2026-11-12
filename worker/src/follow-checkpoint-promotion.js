// Dormant promotion. change(action) must run action again inside the qualified native SQLite CAS.
const DAY = 86_400_000,
  encoder = new TextEncoder(),
  decoder = new TextDecoder();
const unavailable = () => {
  throw new Error("Follow checkpoint promotion unavailable");
};
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const SHA = /^[a-f0-9]{64}$/,
  GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const live = (r, now) => r && r.starts <= now && now < r.expires;
function instant(value) {
  if (!matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/, value) || value.startsWith("0000"))
    return unavailable();
  const aligned = value.slice(0, -4) + "Z",
    floor = Date.parse(aligned);
  if (!Number.isSafeInteger(floor) || new Date(floor).toISOString() !== aligned)
    return unavailable();
  return { floor, ceil: floor + (value.slice(-4, -1) === "000" ? 0 : 1) };
}
const priorKey = (p) => [p.commit, p.public_tree, p.checkpoint_sha256];

export function createFollowCheckpointPromotion({ codec, capture, read, change, maxBytes }) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8_000_000 ||
    [codec?.split, codec?.reassemble, capture, read, change].some((fn) => typeof fn !== "function")
  )
    throw new TypeError("Invalid checkpoint promotion dependencies");
  return async function promote(body, limit, options) {
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
      const bytes = new Uint8Array(new Uint8Array(body));
      const predecessor = { ...options?.predecessor },
        generation = options?.generation,
        checkedAt = options?.checkedAt;
      if (
        Object.keys(predecessor).sort().join(",") !== "checkpoint_sha256,commit,public_tree" ||
        !matches(GIT, predecessor.commit) ||
        !matches(GIT, predecessor.public_tree) ||
        predecessor.commit.length !== predecessor.public_tree.length ||
        (predecessor.checkpoint_sha256 !== null && !matches(SHA, predecessor.checkpoint_sha256)) ||
        !matches(SHA, generation)
      )
        return unavailable();
      const checked = instant(checkedAt);
      const parts = await codec.split(bytes, "accepted"),
        header = JSON.parse(decoder.decode(parts.header));
      const acceptedAt = instant(header.accepted_at);
      const proposed = {
        header: decoder.decode(parts.header),
        digest: parts.checkpointSha256,
        payloadSha: parts.payloadSha256,
        starts: acceptedAt.ceil,
        expires: acceptedAt.floor + 7 * DAY,
      };
      const promotionKey = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            encoder.encode(
              JSON.stringify([
                generation,
                ...priorKey(predecessor),
                header.accepted_commit,
                header.public_tree,
              ]),
            ),
          ),
        ),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      const observe = async () => {
        const before = capture(),
          snapshot = await read(limit),
          after = capture();
        if (
          !snapshot ||
          !["active", "expired", "never_seeded"].includes(snapshot.state) ||
          typeof before?.raw !== "string" ||
          before.raw !== after?.raw ||
          !Number.isSafeInteger(before.now) ||
          !Number.isSafeInteger(after.now) ||
          after.now < before.now
        )
          return unavailable();
        return { state: JSON.parse(after.raw), now: after.now, snapshot };
      };
      const decision = (state, now) => {
        if (
          !Number.isSafeInteger(now) ||
          now < checked.ceil ||
          checkedAt < header.accepted_at ||
          !live(proposed, now)
        )
          return "stale";
        const accepted = state.accepted,
          pending = state.pending;
        const currentHeader = accepted ? JSON.parse(accepted.header) : null;
        if (
          currentHeader?.accepted_commit === header.accepted_commit &&
          currentHeader?.public_tree === header.public_tree &&
          accepted?.generation === generation &&
          accepted.promotionKey === promotionKey &&
          accepted.payloadSha === proposed.payloadSha
        )
          return live(accepted, now) && now < accepted.replayUntil ? "already_promoted" : "stale";
        if (
          state.reservation ||
          state.retired ||
          !live(pending, now) ||
          pending.digest !== generation ||
          pending.payloadSha !== proposed.payloadSha
        )
          return "stale";
        const staged = JSON.parse(pending.header);
        if (
          !same(priorKey(staged.predecessor), priorKey(predecessor)) ||
          header.public_tree !== staged.public_tree ||
          header.accepted_at < staged.prepared_at
        )
          return "stale";
        if (accepted) {
          const old = JSON.parse(accepted.header);
          if (
            !live(accepted, now) ||
            predecessor.commit !== old.accepted_commit ||
            predecessor.public_tree !== old.public_tree ||
            predecessor.checkpoint_sha256 !== accepted.digest
          )
            return "stale";
        } else if (state.initialized || predecessor.checkpoint_sha256 !== null) return "stale";
        return "promote";
      };
      const before = await observe(),
        status = decision(before.state, before.now);
      if (status !== "promote") return status;
      if (!(before.snapshot.pending instanceof ArrayBuffer)) return unavailable();
      const pendingParts = await codec.split(new Uint8Array(before.snapshot.pending), "pending");
      if (pendingParts.checkpointSha256 !== generation) return unavailable();
      const rebuilt = await codec.reassemble(
        pendingParts.payload,
        parts.header,
        "accepted",
        proposed.digest,
      );
      if (rebuilt.bytes.length !== bytes.length || rebuilt.bytes.some((v, i) => v !== bytes[i]))
        return unavailable();
      let result;
      try {
        result = await change((state, now) => {
          if (!same(state, before.state) || decision(state, now) !== "promote") return false;
          const pending = state.pending,
            accepted = state.accepted;
          if (accepted)
            state.retired = {
              slot: accepted.slot,
              nonce: accepted.nonce,
              etag: accepted.etag,
              expires: accepted.expires,
            };
          state.accepted = {
            ...proposed,
            slot: pending.slot,
            nonce: pending.nonce,
            etag: pending.etag,
            generation,
            promotionKey,
            replayUntil: Math.min(pending.expires, accepted?.expires ?? pending.expires),
          };
          state.pending = null;
          state.initialized = true;
          return true;
        });
      } catch {
        /* A lost acknowledgement still requires a qualified exact read. */
      }
      const after = await observe();
      if (decision(after.state, after.now) !== "already_promoted")
        return result === "stale" ? "stale" : unavailable();
      return result === "committed" ? "promoted" : "already_promoted";
    } catch {
      return unavailable();
    }
  };
}
