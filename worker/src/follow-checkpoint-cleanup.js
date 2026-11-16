// Normal retired-slot cleanup only. Uncertain physical effects remain held; no recovery journal.
import { createFollowCheckpointMetadataCapture } from "./follow-checkpoint-retirement.js";
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const matches = (re, v) => typeof v === "string" && re.test(v);
function data(value, keys) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).sort().join(",") !== keys
  )
    return null;
  const out = {};
  for (const key of keys.split(",")) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, "value")) return null;
    out[key] = d.value;
  }
  return out;
}
export function createFollowCheckpointCleanup(options) {
  const { control, slots } = options;
  if (
    [control?.admitted, control?.change, slots?.read, slots?.tombstone, slots?.write].some(
      (v) => typeof v !== "function",
    )
  )
    throw new TypeError("Invalid checkpoint cleanup dependencies");
  const capture = createFollowCheckpointMetadataCapture(options);
  return async function cleanupRetired() {
    try {
      const before = capture(),
        retired = before.state.retired;
      if (!retired) return "held";
      const admitted = await control.admitted();
      if (!admitted || JSON.stringify(admitted) !== before.raw) return "held";
      let latest = before.now;
      const unchanged = () => {
        const current = capture();
        if (current.raw !== before.raw || current.now < latest) return false;
        latest = current.now;
        return true;
      };
      const original = (value) => {
        const r = data(value, "etag,kind,nonce,payload,sha256,status");
        return (
          r?.status === "present" &&
          r.kind === "payload" &&
          r.etag === retired.etag &&
          r.nonce === retired.nonce &&
          matches(/^[a-f0-9]{64}$/, r.sha256) &&
          r.payload instanceof Uint8Array &&
          r.payload.byteLength > 0
        );
      };
      if (!original(await slots.read(retired.slot)) || !unchanged()) return "held";
      const result = await control.change(
        (state, now) => {
          if (JSON.stringify(state) !== before.raw || !Number.isSafeInteger(now) || now < latest)
            throw new Error("Checkpoint cleanup changed");
          state.retired = null;
          return true;
        },
        async (_before, _intent, prepared) => {
          if (!original(await slots.read(retired.slot)) || !unchanged()) return false;
          const receipt = await slots.tombstone();
          const planned = data(receipt, "bytes,kind,nonce,sha256");
          if (
            !planned ||
            planned.kind !== "tombstone" ||
            planned.bytes !== 0 ||
            planned.sha256 !== EMPTY_SHA ||
            !matches(/^[a-f0-9]{32}$/, planned.nonce) ||
            planned.nonce === retired.nonce ||
            !unchanged() ||
            typeof prepared !== "function" ||
            (await prepared()) !== true ||
            !unchanged()
          )
            return false;
          // Exactly one attempt with the original conditional ETag and native single-use receipt.
          const written = data(
            await slots.write(retired.slot, retired.etag, receipt),
            "etag,status",
          );
          if (
            written?.status !== "stored" ||
            !matches(/^[A-Za-z0-9_-]{1,128}$/, written.etag) ||
            written.etag === retired.etag
          )
            return false;
          const observed = data(
            await slots.read(retired.slot),
            "etag,kind,nonce,payload,sha256,status",
          );
          return (
            observed?.status === "present" &&
            observed.kind === "tombstone" &&
            observed.etag === written.etag &&
            observed.nonce === planned.nonce &&
            observed.sha256 === EMPTY_SHA &&
            observed.payload instanceof Uint8Array &&
            observed.payload.byteLength === 0 &&
            (await prepared()) === true &&
            unchanged()
          );
        },
      );
      return result === "committed" ? "committed" : "held";
    } catch {
      return "held";
    }
  };
}
