import { bearerOf } from "./auth.js";
import { json } from "./http.js";
import { bumpUnder } from "./limits.js";
import { recoverAttachedTopup } from "./topup-attached-recovery.js";
import { topupRecoveryConfigured } from "./topup-stripe.js";

export const TOPUP_RECOVERY_LIMITS = Object.freeze({ perAccount: 3, global: 30 });

const response = (status, code, extra = {}, headers = {}) =>
  json({ status, ...extra }, code, { "Cache-Control": "no-store", ...headers });

export async function topupRecoveryResponse({
  request,
  env,
  fetchImpl,
  clock,
  originAllowed,
  returnUrl,
  limits = TOPUP_RECOVERY_LIMITS,
}) {
  if (request.method !== "POST") return response("unavailable", 405, {}, { Allow: "POST" });
  if (!topupRecoveryConfigured(env)) return response("disabled", 503);
  if (typeof originAllowed !== "function" || originAllowed(request, env) !== true)
    return response("unavailable", 403);
  if (
    request.body !== null ||
    new URL(request.url).search ||
    request.headers.has("Transfer-Encoding") ||
    ![null, "0"].includes(request.headers.get("Content-Length"))
  )
    return response("invalid", 400);
  const token = bearerOf(request);
  if (typeof token !== "string" || !/^iss_[A-Za-z0-9_-]{43}$/.test(token))
    return response("auth", 401);
  try {
    const root = new URL(returnUrl);
    if (root.protocol !== "https:" || returnUrl !== root.origin + "/")
      return response("unavailable", 503);
  } catch {
    return response("unavailable", 503);
  }
  const { perAccount, global } = limits ?? {};
  if (![perAccount, global].every((n) => Number.isSafeInteger(n) && n > 0))
    return response("unavailable", 503);

  const admit = async (user, at) => {
    const bucket = "m:" + at.toISOString().slice(0, 16) + ":topup-recovery";
    return (
      (await bumpUnder(env.DB, user, bucket, perAccount)) &&
      (await bumpUnder(env.DB, "topup-recovery", bucket, global))
    );
  };
  try {
    const result = await recoverAttachedTopup(env.DB, env, token, fetchImpl, clock, {
      admit,
      returnUrl,
    });
    switch (result.status) {
      case "open":
        return response("open", 200, { url: result.url });
      case "settled":
      case "expired":
      case "inactive":
        return response(result.status, 200);
      case "auth":
        return response("auth", 401);
      case "limited":
        return response("limited", 429, {}, { "Retry-After": "60" });
      default:
        return response("pending", 202);
    }
  } catch {
    return response("pending", 202);
  }
}
