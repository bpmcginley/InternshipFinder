import { handleFollowCheckpoint } from "./follow-checkpoint-http.js";

export { FollowCheckpoint } from "./follow-checkpoint-store.js";

const SINGLETON = "follow-checkpoint-v1";
const DIGEST = /^[a-f0-9]{64}$/;
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function privateOrigin(value) {
  if (typeof value !== "string" || value.length > 261) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (value !== url.origin || url.protocol !== "https:" || url.port
    || host.length > 253 || !DNS_NAME.test(host)
    || host === "workers.dev" || host.endsWith(".workers.dev")) return null;
  return url.origin;
}

function closed(status) {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export default {
  async fetch(request, env) {
    const origin = privateOrigin(env.FOLLOW_CHECKPOINT_ORIGIN);
    const bound = env.FOLLOW_CHECKPOINT_MAX_BYTES;
    const writer = env.FOLLOW_CHECKPOINT_WRITER_SHA256;
    const operator = env.FOLLOW_CHECKPOINT_OPERATOR_SHA256;
    const namespace = env.FOLLOW_CHECKPOINT;
    if (!origin || typeof bound !== "string" || !/^[1-9]\d{0,6}$/.test(bound)
      || Number(bound) > 8_000_000 || typeof writer !== "string" || !DIGEST.test(writer)
      || typeof operator !== "string" || !DIGEST.test(operator) || writer === operator
      || typeof namespace?.getByName !== "function") return closed(503);
    if (new URL(request.url).origin !== origin) return closed(404);

    return handleFollowCheckpoint(request, {
      maxBytes: Number(bound),
      writer,
      operator,
      openStore: () => namespace.getByName(SINGLETON),
    });
  },
};
