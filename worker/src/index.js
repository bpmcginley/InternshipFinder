// InternScout API Worker: sign-in check and sessions, the Gemini proxy with caps, area demand and the
// saved Deep Dive. Contract: API.md.
import { ROUTES } from "./api-contract.js";
import { CONFIG } from "./config.js";
import { HttpError, json, sameSecret } from "./http.js";
import { authenticateUser, bearerOf, providers, userHash, verifyIdToken } from "./auth.js";
import { copySession, createSession, dropExpiredSessions, endSession, isSessionToken, sessionInfo } from "./session.js";
import { MAX_PROFILE_BYTES, deleteProfile, getProfile, putProfile, requireSync, syncOn } from "./profile.js";
import { callGemini, costCents, estimateCents, readUsageFromSSE, sanitizeRequest } from "./gemini.js";
import { boundLegacySSE } from "./legacy-provider-response.js";
import { allowanceFor, cleanup, upgradeOffer, deleteUser, globalRpm, isPaused, monthOf, release, remainingOf, settle, shownLimit, usageFor } from "./limits.js";
import { admitAiLifecycle, fundedPurchaseCreationReady, respondFundedAi } from "./ai-lifecycle.js";
import { purchasedRunsFor } from "./funded-purchase.js";
import { bonusFor, claim, inviteInfo, noteAccount } from "./referral.js";
import { cleanStates, demandCounts, dropStale, setDemand, touchSeen } from "./demand.js";
import { countEvent, countHit } from "./visits.js";
import { createFollowManagementHttp } from "./follow-management-http.js";
import { createFollowManagementRequestHttp } from "./follow-management-request-http.js";
import { loadFollowCatalog, prepareFollowCatalogRelease } from "./follow-catalog-loader.js";
import { createFollowSignupRoute } from "./follow-signup-route.js";
import { prepareFollowSignupDeployment } from "./follow-signup-release.js";
import { runFollowScheduledMaintenance } from "./follow-scheduled-maintenance.js";
import { followTokenEndpoints } from "./follow-token-endpoint.js";
import { followUnsubscribeEndpoint } from "./follow-unsubscribe-endpoint.js";
import { topupCheckoutResponse, topupOfferResponse } from "./topup-checkout-http.js";
import { canRecoverAttachedTopup } from "./topup-attached-recovery.js";
import { topupRecoveryResponse } from "./topup-recovery-http.js";
import { prepareTopupStripe, topupConfigured, topupRecoveryConfigured } from "./topup-stripe.js";
import { createEmployerPostingRuntime, employerPostingReport } from "./employer-posting-runtime.js";
const employerPostingRuntime = createEmployerPostingRuntime();
import { CAMPAIGN_REPORT_CRON, expireCampaignReportMail, processCampaignReports } from "./campaign-reports.js";
import { CLOCK_CRON, startCatchup } from "./clock.js";
import { maintainEmployerPostings } from "./employer-posting-maintenance.js";
import { MAX_LEAD_BYTES, dropOldLeads, takeLead } from "./leads.js";
import { socialVideo } from "./social-video.js";
import { MAX_ADMIN_BYTES, checkPlacement, createPlacement, endExpiredPlacements, endPlacement, listLeads, listPlacements,
  livePlacements, pausePlacement, placementReport, refusePlacement, requireAdmin, rollupPlacementCounts, switchOn,
  updatePlacement } from "./placements.js";
import { applyEvent, blocksDeletion, canUpgrade, checkout, deletePlan, paymentsInfo, paymentsOn, planOf, portal, siteUrl, verifyWebhook, reconcileStudentBilling, STUDENT_BILLING_CRON } from "./billing.js";
import { listOrders } from "./orders/admin.js";
import { createPilotCode } from "./orders/pilot.js";
import { availability, notePlacementFields } from "./orders/capacity.js";
import { MAX_ORDER_BYTES } from "./orders/shared.js";
import { ordersCron } from "./orders/cron.js";
import { chooseCredit, creditInfo } from "./orders/refunds.js";
import { reviewDecision, reviewPage } from "./orders/review.js";
import { confirmOrder, takeOrder } from "./orders/checkout.js";
import { orderConfig, ordersOn, requireOrders } from "./orders/access.js";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
// InternScout's own extension IDs, named here instead of trusting every chrome-extension:// origin.
// was: one ID, on the belief that the manifest "key" gave the store the same ID as Load unpacked. It
// does not: the store zip drops "key", and the store assigned its own ID when the item was created.
const EXTENSION_ORIGINS = [
  "chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag",   // Load unpacked (fixed by the manifest "key")
  "chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi",   // Chrome Web Store
];
// internscout.org is the site's own domain. The github.io origin stays for tabs opened before the
// switch; GitHub Pages redirects every new visit to internscout.org.
const DASHBOARD_ORIGINS = ["https://internscout.org", "https://bpmcginley.github.io"];
const DEFAULT_ORIGINS = [...DASHBOARD_ORIGINS, "http://localhost:8000", ...EXTENSION_ORIGINS].join(",");

// Which client sent a request, by its Origin, for the funnel steps the Worker counts (visits.js
// countEvent, added 2026-10-04): "extension", "dashboard" (the site) or "worker" (anything else).
function clientOf(request) {
  const origin = request.headers.get("Origin") || "";
  if (EXTENSION_ORIGINS.includes(origin)) return "extension";
  if (DASHBOARD_ORIGINS.includes(origin)) return "dashboard";
  return "worker";
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    // was: "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // PUT is for PUT /profile; without it the browser's preflight refuses the save.
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "X-InternScout-Model, X-InternScout-Remaining",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Keep concurrency per isolate while binding authority and storage to each request.
const followManagement = createFollowManagementHttp({ enabled: true });
const followManagementRequest = createFollowManagementRequestHttp({ enabled: true });
const followSignup = createFollowSignupRoute({ enabled: true });
const followOriginAllowed = (request, env) =>
  request.headers.get("Origin") === "https://internscout.org" &&
  !!corsHeaders(request, env)["Access-Control-Allow-Origin"];
const followPolicyInteger = (value) => {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return String(parsed) === value ? parsed : NaN;
};

const manageFollow = (operation) => ({ request, env, db, d }) => {
  if (env.FOLLOW_MANAGEMENT_ENABLED !== "1")
    throw new HttpError(404, "not_found", "No such endpoint");
  return followManagement[operation](request, {
    db,
    now: d.now,
    originAllowed: (r) => followOriginAllowed(r, env),
  });
};

const requestFollowManagement = ({ request, env, db }) => {
  if (env.FOLLOW_MANAGEMENT_ENABLED !== "1" || env.FOLLOW_MANAGEMENT_REQUEST_ENABLED !== "1")
    throw new HttpError(404, "not_found", "No such endpoint");
  return followManagementRequest(request, {
    db,
    originAllowed: (r) => followOriginAllowed(r, env),
    ttlMs: followPolicyInteger(env.FOLLOW_MANAGEMENT_REQUEST_TTL_MS),
    dailyLimit: followPolicyInteger(env.FOLLOW_MANAGEMENT_REQUEST_DAILY_CAP),
  });
};

const followSignupClosed = () => json({ error: "not_found", message: "No such endpoint" }, 404);

function prepareFollowSignupAdmission({ db, now, d }) {
  let policy, dailyLimit, latest = +now;
  const clock = () => {
    const value = d.now(), at = +value;
    if (
      !(value instanceof Date) || !Number.isSafeInteger(at) || at < latest ||
      (policy && (at < policy.release.notBefore || at >= policy.release.expiresAt))
    ) throw new Error("Follow signup clock unavailable");
    latest = at;
    return new Date(at);
  };
  try {
    if (!Number.isSafeInteger(latest)) return followSignupClosed();
    const supplied = d.followSignupRelease();
    if (
      !supplied ||
      typeof supplied !== "object" ||
      Array.isArray(supplied) ||
      Object.keys(supplied).sort().join(",") !==
        "dailyLimit,deadlineMs,maxBytes,maxKeys,origin,previousValid,release"
    ) {
      void Promise.prototype.then.call(Promise.resolve(supplied), undefined, () => {});
      return followSignupClosed();
    }
    ({ dailyLimit } = supplied);
    policy = prepareFollowCatalogRelease(supplied);
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit <= 0 ||
        !Number.isFinite(+new Date(policy.release.expiresAt))) return followSignupClosed();
    clock();
  } catch {
    return followSignupClosed();
  }
  return {
    db,
    dailyLimit,
    clock,
    loadCatalog: async () => {
      const result = await loadFollowCatalog({
        ...policy, enabled: true, fetch: d.fetch, now: () => +clock(),
      });
      return result.status === "available"
        ? { ...result, expiresAt: policy.release.expiresAt }
        : result;
    },
  };
}

const signupFollow = ({ request, env, db, now, d }) => {
  if (env.FOLLOW_SIGNUP_ENABLED !== "1" ||
      (typeof d.followSignupRelease !== "function" && typeof env.FOLLOW_SIGNUP_RELEASE !== "string"))
    return followSignupClosed();
  return followSignup(request, {
    originAllowed: (r) => followOriginAllowed(r, env),
    prepareAdmission: () => {
      if (typeof d.followSignupRelease === "function")
        return prepareFollowSignupAdmission({ db, now, d });
      try {
        return { db, ...prepareFollowSignupDeployment(env.FOLLOW_SIGNUP_RELEASE, {
          fetch: d.fetch, now: d.now, initialTime: now instanceof Date ? +now : NaN,
        }) };
      } catch {
        return followSignupClosed();
      }
    },
  });
};

const topupOriginAllowed = (request, env) =>
  DASHBOARD_ORIGINS.includes(request.headers.get("Origin")) &&
  !!corsHeaders(request, env)["Access-Control-Allow-Origin"];

const dashboardTopupConfigured = (env) =>
  topupConfigured(env) &&
  DASHBOARD_ORIGINS.includes(siteUrl(env)) &&
  fundedPurchaseCreationReady(env);

const dashboardRecoveryRoot = (env) => {
  const root = siteUrl(env);
  return DASHBOARD_ORIGINS.includes(root) ? root + "/" : undefined;
};

const recoverDashboardTopup = ({ request, env, d }) =>
  topupRecoveryResponse({
    request,
    env,
    fetchImpl: d.fetch,
    clock: d.now,
    originAllowed: topupOriginAllowed,
    returnUrl: dashboardRecoveryRoot(env),
  });

function prepareDashboardTopup({ db, env, d }) {
  const salesReady = () => dashboardTopupConfigured(env) && globalRpm(env, d.config) > 0;
  return async (identity, fresh) => {
    if (!salesReady()) return { enabled: false };
    const canUseAutoApply = async () => {
      const { plan } = await planOf(db, identity.user);
      const at = fresh();
      return (
        allowanceFor(d.config, env, "autofill", identity.tier, plan, at) > 0 &&
        !(await isPaused(db, env, d.config, at, plan))
      );
    };
    if (!(await canUseAutoApply()) || !(Date.parse(identity.expires) > +fresh()) || !salesReady())
      return { enabled: false };
    const root = siteUrl(env) + "/";
    const adapter = await prepareTopupStripe(env, { success: root, cancel: root }, d.fetch);
    if (!adapter.enabled || !salesReady()) return { enabled: false };
    return (await canUseAutoApply()) && salesReady() ? adapter : { enabled: false };
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

// sameSecret (the constant-time compare GET /demand uses) lives in http.js since 2026-10-14, so the
// placement admin routes share it.

const allowanceTable = (config, fn) =>
  Object.fromEntries(Object.entries(config.TASKS).map(([task, c]) => [task, fn(task, c)]));

/**
 * @typedef {object} SafeRouteContext
 * @property {Request} request
 * @property {Parameters<typeof route>[1]} env
 * @property {Parameters<typeof route>[1]["DB"]} db
 * @property {Date} now
 * @property {Parameters<typeof route>[2]} ctx
 * @property {Parameters<typeof route>[3]} d
 * @property {URL} url
 * @property {string} path
 * @property {() => string} tier
 * @property {() => Promise<string>} signIn
 */
/** @typedef {(context: SafeRouteContext) => Promise<Response>} SafeRouteHandler */

// These wrappers preserve each selected route's gate, authentication and parsing order.
/**
 * @param {(context: SafeRouteContext, user: string) => Promise<Response>} handler
 * @returns {SafeRouteHandler}
 */
const withUser = (handler) => async (context) => handler(context, await context.signIn());
/**
 * @param {(context: SafeRouteContext, user: string) => Promise<Response>} handler
 * @returns {SafeRouteHandler}
 */
const withSyncUser = (handler) => async (context) => {
  requireSync(context.env);
  return handler(context, await context.signIn());
};
/**
 * @param {SafeRouteHandler} handler
 * @returns {SafeRouteHandler}
 */
const withAdmin = (handler) => async (context) => {
  await requireAdmin(context.request, context.env);
  return handler(context);
};

/** @type {Record<string, SafeRouteHandler>} */
const safeRouteHandlers = {
  // Token deletion stays available independently of future signup/sending switches.
  "POST /follows/unsubscribe": async ({ request, db, now }) => followUnsubscribeEndpoint(request, db, now),
  "POST /follows/confirm": async ({ request, db, d }) => followTokenEndpoints.confirm(request, db, d.now),
  "POST /follows/delete-request": async ({ request, db, d }) => followTokenEndpoints.deleteRequest(request, db, d.now),
  "POST /follows/manage/list": manageFollow("list"),
  "POST /follows/manage/remove": manageFollow("remove"),
  "POST /follows/manage/delete": manageFollow("deleteAll"),
  "POST /follows/manage/request": requestFollowManagement,
  "POST /follows/signup": signupFollow,

  // Stay signed in: trade a fresh provider ID token for a long-lived session token (session.js).
  // Only an ID token can start a session, so a stolen session token cannot make more of itself.
  "POST /session": async ({ request, env, db, now, ctx, d }) => {
    const token = bearerOf(request);
    if (!token || isSessionToken(token)) throw new HttpError(401, "auth", "Sign in with Google or Microsoft first");
    const { provider, claims, tier } = await verifyIdToken(token, env, { fetch: d.fetch, now: now.getTime() });
    const user = await userHash(provider, claims, env);
    const { token: session, expires } = await createSession(db, { user, tier, provider }, now);
    // A sign-in from the extension, the step between the store click and a first Auto-Apply that
    // nothing counted before (2026-10-04). Counts sign-ins, not accounts; new_account counts those.
    if (clientOf(request) === "extension") later(ctx, countEvent(db, now.toISOString(), "ext_signin", "extension"));
    // The email is echoed for the client to show ("Signed in as ..."); it is not stored.
    const email = claims.email || claims.preferred_username || null;
    return json({ session, account: user.slice(0, 16), email, provider, tier, expires });
  },

  // Is this session token live, and whose is it (2026-10-14, U8)? Only a session token: an ID token is
  // 401, since it already says all this about itself. Used by the extension to check the sign-in the
  // dashboard offers it. Answers { account, provider, tier, expires, copyable }; no email (not stored).
  "GET /session": async ({ request, db, now, ctx }) => {
    const token = bearerOf(request);
    if (!token || !isSessionToken(token)) throw new HttpError(401, "auth", "Send a session token");
    return json(await sessionInfo(db, token, { now: now.getTime(), later: (p) => later(ctx, p) }));
  },

  // A separate session for the same account, from a session token (2026-10-14): the extension takes over
  // the dashboard's sign-in with it, so signing out of one leaves the other signed in. Once per session,
  // never from a copy (session.js copySession). Same reply as POST /session, without the email.
  "POST /session/copy": async ({ request, db, now }) => {
    const token = bearerOf(request);
    if (!token || !isSessionToken(token)) throw new HttpError(401, "auth", "Send a session token");
    return json(await copySession(db, token, { now: now.getTime() }));
  },

  "DELETE /session": async ({ request, db }) => {
    await endSession(db, bearerOf(request));
    return json({ ok: true });
  },

  // The saved Deep Dive (profile.js). All three answer 503 sync_off until PROFILE_KEY is set.
  "GET /profile": withSyncUser(async ({ db, env }, user) => {
    return json(await getProfile(db, env, user));
  }),

  "PUT /profile": withSyncUser(async ({ request, db, env, now }, user) => {
    const { body } = await readJson(request, MAX_PROFILE_BYTES);
    return json(await putProfile(db, env, user, body, now.getTime()));
  }),

  "DELETE /profile": withSyncUser(async ({ db }, user) => {
    await deleteProfile(db, user);
    return json({ ok: true });
  }),

  "POST /demand": withUser(async ({ request, db, now }, user) => {
    const { body } = await readJson(request, 10_000);
    await setDemand(db, user, cleanStates(body), now);
    return json({ ok: true });
  }),

  // One page load on the site (docs/js/count.js, sent with sendBeacon): adds one to the day's exact
  // visit totals (visits.js). No sign-in, nothing about the visitor kept.
  "POST /hit": async ({ request, env, db, now, d }) => {
    const { body } = await readJson(request, 2_000);
    await countHit(db, request, body, now, employerPostingRuntime.service(env, db, d.fetch, d.now));
    return new Response(null, { status: 204 });
  },

  // The interest form on /employers/ (leads.js, added 2026-10-13): no sign-in, the site's Origin only,
  // a honeypot, and a per-address daily limit. Stores the lead for Bruce to read; takes no payment.
  "POST /employer-interest": async ({ request, db, env, now, ctx }) => {
    const { body } = await readJson(request, MAX_LEAD_BYTES);
    return json(await takeLead(db, request, env, body, now, (p) => later(ctx, p)));
  },

  "GET /admin/leads": withAdmin(async ({ db }) => {
    return json(await listLeads(db));
  }),

  // 2026-10-23: aggregate employer funnel for the owner's terminal. Revert: remove this route.
  "GET /admin/employer-metrics": withAdmin(employerPostingReport),

  "GET /demand": async ({ request, env, db, d, now }) => {
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.DEMAND_TOKEN || !token || !(await sameSecret(token, env.DEMAND_TOKEN))) {
      throw new HttpError(401, "auth", "CI token required");
    }
    return json(await demandCounts(db, d.config, now));
  },

  "GET /config": async ({ db, env, d, now }) => {
    const limits = (tier, plan = "free") => allowanceTable(d.config, (task) => allowanceFor(d.config, env, task, tier, plan, now));
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
      ...(dashboardTopupConfigured(env) ? { topups: true } : {}),
      paused: await isPaused(db, env, d.config, now),
      // What an invite is worth (REFERRAL in config.js), so the dashboard can offer it before sign-in.
      invite: { bonus: d.config.REFERRAL.bonus, max: d.config.REFERRAL.maxRewards },
      // "Stay signed in" (POST /session) is always on; saving the Deep Dive needs the PROFILE_KEY secret.
      sessions: true,
      sync: syncOn(env),
    });
  },

  "GET /me": async ({ request, db, env, now, ctx, d, signIn, tier }) => {
    const user = await signIn();
    // was: later(ctx, Promise.all([touchSeen(db, user, now), noteAccount(db, user, now)]));
    later(ctx, Promise.all([touchSeen(db, user, now), noteAccount(db, user, now, clientOf(request))]));
    const month = monthOf(now);
    const used = await usageFor(db, user, month);
    const mine = await planOf(db, user);
    const [extra, purchased] = await Promise.all([bonusFor(db, user), purchasedRunsFor(db, user)]);
    const token = bearerOf(request);
    const canRecover = topupRecoveryConfigured(env) && dashboardRecoveryRoot(env) &&
      isSessionToken(token) && await canRecoverAttachedTopup(db, user, token);
    const usablePurchased = purchased > 0 && fundedPurchaseCreationReady(env) ? purchased : 0;
    const body = {
      month,
      plan: mine.plan,
      plan_renews: mine.periodEnd,
      can_upgrade: canUpgrade(env, d.config, mine.plan),
      // The next plan up and its allowances at this student's tier (null when there is none).
      upgrade_offer: upgradeOffer(env, d.config, tier(), mine.plan, now),
      can_manage: paymentsOn(env, d.config) && !!mine.customer,
      ...(canRecover ? { can_recover_topup: true } : {}),
      tier: tier(),
      // isPaused takes a plan because the day's stop only applies to free accounts (limits.js).
      // `mine.plan` is already loaded above for plan/can_upgrade/allowance, so without passing it
      // here /me told a Supporter or Pro "AI is paused" on a day that POST /ai would have served
      // them. /config keeps the default, which is the honest answer before anyone has signed in.
      // was: paused: await isPaused(db, env, d.config, now),
      paused: await isPaused(db, env, d.config, now, mine.plan),
      // was: allowance: allowanceTable(d.config, (task) => ({ used: used[task] || 0, limit: allowanceFor(d.config, env, task, tier(), mine.plan, now) })),
      // Keep the compatibility remainder accurate while exposing the two credit sources separately.
      allowance: allowanceTable(d.config, (task) => {
        const limit = allowanceFor(d.config, env, task, tier(), mine.plan, now);
        const usedRuns = used[task] || 0;
        const invite = extra[task] || 0;
        const bought = task === "autofill" ? purchased : 0;
        const paidInLimit = bought && limit > 0 ? usablePurchased : 0;
        return {
          used: usedRuns,
          limit: shownLimit(limit, usedRuns, invite + paidInLimit),
          ...(limit != null && invite > 0 ? { bonus: invite } : {}),
          ...(bought > 0 ? { purchased: bought } : {}),
        };
      }),
    };
    return json(body, 200, { "Cache-Control": "no-store" });
  },

  "DELETE /me": async ({ db, env, now, d, signIn }) => {
    const user = await signIn();
    if (await blocksDeletion(db, user, env, d.fetch)) {
      throw new HttpError(409, "subscribed", "Cancel any active plan and finish or let your pending checkout expire before deleting your data. Contact support if a billing confirmation is pending.");
    }
    await deleteUser(db, user, now);
    await deletePlan(db, user);
    return json({ ok: true });
  },

  // Stripe hosts both pages; we only hand out the link.
  "POST /billing/checkout": async ({ request, db, env, now, d, signIn }) => {
    const user = await signIn();
    // The plan is optional: an older extension or dashboard that predates the second tier sends
    // nothing, and gets the cheapest plan on offer.
    const { body } = await readJson(request, d.config.MAX_BODY_BYTES, true);
    return json(await checkout(db, env, d.config, user, body.plan, now, d.fetch));
  },

  "GET /billing/topup/offer": async ({ request, db, env, d }) => {
    const noStore = { "Cache-Control": "no-store" };
    if (!dashboardTopupConfigured(env)) return json({ status: "disabled" }, 503, noStore);
    if (!topupOriginAllowed(request, env))
      return json({ status: "unavailable" }, 403, noStore);
    return topupOfferResponse({
      request,
      db,
      clock: d.now,
      prepareAdapter: prepareDashboardTopup({ db, env, d }),
    });
  },

  "POST /billing/topup/checkout": async ({ request, db, env, d }) => {
    const noStore = { "Cache-Control": "no-store" };
    if (env.TOPUPS_ENABLED !== "1" || !paymentsOn(env))
      return json({ status: "disabled" }, 503, noStore);
    if (!topupOriginAllowed(request, env))
      return json({ status: "unavailable" }, 403, noStore);
    return topupCheckoutResponse({
      request,
      db,
      clock: d.now,
      prepareAdapter: prepareDashboardTopup({ db, env, d }),
    });
  },

  "POST /billing/topup/recover": recoverDashboardTopup,

  "POST /billing/portal": async ({ db, env, d, signIn }) => {
    const user = await signIn();
    return json(await portal(db, env, d.config, user, d.fetch));
  },

  // Called by Stripe, not by a student: no sign-in, a signature instead.
  // was: if (!paymentsOn(env, d.config) || !env.STRIPE_WEBHOOK_SECRET) throw ...
  // Since 2026-10-19 the same endpoint also takes the paid listing orders' payments (orders.js), which
  // can be on while the student plans are off.
  "POST /billing/webhook": async ({ request, db, env, now, d }) => {
    if ((!paymentsOn(env, d.config) && !ordersOn(env) && !topupRecoveryConfigured(env)) || !env.STRIPE_WEBHOOK_SECRET) throw new HttpError(404, "not_found", "No such endpoint");
    const body = await request.text();
    if (body.length > d.config.MAX_BODY_BYTES) throw new HttpError(400, "bad_request", "Request body is too large");
    const event = await verifyWebhook(env.STRIPE_WEBHOOK_SECRET, request.headers.get("Stripe-Signature"), body, now);
    return json(await applyEvent(db, env, d.config, event, now, d.fetch));
  },

  "POST /ai": async ({ request, db, env, now, ctx, d, url, signIn, tier }) => {
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
    const admission = await admitAiLifecycle(db, env, d.config, user, task, runId, now, tier(), plan, estimate);
    if (admission.kind === "funded") {
      const result = await respondFundedAi(admission, { env, config: d.config, fetcher: d.fetch, model, gem, stream, now, db });
      later(ctx, result.completion);
      later(ctx, Promise.all([touchSeen(db, user, now), noteAccount(db, user, now, clientOf(request))]));
      return result.response;
    }
    const admitted = admission.admitted;
    let upstream;
    try {
      upstream = await callGemini(model, gem, stream, env, d.fetch);
    } catch (e) {
      await release(db, user, task, runId, admitted);
      throw e;
    }
    // was: later(ctx, Promise.all([touchSeen(db, user, now), noteAccount(db, user, now)]));
    later(ctx, Promise.all([touchSeen(db, user, now), noteAccount(db, user, now, clientOf(request))]));

    const headers = { "X-InternScout-Model": model, "X-InternScout-Remaining": String(remainingOf(admitted)) };
    const price = (usage) => (usage ? costCents(model, usage, d.config, now) : estimate);

    if (stream) {
      const bounded = boundLegacySSE(upstream.body);
      const [client, meter] = bounded.body.tee();
      later(ctx, readUsageFromSSE(meter).then(async (u) => {
        // Retain first-autofill and ordinary error settlement. Only a byte cutoff
        // discards provisional usage and keeps the already charged estimate.
        const usage = await bounded.completed === "limited" ? null : u;
        await settle(db, user, admitted, price(usage), usage, { task, model });
      }));
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
    later(ctx, settle(db, user, admitted, price(usage), usage, { task, model }));
    return new Response(text, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
  },

  // Referral credits (referral.js). The link a student shares, and a new classmate claiming it.
  "GET /invite": async ({ db, env, now, d, signIn }) => {
    const user = await signIn();
    return json(await inviteInfo(db, env, d.config, user, now));
  },

  "POST /invite/claim": async ({ request, db, now, d, signIn, tier }) => {
    const user = await signIn();
    const { body } = await readJson(request, 1_000);
    return json(await claim(db, d.config, user, tier(), body.code, now));
  },

  // Paid listings (placements.js, added 2026-10-14). The public read is for the site build, once per
  // deploy; visitors never call it. Payment never changes a score, order, filter or count.
  "GET /placements": async ({ db, now }) => {
    return json(await livePlacements(db, now), 200, { "Cache-Control": "public, max-age=300" });
  },

  // Bruce's terminal only (scripts/placement.mjs): 404 until ADMIN_TOKEN is set, 403 from a browser,
  // 401 without the token. The id goes in the body because the router matches exact paths.
  "GET /admin/placements": async ({ request, db, env }) => {
    await requireAdmin(request, env);
    return json(await listPlacements(db));
  },

  // The employer report (S9): one placement, one ended month, rounded counts only (placements.js).
  "POST /admin/placements/report": async ({ request, db, env, now }) => {
    await requireAdmin(request, env);
    const { body } = await readJson(request, MAX_ADMIN_BYTES);
    return json({ report: await placementReport(db, body, now) });
  },
  "POST /admin/placements": changeAdminPlacement,
  "POST /admin/placements/update": changeAdminPlacement,
  "POST /admin/placements/check": changeAdminPlacement,
  "POST /admin/placements/on": changeAdminPlacement,
  "POST /admin/placements/pause": changeAdminPlacement,
  "POST /admin/placements/end": changeAdminPlacement,
  "POST /admin/placements/refuse": changeAdminPlacement,

  // Paid listings bought on the site (orders.js, added 2026-10-19; worker/ORDERS.md). Every route but
  // the config answers 404 until ordersOn(env). The order, confirm and credit choice take the site's
  // Origin only; the review page is Bruce's, signed with ADMIN_TOKEN, and answers HTML.
  "GET /employer/config": async ({ env }) => {
    return json(orderConfig(env));
  },

  "GET /employer/availability": async ({ db, env, url, now, d }) => {
    requireOrders(env);
    return json(await availability(db, env, url.searchParams, now, d.fetch));
  },

  "POST /employer/order": async ({ request, db, env, now, d }) => {
    requireOrders(env);
    const { body } = await readJson(request, MAX_ORDER_BYTES);
    return json(await takeOrder(db, env, request, body, now, d.fetch));
  },

  "POST /employer/order/confirm": async ({ request, db, env, now, d }) => {
    requireOrders(env);
    const { body } = await readJson(request, MAX_ORDER_BYTES);
    return json(await confirmOrder(db, env, request, body, now, d.fetch));
  },

  "GET /employer/review": async ({ db, env, url, now, d }) => {
    requireOrders(env);
    return reviewPage(db, env, url.searchParams, now, d.fetch);
  },

  "POST /employer/review": async ({ request, db, env, now, d }) => {
    requireOrders(env);
    return reviewDecision(db, env, request, now, d.fetch);
  },

  "GET /employer/credit": async ({ db, env, url, now }) => {
    requireOrders(env);
    return json(await creditInfo(db, url.searchParams, now));
  },

  "POST /employer/credit": async ({ request, db, env, now, d }) => {
    requireOrders(env);
    const { body } = await readJson(request, MAX_ORDER_BYTES);
    return json(await chooseCredit(db, env, request, body, now, d.fetch));
  },

  // Bruce's terminal (scripts/placement.mjs orders, pilot-code): the same admin rules as the placements.
  // Not tied to ordersOn, so pilot codes can be made before buying opens.
  "GET /admin/orders": async ({ request, db, env }) => {
    await requireAdmin(request, env);
    return json(await listOrders(db));
  },

  "POST /admin/pilot-codes": async ({ request, db, env, now }) => {
    await requireAdmin(request, env);
    const { body } = await readJson(request, MAX_ADMIN_BYTES, true);
    if (Array.isArray(body)) throw new HttpError(400, "bad_request", "Body must be a JSON object");
    return json(await createPilotCode(db, body, now));
  },
};

/** @param {SafeRouteContext} context */
async function changeAdminPlacement({ request, db, env, now, ctx, d, path }) {
  await requireAdmin(request, env);
  const { body } = await readJson(request, MAX_ADMIN_BYTES);
  if (Array.isArray(body)) throw new HttpError(400, "bad_request", "Body must be a JSON object");
  const act = { "/admin/placements": createPlacement, "/admin/placements/update": updatePlacement,
    "/admin/placements/check": checkPlacement, "/admin/placements/on": switchOn, "/admin/placements/pause": pausePlacement,
    "/admin/placements/end": endPlacement, "/admin/placements/refuse": refusePlacement }[path];
  // These legacy admin writes do not share the order's atomic capacity transaction. Keep them
  // unavailable during live checkout rather than allow a manual edit to bypass the field cap.
  // Stops remain available; paid-order approval uses its own reserved, reviewed path.
  if (ordersOn(env) && (path === "/admin/placements/on" || path === "/admin/placements/update")) {
    throw new HttpError(409, "manual_capacity_hold", "Manual activation and edits are paused while employer checkout is open. Use the order review flow, or reconcile outstanding orders before maintenance. Pause and end remain available.");
  }
  // was: return json({ placement: await act(db, body, now) });
  const placement = await act(db, body, now);
  // A placement made by hand counts toward the orders' per-field cap under its role's fields (orders.js
  // notePlacementFields; the daily cron catches any this misses).
  if ((path === "/admin/placements" || path === "/admin/placements/update") && ordersOn(env)) {
    later(ctx, notePlacementFields(db, env, placement.id, d.fetch, now));
  }
  return json({ placement });
}

// The API contract supplies the dispatch keys. Descriptive auth and gate text stays documentation.
const exactRoutes = new Map(ROUTES.map(({ method, path }) => {
  const key = `${method} ${path}`;
  return [key, safeRouteHandlers[key]];
}));

async function route(request, env, ctx, d) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const db = env.DB;
  const now = d.now();
  // Brand media has no account/session access, analytics, writes, or arbitrary upstream URLs.
  if (path.startsWith("/social-video/")) return socialVideo(request, d.fetch);
  let who = { user: null, tier: "general" };   // set by signIn()
  // was: const signIn = async () => (who = await authenticateUser(request, env, { fetch: d.fetch, now: now.getTime() })).user;
  // `later` carries a session's once-a-day refresh past the response (session.js sessionUser).
  const signIn = async () => (who = await authenticateUser(request, env,
    { fetch: d.fetch, now: now.getTime(), later: (p) => later(ctx, p) })).user;

  const key = `${request.method} ${path}`;
  const handler = exactRoutes.get(key);
  if (handler) return handler({ request, env, db, now, ctx, d, url, path, signIn, tier: () => who.tier });
  if (path === "/billing/topup/recover") return recoverDashboardTopup({ request, env, d });
  throw new HttpError(404, "not_found", "No such endpoint");
}

// deps (tests only): { fetch, now: () => Date, config, followSignupRelease }
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
  // A just-pushed media file can briefly be missing. Never cache a failed public media lookup.
  if (res.status >= 400 && new URL(request.url).pathname.startsWith("/social-video/")) {
    res.headers.set("Cache-Control", "no-store");
  }
  for (const [k, v] of Object.entries(corsHeaders(request, env))) res.headers.set(k, v);
  if (res.status === 429 && res.headers.has("Access-Control-Allow-Origin") &&
      new URL(request.url).pathname.replace(/\/+$/, "") === "/billing/topup/recover")
    res.headers.append("Access-Control-Expose-Headers", "Retry-After");
  return res;
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled(event, env, ctx) {
    // The half-hourly trigger is the repository's clock (clock.js); the daily one is the cleanup.
    if (event && event.cron === CLOCK_CRON) {
      ctx.waitUntil(startCatchup(env).catch((e) => console.error("clock failed:", e && e.name)));
      if (env.EMPLOYER_POSTING_MAINTENANCE_ENABLED === "1") {
        ctx.waitUntil(maintainEmployerPostings(env.DB, { enabled: true }));
      }
      return;
    }
    if (event && event.cron === STUDENT_BILLING_CRON) {
      ctx.waitUntil(reconcileStudentBilling(env.DB, env, new Date()));
      return;
    }
    // 2026-10-23: was: reports shared financial cleanup's D1 budget. A separate bounded invocation
    // keeps report work below the Free plan's limit without relying on the account's plan.
    // Revert: remove this cron branch and its trigger, retaining report outbox tombstones.
    if (event && event.cron === CAMPAIGN_REPORT_CRON) {
      const reportJob = async () => {
        await expireCampaignReportMail(env.DB, new Date());
        if (env.EMPLOYER_REPORTS === "1") await processCampaignReports(env.DB, env, new Date());
      };
      ctx.waitUntil(reportJob());
      return;
    }
    const followCron = env.FOLLOW_MAINTENANCE_CRON;
    if (
      typeof followCron === "string" &&
      followCron.length > 0 &&
      followCron !== "17 7 * * *" &&
      event?.cron === followCron
    ) {
      if (env.FOLLOW_MAINTENANCE_ENABLED === "1") {
        ctx.waitUntil(runFollowScheduledMaintenance(env.DB, env.FOLLOW_MAINTENANCE_POLICY));
      }
      return;
    }
    const now = new Date();
    // was: ctx.waitUntil(Promise.all([cleanup(env.DB, now), dropStale(env.DB, CONFIG, now)]));
    // was: ctx.waitUntil(Promise.all([cleanup(env.DB, now), dropStale(env.DB, CONFIG, now), dropExpiredSessions(env.DB, now)]));
    // dropOldLeads (2026-10-13): employer form leads older than a year (leads.js LEAD_DAYS).
    // was: ctx.waitUntil(Promise.all([cleanup(env.DB, now), dropStale(env.DB, CONFIG, now), dropExpiredSessions(env.DB, now),
    //   dropOldLeads(env.DB, now)]));
    // endExpiredPlacements (2026-10-14): placements whose end day has come (placements.js).
    // rollupPlacementCounts (2026-10-14, S9): daily paid-listing counts older than 400 days become monthly rows.
    // was: ctx.waitUntil(Promise.all([..., dropOldLeads(env.DB, now), endExpiredPlacements(env.DB, now)]));
    // ordersCron (2026-10-19, orders.js): drops orders never confirmed; and while orders are on, resends
    // review emails, reminds Bruce once, closes roles every build dropped and settles unused-day offers.
    // was: ctx.waitUntil(Promise.all([..., endExpiredPlacements(env.DB, now), rollupPlacementCounts(env.DB, now)]));
    // 2026-10-23: was: expiry and order reconciliation raced. Keep the two in order; reports have
    // their own later daily trigger and recheck final state. Revert: restore the parallel cleanup.
    const employerJobs = async () => {
      await endExpiredPlacements(env.DB, now);
      await ordersCron(env.DB, env, now);
      await rollupPlacementCounts(env.DB, now);
    };
    ctx.waitUntil(Promise.all([cleanup(env.DB, now), dropStale(env.DB, CONFIG, now), dropExpiredSessions(env.DB, now),
      dropOldLeads(env.DB, now), expireCampaignReportMail(env.DB, now), employerJobs()]));
  },
};
