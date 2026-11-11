// RFC 8058 handler. The POST router supplies the token from the HTTPS URL.
import { unsubscribeFollows } from "./follows.js";

const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 5000;
const TIMED_OUT = Symbol("body timeout");
const TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;

async function oneClickForm(request, timers) {
  const contentType = request.headers.get("Content-Type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded" && mediaType !== "multipart/form-data") {
    return false;
  }
  if (!request.body || Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return false;

  const bytes = new Uint8Array(MAX_BODY_BYTES);
  const reader = request.body.getReader();
  let size = 0;
  let expired = false;
  let timer;
  // One absolute deadline, never renewed by chunks. Only body reading races the
  // timer: a timed-out read cannot reach D1 or release a slot during a deletion.
  const deadline = new Promise((resolve) => {
    timer = timers.setTimeout(() => {
      expired = true;
      resolve(TIMED_OUT);
      void reader.cancel().catch(() => {});
    }, BODY_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (expired || chunk === TIMED_OUT) return TIMED_OUT;
      const { done, value } = chunk;
      if (done) break;
      if (size + value.byteLength > bytes.length) {
        void reader.cancel().catch(() => {});
        return false;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    const body = bytes.subarray(0, size);
    let fields;
    if (mediaType === "application/x-www-form-urlencoded") {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
      if (text.startsWith("?")) return false;
      fields = new URLSearchParams(text);
    } else {
      fields = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
    }
    if (expired) return TIMED_OUT;
    const entries = [...fields];
    return (
      entries.length === 1 && entries[0][0] === "List-Unsubscribe" && entries[0][1] === "One-Click"
    );
  } catch {
    return expired ? TIMED_OUT : false;
  } finally {
    timers.clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function handleFollowUnsubscribe(
  request,
  db,
  token,
  now = new Date(),
  timers = { setTimeout, clearTimeout },
) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
  }
  const form =
    typeof token === "string" && TOKEN.test(token) && (await oneClickForm(request, timers));
  if (form === TIMED_OUT) {
    return new Response(null, { status: 503, headers: { ...headers, "Retry-After": "60" } });
  }
  if (!form) {
    return new Response(null, { status: 400, headers });
  }

  // A missing, replayed or wrong-purpose token gives the same response as a deletion.
  // Keep D1 failures outside the parser catch so a caller can return a retryable error.
  await unsubscribeFollows(db, token, now);
  return new Response(null, { status: 204, headers });
}
