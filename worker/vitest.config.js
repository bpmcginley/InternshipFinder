// Runs test-workers/ inside the real Workers runtime (after `npm install`): `npm run test:workers`.
// The install-free suite is `node --test test/`.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: { include: ["test-workers/**/*.test.js"] },
});
