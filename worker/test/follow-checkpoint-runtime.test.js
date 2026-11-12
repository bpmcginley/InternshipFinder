import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("isolated native checkpoint entry admission suite", () => {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.follow-checkpoint-runtime.config.js",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, CLOUDFLARE_CF_FETCH_ENABLED: "false" },
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    String(result.error ?? "") + (result.stdout + result.stderr).slice(-6000),
  );
});
