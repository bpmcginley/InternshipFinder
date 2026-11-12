import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { admitFollowSignup } from "../src/follow-signup-admission.js";
import { createFollowSignupHttp } from "../src/follow-signup-http.js";
import * as scenarios from "../test-support/follow-signup-admission.js";

for (const [name, scenario] of Object.entries(scenarios))
  it(`local D1 signup admission: ${name}`, async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch(
      ["rate", "follow_subscribers"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    );
    await scenario(env.DB);
  });

it("bounded signup HTTP admits one exact pending job through actual D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    ["rate", "follow_subscribers"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  const origin = "https://example.test";
  const options = {
    enabled: true,
    dailyLimit: 2,
    catalog: { companies: new Set(["acme"]), fields: new Set(), states: new Set() },
  };
  const handle = createFollowSignupHttp({
    enabled: true,
    originAllowed: (request) => request.headers.get("Origin") === origin,
    admit: (input) => admitFollowSignup(env.DB, input, options),
  });
  const body = {
    email: "person@example.test",
    link: false,
    scope: { kind: "company", company: "acme" },
  };
  const post = (input) =>
    handle(
      new Request("https://api.example.test/follows/request", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  expect((await post({ ...body, link: true })).status).toBe(503);
  expect((await post({ ...body, scope: { kind: "company", company: "unknown" } })).status).toBe(
    400,
  );
  const accepted = await post(body);
  expect(accepted.status).toBe(202);
  expect(await accepted.text()).toBe("");
  expect((await post(body)).status).toBe(202);
  expect((await post(body)).status).toBe(503);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM follow_confirmation_outbox").first(),
  ).toEqual({ count: 1 });
  expect(await env.DB.prepare("SELECT calls FROM rate").first()).toEqual({ calls: 2 });
});
