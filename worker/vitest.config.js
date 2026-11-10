// Runs test-workers/ inside the real Workers runtime (after `npm install`): `npm run test:workers`.
// The install-free suite is `node --test test/`.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery } from "wrangler";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Use the same parser as Wrangler's D1 migration helper. Splitting on semicolons breaks inline
      // comments and trigger bodies; this binding exists only in the local test runtime.
      miniflare: {
        d1Databases: ["DB", "MIGRATION_DB", "LEGACY_DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("./migrations", import.meta.url)),
          ),
          TEST_EXTRA_SCHEMA_SQL: ["order-mail-schema.sql", "campaign-report-schema.sql"].flatMap(
            (name) => unstable_splitSqlQuery(readFileSync(new URL(name, import.meta.url), "utf8")),
          ),
          TEST_SCHEMA_SQL: unstable_splitSqlQuery(
            readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
          ),
        },
      },
    }),
  ],
  test: { include: ["test-workers/**/*.test.js"] },
});
