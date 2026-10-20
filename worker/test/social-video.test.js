import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { MAX_SOCIAL_VIDEO_BYTES } from "../src/social-video.js";

const FILE = "2026-10-22-software-engineering.mp4";
const URL = `https://internscout-api.bpmcginley.workers.dev/social-video/${FILE}`;
const RAW = `https://raw.githubusercontent.com/bpmcginley/InternshipFinder/social-cards/${FILE}`;
const bytes = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 109, 112, 52, 50]);
const upstream = (options = {}) => new Response(bytes, {
  headers: { "Content-Length": String(bytes.length), "Content-Type": "application/octet-stream" }, ...options,
});
const call = (request, fetcher) => handle(request, {}, undefined, { fetch: fetcher });

test("public brand MP4 streams from one repository without credentials, analytics or a database", async () => {
  const calls = [];
  const res = await call(new Request(URL, { headers: { Cookie: "private", Authorization: "Bearer private" } }), async (url, options) => {
    calls.push({ url, options });
    return upstream();
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "video/mp4");
  assert.equal(res.headers.get("Content-Length"), String(bytes.length));
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RAW);
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(Object.keys(calls[0].options.headers), ["User-Agent"]);
  assert.equal(calls[0].options.cf.cacheTtlByStatus["400-599"], -1);
});

test("HEAD asks upstream only for metadata and returns no body; existing CORS still applies", async () => {
  const res = await call(new Request(URL, { method: "HEAD", headers: { Origin: "https://internscout.org" } }), async (_url, options) => {
    assert.equal(options.method, "HEAD");
    return new Response(null, { headers: { "Content-Length": "42" } });
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Length"), "42");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://internscout.org");
  assert.equal(await res.text(), "");
});

test("paths, query strings and unsupported methods cannot make an arbitrary proxy request", async () => {
  const never = async () => assert.fail("invalid media request must not fetch");
  for (const tail of ["https://attacker.test/a.mp4", "../%2fsecret.mp4", "%2e%2e%2fsecret.mp4", `${FILE}?url=https://attacker.test`, `${FILE}?access_token=secret`, "2026-10-22-secret.json", `nested/${FILE}`, "2026-10-22-a%2fb.mp4"]) {
    const res = await call(new Request(`https://internscout-api.bpmcginley.workers.dev/social-video/${tail}`), never);
    assert.equal(res.status, 404, tail);
  }
  assert.equal((await call(new Request(URL, { method: "POST" }), never)).status, 405);
});

test("a single valid byte range is forwarded and total video size remains bounded", async () => {
  const res = await call(new Request(URL, { headers: { Range: "bytes=0-3" } }), async (_url, options) => {
    assert.equal(options.headers.Range, "bytes=0-3");
    return new Response(bytes.slice(0, 4), { status: 206, headers: { "Content-Length": "4", "Content-Range": "bytes 0-3/12" } });
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 0-3/12");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes.slice(0, 4));
  const invalid = await call(new Request(URL, { headers: { Range: "bytes=0-3,9-11" } }), async () => assert.fail());
  assert.equal(invalid.status, 416);
});

test("missing, oversized, malformed and unexpected upstream responses fail closed", async () => {
  for (const [response, expected] of [
    [new Response("missing", { status: 404 }), 404],
    [new Response("denied", { status: 403 }), 502],
    [new Response(null, { status: 301, headers: { Location: "https://attacker.test" } }), 502],
    [new Response("bad range", { status: 416 }), 416],
    [new Response("unknown size"), 502],
    [upstream({ headers: { "Content-Length": String(MAX_SOCIAL_VIDEO_BYTES + 1) } }), 502],
    [upstream({ headers: { "Content-Length": "-1" } }), 502],
    [upstream({ status: 206, headers: { "Content-Length": "12", "Content-Range": `bytes 0-11/${MAX_SOCIAL_VIDEO_BYTES + 1}` } }), 502],
  ]) {
    const res = await call(new Request(URL), async () => response);
    assert.equal(res.status, expected);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.doesNotMatch(await res.text(), /attacker|denied|unknown size/);
  }
  assert.equal((await call(new Request(URL), async () => { throw new Error("private upstream data"); })).status, 502);
});

test("the stream enforces declared byte length without buffering the whole video", async () => {
  const res = await call(new Request(URL), async () => upstream({ headers: { "Content-Length": "4" } }));
  await assert.rejects(res.arrayBuffer(), /exceeded its declared size/);
  const short = await call(new Request(URL), async () => upstream({ headers: { "Content-Length": "15" } }));
  await assert.rejects(short.arrayBuffer(), /incomplete/);
});
