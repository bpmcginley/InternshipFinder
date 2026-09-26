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
  expect(body.providers.every((p) => p.scopes.includes("openid"))).toBe(true);
  expect(body.payments.enabled).toBe(false);
  expect(body.paused).toBe(false);
});

it("POST /ai without a token is 401", async () => {
  const res = await exports.default.fetch("https://internscout.test/ai", { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe("auth");
});

// Sessions and the saved Deep Dive: the SQL and WebCrypto calls behave the same in workerd as in Node.
it("GET /config offers sessions; an unknown session is 401 and signing one out is a no-op", async () => {
  const cfg = await (await exports.default.fetch("https://internscout.test/config")).json();
  expect(cfg.sessions).toBe(true);
  expect(cfg.sync).toBe(false);
  const unknown = { headers: { Authorization: "Bearer iss_" + "A".repeat(43) } };
  const me = await exports.default.fetch("https://internscout.test/me", unknown);
  expect(me.status).toBe(401);
  expect((await me.json()).message).toBe("Sign-in expired; sign in again");
  const out = await exports.default.fetch("https://internscout.test/session", { method: "DELETE", ...unknown });
  expect(await out.json()).toEqual({ ok: true });
});

it("profile encryption (HKDF-SHA256 -> AES-GCM-256) round-trips in the Workers runtime, per account", async () => {
  const { seal, unseal } = await import("../src/profile.js");
  const key = { PROFILE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
  const data = await seal(key, "user-a", JSON.stringify({ skills: ["Python"] }));
  expect(JSON.parse(await unseal(key, "user-a", data))).toEqual({ skills: ["Python"] });
  await expect(unseal(key, "user-b", data)).rejects.toThrow();
});
