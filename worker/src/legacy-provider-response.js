import { HttpError } from "./http.js";
import { createSSEWireCounter } from "./sse-wire.js";

// Same technical wire ceilings as the 0.6.0 Worker client. No financial mode switch.
export const LEGACY_SSE_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxEventBytes: 1024 * 1024,
});
const failure = () => new HttpError(502, "upstream", "AI response could not be completed");

// Guard before tee so neither the client nor usage reader receives a rejected chunk.
export function boundLegacySSE(stream) {
  if (!stream?.getReader) throw failure();
  const reader = stream.getReader(),
    scan = createSSEWireCounter(LEGACY_SSE_LIMITS.maxEventBytes, failure);
  let total = 0,
    ended = false,
    limited = false,
    resolve;
  const completed = new Promise((r) => {
    resolve = r;
  });
  const finish = (outcome) => {
    if (!ended) {
      ended = true;
      resolve(outcome);
    }
  };
  const release = () => {
    try {
      reader.releaseLock();
    } catch {}
  };
  const cancel = () => {
    finish(limited ? "limited" : "interrupted");
    try {
      void Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      /* Cancellation is best effort. */
    } finally {
      release(); // Do not retain a lock while upstream cancellation hangs.
    }
  };
  const body = new ReadableStream(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (ended) return;
          if (result.done) {
            finish("complete");
            controller.close();
            release();
            return;
          }
          if (!(result.value instanceof Uint8Array)) throw failure();
          total += result.value.byteLength;
          if (total > LEGACY_SSE_LIMITS.maxBytes) {
            limited = true;
            throw failure();
          }
          try {
            scan(result.value);
          } catch {
            limited = true;
            throw failure();
          }
          controller.enqueue(result.value);
        } catch {
          if (ended) {
            release();
            return;
          }
          controller.error(failure());
          cancel();
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { body, completed };
}
