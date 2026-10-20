// Smoke tests in the Workers runtime with local D1. No provider requests or live database access.
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

beforeAll(async () => {
  await env.DB.batch(env.TEST_SCHEMA_SQL.map((s) => env.DB.prepare(s)));
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

it("D1 enforces field capacity and rolls back a whole reservation batch", async () => {
  const at = "2026-10-20T00:00:00Z";
  const day = "2026-11-01";
  const insert = (order, listing, field, expires = null) => env.DB.prepare(
    "INSERT INTO employer_capacity_reservations (order_id, listing_id, field, day, expires_at, checked_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(order, listing, field, day, expires, at);
  for (let n = 0; n < 5; n++) await insert(`runtime-${n}`, `listing-${n}`, "runtime-field").run();
  await expect(env.DB.batch([
    insert("runtime-sixth", "listing-sixth", "runtime-other"),
    insert("runtime-sixth", "listing-sixth", "runtime-field"),
  ])).rejects.toThrow(/employer_capacity_full/);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM employer_capacity_reservations WHERE field = 'runtime-field'").first("n")).toBe(5);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM employer_capacity_reservations WHERE order_id = 'runtime-sixth'").first("n")).toBe(0);
  await expect(insert("runtime-duplicate", "listing-0", "runtime-other").run()).rejects.toThrow(/employer_listing_taken/);

  // Expired checkout holds do not consume a current field slot.
  await insert("runtime-old", "listing-old", "runtime-expiring", "2026-10-19T00:00:00Z").run();
  for (let n = 0; n < 5; n++) await insert(`runtime-fresh-${n}`, `fresh-${n}`, "runtime-expiring").run();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM employer_capacity_reservations WHERE field = 'runtime-expiring' AND expires_at IS NULL").first("n")).toBe(5);
});
