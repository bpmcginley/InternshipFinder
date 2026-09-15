// Google or Microsoft sign-in for the InternScout Worker (worker/API.md → Sign-in).
// Implicit OIDC flow through chrome.identity.launchWebAuthFlow; the ID token lives in chrome.storage.session
// (cleared when the browser closes) and is only ever sent to WORKER_URL.
// The pure helpers at the top have no chrome dependency so node tests can import this file.
import { WORKER_URL } from "./config.js";

const KEY = "internscout.idtoken";
const LEEWAY_S = 60;

export function decodeJwt(token) {
  try {
    const part = String(token).split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bin = atob(b64);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch (e) {
    return null;
  }
}

// True when the token is missing, unreadable, or expires within the leeway.
export function isExpired(token, now = Date.now(), leeway = LEEWAY_S) {
  const p = token && decodeJwt(token);
  return !p || !p.exp || p.exp * 1000 <= now + leeway * 1000;
}

export const emailOf = (payload) => (payload && (payload.email || payload.preferred_username || payload.upn)) || "";

// One entry of GET /config's providers list ({id, client_id, authorize_url, scopes}), or null.
export function pickProvider(cfg, id) {
  const list = (cfg && Array.isArray(cfg.providers)) ? cfg.providers : [];
  return list.find((p) => p.id === id) || null;
}

export const PROVIDER_LABELS = { google: "Google", microsoft: "Microsoft" };

export function buildAuthUrl(provider, { redirectUri, nonce, loginHint, silent }) {
  const u = new URL(provider.authorize_url);
  const q = u.searchParams;
  q.set("client_id", provider.client_id);
  q.set("response_type", "id_token");
  q.set("redirect_uri", redirectUri);
  q.set("scope", (provider.scopes && provider.scopes.length ? provider.scopes : ["openid", "email", "profile"]).join(" "));
  q.set("nonce", nonce);
  q.set("state", nonce);
  if (provider.id === "microsoft") q.set("response_mode", "fragment");
  if (silent) q.set("prompt", "none");
  else if (!loginHint) q.set("prompt", "select_account");
  if (loginHint) q.set("login_hint", loginHint);
  return u.toString();
}

// Reads the id_token out of the redirect URL and checks the nonce we sent.
export function parseRedirect(url, nonce) {
  const u = new URL(url);
  const params = new URLSearchParams(u.hash.replace(/^#/, "") || u.search.replace(/^\?/, ""));
  if (params.get("error")) throw new Error(`Sign-in failed: ${params.get("error_description") || params.get("error")}`);
  const token = params.get("id_token");
  if (!token) throw new Error("Sign-in failed: no ID token came back.");
  const p = decodeJwt(token);
  if (!p || p.nonce !== nonce) throw new Error("Sign-in failed: the reply did not match this request. Try again.");
  return token;
}

// ---------- chrome-backed ----------
let cfgCache = null;
export async function getConfig(fetchImpl = fetch) {
  if (cfgCache && Date.now() - cfgCache.at < 10 * 60 * 1000) return cfgCache.cfg;
  const res = await fetchImpl(`${WORKER_URL}/config`).catch(() => null);
  if (!res || !res.ok) throw new Error("Couldn't reach InternScout. Check your connection and try again.");
  const cfg = await res.json();
  cfgCache = { cfg, at: Date.now() };
  return cfg;
}

async function readSession() {
  return (await chrome.storage.session.get(KEY))[KEY] || {};
}

// A valid (not expired) token, or null.
export async function getToken() {
  const { token } = await readSession();
  return token && !isExpired(token) ? token : null;
}

// provider: "google" or "microsoft". A silent refresh reuses the provider from the last sign-in.
export async function signIn({ interactive = true, provider } = {}) {
  const cfg = await getConfig();
  const saved = await readSession();
  const id = provider || saved.provider || "google";
  const p = pickProvider(cfg, id);
  if (!p) throw new Error(`${PROVIDER_LABELS[id] || id} sign-in isn't available right now.`);
  const nonce = crypto.randomUUID();
  const hint = saved.provider === id ? saved.hint : undefined;
  const url = buildAuthUrl(p, { redirectUri: chrome.identity.getRedirectURL(), nonce, loginHint: hint, silent: !interactive });
  const back = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!back) throw new Error("Sign-in was cancelled.");
  const token = parseRedirect(back, nonce);
  await chrome.storage.session.set({ [KEY]: { token, hint: emailOf(decodeJwt(token)), provider: id } });
  return token;
}

// Valid token, trying a silent refresh when the old one expired. Never opens a window.
export async function ensureToken() {
  const t = await getToken();
  if (t) return t;
  const { hint } = await readSession();
  if (!hint) return null;
  return signIn({ interactive: false }).catch(() => null);
}

export async function signOut() {
  await chrome.storage.session.remove(KEY);
}

export async function authStatus() {
  const token = await getToken();
  const p = token && decodeJwt(token);
  const { provider } = await readSession();
  return { signedIn: !!token, email: emailOf(p), provider: token ? provider || null : null, exp: (p && p.exp) || null };
}

// GET /me: this month's allowance. Returns null when signed out or unreachable.
export async function getMe(token) {
  token = token || (await getToken());
  if (!token) return null;
  const res = await fetch(`${WORKER_URL}/me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res) return null;
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: data.error || String(res.status), message: data.message || "" };
}

// DELETE /me: removes every usage and demand row for this user on the Worker.
export async function deleteServerData(token) {
  token = token || (await ensureToken());
  if (!token) return { ok: false, error: "auth" };
  const res = await fetch(`${WORKER_URL}/me`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res) return { ok: false, error: "network" };
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, error: data.error || String(res.status), message: data.message || "" };
}

export const TASK_LABELS = {
  resume_tailor: "Tailored resumes", autofill: "Auto-Apply runs", deep_dive: "Deep Dives",
  field_match: "Field matches", short_answer: "Short answers",
};

// "Tailored resumes: 7 of 8 left" per task in a GET /me reply (optionally only some tasks).
export function allowanceLines(me, tasks) {
  if (!me || me.error || !me.allowance) return [];
  return Object.entries(me.allowance)
    .filter(([k]) => !tasks || tasks.includes(k))
    .map(([k, v]) => `${TASK_LABELS[k] || k}: ${Math.max(0, (v.limit || 0) - (v.used || 0))} of ${v.limit || 0} left`);
}
