import { HttpError } from "../http.js";
import { hex, sameHex } from "../billing.js";
import { ORDER_ID } from "./shared.js";
import { reviewSig } from "./templates.js";

// Only the site's own pages send the order, confirm and credit choice (a browser always sets Origin).
const SITE = /^https:\/\/(internscout\.org|bpmcginley\.github\.io)$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const ordersOn = (env) =>
  env.EMPLOYER_CHECKOUT === "1" && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET && !!env.ADMIN_TOKEN &&
  !!env.REVIEW_TO && !!env.ORDER_FROM && !!(env.EMAIL && typeof env.EMAIL.send === "function");

function siteOnly(request) {
  if (!SITE.test(request.headers.get("Origin") || "")) {
    throw new HttpError(403, "forbidden", "This is sent from internscout.org only");
  }
}

// ---------------------------------------------------------------- small helpers

const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

// The email link: 32 random bytes, base64url. Only its SHA-256 (hex) is stored.
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function tokenHash(token) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

// Constant time over the two hashes (billing.js sameHex), so a guess learns nothing from the timing.
async function tokenOk(token, hash) {
  if (typeof token !== "string" || !TOKEN.test(token) || typeof hash !== "string" || !hash) return false;
  return sameHex(await tokenHash(token), hash);
}

async function sigOk(env, id, sig) {
  if (typeof id !== "string" || !ORDER_ID.test(id) || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return sameHex(await reviewSig(env, id), sig);
}

async function addressKey(request, env) {
  if (!env.HASH_SALT) throw new HttpError(500, "server", "Server is missing HASH_SALT");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return "order:" + (await tokenHash(`order|${ip}|${env.HASH_SALT}`));
}

export { addressKey, randomHex, sigOk, siteOnly, tokenOk };
