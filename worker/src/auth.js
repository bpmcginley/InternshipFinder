// Sign-in check: verifies a Google or Microsoft OIDC ID token with WebCrypto and turns it into a user_hash
// plus a tier ("edu" or "general"). Nothing from the token (email, name, the token itself) is kept or logged.
import { HttpError } from "./http.js";

const LEEWAY_S = 60;
const JWKS_TTL_MS = 3600_000;
const JWKS_RETRY_MS = 300_000;   // refetch early for an unknown kid, at most this often
const jwksCache = new Map();     // url -> { keys, at }
const MS_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";   // personal Outlook/Hotmail accounts

export function clearJwksCache() {
  jwksCache.clear();
}

// API.md "Sign-in". A provider is off while its client ID var is empty.
const PROVIDERS = {
  google: {
    clientVar: "GOOGLE_CLIENT_ID",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuerOk: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
  },
  microsoft: {
    clientVar: "MS_CLIENT_ID",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    jwks: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    // multi-tenant: the issuer must name the token's own tenant
    issuerOk: (iss, claims) => typeof claims.tid === "string" && iss === `https://login.microsoftonline.com/${claims.tid}/v2.0`,
  },
};

// Enabled providers for GET /config.
export const providers = (env) =>
  Object.entries(PROVIDERS)
    .filter(([, p]) => env[p.clientVar])
    .map(([id, p]) => ({ id, client_id: env[p.clientVar], authorize_url: p.authorize }));

const providerOf = (iss) =>
  String(iss || "").startsWith("https://login.microsoftonline.com/") ? "microsoft" : "google";

// "edu" only for a verified email on a .edu (or EDU_EXTRA_DOMAINS) domain; everyone else is "general".
export function tierOf(provider, claims, env) {
  const email = String(claims.email || "").toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return "general";
  const domain = email.slice(at + 1);
  const extra = String(env.EDU_EXTRA_DOMAINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!(domain.endsWith(".edu") || extra.some((d) => domain === d || domain.endsWith("." + d)))) return "general";
  const yes = (v) => v === true || v === "true" || v === 1;
  if (provider === "google") return yes(claims.email_verified) ? "edu" : "general";
  // Microsoft's email claim is only trustworthy when the tenant owns the domain (optional claim xms_edov)
  return claims.tid !== MS_CONSUMER_TENANT && yes(claims.xms_edov) ? "edu" : "general";
}

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const decodeJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
const authError = (msg) => new HttpError(401, "auth", msg);

async function signingKey(url, kid, fetcher, now) {
  let hit = jwksCache.get(url);
  const stale = !hit || now - hit.at > JWKS_TTL_MS;
  const missing = hit && !hit.keys.some((k) => k.kid === kid) && now - hit.at > JWKS_RETRY_MS;
  if (stale || missing) {
    let res;
    try {
      res = await fetcher(url);
    } catch {
      res = null;
    }
    if (!res || !res.ok) throw new HttpError(502, "upstream", "Sign-in keys are unavailable; try again soon");
    hit = { keys: (await res.json()).keys || [], at: now };
    jwksCache.set(url, hit);
  }
  const jwk = hit.keys.find((k) => k.kid === kid);
  if (!jwk || jwk.kty !== "RSA") throw authError("Unknown signing key; sign in again");
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

// Checks signature, then iss/aud/exp. Returns { provider, claims, tier }.
export async function verifyIdToken(token, env, { fetch: fetcher = globalThis.fetch, now = Date.now() } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw authError("Sign in first");
  let header, claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw authError("Malformed sign-in token");
  }
  if (header.alg !== "RS256") throw authError("Unsupported token algorithm");

  // The unverified iss only picks which keys to check against; everything is re-checked after the signature.
  const provider = providerOf(claims.iss);
  const p = PROVIDERS[provider];
  const clientId = env[p.clientVar];
  if (!clientId) throw authError("That sign-in provider is not enabled");
  const key = await signingKey(p.jwks, header.kid, fetcher, now);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    ok = false;
  }
  if (!ok) throw authError("Bad token signature");

  const t = Math.floor(now / 1000);
  if (!p.issuerOk(claims.iss, claims)) throw authError("Wrong token issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw authError("Wrong token audience");
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < t) throw authError("Sign-in expired; sign in again");
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > t) throw authError("Token not valid yet");
  if (!claims.sub) throw authError("Token has no subject");
  return { provider, claims, tier: tierOf(provider, claims, env) };
}

// user_hash = hex(sha256(provider | sub | HASH_SALT)). One hash per person per provider, across Microsoft tenants.
export async function userHash(provider, claims, env) {
  if (!env.HASH_SALT) throw new HttpError(500, "server", "Server is missing HASH_SALT");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${provider}|${claims.sub}|${env.HASH_SALT}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// { user, tier } for a request's bearer token.
export async function authenticateUser(request, env, deps = {}) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") || "");
  if (!m) throw authError("Sign in first");
  const { provider, claims, tier } = await verifyIdToken(m[1], env, deps);
  return { user: await userHash(provider, claims, env), tier };
}
