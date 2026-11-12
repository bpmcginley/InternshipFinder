import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const digest = (character) => createHash("sha256").update(character.repeat(43)).digest("hex");

export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    wrangler: { configPath: "./wrangler.follow-checkpoint.toml" },
    miniflare: {
      bindings: {
        FOLLOW_CHECKPOINT_ORIGIN: "https://private-checkpoint.example.test",
        FOLLOW_CHECKPOINT_MAX_BYTES: "4096",
        FOLLOW_CHECKPOINT_WRITER_SHA256: digest("A"),
        FOLLOW_CHECKPOINT_OPERATOR_SHA256: digest("B"),
      },
    },
  })],
  test: { include: ["test-checkpoint-runtime/*.test.js"] },
});
