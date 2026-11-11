import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { handle } from "../src/index.js";
import { createSession } from "../src/session.js";
import { NOW, makeEnv } from "../test/helpers.js";

const site = "https://internscout.org";
const origin = { Origin: site };
const admin = { Authorization: "Bearer fixture-admin" };
const media = "/social-video/2026-09-14-example.mp4";
const rawMedia =
  "https://raw.githubusercontent.com/bpmcginley/InternshipFinder/social-cards/2026-09-14-example.mp4";
const malformed = { body: "{" };
const profile = { sync: true };
const session = { session: true };

function request(label, method, path, options = {}) {
  return { label, method, path, ...options };
}

// Every exact route gets a request against the unchanged router. Additional cases
// exercise observable precedence and transports, with providers unreachable.
export const exactCases = [
  request("config", "GET", "/config"),
  request("me-no-session", "GET", "/me"),
  request("session-create-no-provider", "POST", "/session"),
  request("session-read-no-token", "GET", "/session"),
  request("session-copy-no-token", "POST", "/session/copy"),
  request("session-delete-no-token", "DELETE", "/session"),
  request("profile-read-sync-off", "GET", "/profile"),
  request("profile-write-sync-off", "PUT", "/profile", malformed),
  request("profile-delete-sync-off", "DELETE", "/profile"),
  request("me-delete-no-session", "DELETE", "/me"),
  request("billing-checkout-auth-before-body", "POST", "/billing/checkout", malformed),
  request("billing-portal-no-session", "POST", "/billing/portal"),
  request("billing-webhook-disabled", "POST", "/billing/webhook", malformed),
  request("ai-auth-before-body", "POST", "/ai", malformed),
  request("invite-no-session", "GET", "/invite"),
  request("invite-claim-auth-before-body", "POST", "/invite/claim", malformed),
  request("demand-write-auth-before-body", "POST", "/demand", malformed),
  request("hit", "POST", "/hit", { body: "{}", headers: origin }),
  request("lead-malformed", "POST", "/employer-interest", malformed),
  request("placements-public", "GET", "/placements"),
  request("admin-placements-disabled", "GET", "/admin/placements"),
  request("admin-leads-disabled", "GET", "/admin/leads"),
  request("admin-metrics-disabled", "GET", "/admin/employer-metrics"),
  request("admin-placement-report-disabled", "POST", "/admin/placements/report", malformed),
  request("admin-placement-create-disabled", "POST", "/admin/placements", malformed),
  request("admin-placement-update-disabled", "POST", "/admin/placements/update", malformed),
  request("admin-placement-check-disabled", "POST", "/admin/placements/check", malformed),
  request("admin-placement-on-disabled", "POST", "/admin/placements/on", malformed),
  request("admin-placement-pause-disabled", "POST", "/admin/placements/pause", malformed),
  request("admin-placement-end-disabled", "POST", "/admin/placements/end", malformed),
  request("admin-placement-refuse-disabled", "POST", "/admin/placements/refuse", malformed),
  request("order-config-disabled", "GET", "/employer/config"),
  request("availability-disabled", "GET", "/employer/availability"),
  request("order-disabled-before-body", "POST", "/employer/order", malformed),
  request("confirm-disabled-before-body", "POST", "/employer/order/confirm", malformed),
  request("review-read-disabled", "GET", "/employer/review"),
  request("review-write-disabled", "POST", "/employer/review", malformed),
  request("credit-read-disabled", "GET", "/employer/credit"),
  request("credit-write-disabled-before-body", "POST", "/employer/credit", malformed),
  request("admin-orders-disabled", "GET", "/admin/orders"),
  request("admin-pilot-disabled-before-body", "POST", "/admin/pilot-codes", malformed),
  request("demand-read-no-token", "GET", "/demand"),
];

export const responseCases = [
  ...exactCases,
  request("config-path-normalized", "GET", "/config///?ignored=1", { headers: origin }),
  request("config-origin-not-allowed", "GET", "/config", {
    headers: { Origin: "https://unlisted.test" },
  }),
  request("preflight-before-any-gate", "OPTIONS", "/billing/webhook", { headers: origin }),
  request("preflight-unlisted-origin", "OPTIONS", "/unmatched", {
    headers: { Origin: "https://unlisted.test" },
  }),
  request("known-path-wrong-method", "POST", "/config"),
  request("unknown-path", "GET", "/unmatched/", { headers: origin }),
  request("path-case-sensitive", "GET", "/Config"),
  request("session-live", "GET", "/session", session),
  request("session-end-live", "DELETE", "/session", session),
  request("session-create-rejects-session-token", "POST", "/session", session),
  request("me-synthetic-session", "GET", "/me", session),
  request("profile-sync-on-auth-before-body", "PUT", "/profile", { ...profile, ...malformed }),
  request("profile-read-empty", "GET", "/profile", { ...profile, ...session }),
  request("profile-write-valid", "PUT", "/profile", {
    ...profile,
    ...session,
    body: '{"profile":{"facts":{}},"updated":"2026-09-14T10:00:00.000Z"}',
  }),
  request("profile-delete-valid", "DELETE", "/profile", { ...profile, ...session }),
  request("demand-read-valid", "GET", "/demand", {
    headers: { Authorization: "Bearer fixture-demand" },
  }),
  request("demand-write-valid", "POST", "/demand", { ...session, body: '{"states":["MA"]}' }),
  request("hit-invalid-json", "POST", "/hit", { ...malformed, headers: origin }),
  request("lead-wrong-origin", "POST", "/employer-interest", { body: "{}" }),
  request("lead-validation", "POST", "/employer-interest", { body: "{}", headers: origin }),
  request("admin-browser-origin", "GET", "/admin/placements", {
    admin: true,
    headers: { ...admin, ...origin },
  }),
  request("admin-missing-auth-before-body", "POST", "/admin/placements/report", {
    admin: true,
    ...malformed,
  }),
  request("admin-placement-read-valid", "GET", "/admin/placements", {
    admin: true,
    headers: admin,
  }),
  request("admin-lead-read-valid", "GET", "/admin/leads", { admin: true, headers: admin }),
  request("admin-metrics-read-valid", "GET", "/admin/employer-metrics?days=7", {
    admin: true,
    headers: admin,
  }),
  request("admin-report-invalid-after-auth", "POST", "/admin/placements/report", {
    admin: true,
    headers: admin,
    ...malformed,
  }),
  request("manual-update-capacity-gate", "POST", "/admin/placements/update", {
    admin: true,
    orders: true,
    headers: admin,
    body: "{}",
  }),
  request("manual-activation-capacity-gate", "POST", "/admin/placements/on", {
    admin: true,
    orders: true,
    headers: admin,
    body: "{}",
  }),
  request("admin-pilot-array-after-auth", "POST", "/admin/pilot-codes", {
    admin: true,
    headers: admin,
    body: "[]",
  }),
  request("order-config-enabled", "GET", "/employer/config", { orders: true }),
  request("availability-invalid-ids", "GET", "/employer/availability?shard=a&ids=bad", {
    orders: true,
  }),
  request("order-enabled-bad-json", "POST", "/employer/order", { orders: true, ...malformed }),
  request("review-invalid-link-html", "GET", "/employer/review", { orders: true }),
  request("credit-invalid-json-after-gate", "POST", "/employer/credit", {
    orders: true,
    ...malformed,
  }),
  request("webhook-no-signature-with-order-gate", "POST", "/billing/webhook", {
    orders: true,
    body: "{}",
  }),
  request("media-get", "GET", media, { upstream: "whole", headers: origin }),
  request("media-head", "HEAD", media, { upstream: "whole" }),
  request("media-range", "GET", media, { upstream: "range", headers: { Range: "bytes=1-2" } }),
  request("media-bad-range", "GET", media, { headers: { Range: "bytes=0-1,2-3" } }),
  request("media-wrong-method", "POST", media),
  request("media-query-rejected", "GET", media + "?ignored=1"),
  request("media-trailing-slash-rejected", "GET", media + "/"),
  request("media-upstream-404", "GET", media, { upstream: "missing" }),
  request("media-upstream-failure", "GET", media, { upstream: "unavailable" }),
];

function mediaResponse(kind, method) {
  if (kind === "missing") return new Response(null, { status: 404 });
  if (kind === "unavailable") throw new Error("Synthetic media failure");
  if (kind === "range") {
    return new Response(new Uint8Array([255, 128]), {
      status: 206,
      headers: { "Content-Length": "2", "Content-Range": "bytes 1-2/4" },
    });
  }
  return new Response(method === "HEAD" ? null : new Uint8Array([0, 255, 128, 127]), {
    headers: { "Content-Length": "4" },
  });
}

export async function captureRouteResponses() {
  const nativeFetch = globalThis.fetch;
  const captured = {};
  let unexpectedTransport = false;
  const blocked = () => {
    unexpectedTransport = true;
    throw new Error("Unmocked route baseline transport");
  };
  globalThis.fetch = blocked;
  try {
    for (const row of responseCases) {
      const env = makeEnv({
        ALLOWED_ORIGINS: site,
        GEMINI_API_KEY: undefined,
        DEMAND_TOKEN: "fixture-demand",
        ...(row.sync ? { PROFILE_KEY: Buffer.alloc(32, 9).toString("base64") } : {}),
        ...(row.admin || row.orders ? { ADMIN_TOKEN: "fixture-admin" } : {}),
        ...(row.orders
          ? {
              EMPLOYER_CHECKOUT: "1",
              STRIPE_SECRET_KEY: "fixture-stripe",
              STRIPE_WEBHOOK_SECRET: "fixture-webhook",
              REVIEW_TO: "review@example.test",
              ORDER_FROM: "orders@example.test",
              EMAIL: { send: blocked },
            }
          : {}),
      });
      const headers = new Headers(row.headers);
      if (row.body !== undefined) headers.set("Content-Type", "application/json");
      if (row.session) {
        const { token } = await createSession(
          env.DB,
          {
            user: "synthetic-route-baseline-account",
            tier: "general",
            provider: "google",
          },
          NOW,
        );
        headers.set("Authorization", "Bearer " + token);
      }
      let mediaReads = 0;
      const fetch = async (url, init) => {
        if (!row.upstream || url !== rawMedia || init?.method !== row.method || mediaReads)
          return blocked();
        mediaReads++;
        return mediaResponse(row.upstream, row.method);
      };
      const pending = [];
      const response = await handle(
        new Request("https://worker.test" + row.path, {
          method: row.method,
          headers,
          body: row.body,
        }),
        env,
        { waitUntil: (p) => pending.push(p) },
        { fetch, now: () => new Date(NOW) },
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      await Promise.all(pending);
      assert.equal(unexpectedTransport, false, row.label);
      assert.equal(mediaReads, row.upstream ? 1 : 0, row.label);
      captured[row.label] = {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: isUtf8(bytes) ? bytes.toString("utf8") : { hex: bytes.toString("hex") },
      };
    }
  } finally {
    globalThis.fetch = nativeFetch;
  }
  return captured;
}
