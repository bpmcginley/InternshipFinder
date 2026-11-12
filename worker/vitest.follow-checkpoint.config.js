import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    main: "./test-checkpoint/worker.js",
    miniflare: {
      compatibilityDate: "2026-09-01",
      durableObjects: {
        CHECKPOINT: { className: "FollowCheckpoint", useSQLite: true },
      },
    },
  })],
  test: { include: ["test-checkpoint/*.test.js"] },
});
