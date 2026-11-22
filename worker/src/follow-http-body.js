const BODY_TIMEOUT_MS = 5000;
export const FOLLOW_BODY_TIMEOUT = Symbol("follow body timeout");

// Keep one absolute deadline through streaming and decoding. A stuck cancel
// acknowledgement must not hold the request open.
export async function readFollowBody(body, limit, timers, decode) {
  const reader = body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  let timedOut = false;
  let timer;
  const expiresAt = timers.monotonicNow() + BODY_TIMEOUT_MS;
  const expired = () => timers.monotonicNow() >= expiresAt;
  const expire = () => {
    timedOut = true;
    void reader.cancel().catch(() => {});
    return FOLLOW_BODY_TIMEOUT;
  };
  const deadline = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve(expire()), BODY_TIMEOUT_MS);
  });
  try {
    for (;;) {
      if (expired()) return expire();
      const chunk = await Promise.race([reader.read(), deadline]);
      if (timedOut || chunk === FOLLOW_BODY_TIMEOUT) return FOLLOW_BODY_TIMEOUT;
      if (expired()) return expire();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    const value = decode(bytes.subarray(0, size));
    return expired() ? expire() : value;
  } catch {
    if (timedOut) return FOLLOW_BODY_TIMEOUT;
    return expired() ? expire() : null;
  } finally {
    timers.clearTimeout(timer);
    reader.releaseLock();
  }
}
