import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-signup-route.js";
import { loadFollowCatalog } from "../src/follow-catalog-loader.js";
import { createFollowSignupRoute } from "../src/follow-signup-route.js";

for (const [name, scenario] of Object.entries(scenarios))
  test(`follow signup route: ${name}`, () => scenario(fakeD1()));

test("signup composes the exact pinned loader and Python fixture without request-selected inputs", async () => {
  const bytes = readFileSync(new URL("./fixtures/follow-catalog-python.json", import.meta.url));
  const wire = JSON.parse(bytes),
    origin = "https://example.test",
    url = origin + "/qualified.json";
  let reads = 0;
  const loadCatalog = (...args) => {
    assert.equal(args.length, 0);
    return loadFollowCatalog({
      enabled: true,
      origin,
      maxBytes: bytes.length,
      maxKeys: 100,
      deadlineMs: 100,
      now: () => 1100,
      release: {
        url,
        sourceSha256: wire.source_sha256,
        catalogSha256: createHash("sha256").update(bytes).digest("hex"),
        notBefore: 1000,
        expiresAt: 2000,
      },
      previousValid: Object.fromEntries(
        Object.entries(wire.valid).map(([k, v]) => [k, new Set(v)]),
      ),
      fetch: async (target) => {
        reads++;
        assert.equal(target, url);
        const response = new Response(bytes);
        Object.defineProperty(response, "url", { value: url });
        return response;
      },
    });
  };
  const db = fakeD1(),
    handle = createFollowSignupRoute({
      enabled: true,
      dailyLimit: 2,
      originAllowed: (r) => r.headers.get("Origin") === origin,
      loadCatalog,
    });
  const request = new Request(origin + "/not-mounted", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "reader@example.test",
      link: false,
      scope: { kind: "company", company: "booz allen" },
    }),
  });
  assert.equal((await handle(request, { db })).status, 202);
  assert.equal(reads, 1);
  assert.equal(
    (await db.prepare("SELECT scope_key FROM follow_subscriptions").first()).scope_key,
    JSON.stringify({ kind: "company", company: "booz allen" }),
  );
});
