import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test-checkpoint-integration/worker.js",
      remoteBindings: false,
      miniflare: {
        cf: false,
        compatibilityDate: "2026-09-01",
        durableObjects: { CHECKPOINT: { className: "CheckpointIntegration", useSQLite: true } },
        r2Buckets: ["SLOTS"],
        outboundService() {
          throw new Error("External requests forbidden in checkpoint qualification");
        },
      },
    }),
  ],
  test: { include: ["test-checkpoint-integration/*.test.js"] },
});
