import { handleFollowCheckpoint } from "../src/follow-checkpoint-http.js";

export { FollowCheckpoint } from "../src/follow-checkpoint-store.js";

export const WRITER = "A".repeat(43);
export const OPERATOR = "B".repeat(43);
export const MAX = 3_000_000;
export async function sha(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function credentials() {
  const encoder = new TextEncoder();
  return {
    writer: await sha(encoder.encode(WRITER)),
    operator: await sha(encoder.encode(OPERATOR)),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/checkpoint")) return new Response(null, { status: 404 });
    return handleFollowCheckpoint(request, {
      ...await credentials(),
      maxBytes: MAX,
      openStore: () => env.CHECKPOINT.getByName(url.hostname),
    });
  },
};
