// Runs test-workers/ inside the real Workers runtime (after `npm install`): `npm run test:workers`.
// The install-free suite is `node --test test/`.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { unstable_splitSqlQuery } from "wrangler";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.toml" },
    // Use the same parser as Wrangler's D1 migration helper. Splitting on semicolons breaks inline
    // comments and trigger bodies; this binding exists only in the local test runtime.
    miniflare: { bindings: { TEST_SCHEMA_SQL: unstable_splitSqlQuery(readFileSync(new URL("./schema.sql", import.meta.url), "utf8")) } },
  })],
  test: { include: ["test-workers/**/*.test.js"] },
});
