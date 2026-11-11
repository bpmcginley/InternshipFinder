import { expect, it, vi } from "vitest";
import { handle } from "../src/index.js";

it("accepts the native Worker redirect option and rejects redirect responses", async () => {
  const file = "2026-11-05-data-science.mp4";
  const raw = `https://raw.githubusercontent.com/bpmcginley/InternshipFinder/social-cards/${file}`;
  const request = new Request(`https://worker.test/social-video/${file}`, {
    method: "HEAD",
    headers: { Authorization: "Bearer synthetic", Cookie: "synthetic=1" },
  });
  const fetch = vi.fn(async (url, options) => {
    // The native constructor rejects redirect modes unsupported by workerd.
    const upstream = new Request(url, options);
    expect(upstream.url).toBe(raw);
    expect(upstream.method).toBe("HEAD");
    expect(upstream.redirect).toBe("manual");
    expect(upstream.headers.has("Authorization")).toBe(false);
    expect(upstream.headers.has("Cookie")).toBe(false);
    return new Response(null, { headers: { "Content-Length": "12" } });
  });
  const valid = await handle(request, {}, undefined, { fetch });
  expect(valid.status).toBe(200);
  expect(valid.headers.get("Content-Type")).toBe("video/mp4");
  expect(await valid.text()).toBe("");
  expect(fetch).toHaveBeenCalledTimes(1);

  fetch.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } }),
  );
  const redirected = await handle(request, {}, undefined, { fetch });
  expect(redirected.status).toBe(502);
  expect(redirected.headers.get("Location")).toBeNull();
  expect(redirected.headers.get("Cache-Control")).toBe("no-store");
  expect(fetch).toHaveBeenCalledTimes(2);
});
