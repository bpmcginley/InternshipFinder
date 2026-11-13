import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import {
  deploymentDefaultExportAdmitsGenesisAndPinnedContinuity,
  deploymentDescriptorRejectsMalformedAuthorityBeforeBodyOrIO,
} from "../test-support/follow-signup-release.js";

it("deployment default entry remains compatible with ordered schema through 0029", async () => {
  await applyD1Migrations(
    env.MIGRATION_DB,
    env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) <= 29),
  );
  await deploymentDescriptorRejectsMalformedAuthorityBeforeBodyOrIO();
  await deploymentDefaultExportAdmitsGenesisAndPinnedContinuity(env.MIGRATION_DB);
});
