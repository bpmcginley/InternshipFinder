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

for (const expireDuringRate of [false, true])
  test(`signup composes pinned loader, expiry during rate: ${expireDuringRate}`, async () => {
    const bytes = readFileSync(new URL("./fixtures/follow-catalog-python.json", import.meta.url));
    const wire = JSON.parse(bytes),
      origin = "https://example.test",
      url = origin + "/qualified.json";
    let reads = 0;
    let now = Date.now();
    const release = Object.freeze({
      url,
      sourceSha256: wire.source_sha256,
      catalogSha256: createHash("sha256").update(bytes).digest("hex"),
      notBefore: now - 1000,
      expiresAt: now + 60000,
    });
    const loadCatalog = async (...args) => {
      assert.equal(args.length, 0);
      const result = await loadFollowCatalog({
        enabled: true,
        origin,
        maxBytes: bytes.length,
        maxKeys: 100,
        deadlineMs: 100,
        now: () => now,
        release,
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
      return result.status === "available" ? { ...result, expiresAt: release.expiresAt } : result;
    };
    const db = fakeD1(),
      handle = createFollowSignupRoute({
        enabled: true,
        dailyLimit: 2,
        originAllowed: (r) => r.headers.get("Origin") === origin,
        loadCatalog,
        clock: () => new Date(now),
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
    const wrapper = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!expireDuringRate || !sql.startsWith("INSERT INTO rate")) return statement;
        return {
          bind: (...args) => ({
            run: async () => {
              const result = await statement.bind(...args).run();
              now = release.expiresAt;
              return result;
            },
          }),
        };
      },
      batch: (ss) => db.batch(ss),
    };
    assert.equal((await handle(request, { db: wrapper })).status, expireDuringRate ? 503 : 202);
    assert.equal(reads, 1);
    assert.deepEqual(
      await db.prepare("SELECT scope_key FROM follow_subscriptions").first(),
      expireDuringRate
        ? null
        : { scope_key: JSON.stringify({ kind: "company", company: "booz allen" }) },
    );
    assert.equal((await db.prepare("SELECT calls FROM rate").first()).calls, 1);
  });
