// Test kit, no installs: a D1 fake over node:sqlite, an RSA keypair for ID tokens, and a fake fetch.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handle } from "../src/index.js";
import { clearJwksCache } from "../src/auth.js";
import { CONFIG } from "../src/config.js";

export const NOW = new Date("2026-09-14T10:05:30Z");
export const CLIENT = "client-123.apps.googleusercontent.com";
export const MS_CLIENT = "ms-client-456";
export const TENANT = "tenant-umass";

// Same surface as D1: prepare().bind().first/all/run, batch, exec. Plus dump() for assertions.
export function fakeD1() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (query, params = []) => ({
    bind: (...p) => stmt(query, p),
    first: async (col) => {
      const row = sql.prepare(query).get(...params);
      return row ? (col ? row[col] : { ...row }) : null;
    },
    all: async () => ({ success: true, meta: {}, results: sql.prepare(query).all(...params).map((r) => ({ ...r })) }),
    run: async () => {
      const r = sql.prepare(query).run(...params);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (query) => stmt(query),
    async batch(list) {
      sql.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        sql.exec("COMMIT");
        return out;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (query) => (sql.exec(query), { count: 1 }),
    dump() {
      const out = {};
      for (const t of ["usage", "runs", "rate", "demand", "budget", "plans", "stripe_events", "spend", "tokens", "forget"]) {
        out[t] = sql.prepare(`SELECT * FROM ${t}`).all().map((r) => ({ ...r }));
      }
      return out;
    },
  };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export async function makeKeys(kid = "k1") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" } };
}

let shared;
export const sharedKeys = () => (shared ||= makeKeys());

export async function signJwt(claims, privateKey, kid = "k1") {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export function googleClaims(now, over = {}) {
  const t = Math.floor(now.getTime() / 1000);
  return {
    iss: "https://accounts.google.com", aud: CLIENT, azp: CLIENT, sub: "109876543210",
    email: "student@umass.edu", email_verified: true, hd: "umass.edu", name: "Test Student",
    iat: t - 10, exp: t + 3600, ...over,
  };
}

export function microsoftClaims(now, over = {}) {
  const t = Math.floor(now.getTime() / 1000);
  return {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: MS_CLIENT, sub: "ms-subject-1", tid: TENANT,
    email: "student@umass.edu", xms_edov: true,
    preferred_username: "student@umass.edu", name: "Test Student", iat: t - 10, exp: t + 3600, ...over,
  };
}

export function makeEnv(extra = {}) {
  return {
    DB: fakeD1(),
    GOOGLE_CLIENT_ID: CLIENT, MS_CLIENT_ID: MS_CLIENT, EDU_EXTRA_DOMAINS: "", GENERAL_ALLOWANCE_PCT: "50",
    ALLOWED_ORIGINS: "https://bpmcginley.github.io,http://localhost:8000,chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag,chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi",
    MONTHLY_BUDGET_CENTS: "2500",
    GEMINI_API_KEY: "dummy-test-key", HASH_SALT: "test-salt", DEMAND_TOKEN: "ci-test-token",
    ...extra,
  };
}

export const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 100, totalTokenCount: 1300 };

export function geminiReply(url) {
  if (url.includes("alt=sse")) {
    const chunk = (text, usage) =>
      `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }], usageMetadata: usage })}\r\n\r\n`;
    const parts = [chunk("Hello ", { ...USAGE, candidatesTokenCount: 5 }), chunk("world", USAGE)];
    const body = new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }
  return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Hello world" }] } }], usageMetadata: USAGE });
}

// stripe(url, init) answers api.stripe.com; the default pretends every call succeeds.
export function stripeReply(url) {
  if (url.includes("checkout/sessions")) return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.test/pay/cs_test_1" });
  if (url.includes("billing_portal/sessions")) return Response.json({ id: "bps_1", url: "https://billing.stripe.test/p/1" });
  if (url.includes("subscriptions/")) return Response.json({ id: "sub_1", status: "active", current_period_end: 1794000000 });
  return Response.json({ error: { type: "invalid_request_error" } }, { status: 400 });
}

export function fakeFetch(jwks, gemini = geminiReply, stripe = stripeReply) {
  const calls = [];
  const fn = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    if (url.endsWith("/certs") || url.endsWith("/keys")) return Response.json({ keys: jwks });
    if (url.includes("generativelanguage.googleapis.com")) return gemini(url, init);
    if (url.startsWith("https://api.stripe.com/")) return stripe(url, init);
    return new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// The Deep Dive has no monthly cap (allowance null), but the cap tests were written against its old
// allowance of 2 a month, and they test the cap machinery rather than the Deep Dive. Passing this as
// `config` gives it that cap back for one test.
export const CAPPED_DEEP_DIVE = { TASKS: { ...CONFIG.TASKS, deep_dive: { ...CONFIG.TASKS.deep_dive, allowance: 2 } } };

// A Worker plus helpers: api(method, path, {token, body, headers}) and token(claimOverrides)
export async function setup({ env = {}, config = {}, gemini, stripe, now = NOW } = {}) {
  clearJwksCache();
  const keys = await sharedKeys();
  const e = makeEnv(env);
  const fetch = fakeFetch([keys.jwk], gemini, stripe);
  const cfg = { ...CONFIG, ...config };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const t = { now };
  const api = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const req = new Request("https://api.test" + path, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handle(req, e, ctx, { fetch, now: () => t.now, config: cfg });
    await Promise.all(pending.splice(0));
    return res;
  };
  // token(overrides) is a verified UMass Google token; token(overrides, "microsoft") a Microsoft one
  const token = (over = {}, provider = "google") =>
    signJwt((provider === "microsoft" ? microsoftClaims : googleClaims)(t.now, over), keys.privateKey);
  return { env: e, db: e.DB, fetch, api, token, keys, config: cfg, setNow: (d) => (t.now = d) };
}

export const aiBody = (task = "field_match", run_id, text = "hello") => ({
  task, run_id, request: { contents: [{ role: "user", parts: [{ text }] }] },
});
