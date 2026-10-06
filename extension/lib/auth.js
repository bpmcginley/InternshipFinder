// Google or Microsoft sign-in for the InternScout Worker (worker/API.md → Sign-in, Sessions).
// Implicit OIDC flow through chrome.identity.launchWebAuthFlow, then POST /session trades the ID token for
// an InternScout session token ("iss_…") kept in chrome.storage.local, so the student stays signed in
// across browser restarts until they sign out (the Worker drops a session unused for a year).
// was: the ID token lived in chrome.storage.session, which Chrome clears when the browser closes, and it
// lasts about an hour, so students were signed out every day. An older Worker without /session still gets
// that ID token (the legacy flow below), with the login hint kept in chrome.storage.local so the silent
// refresh works after a restart. Tokens are only ever sent to WORKER_URL.
// The pure helpers at the top have no chrome dependency so node tests can import this file.
import { WORKER_URL } from "./config.js";

const KEY = "internscout.idtoken";                // chrome.storage.session: { token } (legacy ID token)
export const SESSION_KEY = "internscout.session"; // chrome.storage.local: { token, account, email, provider, tier, expires }
export const SIGNIN_KEY = "internscout.signin";   // chrome.storage.local: { hint, provider } for the silent refresh
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

// May the page a bridge request came from have the student's sign-in (auth:token)? internscout.org
// always; a local copy of the site only on an unpacked (developer) build, where `unpacked` is true.
export function trustedDashboard(sender, unpacked) {
  let origin = sender && sender.origin;
  try { origin = origin || new URL(sender.url).origin; } catch (e) { return false; }
  if (origin === "https://internscout.org") return true;
  return !!unpacked && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
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

// ---------- sessions (pure) ----------
export const isSessionToken = (t) => typeof t === "string" && t.startsWith("iss_");

// A session record that can still be used: a token and an expiry in the future.
export function sessionLive(rec, now = Date.now()) {
  return !!(rec && isSessionToken(rec.token) && Date.parse(rec.expires) > now);
}

// The token to send: the session while it lasts, else a legacy ID token that hasn't expired, else null.
export function pickToken(session, idToken, now = Date.now()) {
  if (sessionLive(session, now)) return session.token;
  return idToken && !isExpired(idToken, now) ? idToken : null;
}

// POST /session's 200 reply → the record kept in chrome.storage.local, or null when it isn't one.
export function sessionRecord(data) {
  if (!data || !isSessionToken(data.session) || !data.expires || !Number.isFinite(Date.parse(data.expires))) return null;
  return { token: data.session, account: String(data.account || ""), email: String(data.email || ""),
    provider: data.provider || null, tier: data.tier || null, expires: data.expires };
}

// POST /session's outcome: "session" (use it), "legacy" (an older Worker, or it's down: keep the ID token)
// or "refused" (the Worker read the ID token and said no, so the sign-in failed).
// status 0 = the request never got an answer.
export function sessionOutcome(status, data) {
  if (status >= 200 && status < 300) return sessionRecord(data) ? "session" : "legacy";
  if (status === 401 || status === 403) return "refused";
  return "legacy";   // 404 (no /session yet), 5xx, network
}

// The bridge's auth:token reply (the dashboard asks the extension for its sign-in):
// { token, email, account, expires (ms epoch) } for a session, { token } for a legacy ID token.
export function bridgeReply(session, token) {
  if (token && session && session.token === token) {
    return { token, email: session.email || "", account: session.account || "", expires: Date.parse(session.expires) };
  }
  return { token: token || null };
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

const local = async (k) => (await chrome.storage.local.get(k))[k] || null;
async function readLegacy() {
  return (await chrome.storage.session.get(KEY))[KEY] || {};
}
// { hint, provider } of the last sign-in. was: kept beside the ID token in chrome.storage.session, so a
// browser restart lost it and the silent refresh had nothing to go on. That older record is still read,
// for a browser that updated to this version mid-session.
async function readSignin() {
  const s = await local(SIGNIN_KEY);
  if (s) return s;
  const { hint, provider } = await readLegacy();
  return { hint, provider };
}

// The live session record, or null.
export async function getSession() {
  const s = await local(SESSION_KEY);
  return sessionLive(s) ? s : null;
}

// A valid token (the session, else a legacy ID token that hasn't expired), or null.
export async function getToken() {
  return pickToken(await local(SESSION_KEY), (await readLegacy()).token);
}

const quick = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined);

// Best effort: the Worker forgets this session. Nothing is thrown; a session nobody uses expires anyway.
async function endSession(token, fetchImpl = fetch) {
  if (!isSessionToken(token)) return;
  await fetchImpl(`${WORKER_URL}/session`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, signal: quick() }).catch(() => null);
}

// Trades a provider ID token for a session. Returns the record, or null to keep using the ID token.
export async function createSession(idToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${WORKER_URL}/session`, { method: "POST", headers: { authorization: `Bearer ${idToken}` }, signal: quick() }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  const out = sessionOutcome(res ? res.status : 0, data);
  if (out === "refused") throw new Error(`Sign-in failed: ${data.message || "InternScout didn't accept this account"}.`);
  return out === "session" ? sessionRecord(data) : null;
}

// provider: "google" or "microsoft". A silent refresh reuses the provider from the last sign-in.
// Returns the token to use: a session token when the Worker gave one, else the ID token.
export async function signIn({ interactive = true, provider } = {}) {
  const cfg = await getConfig();
  const saved = await readSignin();
  const id = provider || saved.provider || "google";
  const p = pickProvider(cfg, id);
  if (!p) throw new Error(`${PROVIDER_LABELS[id] || id} sign-in isn't available right now.`);
  const nonce = crypto.randomUUID();
  const hint = saved.provider === id ? saved.hint : undefined;
  const url = buildAuthUrl(p, { redirectUri: chrome.identity.getRedirectURL(), nonce, loginHint: hint, silent: !interactive });
  // A silent refresh (prompt=none) can take a redirect or two after the first page load; by default Chrome
  // gives up on a non-interactive flow at that first load, so the refresh failed and every job an hour
  // after sign-in stopped at "sign in". These two options (Chrome 113+, ignored before) let it finish.
  const back = await chrome.identity.launchWebAuthFlow(interactive ? { url, interactive }
    : { url, interactive, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000 });
  if (!back) throw new Error("Sign-in was cancelled.");
  const token = parseRedirect(back, nonce);
  const session = await createSession(token);
  const old = await local(SESSION_KEY);
  await chrome.storage.local.set({ [SIGNIN_KEY]: { hint: emailOf(decodeJwt(token)), provider: id } });
  if (session) {
    await chrome.storage.local.set({ [SESSION_KEY]: session });
    await chrome.storage.session.remove(KEY);
    if (old && old.token !== session.token) endSession(old.token);   // signed in again over a live session
    return session.token;
  }
  // was: chrome.storage.session.set({ [KEY]: { token, hint, provider } }). The hint and provider now sit in
  // chrome.storage.local (SIGNIN_KEY) so they outlive the browser; the ID token itself still expires hourly.
  await chrome.storage.session.set({ [KEY]: { token } });
  return token;
}

// Valid token, trying a silent refresh when the old one expired. Never opens a window.
export async function ensureToken() {
  const t = await getToken();
  if (t) return t;
  const { hint } = await readSignin();
  if (!hint) return null;
  return signIn({ interactive: false }).catch(() => null);
}

// Forgets every sign-in on this device. The login hint goes too, so no silent refresh signs back in.
async function forget() {
  await chrome.storage.local.remove([SESSION_KEY, SIGNIN_KEY]);
  await chrome.storage.session.remove(KEY);
}

export async function signOut() {
  const s = await local(SESSION_KEY);
  if (s) await endSession(s.token);
  await forget();
}

// The Worker answered 401 to this token. A session it no longer knows (signed out elsewhere, "Delete my
// data" on the website, a year unused) is dropped here so the extension shows "Sign in" instead of failing
// every call; the student signs in again by hand. A legacy ID token is left alone (ensureToken refreshes it).
export async function dropSession(token) {
  if (!isSessionToken(token)) return;
  const s = await local(SESSION_KEY);
  if (s && s.token === token) await forget();
}

// callWorker's refreshToken: after a 401, drop a dead session (the student signs in again), or refresh
// a legacy ID token silently as before.
export async function refreshAfter401(badToken) {
  await dropSession(badToken);
  return isSessionToken(badToken) ? null : ensureToken();
}

// Every other Worker call goes through here, so a 401 on a session is handled in one place.
// Returns the Response, or null when signed out or the request never got an answer.
export async function workerFetch(path, init = {}, token) {
  token = token || (await ensureToken());
  if (!token) return null;
  const headers = { ...(init.headers || {}), authorization: `Bearer ${token}` };
  const res = await fetch(`${WORKER_URL}${path}`, { ...init, headers }).catch(() => null);
  if (res && res.status === 401) await dropSession(token);
  return res;
}

export async function authStatus() {
  const session = await getSession();
  if (session) {
    return { signedIn: true, email: session.email || "", provider: session.provider || null,
      exp: Math.floor(Date.parse(session.expires) / 1000), account: session.account || "", session: true };
  }
  const token = await getToken();
  const p = token && decodeJwt(token);
  const { provider } = await readSignin();
  return { signedIn: !!token, email: emailOf(p), provider: token ? provider || null : null, exp: (p && p.exp) || null };
}

// The bridge's auth:token reply.
export async function authBridge() {
  return bridgeReply(await getSession(), await getToken());
}

// GET /me: this month's allowance. Returns null when signed out or unreachable.
export async function getMe(token) {
  token = token || (await getToken());
  if (!token) return null;
  const res = await workerFetch("/me", {}, token);
  if (!res) return null;
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: data.error || String(res.status), message: data.message || "" };
}

// DELETE /me: removes every usage and demand row, the saved Deep Dive and every sign-in for this user on the Worker.
export async function deleteServerData(token) {
  token = token || (await ensureToken());
  if (!token) return { ok: false, error: "auth" };
  const res = await workerFetch("/me", { method: "DELETE" }, token);
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
    .map(([k, v]) => v.limit == null   // no monthly cap on this task (the Deep Dive)
      ? `${TASK_LABELS[k] || k}: unlimited`
      : `${TASK_LABELS[k] || k}: ${Math.max(0, (v.limit || 0) - (v.used || 0))} of ${v.limit || 0} left`);
}

// The allowances a student acts on; field matches and short answers happen inside those runs.
export const MAIN_TASKS = ["autofill", "resume_tailor", "deep_dive"];

// One line under the allowance: which tier, or why the allowance couldn't be read.
export function tierNote(me) {
  if (!me) return "Couldn't reach InternScout to check your allowance.";
  if (me.error) return me.message || `Couldn't check your allowance (${me.error}).`;
  const paused = me.paused ? " AI is paused for everyone until next month; search still works." : "";
  return (me.tier === "edu"
    ? "School (.edu) allowance: about twice the standard. Resets on the 1st."
    : "Standard allowance. A Google account with a .edu email gets about twice as much. Resets on the 1st.") + paused;
}
