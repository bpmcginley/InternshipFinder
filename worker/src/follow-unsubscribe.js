// Dormant RFC 8058 handler. A future router supplies the token from the HTTPS URL.
import { unsubscribeFollows } from "./follows.js";

const MAX_BODY_BYTES = 4096;
const TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;

async function oneClickForm(request) {
  const contentType = request.headers.get("Content-Type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded" && mediaType !== "multipart/form-data") {
    return false;
  }
  if (!request.body || Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return false;

  const bytes = new Uint8Array(MAX_BODY_BYTES);
  const reader = request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    const entries = [...fields];
    return (
      entries.length === 1 && entries[0][0] === "List-Unsubscribe" && entries[0][1] === "One-Click"
    );
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

export async function handleFollowUnsubscribe(request, db, token, now = new Date()) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
  }
  if (typeof token !== "string" || !TOKEN.test(token) || !(await oneClickForm(request))) {
    return new Response(null, { status: 400, headers });
  }

  // A missing, replayed or wrong-purpose token gives the same response as a deletion.
  // Keep D1 failures outside the parser catch so a caller can return a retryable error.
  await unsubscribeFollows(db, token, now);
  return new Response(null, { status: 204, headers });
}
