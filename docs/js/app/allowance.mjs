// Allowance, return intent and invite controls.

export function createAllowance(browser, {
    IS, h, F,
  }) {
  const ARRIVAL_KEY = "internscout.allowance.return.v1", ARRIVAL_TTL = 10 * 60 * 1000;
  // Only a one-use intent flag and expiry cross sign-in, never a URL, plan or account value.
  function arrivalFlag(action, storage, now = browser.Date.now()) {
    try {
      storage = storage || browser.sessionStorage;
      if (action === "save") { storage.setItem(ARRIVAL_KEY, JSON.stringify({ show: true, expiresAt: now + ARRIVAL_TTL })); return; }
      const raw = storage.getItem(ARRIVAL_KEY); storage.removeItem(ARRIVAL_KEY);
      const v = raw && JSON.parse(raw);
      return action === "take" && !!(v && v.show === true && Number.isFinite(v.expiresAt) && v.expiresAt > now && v.expiresAt <= now + ARRIVAL_TTL);
    } catch (e) { return false; }
  }
  function configuredPlans(cfg) {
    return cfg && cfg.payments && cfg.payments.enabled && Array.isArray(cfg.payments.plans) ? cfg.payments.plans.filter(p => p && typeof p.plan === "string" && p.plan && Number.isFinite(p.multiplier) && p.multiplier > 1) : [];
  }
  function allowanceArrival(search, cfg) {
    const q = new browser.URLSearchParams(search), plan = q.get("upgrade");
    return { plan: configuredPlans(cfg).some(p => p.plan === plan) ? plan : "", generic: q.get("out_of_runs") === "1" };
  }
  function clearArrivalKeys(keys) {
    const url = new browser.URL(browser.location.href); keys.forEach(k => url.searchParams.delete(k));
    browser.history.replaceState(browser.history.state, "", url.pathname + url.search + url.hash);
  }
  function runAllowance(me, cfg) {
    const a = me && me.allowance && me.allowance.autofill;
    if (!a || !Number.isFinite(a.used) || a.used < 0 || (a.limit !== null && (!Number.isFinite(a.limit) || a.limit < 0))) return null;
    const unlimited = a.limit === null, left = unlimited ? null : Math.max(0, a.limit - a.used);
    // /me.limit is a compatibility value including prior usage and bonus. Only these
    // /config tables describe this account exactly; paid general tables are not supplied.
    const table = cfg && cfg.allowance, tier = me.plan === "free" ? me.tier : me.tier === "edu" ? me.plan : null;
    const disabled = a.limit === 0 || !!(tier && table && table[tier] && table[tier].autofill === 0);
    const summary = `${a.used.toLocaleString()} Auto-Apply runs used this month; ` + (unlimited ? "no monthly run limit." : `${left.toLocaleString()} runs left in your allowance.`);
    return { summary, left, unlimited, disabled, exhausted: !disabled && !me.paused && a.limit > 0 && left === 0, purchased: Number.isSafeInteger(a.purchased) && a.purchased > 0 ? a.purchased : 0, bonus: Number.isFinite(a.bonus) && a.bonus > 0 ? a.bonus : 0 };
  }
  const bounded = promise => new Promise(resolve => {
    const timer = browser.setTimeout(() => resolve(null), 8000);
    Promise.resolve(promise).then(v => { browser.clearTimeout(timer); resolve(v); }, () => { browser.clearTimeout(timer); resolve(null); });
  });
  const bonusWords = bonus => Object.entries(bonus || {}).filter(([k, n]) => IS.ALLOWANCE_LABELS[k] && Number.isFinite(n) && n > 0)
    .map(([k, n]) => `${n} extra ${IS.midSentence(IS.ALLOWANCE_LABELS[k])}`).join(" and ");
  function countArrivalOnce(seen, event) { if (!seen.has(event)) { seen.add(event); IS.count(event); } }
  function focusArrival(panel) {
    const active = browser.document.activeElement;
    if (!panel || (active && active !== browser.document.body && active !== browser.document.documentElement)) return false;
    panel.focus(); panel.scrollIntoView({ block: "start" }); return true;
  }
  function visibleFocusAnchor() {
    const node = browser.document.activeElement;
    if (!node || node === browser.document.body || node === browser.document.documentElement) return null;
    const box = node.getBoundingClientRect();
    return box.bottom > 0 && box.top < browser.innerHeight ? { node, top: box.top } : null;
  }
  function restoreArrivalAnchor(anchor) {
    if (!anchor || !anchor.node.isConnected || browser.document.activeElement !== anchor.node) return;
    const shift = anchor.node.getBoundingClientRect().top - anchor.top;
    if (shift) browser.scrollBy({ top: shift, behavior: "instant" });
  }
  function validInvite(r) {
    try { return !!(r && ["https:", "http:"].includes(new browser.URL(r.link).protocol) && Number.isInteger(r.max) && r.max >= 0 && Number.isInteger(r.rewarded) && r.rewarded >= 0 && bonusWords(r.bonus)); }
    catch (e) { return false; }
  }
  function InviteBlock({ invite, status, note, onLoad, onCopy }) {
    const words = invite && bonusWords(invite.bonus), capped = invite && invite.rewarded >= invite.max;
    return h("section", { className: "invite", "aria-label": "Invite a classmate" },
      h("h3", null, invite && invite.bonus.autofill > 0 && !capped ? "Invite a classmate: share extra runs" : "Invite a classmate"),
      h("p", null, invite ? (capped ? `Your invite reward limit is reached. Eligible new classmates can still get ${words}; you will not receive more invite rewards.` : `You each get ${words}.`)
        : "New classmates who join through your link with a verified .edu email in their first week can get extra AI use. Load your link to check your reward eligibility."),
      invite && h("p", { className: "muted" }, `For classmates with a verified .edu email, in their first week. Your rewarded invites: ${invite.rewarded} of ${invite.max}.`),
      h("div", { className: "invite-row" },
        invite && h("input", { id: "invite-link", type: "text", readOnly: true, value: invite.link, "aria-label": "Your invite link", onFocus: e => e.target.select() }),
        invite ? h("button", { type: "button", className: "btn", onClick: onCopy }, "Copy link")
          : h("button", { type: "button", className: "btn", disabled: status === "loading", onClick: onLoad }, status === "loading" ? "Loading invite link…" : status === "error" ? "Retry invite link" : "Get my invite link")),
      h("p", { className: "muted", role: "status" }, status === "error" ? "Couldn't load your invite link. Try again." : note));
  }
  function AllowancePanel({ signedIn, me, status, cfgStatus, allowance, resetDay, plans, busy, signIn, inviteBlock, topup, recovery, onRetry, onConfigRetry, onCheckout, onClose }) {
    return h("section", { id: "allowance-panel", className: "notice allowance-panel", "aria-labelledby": "allowance-title", tabIndex: -1 },
      h("h2", { id: "allowance-title" }, allowance && allowance.exhausted ? "No Auto-Apply runs left in your allowance" : "Your Auto-Apply allowance"),
      h("p", { id: "allowance-status", role: "status", "aria-live": "polite", "aria-atomic": true }, !signedIn ? ""
        : allowance ? (status === "loading" ? "Refreshing your allowance… " : "") + allowance.summary
        : status === "loading" ? "Loading your allowance…" : "Couldn't load your allowance."),
      !signedIn ? h(F, null, h("p", null, "Sign in to see your allowance, invite link and available plans. Searching stays free without sign-in."), cfgStatus === "loading" && h("p", { role: "status" }, "Loading sign-in options…"), signIn)
        : !allowance ? status !== "loading" && h("button", { type: "button", className: "btn", onClick: onRetry }, "Retry allowance")
        : h(F, null,
          allowance.exhausted && h("p", null, `Monthly allowance resets on ${resetDay} (UTC).`),
          allowance.bonus > 0 && h("p", null, `Includes ${allowance.bonus.toLocaleString()} extra runs from invites. Invite credits do not expire.`),
          status === "ready" && allowance.purchased > 0 && h("p", { role: "status", "aria-live": "polite" }, `Purchased Auto-Apply runs remaining: ${allowance.purchased.toLocaleString()}. Purchased runs do not expire. Service limits and temporary pauses still apply.`),
          h("p", { className: "muted" }, me.paused ? "AI use is temporarily paused. Search still works." : allowance.disabled ? "Auto-Apply is currently unavailable for this account." : "Per-run and other service limits can still apply."),
          !allowance.disabled && !me.paused && inviteBlock),
      recovery && h("section", { "aria-label": "Existing checkout" },
        h("p", null, "Check an existing checkout or resume it on Stripe. This does not create a new checkout."),
        h("button", { type: "button", id: "checkout-recovery-action", className: "btn", style: { minHeight: 44 }, "aria-disabled": !!busy, onClick: () => { if (!busy) recovery(); } }, "Check or resume checkout")),
      topup && h("section", { "aria-label": "Extra Auto-Apply runs" },
        h("p", { role: "status", "aria-live": "polite", "aria-atomic": true }, topup.status === "loading" ? "Loading extra runs…" : topup.status === "error" ? TOPUP_UNAVAILABLE : topup.status === "opening" ? "Opening Stripe…" : ""),
        topup.verified && h(F, null,
          h("h3", null, "25 extra Auto-Apply runs for $3"),
          h("p", null, "One payment. No subscription. Your extra runs do not expire. Tax, if any, is shown at checkout."),
          h("p", null, "We use your monthly allowance first, then your extra runs. A run can fill one application. You still review and submit it yourself. Service limits still apply.")),
        h("button", { id: "topup-action", type: "button", className: "btn", style: { minHeight: 44 }, "aria-disabled": !!busy || ["loading", "opening"].includes(topup.status), onClick: () => { if (!busy && !["loading", "opening"].includes(topup.status)) (topup.status === "error" ? topup.retry : topup.buy)(); } }, topup.status === "loading" ? "Loading extra runs…" : topup.status === "error" ? "Retry extra runs" : "Buy 25 extra runs")),
      cfgStatus === "error" && h(F, null, h("p", { role: "status" }, "Couldn't load account options."), h("button", { type: "button", className: "btn", onClick: onConfigRetry }, "Retry account options")),
      signedIn && allowance && h("div", { className: "allowance-plans" }, h("h3", null, "Available plans"),
        plans.length ? plans.map(pl => h("button", { key: pl.plan, type: "button", className: "btn", disabled: !!busy || status !== "ready", onClick: () => onCheckout(pl.plan) }, `${pl.label || IS.PLAN_LABELS[pl.plan] || pl.plan}${pl.price ? ` · ${pl.price}` : ""}`))
          : h("p", null, cfgStatus === "loading" ? "Loading plan options…" : cfgStatus === "error" ? "Plan options could not be loaded." : "No plan upgrade is available for this account."),
        plans.length > 0 && h("p", { className: "muted" }, "Optional monthly plans. Checkout opens only when you choose a plan. Cancel any time.")),
      h("button", { type: "button", className: "btn quiet", onClick: onClose }, "Not now"));
  }

  return {
    arrivalFlag, configuredPlans, allowanceArrival, clearArrivalKeys, runAllowance, bounded,
    bonusWords, countArrivalOnce, focusArrival, visibleFocusAnchor, restoreArrivalAnchor,
    validInvite, InviteBlock, AllowancePanel,
  };
}

export function createAskExtension({
  authRef, IS, setAuth, signedIn,
}) {
  return () => {
    const before = authRef.current;
    return IS.ext.call({ type: "auth:token" }, 1500).then(r => {
      if (authRef.current.token !== before.token || authRef.current.source !== before.source) return;
      if (r && r.token && IS.authOk(r)) setAuth(a => ({ ...a, ...signedIn(r, "extension") }));
    });
  };
}

export function createLoadMe({
  authRef, authGeneration = { current: 0 }, meRequest, setMeResult, bounded, IS, runAllowance, dropToken,
}) {
  return async (token = authRef.current.token) => {
    if (!token || token !== authRef.current.token) return null;
    const seq = ++meRequest.current, generation = authGeneration.current;
    setMeResult(previous => ({ token, generation, data: previous && previous.token === token && previous.generation === generation ? previous.data : null, status: "loading" }));
    const current = () => token === authRef.current.token && generation === authGeneration.current && seq === meRequest.current;
    let active = true, data;
    try { data = await bounded(IS.fetchMe(token, () => active && current())); }
    finally { active = false; } // A late response after timeout must not mutate Core auth.
    if (!current()) return null;
    setMeResult({ token, generation, data, status: runAllowance(data) ? "ready" : "error" });
    if (!data && !IS.authOk(authRef.current.who)) dropToken();
    return data;
  };
}

// One read per return episode, including BFCache. A return during an in-flight read
// schedules one trailing fresh read; paired pageshow/visibility events coalesce.
export function watchAllowanceReturns(browser, load) {
  let away = false, episode = 0, requested = -1;
  let stopped = false, active = false, pending = false;
  const run = async () => {
    active = true;
    try { await load(); } catch { /* The loader owns its error state; keep later returns usable. */ } finally {
      active = false;
      if (pending && !stopped) { pending = false; void run(); }
    }
  };
  const request = () => {
    if (stopped || requested === episode) return;
    requested = episode;
    if (active) pending = true; else void run();
  };
  const leave = () => { if (!away) { away = true; episode++; } };
  const visible = () => {
    if (browser.document.visibilityState === "hidden") leave();
    else if (away) { away = false; request(); }
  };
  const show = event => { if (event.persisted) { away = false; request(); } };
  browser.document.addEventListener("visibilitychange", visible);
  browser.addEventListener("pagehide", leave);
  browser.addEventListener("pageshow", show);
  request();
  if (browser.document.visibilityState === "hidden") leave();
  return () => {
    stopped = true;
    browser.document.removeEventListener("visibilitychange", visible);
    browser.removeEventListener("pagehide", leave);
    browser.removeEventListener("pageshow", show);
  };
}

export async function openInviteAction({
  inviteStatus, inviteRequest, setInviteState, authRef, inviteOffer, setInviteNote,
  bounded, IS, validInvite, setNudge,
}, retry = false) {
    if (inviteStatus !== "idle" && retry !== true) { inviteRequest.current++; setInviteState(null); return; }
    const token = authRef.current.token; if (!token || !inviteOffer) return;
    const seq = ++inviteRequest.current; setInviteNote(""); setInviteState({ token, data: null, status: "loading" });
    const r = await bounded(IS.fetchInvite(token));
    if (token !== authRef.current.token || seq !== inviteRequest.current) return;
    if (validInvite(r)) {
      setInviteState({ token, data: r, status: "ready" }); setNudge(false); IS.markInviteNudge("opened"); IS.count("invite_open");
    } else setInviteState({ token, data: null, status: "error" });
  }

export async function copyInviteAction({
  invite, inviteState, authRef, browser, setInviteNote,
}) {
    if (!invite || inviteState.token !== authRef.current.token) return;
    const token = authRef.current.token, link = invite.link;
    try {
      await browser.navigator.clipboard.writeText(link);
      if (token === authRef.current.token) setInviteNote("Link copied");
    } catch (e) {
      if (token !== authRef.current.token) return;
      const input = browser.document.getElementById("invite-link"); if (input) { input.focus(); input.select(); }
      setInviteNote("Select the link and copy it. Clipboard access is unavailable.");
    }
  }

export async function billingAction({
  authRef, meResult, meStatus, upgrades, billingRequest, countArrival, IS, setBusy,
  bounded, browser, setNote,
}, kind, plan, fromArrival = false) {
    const token = authRef.current.token;
    if (!token || !meResult || meResult.token !== token || (kind === "checkout" && (meStatus !== "ready" || !upgrades.some(p => p.plan === plan)))) return;
    const seq = ++billingRequest.current;
    if (fromArrival && kind === "checkout") countArrival("out_of_runs_plan");
    if (kind === "checkout") IS.count("checkout");
    setBusy(kind === "checkout" ? "Opening Stripe…" : "Opening your billing page…");
    const r = await bounded(IS.billingUrl(token, kind, plan));
    if (seq !== billingRequest.current) return;
    setBusy("");
    if (token !== authRef.current.token) return;
    if (r && r.url) browser.location.assign(r.url);
    else setNote((r && r.error) || "Couldn't open billing. Try again.");
  }


export const TOPUP_UNAVAILABLE = "Extra runs are not available right now. Your current allowance is unchanged.";
export function topupEligible({ open, auth, cfgStatus, meStatus, allowance }) {
  return !!(open && cfgStatus === "ready" && auth.cfg?.topups === true &&
    typeof auth.token === "string" && auth.token.startsWith("iss_") &&
    meStatus === "ready" && allowance?.exhausted && !allowance.disabled && !allowance.unlimited);
}
export function topupCheckoutUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\\\s<>"]/.test(value)) return null;
  try {
    const u = new URL(value);
    return u.origin === "https://checkout.stripe.com" && !u.username && !u.password &&
      !value.slice(0, value.indexOf(u.pathname, 8)).includes("@") &&
      /^\/c\/pay\/cs_[A-Za-z0-9_]{1,250}$/.test(u.pathname) ? value : null;
  } catch { return null; }
}
// All response state belongs to this mounted panel and auth generation, never storage.
export function createTopupActions(browser, { context, update, lock, onPurchase = () => {}, deadlineMs = 8000 }) {
  let sequence = 0, active = null, verified = null;
  const same = c => {
    const n = context();
    return n.eligible && n.token === c.token && n.generation === c.generation && n.workerUrl === c.workerUrl;
  };
  const cancel = () => { sequence++; active?.abort(); active = null; verified = null; };
  const request = async (path, method, c, controller) => (await topupRequest(browser, path, method, c, controller, same, deadlineMs)).data;
  async function load() {
    if (active) return;
    const c = { ...context() }; if (!c.eligible) return;
    verified = null;
    const seq = ++sequence, controller = new AbortController(); active = controller;
    update({ status: "loading", verified: false });
    try {
      const r = await request("/billing/topup/offer", "GET", c, controller);
      if (seq !== sequence || !same(c)) return;
      if (r?.enabled !== true || r.offer?.amount !== 300 || r.offer?.currency !== "usd" || r.offer?.units !== 25) throw Error("offer");
      verified = c; update({ status: "ready", verified: true });
    } catch { if (seq === sequence && same(c)) update({ status: "error", verified: false }); }
    finally { if (seq === sequence) active = null; }
  }
  async function buy() {
    if (active || lock.current || !verified || !same(verified)) return;
    const c = verified, seq = ++sequence, controller = new AbortController(), ticket = { kind: "topup" };
    active = controller; lock.current = ticket; verified = null;
    onPurchase();
    update({ status: "opening", verified: true });
    try {
      const r = await request("/billing/topup/checkout", "POST", c, controller);
      if (seq !== sequence || !same(c)) return;
      const url = r?.status === "open" && topupCheckoutUrl(r.url);
      if (!url) throw Error("checkout");
      browser.location.assign(url);
    } catch { if (seq === sequence && same(c)) update({ status: "error", verified: false }); }
    finally { if (lock.current === ticket) lock.current = null; if (seq === sequence) active = null; }
  }
  return { load, buy, cancel };
}

async function topupRequest(browser, path, method, c, controller, same, deadlineMs, statuses = [200]) {
    const base = new URL(c.workerUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw Error("base");
    const url = base.origin + path, started = browser.performance.now();
    if (!Number.isFinite(started)) throw Error("clock");
    let last = started, reader, timer;
    const check = () => {
      const now = browser.performance.now();
      if (!Number.isFinite(now) || now < last || now - started >= deadlineMs || controller.signal.aborted || !same(c)) throw Error("expired");
      last = now;
    };
    const expired = new Promise((_, reject) => { timer = browser.setTimeout(() => { controller.abort(); reject(Error("timeout")); }, deadlineMs); });
    const work = async () => {
      check();
      const response = await browser.fetch(url, { method, headers: { Authorization: "Bearer " + c.token }, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
      check();
      if (!statuses.includes(response.status) || response.redirected || response.url !== url || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") || "")) throw Error("response");
      if (Number(response.headers.get("content-length")) > 16384 || !response.body) throw Error("size");
      reader = response.body.getReader();
      let size = 0, text = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        const part = await reader.read(); check();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16384) throw Error("size");
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode(); check();
      return { status: response.status, data: JSON.parse(text) };
    };
    try { return await Promise.race([work(), expired]); }
    finally { browser.clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
  }

export const RECOVERY_UNAVAILABLE = "Couldn't check your checkout. Try again. No new checkout was created.";
export const PENDING_TOPUP_DELETION = "Finish or let your pending checkout expire before deleting your data. Contact support if a billing confirmation is pending. Nothing was deleted.";
export function recoveryEligible(me, status, token) {
  return status === "ready" && me?.can_recover_topup === true && typeof token === "string" && token.startsWith("iss_");
}
export function createRecoveryActions(browser, { context, update, lock, refresh, deadlineMs = 8000 }) {
  let sequence = 0, active = null;
  const same = c => { const n = context(); return n.eligible && n.token === c.token && n.generation === c.generation && n.workerUrl === c.workerUrl; };
  const cancel = () => { sequence++; active?.abort(); active = null; };
  async function recover() {
    const c = { ...context() };
    if (!c.eligible || active || lock.current) return;
    const seq = ++sequence, controller = new AbortController(), ticket = { kind: "topup" };
    active = controller; lock.current = ticket;
    update({ status: "checking", message: "Checking your checkout…" });
    try {
      const { status, data } = await topupRequest(browser, "/billing/topup/recover", "POST", c, controller, same, deadlineMs, [200, 202, 401, 429, 503]);
      if (seq !== sequence || !same(c)) return;
      if (status === 200 && data?.status === "open") {
        const url = topupCheckoutUrl(data.url); if (!url) throw Error("checkout");
        update({ status: "open", message: "Opening your existing checkout on Stripe…" });
        browser.location.assign(url);
      } else if (status === 200 && ["settled", "expired", "inactive"].includes(data?.status)) {
        update({ status: "terminal", message: data.status === "expired" ? "That checkout has expired. Refreshing your allowance." : data.status === "inactive" ? "No active checkout was found. Refreshing your allowance." : "Checkout checked. Refreshing your allowance." });
        void refresh(); // Existing loader fences this fresh read by account and request generation.
      } else {
        const message = status === 202 && data?.status === "pending" ? "Your checkout is still being checked. Try again later."
          : status === 401 && data?.status === "auth" ? "Sign in again to check your checkout."
          : status === 429 && data?.status === "limited" ? "Too many checkout checks. Wait a minute, then try again."
          : status === 503 && data?.status === "disabled" ? "Checkout recovery is unavailable right now. Try again later."
          : RECOVERY_UNAVAILABLE;
        update({ status: "error", message });
      }
    } catch { if (seq === sequence && same(c)) update({ status: "error", message: RECOVERY_UNAVAILABLE }); }
    finally { if (lock.current === ticket) lock.current = null; if (seq === sequence) active = null; }
  }
  return { recover, cancel };
}
