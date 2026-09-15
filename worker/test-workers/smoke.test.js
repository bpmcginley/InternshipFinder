// Smoke test in the Workers runtime with a local D1. Not run yet; needs `npm install`.
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../schema.sql?raw";

beforeAll(async () => {
  const statements = schema
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
});

it("GET /config answers without sign-in", async () => {
  const res = await exports.default.fetch("https://internscout.test/config");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.scopes).toEqual(["openid", "email", "profile"]);
  expect(body.paused).toBe(false);
});

it("POST /ai without a token is 401", async () => {
  const res = await exports.default.fetch("https://internscout.test/ai", { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe("auth");
});
