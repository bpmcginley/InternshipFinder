// InternScout API Worker: sign-in check, the Gemini proxy with caps, and area demand. Contract: API.md.
import { CONFIG } from "./config.js";
import { HttpError, json } from "./http.js";
import { authenticateUser, providers } from "./auth.js";
import { callGemini, costCents, estimateCents, readUsageFromSSE, sanitizeRequest } from "./gemini.js";
import { admit, allowanceFor, cleanup, deleteUser, isPaused, monthOf, release, remainingOf, settle, usageFor } from "./limits.js";
import { cleanStates, demandCounts, dropStale, setDemand, touchSeen } from "./demand.js";
import { applyEvent, blocksDeletion, canUpgrade, checkout, deletePlan, paymentsInfo, paymentsOn, planOf, portal, verifyWebhook } from "./billing.js";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
// The extension's ID is fixed by the "key" in its manifest (same ID from the store and from Load unpacked),
// so it is named here instead of trusting every chrome-extension:// origin.
const EXTENSION_ORIGIN = "chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag";
const DEFAULT_ORIGINS = `https://bpmcginley.github.io,http://localhost:8000,${EXTENSION_ORIGIN}`;

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "X-InternScout-Model, X-InternScout-Remaining",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Background work that must not fail the response
function later(ctx, promise) {
  const p = promise.catch((e) => console.error("background task failed:", e && e.name));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

async function readJson(request, maxBytes, optional = false) {
  if (Number(request.headers.get("Content-Length")) > maxBytes) {
    throw new HttpError(400, "bad_request", "Request body is too large");
  }
  const text = await request.text();
  // was: text.length, which counts UTF-16 units. A body sent chunked (no Content-Length to check) and
  // written in three-byte characters came in at three times the cap, and the cost estimate made from
  // "bytes" was a third of what it should be.
  const size = new TextEncoder().encode(text).length;
  if (size > maxBytes) throw new HttpError(400, "bad_request", "Request body is too large");
  // Some routes take a body only to carry an optional choice, so no body means "use the default"
  // rather than a mistake.
  if (optional && !text.trim()) return { body: {}, bytes: 0 };
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== "object") throw new Error();
    return { body, bytes: size };   // was: bytes: text.length
  } catch {
    throw new HttpError(400, "bad_request", "Body must be a JSON object");
  }
}

// Constant-time compare of two secrets via their hashes
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

const allowanceTable = (config, fn) =>
  Object.fromEntries(Object.entries(config.TASKS).map(([task, c]) => [task, fn(task, c)]));

async function route(request, env, ctx, d) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const db = env.DB;
  const now = d.now();
  let who = { user: null, tier: "general" };   // set by signIn()
  const signIn = async () => (who = await authenticateUser(request, env, { fetch: d.fetch, now: now.getTime() })).user;
  const limits = (tier, plan = "free") => allowanceTable(d.config, (task) => allowanceFor(d.config, env, task, tier, plan, now));

  switch (`${request.method} ${path}`) {
    case "GET /config": {
      return json({
        providers: providers(env).map((p) => ({ ...p, scopes: d.config.SCOPES })),
        // One table per plan, so the dashboard can say what each tier actually buys before
        // a student pays. `general` is the non-.edu half of the free tier.
        allowance: {
          edu: limits("edu"),
          general: limits("general"),
          ...Object.fromEntries(d.config.PAID_PLANS.map((plan) => [plan, limits("edu", plan)])),
        },
        payments: paymentsInfo(env, d.config),
        paused: await isPaused(db, env, d.config, now),
      });
    }

    case "GET /me": {
      const user = await signIn();
      later(ctx, touchSeen(db, user, now));
      const month = monthOf(now);
      const used = await usageFor(db, user, month);
      const mine = await planOf(db, user);
      return json({
        month,
        plan: mine.plan,
        plan_renews: mine.periodEnd,
        can_upgrade: canUpgrade(env, d.config, mine.plan),
        can_manage: paymentsOn(env, d.config) && !!mine.customer,
        tier: who.tier,
        // isPaused takes a plan because the day's stop only applies to free accounts (limits.js).
        // `mine.plan` is already loaded above for plan/can_upgrade/allowance, so without passing it
        // here /me told a Supporter or Pro "AI is paused" on a day that POST /ai would have served
        // them. /config keeps the default, which is the honest answer before anyone has signed in.
        // was: paused: await isPaused(db, env, d.config, now),
        paused: await isPaused(db, env, d.config, now, mine.plan),
        allowance: allowanceTable(d.config, (task) => ({ used: used[task] || 0, limit: allowanceFor(d.config, env, task, who.tier, mine.plan, now) })),
      });
    }

    case "DELETE /me": {
      const user = await signIn();
      if (await blocksDeletion(db, user)) {
        throw new HttpError(409, "subscribed", "Cancel your paid plan first, then delete your data.");
      }
      await deleteUser(db, user, now);
      await deletePlan(db, user);
      return json({ ok: true });
    }

    // Stripe hosts both pages; we only hand out the link.
    case "POST /billing/checkout": {
      const user = await signIn();
      // The plan is optional: an older extension or dashboard that predates the second tier sends
      // nothing, and gets the cheapest plan on offer.
      const { body } = await readJson(request, d.config.MAX_BODY_BYTES, true);
      return json(await checkout(db, env, d.config, user, body.plan, now, d.fetch));
    }

    case "POST /billing/portal": {
      const user = await signIn();
      return json(await portal(db, env, d.config, user, d.fetch));
    }

    // Called by Stripe, not by a student: no sign-in, a signature instead.
    case "POST /billing/webhook": {
      if (!paymentsOn(env, d.config) || !env.STRIPE_WEBHOOK_SECRET) throw new HttpError(404, "not_found", "No such endpoint");
      const body = await request.text();
      if (body.length > d.config.MAX_BODY_BYTES) throw new HttpError(400, "bad_request", "Request body is too large");
      const event = await verifyWebhook(env.STRIPE_WEBHOOK_SECRET, request.headers.get("Stripe-Signature"), body, now);
      return json(await applyEvent(db, env, d.config, event, now, d.fetch));
    }

    case "POST /ai": {
      const user = await signIn();
      const { body, bytes } = await readJson(request, d.config.MAX_BODY_BYTES);
      const task = body.task;
      if (typeof task !== "string" || !Object.hasOwn(d.config.TASKS, task)) {
        throw new HttpError(400, "bad_task", "Unknown task");
      }
      if (body.run_id != null && !RUN_ID.test(String(body.run_id))) {
        throw new HttpError(400, "bad_request", "run_id must be 1-64 letters, digits, - or _");
      }
      // no run_id: every call is its own run
      const runId = body.run_id != null ? String(body.run_id) : "solo-" + crypto.randomUUID();
      const taskMax = d.config.TASKS[task].maxBodyBytes;
      if (taskMax && bytes > taskMax) throw new HttpError(400, "bad_request", "Request body is too large for this task");
      const gem = sanitizeRequest(body.request, task, d.config);
      const model = d.config.TASKS[task].model;
      const stream = url.searchParams.get("stream") === "1";

      const { plan } = await planOf(db, user);
      // The estimate is charged before Gemini is called and corrected after, so a call whose Worker
      // is cut off mid-reply (the student closes the tab) is still paid for in the books.
      const estimate = estimateCents(model, bytes, gem.generationConfig.maxOutputTokens, d.config, now);
      const admitted = await admit(db, env, d.config, user, task, runId, now, who.tier, plan, estimate);
      let upstream;
      try {
        upstream = await callGemini(model, gem, stream, env, d.fetch);
      } catch (e) {
        await release(db, user, task, runId, admitted);
        throw e;
      }
      later(ctx, touchSeen(db, user, now));

      const headers = { "X-InternScout-Model": model, "X-InternScout-Remaining": String(remainingOf(admitted)) };
      const price = (usage) => (usage ? costCents(model, usage, d.config, now) : estimate);

      if (stream) {
        const [client, meter] = upstream.body.tee();
        later(ctx, readUsageFromSSE(meter).then((u) => settle(db, user, admitted, price(u), u)));
        return new Response(client, {
          status: 200,
          headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      const text = await upstream.text();
      let usage = null;
      try {
        usage = JSON.parse(text).usageMetadata || null;
      } catch {}
      later(ctx, settle(db, user, admitted, price(usage), usage));
      return new Response(text, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
    }

    case "POST /demand": {
      const user = await signIn();
      const { body } = await readJson(request, 10_000);
      await setDemand(db, user, cleanStates(body), now);
      return json({ ok: true });
    }

    case "GET /demand": {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.DEMAND_TOKEN || !token || !(await sameSecret(token, env.DEMAND_TOKEN))) {
        throw new HttpError(401, "auth", "CI token required");
      }
      return json(await demandCounts(db, d.config, now));
    }
  }
  throw new HttpError(404, "not_found", "No such endpoint");
}

// deps (tests only): { fetch, now: () => Date, config }
export async function handle(request, env, ctx, deps = {}) {
  const d = { fetch: (...args) => fetch(...args), now: () => new Date(), config: CONFIG, ...deps };
  let res;
  try {
    res = request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await route(request, env, ctx, d);
  } catch (e) {
    if (e instanceof HttpError) {
      res = json({ error: e.code, message: e.message, ...e.extra }, e.status);
    } else {
      console.error("internal error:", e && e.name);
      res = json({ error: "server", message: "Internal error" }, 500);
    }
  }
  for (const [k, v] of Object.entries(corsHeaders(request, env))) res.headers.set(k, v);
  return res;
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled(event, env, ctx) {
    const now = new Date();
    ctx.waitUntil(Promise.all([cleanup(env.DB, now), dropStale(env.DB, CONFIG, now)]));
  },
};
