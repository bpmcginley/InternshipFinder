// Dashboard account and Worker operations.

export function createAccount(browser, { C, ls, ss, DAY, demandStates, PROFILE_KEY, DELETED_KEY }) {
  // ---------- Google / Microsoft sign-in (implicit id_token flow, see worker/API.md) ----------
  // The provider's ID token lasts about an hour, and sessionStorage goes when the tab closes, so the
  // dashboard used to sign out that often. After the redirect the ID token is now traded once for a
  // Worker session (POST /session): an opaque "iss_..." code kept in localStorage until sign-out, or
  // until the Worker forgets it after a year unused. The ID token stays the fallback for a Worker
  // that doesn't know /session yet (404), is down (5xx) or can't be reached.
  const TOKEN_KEY = "internscout.idtoken";
  const SESSION_KEY = "internscout.session";
  const workerOn = () => !!C.workerUrl && !/\.example\.|example\.workers\.dev/.test(C.workerUrl);
  const workerBase = () => C.workerUrl.replace(/\/$/, "");
  function decodeJwt(t) {
    try {
      let s = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      s += "===".slice((s.length + 3) % 4);
      return JSON.parse(new browser.TextDecoder().decode(Uint8Array.from(browser.atob(s), c => c.charCodeAt(0))));
    } catch (e) { return null; }
  }
  const isSession = t => typeof t === "string" && t.startsWith("iss_");
  const storedSession = () => { const r = ls.get(SESSION_KEY, null); return r && typeof r === "object" && isSession(r.token) ? r : null; };
  // Tokens the Worker answered 401 for on this page. The page's own copies are dropped at once
  // (forget), and this lets a token the page didn't store (the extension's) read as signed out too.
  const rejected = new Set();
  // The one place that reads who a sign-in belongs to and when it ends, for either kind:
  //   a session record, as stored here { token, account, email, provider, tier, expires: ISO } or as
  //   the extension's bridge sends it { token, email, account, expires: ms };
  //   a legacy ID token (a JWT string, or { token: JWT } from an older extension);
  //   a bare "iss_..." string, looked up in this page's stored record;
  //   or this function's own result.
  // Returns { token, email, sub, exp (ms), signin, session } or null. `sub` is the provider's sub for
  // an ID token and the session's `account` for a session (both are stable per account, which is all
  // the dedupe keys need). `signin` changes with each new sign-in: the ID token's iat, or the tail of
  // the session code.
  // was: callers ran decodeJwt(token).email / .sub / .exp and tokenOk(token) themselves, which a
  // session code can't answer.
  function authInfo(x) {
    if (!x) return null;
    if (typeof x === "string") {
      if (isSession(x)) { const r = storedSession(); return r && r.token === x ? authInfo(r) : null; }
      const p = decodeJwt(x);
      return p ? { token: x, email: p.email || "", sub: p.sub || "", exp: (Number(p.exp) || 0) * 1000, signin: String(p.iat || ""), session: false } : null;
    }
    if (typeof x !== "object" || typeof x.token !== "string") return null;
    if (!isSession(x.token)) {
      const i = authInfo(x.token);
      return i && x.email && !i.email ? { ...i, email: x.email } : i;
    }
    const exp = typeof x.exp === "number" ? x.exp : typeof x.expires === "number" ? x.expires : browser.Date.parse(x.expires || "") || 0;
    return { token: x.token, email: x.email || "", sub: x.sub || x.account || "", exp, signin: x.signin || x.token.slice(-8), session: true };
  }
  // Signed in and good for at least another minute, and not refused by the Worker on this page.
  const authOk = x => { const i = authInfo(x); return !!(i && i.exp > browser.Date.now() + 60000 && !rejected.has(i.token)); };
  // was: const tokenOk = t => { const p = t && decodeJwt(t); return !!(p && p.exp && p.exp * 1000 > Date.now() + 60000); };
  // Kept under its old name for anything still calling it; it understands sessions now.
  const tokenOk = authOk;
  // was: const storedToken = () => { const t = ss.get(TOKEN_KEY); if (t && tokenOk(t)) return t; if (t) ss.del(TOKEN_KEY); return null; };
  // The session first (it outlives the tab), then this tab's ID token. Expired ones are removed.
  const storedToken = () => {
    const r = storedSession();
    if (r && authOk(r)) return r.token;
    if (ls.get(SESSION_KEY, null) != null) ls.del(SESSION_KEY);
    const t = ss.get(TOKEN_KEY); if (t && authOk(t)) return t; if (t) ss.del(TOKEN_KEY); return null;
  };
  // Drop this page's copy of a token the Worker refused (401). Only that token: a 401 for the
  // extension's token mustn't sign out the page's own session, or the other way round.
  function forget(token) {
    if (!token) return;
    rejected.add(token);
    const r = storedSession(); if (r && r.token === token) ls.del(SESSION_KEY);
    if (ss.get(TOKEN_KEY) === token) ss.del(TOKEN_KEY);
  }
  // The Worker slides a session's expiry to a year from its last use. The record here keeps the
  // expiry it was created with, so after a successful call move it forward the same way (a day
  // short, since the Worker refreshes at most once a day); otherwise a student who uses InternScout
  // every day would still be signed out here a year after signing in.
  function touchSession(token) {
    const r = storedSession();
    if (!r || r.token !== token) return;
    const next = browser.Date.now() + 364 * DAY;
    if ((browser.Date.parse(r.expires) || 0) < next - DAY) ls.set(SESSION_KEY, { ...r, expires: new browser.Date(next).toISOString() });
  }
  const randomHex = () => Array.from(browser.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const redirectUri = () => C.redirectUri || (browser.location.origin + browser.location.pathname.replace(/index\.html$/, ""));

  // Trade a checked ID token for a session. Returns the stored record, { error } for a 401 (the
  // Worker refused the ID token itself), or null when sessions aren't available (404, 5xx, network,
  // or any other answer without a session in it) and the caller keeps the ID token instead.
  async function startSession(idToken) {
    if (!workerOn()) return null;
    const ctl = new browser.AbortController(); const timer = browser.setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await browser.fetch(workerBase() + "/session", { method: "POST", headers: { Authorization: "Bearer " + idToken }, signal: ctl.signal });
      if (r.status === 401) { const b = await r.json().catch(() => ({})); return { error: (b && b.message) || "Sign-in check failed. Try again." }; }
      if (!r.ok) return null;
      const b = await r.json().catch(() => null);
      if (!b || !isSession(b.session) || !(browser.Date.parse(b.expires) > browser.Date.now())) return null;
      const rec = { token: b.session, account: b.account || "", email: b.email || "", provider: b.provider || "", tier: b.tier || "", expires: b.expires };
      ls.set(SESSION_KEY, rec);
      return rec;
    } catch (e) { return null; } finally { browser.clearTimeout(timer); }
  }

  // was: // Reads the #id_token=... hash the provider sends back. Returns null, {token}, or {error}.
  // was: function handleRedirect() { ... ss.set(TOKEN_KEY, t); return { token: t }; }
  // Reads the #id_token=... hash the provider sends back and, when the Worker has sessions, trades the
  // token for one. Resolves to null (no sign-in in the address), { token, session } (session: the
  // stored record, or null when the ID token was kept instead), or { error }. Async now, because the
  // trade is a network call; the hash is still read and cleared before the first await.
  async function handleRedirect() {
    const h = browser.location.hash || "";
    if (!/[#&](id_token|error)=/.test(h)) return null;
    const q = new browser.URLSearchParams(h.slice(1));
    browser.history.replaceState(null, "", browser.location.pathname + browser.location.search);
    const state = ss.get("internscout.auth.state"), nonce = ss.get("internscout.auth.nonce");
    ss.del("internscout.auth.state"); ss.del("internscout.auth.nonce");
    if (q.get("error")) return { error: q.get("error_description") || q.get("error") };
    const t = q.get("id_token");
    if (!state || q.get("state") !== state) return { error: "Sign-in state didn't match. Try again." };
    const p = decodeJwt(t);
    if (!p || p.nonce !== nonce) return { error: "Sign-in check failed. Try again." };
    // was: if (!tokenOk(t)) return { error: "Sign-in expired. Try again." };
    if (!authOk(t)) return { error: "Sign-in expired. Try again." };
    // A new sign-in replaces whatever this browser held before.
    ls.del(SESSION_KEY); ss.del(TOKEN_KEY);
    const s = await startSession(t);
    if (s && s.error) return { error: s.error };
    count("signin");
    if (s) return { token: s.token, session: s };
    // was: ss.set(TOKEN_KEY, t); return { token: t };
    ss.set(TOKEN_KEY, t);
    return { token: t, session: null };
  }

  async function fetchWorkerConfig() {
    if (!workerOn()) return null;
    const ctl = new browser.AbortController(); const timer = browser.setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await browser.fetch(C.workerUrl.replace(/\/$/, "") + "/config", { signal: ctl.signal });
      if (!r.ok) return null;
      const cfg = await r.json();
      const providers = (cfg && Array.isArray(cfg.providers) ? cfg.providers : []).filter(p => p && p.id && p.client_id && p.authorize_url);
      return providers.length ? { ...cfg, providers } : null;
    } catch (e) { return null; } finally { browser.clearTimeout(timer); }
  }

  const PROVIDER_LABELS = { google: "Google", microsoft: "Microsoft" };

  // Anyone can sign in; a verified school .edu email gets the larger AI allowance (the Worker decides).
  // One step toward using InternScout, for the daily step totals (js/count.js, worker/src/visits.js
  // EVENTS). Queued when count.js has not run yet; it sends the queue when it does.
  const count = (event) => { (browser.ISCountQ = browser.ISCountQ || []).push(event); };

  function startSignIn(cfg, providerId) {
    const p = (cfg.providers || []).find(x => x.id === providerId);
    if (!p) return;
    count("signin_start");
    const state = randomHex(), nonce = randomHex();
    ss.set("internscout.auth.state", state); ss.set("internscout.auth.nonce", nonce);
    const q = new browser.URLSearchParams({
      client_id: p.client_id, response_type: "id_token", redirect_uri: redirectUri(),
      scope: (p.scopes || ["openid", "email", "profile"]).join(" "), nonce, state, response_mode: "fragment", prompt: "select_account",
    });
    browser.location.assign(p.authorize_url + (p.authorize_url.includes("?") ? "&" : "?") + q.toString());
  }
  // was: const signOut = () => ss.del(TOKEN_KEY);
  // Removes this page's sign-in. With `everywhere` (the Sign out button) it also ends the session on
  // the Worker: DELETE /session, best effort, since a failure still signs out here and an unused
  // session lapses by itself after a year. Without it (an expiry) there is nothing to end.
  function signOut(everywhere) {
    const r = storedSession();
    ls.del(SESSION_KEY); ss.del(TOKEN_KEY);
    if (everywhere && r && workerOn()) {
      try { browser.fetch(workerBase() + "/session", { method: "DELETE", headers: { Authorization: "Bearer " + r.token }, keepalive: true }).catch(() => { }); } catch (e) { }
    }
  }

  async function postDemand(token, p) {
    if (!workerOn() || !token || !p) return false;
    const states = demandStates(p);
    if (!states.length) return false;
    // was: const sub = (decodeJwt(token) || {}).sub || "";
    // A session's account stands in for the sub, so the first send after the switch repeats once.
    const sub = (authInfo(token) || {}).sub || "";
    const key = sub + "|" + states.slice().sort().join(",");
    if (ls.get("internscout.demand.sent", "") === key) return true;
    try {
      const r = await browser.fetch(C.workerUrl.replace(/\/$/, "") + "/demand", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ states }),
      });
      if (r.ok) { ls.set("internscout.demand.sent", key); return true; }
      // was: if (r.status === 401) signOut();
      if (r.status === 401) forget(token);
    } catch (e) { }
    return false;
  }

  // GET /me: this month's allowance ({tier, paused, allowance:{task:{used,limit}}}), or null.
  async function fetchMe(token, current = () => true) {
    if (!workerOn() || !token) return null;
    try {
      if (!current()) return null;
      const r = await browser.fetch(C.workerUrl.replace(/\/$/, "") + "/me", { headers: { Authorization: "Bearer " + token } });
      // The native loader can end this request's authority even when a token is reused.
      // Keep one-argument callers' current-session rejection/refresh behavior unchanged.
      if (!current()) return null;
      if (r.status === 401) { forget(token); return null; }
      if (r.ok) touchSession(token);
      const data = r.ok ? await r.json() : null;
      return current() ? data : null;
    } catch (e) { return null; }
  }
  // Referral credits (worker/src/referral.js). A classmate's invite code rides in on ?ref= and waits
  // here until the student signs in; GET /invite is the student's own link, POST /invite/claim uses one.
  const INVITE_KEY = "internscout.invite.v1";
  // sessionStorage: the sign-in sub of the account the Worker last answered "edu_only" for, so the
  // dashboard asks for that account once per session instead of on every page load.
  const INVITE_EDU_KEY = "internscout.invite.edu_only";
  // sessionStorage: "sub|iat|code" of the sign-in whose claim last failed for a passing reason (the
  // Worker unreachable, a 5xx, 429, or a 401 while Google rotates its keys). The code stays in
  // localStorage, and the dashboard tries again on the next sign-in or the next session instead of
  // on every page load with the same token.
  const INVITE_TRIED_KEY = "internscout.invite.tried";
  const INVITE_CODE = /^[a-hj-km-np-z2-9]{8}$/;
  // The invite nudge (added 2026-10-02). The invite used to live only in the Account menu, where few
  // students look. It is offered once, right after a good moment (a first Auto-Apply queued or a first
  // profile saved), as a notice the student can wave off. localStorage holds the day it was shown,
  // then "dismissed" (Not now) or "opened" (the invite panel was opened, from here or the menu); any
  // value at all means this browser never sees it again.
  const INVITE_NUDGE_KEY = "internscout.invite_nudge";
  // Pure, so the rule is tested (tests/site/core.test.mjs): signed in, the Worker offers invites with a
  // reward to name, the panel isn't already open, and this browser hasn't had the nudge before.
  function inviteNudgeDue({ signedIn, offer, panelOpen, seen }) {
    return !!(signedIn && offer && offer.bonus && Object.keys(offer.bonus).length && !panelOpen && !seen);
  }
  const inviteNudgeSeen = () => ls.get(INVITE_NUDGE_KEY, null) != null;
  // how: "dismissed" or "opened"; with nothing, the day it was shown, so a reload doesn't show it twice.
  const markInviteNudge = how => ls.set(INVITE_NUDGE_KEY, how || new browser.Date().toISOString().slice(0, 10));
  // One quiet email invitation per browser, after an explicit useful action. Keep no profile,
  // listing ID or email here. Fail closed if persistence is blocked: a reload must not nag again.
  const DIGEST_NUDGE_KEY = "internscout.digest_nudge.v1";
  function createDigestNudge(storage) {
    let used = false;
    return {
      claim(action, { enabled = false, blocked = false, manual = false } = {}) {
        if (used || !enabled || blocked || !manual || !["interested", "profile"].includes(action)) return false;
        // Checks storage works (fail closed), but keeps "shown" only from shown(), once it is on screen.
        try {
          const target = storage || browser.localStorage;
          if (target.getItem(DIGEST_NUDGE_KEY) !== null) return false;
          target.setItem(DIGEST_NUDGE_KEY, "shown");
          const ok = target.getItem(DIGEST_NUDGE_KEY) === "shown";
          target.removeItem(DIGEST_NUDGE_KEY);
          if (!ok) return false;
        } catch (e) { return false; }
        used = true;
        return true;
      },
      shown() {
        if (!used) return;
        try { const t = storage || browser.localStorage; if (t.getItem(DIGEST_NUDGE_KEY) === null) t.setItem(DIGEST_NUDGE_KEY, "shown"); } catch (e) { }
      },
      finish(how) {
        if (!["dismissed", "opened"].includes(how)) return;
        used = true;
        try { (storage || browser.localStorage).setItem(DIGEST_NUDGE_KEY, how); } catch (e) { }
      },
    };
  }
  async function fetchInvite(token) {
    if (!workerOn() || !token) return null;
    try {
      const r = await browser.fetch(C.workerUrl.replace(/\/$/, "") + "/invite", { headers: { Authorization: "Bearer " + token } });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  // was: // { ok, bonus } or { error, message } from the Worker; null when it couldn't be reached (try later).
  // { ok, bonus } or { error, message } from the Worker; null when the answer says nothing about the
  // invite itself (try later): unreachable, 5xx, 429, or 401. A 401 ("Sign in first", "Unknown
  // signing key; sign in again") is about the token, e.g. mid Google key rotation, not the code.
  async function claimInvite(token, code) {
    if (!workerOn() || !token) return null;
    try {
      const r = await browser.fetch(C.workerUrl.replace(/\/$/, "") + "/invite/claim", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      });
      // was: if (r.status >= 500) return null;
      if (r.status >= 500 || r.status === 401 || r.status === 429) return null;
      return await r.json().catch(() => null);
    } catch (e) { return null; }
  }
  const ALLOWANCE_LABELS = { autofill: "Auto-Apply runs", resume_tailor: "Tailored resumes", deep_dive: "Deep Dives" };
  // A label as it reads mid-sentence: "tailored resumes", but Auto-Apply and the Deep Dive keep their capitals.
  const midSentence = l => /^(Auto-Apply|Deep Dive)/.test(l) ? l : l.charAt(0).toLowerCase() + l.slice(1);
  // Fallback names for the paid tiers. /config carries the real labels; this is for when it hasn't
  // loaded yet, or an older page meets a tier it doesn't know.
  const PLAN_LABELS = { supporter: "Supporter", pro: "Pro" };
  // The plans announcement (added 2026-10-04): what free and each paid plan give in Auto-Apply runs,
  // read from the Worker's /config (allowance tables and payments.plans), so it can never state a
  // number the server doesn't serve. null when payments are off, the tables are missing, or the
  // student already pays. PLANS_BANNER_KEY remembers a dismissal by announcement, so a later one shows.
  const PLANS_BANNER_KEY = "internscout.plans_banner";
  const PLANS_BANNER_ID = "2026-10-plans";
  function plansBanner(cfg, me) {
    const pay = cfg && cfg.payments, al = cfg && cfg.allowance;
    if (!pay || !pay.enabled || !al || !al.edu || !al.general) return null;
    if (me && me.plan && me.plan !== "free") return null;
    const runs = t => t && t.autofill;
    const plans = (pay.plans || []).filter(pl => runs(al[pl.plan]) && pl.price)
      .sort((a, b) => a.multiplier - b.multiplier)
      .map(pl => ({ plan: pl.plan, label: pl.label || PLAN_LABELS[pl.plan] || pl.plan, price: pl.price, runs: runs(al[pl.plan]) }));
    if (!plans.length || runs(al.general) == null || runs(al.edu) == null) return null;
    return { free: runs(al.general), edu: runs(al.edu), plans, from: plans[0].price };
  }

  // The dashboard's review line (added 2026-10-07; docs/js/app.js). Only for a student whose extension
  // is set up and has filled applications: the extension says so in its ping reply (review_line, true
  // or false, extension/lib/review.js), and false also means they reviewed or chose "Don't ask again"
  // there. An extension from before that field falls back to the queue holding a filled application.
  // Nothing about it leaves the browser; REVIEW_LINE_KEY is the one setting "Hide" keeps.
  const REVIEW_LINE_KEY = "internscout.review_line";
  const REVIEWS_URL = "https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi/reviews";
  function reviewLineDue(info, queue) {
    if (!info || !info.installed || !info.onboarded) return false;
    if (typeof info.review_line === "boolean") return info.review_line;
    const jobs = Object.values((queue && queue.jobs) || {});
    return jobs.some(j => j && (j.status === "ready_to_submit" || j.status === "submitted"));
  }

  const leftOf = (me, task) => { const a = me && me.allowance && me.allowance[task]; return a ? Math.max(0, (a.limit || 0) - (a.used || 0)) : null; };
  // "Auto-Apply runs: 20 of 20 left" lines plus the tier, for a tooltip.
  function allowanceText(me) {
    if (!me || !me.allowance) return "";
    // limit null = no monthly cap on that task (the Deep Dive)
    const lines = Object.keys(ALLOWANCE_LABELS).filter(k => me.allowance[k]).map(k => me.allowance[k].limit == null
      ? `${ALLOWANCE_LABELS[k]}: unlimited`
      : `${ALLOWANCE_LABELS[k]}: ${leftOf(me, k)} of ${me.allowance[k].limit} left`);
    // was: lines.push(me.tier === "edu" ? "School (.edu) allowance: twice the standard." : "Standard allowance. A Google account with a .edu email gets twice as much.");
    // worker/src/auth.js grants the "edu" tier on a verified .edu address from Microsoft as well as
    // Google, so naming only Google told half the students here that they couldn't qualify.
    lines.push(me.tier === "edu" ? "School (.edu) allowance: twice the standard." : "Standard allowance. A Google or Microsoft account with a verified .edu email gets twice as much.");
    // The Worker already counts invite units in `limit`; say where they came from.
    const extra = Object.keys(ALLOWANCE_LABELS).filter(k => me.allowance[k] && me.allowance[k].bonus > 0)
      .map(k => `${me.allowance[k].bonus} ${midSentence(ALLOWANCE_LABELS[k])}`);
    if (extra.length) lines.push(`Includes ${extra.join(" and ")} from invites. They don't expire.`);
    if (me.plan && me.plan !== "free") lines.push((PLAN_LABELS[me.plan] || me.plan) + " plan" + (me.plan_renews ? ", renews " + String(me.plan_renews).slice(0, 10) : "") + ". Thank you.");
    if (me.paused) lines.push("AI is paused for everyone until next month; search still works.");
    return lines.join("\n");
  }

  // Upgrade ("checkout", with which tier) or change/cancel ("portal"). The Worker talks to Stripe;
  // we only get a URL to send the student to. No card details ever touch this page.
  async function billingUrl(token, kind, plan) {
    if (!workerOn() || !token) return { error: "Sign in first." };
    try {
      const r = await browser.fetch(C.workerUrl.replace(/\/$/, "") + "/billing/" + kind, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(plan ? { plan } : {}),
      });
      // was: if (r.status === 401) { signOut(); return { error: "Sign in again." }; }
      if (r.status === 401) { forget(token); return { error: "Sign in again." }; }
      const b = await r.json().catch(() => ({}));
      if (r.ok && b.url) return { url: b.url };
      return { error: b.message || "That didn't work. Try again later." };
    } catch (e) { return { error: "Couldn't reach the server." }; }
  }

  // "Delete my data": server rows (if signed in), then everything this page keeps in the browser.
  async function deleteMyData(token) {
    let server = null, blocked = false;
    if (workerOn() && token) {
      try {
        const r = await browser.fetch(C.workerUrl.replace(/\/$/, "") + "/me", { method: "DELETE", headers: { Authorization: "Bearer " + token } });
        server = r.ok;
        // A live subscription would keep billing a card for an account we'd just erased, so the
        // Worker refuses until it is cancelled. Leave the browser copy alone and say so.
        if (r.status === 409) {
          const reason = await pendingDeletionReason(browser, r);
          return { server: false, blocked: true, ...(reason ? { reason } : {}) };
        }
      } catch (e) { server = false; }
    }
    ls.del(PROFILE_KEY); ls.del("internscout.demand.sent"); ls.del(INVITE_KEY); ls.del(DIGEST_NUDGE_KEY); ls.set(DELETED_KEY, true);
    // was: ss.del(TOKEN_KEY);
    // The invite check now keeps the account's sub for the session; it comes from the token and goes with it.
    // was: ss.del(TOKEN_KEY); ss.del(INVITE_EDU_KEY);
    // was: ss.del(TOKEN_KEY); ss.del(INVITE_EDU_KEY); ss.del(INVITE_TRIED_KEY);
    // DELETE /me also ends every session of the account on the Worker, so the record here goes too.
    ss.del(TOKEN_KEY); ls.del(SESSION_KEY); ss.del(INVITE_EDU_KEY); ss.del(INVITE_TRIED_KEY);
    return { server };
  }

  // ---------- feedback links ----------
  function reportUrl(x) {
    if (C.formUrl) return C.formUrl.includes("{id}") ? C.formUrl.split("{id}").join(encodeURIComponent(x.id)) : C.formUrl;
    const title = `Wrong tag: listing ${x.id} (${x.company_name} - ${x.title})`;
    return `https://github.com/${C.repo}/issues/new?template=${encodeURIComponent(C.reportTemplate || "wrong_tag.yml")}&title=${encodeURIComponent(title)}`;
  }

  // ---------- weekly email ----------
  // The newsletter's public web archive on Buttondown, worked out from the sign-up form's address
  // (CONFIG.digest.formAction, the one place it is pasted): ".../api/emails/embed-subscribe/NAME" ->
  // "https://buttondown.com/NAME/archive/". "" for any other address, so the dashboard shows no
  // "See last Monday's email" link it can't vouch for. backend/internscout/seo_pages.py digest_archive
  // does the same for the landing pages (added 2026-10-06).
  function digestArchive(formAction) {
    const m = /^https:\/\/buttondown\.(?:com|email)\/api\/emails\/embed-subscribe\/([A-Za-z0-9_-]+)\/?$/.exec(String(formAction || ""));
    return m ? `https://buttondown.com/${m[1]}/archive/` : "";
  }

  return {
    SESSION_KEY, workerOn, decodeJwt, authInfo, authOk, tokenOk, storedToken, startSession,
    handleRedirect, fetchWorkerConfig, PROVIDER_LABELS, count, startSignIn, signOut,
    postDemand, fetchMe, INVITE_KEY, INVITE_EDU_KEY, INVITE_TRIED_KEY, INVITE_CODE,
    INVITE_NUDGE_KEY, inviteNudgeDue, inviteNudgeSeen, markInviteNudge, DIGEST_NUDGE_KEY,
    createDigestNudge, fetchInvite, claimInvite, ALLOWANCE_LABELS, midSentence, PLAN_LABELS,
    PLANS_BANNER_KEY, PLANS_BANNER_ID, plansBanner, REVIEW_LINE_KEY, REVIEWS_URL,
    reviewLineDue, leftOf, allowanceText, billingUrl, deleteMyData, reportUrl, digestArchive,
  };
}

// A bounded classification only; never show arbitrary server text or clear local data on 409.
async function pendingDeletionReason(browser, response) {
  let reader, timer;
  const started = browser.Date.now();
  try {
    if (!Number.isFinite(started) || !response.body || Number(response.headers.get("content-length")) > 4096) return;
    reader = response.body.getReader();
    const read = async () => {
      let size = 0, text = "", last = started;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        const part = await reader.read(), now = browser.Date.now();
        if (now < last || !Number.isFinite(now) || now - started >= 8000) return;
        last = now;
        if (part.done) break;
        size += part.value.byteLength; if (size > 4096) return;
        text += decoder.decode(part.value, { stream: true });
      }
      const data = JSON.parse(text + decoder.decode());
      return data?.error === "topup_payment_pending" ? "topup_payment_pending" : undefined;
    };
    return await Promise.race([read(), new Promise(resolve => { timer = browser.setTimeout(resolve, 8000); })]);
  } catch { /* Every 409 still preserves the profile and session. */ }
  finally { browser.clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); }
}
