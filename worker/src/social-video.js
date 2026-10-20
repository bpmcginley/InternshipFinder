// Public brand media only. GitHub's raw host serves MP4s as application/octet-stream; Meta's
// Instagram Login publisher needs a public video URL. Reuse the existing social-cards branch and
// stream its generated videos with the right type, without storing a second copy or counting views.
import { HttpError } from "./http.js";

const RAW = "https://raw.githubusercontent.com/bpmcginley/InternshipFinder/social-cards/";
export const MAX_SOCIAL_VIDEO_BYTES = 16 * 1024 * 1024;
const NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.mp4$/;

export async function socialVideo(request, fetcher) {
  const url = new URL(request.url);
  const name = url.pathname.slice("/social-video/".length);
  if (!url.pathname.startsWith("/social-video/") || name.length > 120 || !NAME.test(name) || url.search) {
    throw new HttpError(404, "not_found", "No such brand video");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "method", "Use GET or HEAD");
  }
  const headers = { "User-Agent": "InternScout-brand-media/1.0 (+https://internscout.org)" };
  const range = request.headers.get("Range");
  if (range) {
    if (!/^bytes=(?:\d{1,9}-\d{0,9}|-\d{1,9})$/.test(range)) {
      throw new HttpError(416, "range", "Use one byte range");
    }
    headers.Range = range;
  }
  let upstream;
  try {
    upstream = await fetcher(RAW + name, {
      method: request.method, headers, redirect: "error", signal: AbortSignal.timeout(15000),
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 3600, "400-599": -1 } },
    });
  } catch {
    throw new HttpError(502, "media_unavailable", "Brand video is not available yet");
  }
  const refuse = async (status, code, message) => {
    if (upstream.body) await upstream.body.cancel();
    throw new HttpError(status, code, message);
  };
  if (upstream.status === 404) return refuse(404, "not_found", "No such brand video");
  if (upstream.status === 416) return refuse(416, "range", "Byte range is not available");
  if (upstream.status !== 200 && upstream.status !== 206) {
    return refuse(502, "media_unavailable", "Brand video is not available yet");
  }
  const length = upstream.headers.get("Content-Length") || "";
  if (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > MAX_SOCIAL_VIDEO_BYTES) {
    return refuse(502, "media_size", "Brand video has no supported size");
  }
  const resultHeaders = {
    "Content-Type": "video/mp4", "Content-Length": length, "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=3600", "Accept-Ranges": "bytes",
  };
  if (upstream.status === 206) {
    const contentRange = upstream.headers.get("Content-Range") || "";
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!range || !match || Number(match[3]) > MAX_SOCIAL_VIDEO_BYTES ||
        Number(match[1]) > Number(match[2]) || Number(match[2]) >= Number(match[3]) ||
        Number(match[2]) - Number(match[1]) + 1 !== Number(length)) {
      return refuse(502, "media_range", "Brand video returned an unsupported range");
    }
    resultHeaders["Content-Range"] = contentRange;
  }
  if (request.method === "HEAD" && upstream.body) await upstream.body.cancel();
  if (request.method === "GET" && !upstream.body) return refuse(502, "media_unavailable", "Brand video has no body");
  let received = 0;
  const body = request.method === "HEAD" ? null : upstream.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > Number(length)) throw new Error("Brand video exceeded its declared size");
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== Number(length)) throw new Error("Brand video was incomplete");
    },
  }));
  return new Response(body, {
    status: upstream.status, headers: resultHeaders,
  });
}
