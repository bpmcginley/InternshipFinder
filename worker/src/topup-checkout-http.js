// Dormant outer boundary. The future router owns origin/CORS and server-owned dependencies.
import { bearerOf } from "./auth.js";
import { HttpError, json } from "./http.js";
import { isSessionToken, sessionUser } from "./session.js";
import { getSessionTopupCheckout } from "./topup-checkout-service.js";

// Checkout must not slide a session beyond the expiry observed by authentication.
const authenticateSession = (request, env, deps) =>
  sessionUser(env.DB, bearerOf(request), { ...deps, refresh: false });

const response = (status, code, extra = {}, headers = {}) =>
  json({ status, ...extra }, code, { "Cache-Control": "no-store", ...headers });

export async function topupCheckoutResponse({
  request,
  db,
  adapter = {},
  clock = () => new Date(),
  authenticate = authenticateSession,
  checkout = getSessionTopupCheckout,
}) {
  if (request.method !== "POST") return response("unavailable", 405, {}, { Allow: "POST" });
  const token = bearerOf(request);
  // Provider ID tokens must first become a session through the existing sign-in flow.
  // Cookies, query fields and body fields cannot supply identity, offer or return URLs.
  if (!isSessionToken(token)) return response("auth", 401);
  try {
    let latest = -Infinity;
    const fresh = () => {
      const at = clock();
      if (!(at instanceof Date) || !Number.isFinite(+at) || +at < latest)
        throw new Error("Invalid clock");
      latest = +at;
      return new Date(latest);
    };
    const identity = await authenticate(request, { DB: db }, { now: +fresh() });
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(identity.user || "") ||
      !(Date.parse(identity.expires) > +fresh())
    )
      return response("auth", 401);
    const result = await checkout(db, identity.user, token, adapter, fresh);
    if (result?.status === "open") {
      // Only the verified service may authorize this URL; this is defensive output validation.
      if (
        typeof result.url !== "string" ||
        result.url.length > 8192 ||
        /[\\\s<>"]/.test(result.url)
      )
        return response("unavailable", 503);
      const url = new URL(result.url);
      if (
        url.origin !== "https://checkout.stripe.com" ||
        url.username ||
        url.password ||
        !/^\/c\/pay\/cs_[A-Za-z0-9_]{1,250}$/.test(url.pathname)
      )
        return response("unavailable", 503);
      return response("open", 200, { url: url.href });
    }
    if (result?.status === "pending") return response("pending", 202);
    if (result?.status === "auth") return response("auth", 401);
    return response(result?.status === "disabled" ? "disabled" : "unavailable", 503);
  } catch (error) {
    return error instanceof HttpError && error.status === 401
      ? response("auth", 401)
      : response("unavailable", 503);
  }
}
