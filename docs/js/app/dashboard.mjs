// Dashboard state, effects and React controller.
import { createAskExtension, createLoadMe, watchAllowanceReturns, openInviteAction, copyInviteAction, billingAction, topupEligible, createTopupActions, recoveryEligible, createRecoveryActions, PENDING_TOPUP_DELETION } from "./allowance.mjs";
import { saveProfileAction, saveQuickProfileAction, finishQuickProfileAction } from "./setup.mjs";
import { clearTrackerAction, createSetAppState, createToggleSaved, useManualAppState, showMyListAction } from "./tracker.mjs";
import { createFollowSource } from "./follow-source.mjs";
import { useDigestPrompt } from "./navigation.mjs";

export function createDashboard(browser, {
    useRef, IS, useState, SKIP_KEY, LANDING_KEY, LS_KEY, SAVED_KEY, PAGE, readMyList,
    MYLIST_KEY, VISIT_KEY, useCallback, writeLocal, useEffect, bounded, useExtension, useMemo,
    resolveSavedRoles, DESC_AUTO, arrivalFlag, runAllowance, countArrivalOnce,
    allowanceArrival, EXT_NOTICE_KEY, clearArrivalKeys, bonusWords, validInvite,
    scrollBehavior, quickProfile, publicRole, MORE_KEY, blockers, savedRoleRows, companyRuns,
    touchOnly, plural, C, h, cx, configuredPlans, visibleFocusAnchor, useLayoutEffect,
    restoreArrivalAnchor, focusArrival, Setup, QuickProfile, STATE_LABEL, useNarrow, factsLine,
    matchControl, Why, prevent, PLACE_NOTICE_KEY, PlaceNotice, F, installUrl, SiteNav, ADMIN,
    AccountMenu, noCount, NOCOUNT_KEY, AllowancePanel, InviteBlock, Sel, opt, APP_STATES,
    SearchBox, MultiSelect, ShareSearch, ListTable, Digest, Row, sinceVisit, Landing, DashboardFollow,
  }) {
  function App() {
    const store = useRef(null); if (!store.current) store.current = IS.createStore();
    const [p, setP] = useState(IS.loadProfile);
    const profileRef = useRef(p); profileRef.current = p;
    const [majors, setMajors] = useState(null);
    // Set when IS.loadMajors() settles, either way (see majorsReady in Setup).
    const [majorsReady, setMajorsReady] = useState(false);
    const [stats, setStats] = useState(null);
    // Separate from stats because IS.loadStats() resolves with null on failure (core.js), so the
    // value alone cannot say whether the fetch is still in flight.
    const [statsReady, setStatsReady] = useState(false);
    const [index, setIndex] = useState(null);
    const [legacy, setLegacy] = useState(false);
    const [ready, setReady] = useState(0);
    const [ver, setVer] = useState(0);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    // was: open on every first visit (no profile, not skipped), above the list, so a phone showed a
    // three-step form for two screens before any listing. A first visit now gets one line offering it
    // (setupAsk below), and the card opens in that place when asked for.
    const [setupOpen, setSetupOpen] = useState(false);
    const [skipped, setSkipped] = useState(() => !!IS.ls.get(SKIP_KEY, false));
    const [quickOpen, setQuickOpen] = useState(() => !p && !skipped);
    const [quickMessage, setQuickMessage] = useState("");
    const quickFirstSave = useRef(false);
    const [landingOpen, setLandingOpen] = useState(() => !IS.ls.get(LANDING_KEY, false));
    const initF = prof => ({ sort: prof ? "score" : "new", hide_citizen: !!(prof && prof.work_auth && prof.work_auth !== "citizen"), paid: prof && prof.paid_only ? "no_unpaid" : "" });
    // The landing pages under internships/ link here with ?field=a,b&state=MA, so the list opens on what the
    // student was reading; since U10 (2026-10-14) the dashboard writes its own filters to the address with
    // the same names, so a copied link or a reload opens the same list. IS.filtersFromUrl (core.js) takes
    // only well-formed values; an unknown tag or state matches nothing.
    // was: const fromLink = () => { ... field, state, company, new, stage, year and paid=1 ... };
    const fromLink = () => IS.filtersFromUrl(browser.location.search);
    // The landing link, read once: its fields also prefill the setup card's Major (prefill below).
    const [link] = useState(fromLink);
    const [followSource] = useState(() => createFollowSource(browser));
    const [, refreshFollowNavigation] = useState(0);
    useEffect(() => {
      if (!followSource.enabled) return;
      const navigate = () => { followSource.navigate(); refreshFollowNavigation(n => n + 1); };
      browser.addEventListener("popstate", navigate);
      return () => browser.removeEventListener("popstate", navigate);
    }, []);
    const [f, setF] = useState(() => ({ q: "", fields: [], states: [], company: [], where: "", stage: "", year: "", sector: "", status: "open", app_state: "", new_only: false, eligible: false, ...initF(IS.loadProfile()), ...link }));
    const [appStates, setAppStates] = useState(() => IS.ls.get(LS_KEY, {}) || {});
    const [saved, setSaved] = useState(() => IS.ls.get(SAVED_KEY, []) || []);
    const [myList, setMyList] = useState(false), [myProgress, setMyProgress] = useState("");
    const [myLimit, setMyLimit] = useState(PAGE), [myRetry, setMyRetry] = useState(0);
    const [myLoad, setMyLoad] = useState({ checking: false, failed: [] });
    const [roleBook, setRoleBook] = useState(() => readMyList(IS.ls.get(MYLIST_KEY, null), appStates));
    const roleBookRef = useRef(roleBook); roleBookRef.current = roleBook;
    const [trackerStored, setTrackerStored] = useState(true);
    const [visitStart] = useState(() => browser.Date.now());
    const [previousVisit, setPreviousVisit] = useState(() => IS.ls.get(VISIT_KEY, null));
    const keepRoleBook = useCallback(next => { roleBookRef.current = next; setRoleBook(next); if (!writeLocal(MYLIST_KEY, next)) setTrackerStored(false); }, []);
    useEffect(() => { keepRoleBook(roleBookRef.current); if (!writeLocal(VISIT_KEY, visitStart)) setTrackerStored(false); }, []);
    const savedIds = Object.keys(roleBook.roles).filter(id => roleBook.roles[id].saved), savedIdsKey = JSON.stringify(savedIds);
    const [openId, setOpenId] = useState(null);
    const [browseLimit, setLimit] = useState(PAGE);
    const [browseSel, setBrowseSel] = useState(() => new Set()), [mySel, setMySel] = useState(() => new Set());
    const sel = myList ? mySel : browseSel, setSel = myList ? setMySel : setBrowseSel;
    const selectionSetter = useRef(setSel); selectionSetter.current = setSel;
    const [note, setNote] = useState("");
    // A classmate's invite code waiting for sign-in, and the student's own invite panel (worker/src/referral.js).
    const [invited, setInvited] = useState(() => IS.ls.get(IS.INVITE_KEY, null));
    const [inviteState, setInviteState] = useState(null);
    const inviteRequest = useRef(0);
    const [inviteNote, setInviteNote] = useState("");
    // The one-time invite nudge (added 2026-10-02; core.js inviteNudgeDue): on for the rest of this page
    // load once a first Auto-Apply or first profile triggers it, until Not now or the panel opens.
    const [nudge, setNudge] = useState(false);
    // A browser may still have the previous core.js cached during deployment. The invitation is
    // optional; a missing new helper must never stop the internship dashboard from rendering.
    const digestPrompt = useDigestPrompt({ useRef, IS });
    const [digestNudge, setDigestNudge] = useState(false);
    const [busy, setBusy] = useState("");
    const billingRequest = useRef(0), checkoutLock = useRef(null);
    const [ghToken, setGhToken] = useState(() => { try { return browser.localStorage.getItem("internscout.gh_token") || ""; } catch (e) { return ""; } });
    // was: const [auth, setAuth] = useState(() => ({ cfg: null, token: IS.storedToken(), source: "page" }));
    // auth.token is the bearer sent to the Worker (a session code or an ID token); auth.who is
    // IS.authInfo() of the sign-in it came from ({ email, sub, exp, signin, session }), because a
    // session code can't be decoded the way an ID token could.
    const [auth, setAuthState] = useState(() => { const t = IS.storedToken(); return { cfg: null, token: t, who: IS.authInfo(t), source: "page" }; });
    const authRef = useRef(auth), authGeneration = useRef(0);
    const setAuth = useCallback(update => { const next = typeof update === "function" ? update(authRef.current) : update; if (next.token !== authRef.current.token || next.source !== authRef.current.source) authGeneration.current++; authRef.current = next; setAuthState(next); }, []);
    const invite = inviteState && inviteState.token === auth.token ? inviteState.data : null;
    const inviteStatus = inviteState && inviteState.token === auth.token ? inviteState.status : "idle";
    const [cfgStatus, setCfgStatus] = useState("loading");
    const configRequest = useRef(0);
    const loadConfig = useCallback(async () => {
      const seq = ++configRequest.current; setCfgStatus("loading");
      const cfg = await bounded(IS.fetchWorkerConfig());
      if (seq !== configRequest.current) return;
      setAuth(a => ({ ...a, cfg })); setCfgStatus(cfg ? "ready" : "error");
    }, []);
    const signedIn = (x, source) => { const who = IS.authInfo(x); return who ? { token: who.token, who, source } : { token: null, who: null }; };
    // was (twice): IS.ext.call({ type: "auth:token" }, 1500).then(r => { if (r && r.token && IS.tokenOk(r.token)) setAuth(a => ({ ...a, token: r.token, source: "extension" })); });
    // The extension answers { token, email, account, expires } for a session and { token } for an ID token.
    const askExtension = createAskExtension({
      authRef, IS, setAuth, signedIn,
    });
    const { info, queue, profile: extProfile } = useExtension();

    useEffect(() => { IS.ls.set(LANDING_KEY, true); }, []);
    // was: the landing page's filters were dropped from the address once read ("a reload after changing
    // filters should not bring the landing page's back"). The address now follows the filters instead
    // (the effect after the Stripe ones below), so a reload brings back the current ones.
    useEffect(() => {
      const q = new browser.URLSearchParams(browser.location.search);
      if (!q.has("ref")) return;
      // A classmate's invite (?ref=) waits in this browser until the student signs in (see the claim
      // effect below). Only a code shaped like the Worker's is kept.
      const ref = q.get("ref");
      if (ref && IS.INVITE_CODE.test(ref)) { IS.ls.set(IS.INVITE_KEY, ref); setInvited(ref); }
      q.delete("ref");
      browser.history.replaceState(browser.history.state, "", browser.location.pathname + (q.toString() ? "?" + q : "") + browser.location.hash);
    }, []);

    // data
    const reload = useCallback(async fromRaw => {
      setLoading(true); setErr(null);
      try {
        const r = await store.current.init(fromRaw);
        setIndex(r.index); setLegacy(r.legacy); setErr(null); setReady(n => n + 1); setVer(store.current.version());
      } catch (e) { setErr(String(e.message || e)); setLoading(false); }
    }, []);
    useEffect(() => {
      reload(false);
      // was: IS.loadMajors().then(setMajors);
      IS.loadMajors().catch(() => null).then(m => { setMajors(m); setMajorsReady(true); });
      // was: IS.loadStats().then(setStats);
      // loadStats never rejects (core.js catches every base and returns null), so this .then is the
      // one place that knows the fetch has settled, whichever way it went.
      IS.loadStats().then(s => { setStats(s); setStatsReady(true); });
    }, [reload]);

    // Where the list looks (2026-10-14; IS.viewScope). was: keys = f.states, else IS.profileKeys(p),
    // which with no states picked was the Northeast and remote alone. No states now means every state:
    // the Northeast and remote load first so the first rows paint as fast as before, and the other
    // states follow as soon as a search or a filter needs them (or "Show every state"). A place typed in
    // the search loads that place's file first, whatever the scope.
    const scope = useMemo(() => IS.viewScope(p, f.states), [p, f.states]);
    const qKeys = useMemo(() => IS.queryKeys(f.q), [f.q]);
    const qKeysKey = qKeys.join(",");
    const indexKeys = useMemo(() => index && index.files ? Object.keys(index.files) : [], [index]);
    const searching = f.q.trim().length >= 2;
    // Anything that narrows the list needs every state to be honest about what matches. So does a profile
    // saved with no states: its best matches can be anywhere.
    const wantsAll = searching || f.states.includes(IS.ALL_KEY) || f.fields.length > 0 || f.company.length > 0 || f.new_only || f.status !== "open"
      || !!(f.stage || f.year || f.sector || f.where || f.app_state || f.paid === "paid") || !!(p && !(p.states && p.states.length));
    // Once the other states are loading they stay in the list: clearing the search doesn't hide them again.
    const [allAsked, setAllAsked] = useState(false);
    useEffect(() => { if (scope.all && wantsAll && !allAsked) setAllAsked(true); }, [scope.all, wantsAll]);
    const everything = scope.all && (allAsked || wantsAll);
    const plan = useMemo(() => IS.loadPlan(scope, indexKeys, qKeys, everything), [scope, indexKeys, qKeysKey, everything]);
    const shareViews = useMemo(() => browser.ISShare?.landingViews(browser.document.getElementById("landing-share-views")), []);
    const shareUrl = !myList && browser.ISShare?.searchLink(
      f, scope, { allLoaded: everything, first: plan.first, indexKeys }, shareViews, browser.location.origin, IS.filterParams);
    const planKey = plan.first.join(",") + "|" + plan.rest.join(",");
    // The files the list is drawn from: the scope's own, and any place in the search.
    const keys = useMemo(() => [...plan.first, ...plan.rest], [planKey]);
    const keysKey = keys.slice().sort().join(",");
    const viewSet = useMemo(() => scope.all ? null : new Set([...scope.keys, ...qKeys]), [scope, qKeysKey]);
    // The first-screen file (data/first.json) is the top of exactly one list: no profile, newest first,
    // nothing searched, the Northeast and remote. Any other view loads the state files as before.
    // Filters on that view are fine (a filter keeps the order, and every row it lacks ranks below it).
    const prime = !p && !everything && scope.all && !qKeys.length && f.sort === "new";
    const [failedKeys, setFailedKeys] = useState([]); const [retry, setRetry] = useState(0);
    // Files settled so far and in all, for the "loading more states (12 of 65)" line. A ref, so a file
    // landing doesn't redraw the page by itself; the throttled version bump below does.
    const progress = useRef({ done: 0, total: 0 });
    useEffect(() => {
      if (!ready) return;
      let live = true, timer = 0, frame = 0;
      const st = store.current, total = [...plan.first, ...plan.rest].filter(k => index && index.files && index.files[k]).length;
      progress.current = { done: 0, total };
      const step = () => { progress.current = { done: Math.min(total, progress.current.done + 1), total }; };
      // One redraw per animation frame at most: files that land in the same frame share it.
      // was: setVer for each of the first files as it landed, so two arriving together drew the list twice.
      const paint = () => { if (!frame) frame = browser.requestAnimationFrame(() => { frame = 0; if (live) setVer(st.version()); }); };
      // The first files redraw as they land (the list paints from the first one); the rest at most four
      // times a second, so 56 files arriving don't redraw the page 56 times.
      const bump = () => { if (!timer) timer = browser.setTimeout(() => { timer = 0; paint(); }, 250); };
      setLoading(true); setFailedKeys([]);
      (async () => {
        // A first visit paints from the small first-screen file, then fetches the state files (P2).
        if (prime) { await st.primer(); if (!live) return; paint(); }
        const bad = await st.ensure(plan.first, () => { step(); paint(); });
        for (let i = 0; i < plan.rest.length && live; i += 4) bad.push(...await st.ensure(plan.rest.slice(i, i + 4), () => { step(); bump(); }));
        if (!live) return;
        browser.clearTimeout(timer); browser.cancelAnimationFrame(frame); frame = 0; setVer(st.version()); setLoading(false); setFailedKeys(bad || []);
      })();
      return () => { live = false; browser.clearTimeout(timer); browser.cancelAnimationFrame(frame); };
    }, [ready, planKey, retry]);

    useEffect(() => {
      if (!myList || !ready) return;
      let live = true; setMyLoad({ checking: true, failed: [] });
      resolveSavedRoles(store.current, index, roleBookRef.current.roles, () => setVer(store.current.version()), () => live)
        .then(failed => { if (live) setMyLoad({ checking: false, failed: failed || [] }); });
      return () => { live = false; };
    }, [myList, ready, savedIdsKey, myRetry]);

    // Descriptions come in a sidecar per state; fetch them the first time the search box is used.
    // Each description file is about the size of its listing file (MA: 0.9 MB), so they are fetched only
    // for a real search (2+ letters), and only on their own while the chosen states stay under
    // DESC_AUTO listings. Past that the search covers titles, companies and fields until the student
    // asks for descriptions too.
    const [descAll, setDescAll] = useState(false);
    const [descFailed, setDescFailed] = useState([]), [descLoading, setDescLoading] = useState(false), [descRetry, setDescRetry] = useState(0);
    const descOpen = useMemo(() => keys.reduce((a, k) => a + ((index && index.files && index.files[k] && index.files[k].open) || 0), 0), [keysKey, index]);
    const wantDesc = searching && (descOpen <= DESC_AUTO || descAll);
    useEffect(() => {
      if (!ready || !wantDesc) return;
      let live = true; setDescLoading(true); setDescFailed([]);
      store.current.descs(keys).then(bad => { if (live) { setVer(store.current.version()); setDescFailed(bad || []); setDescLoading(false); } });
      return () => { live = false; };
    }, [ready, wantDesc, keysKey, descRetry, retry]);

    // sign-in
    useEffect(() => {
      // was: const r = IS.handleRedirect(); (synchronous, before the trade for a session)
      IS.handleRedirect().then(r => {
        if (r && r.token) setAuth(a => ({ ...a, ...signedIn(r.session || r.token, "page") }));
        if (r && r.error) setNote("Sign-in didn't work: " + r.error);
      });
      loadConfig();
    }, []);
    useEffect(() => {
      if (!info.installed || auth.token) return;
      askExtension();
    }, [info.installed]);
    // The other way round (U8, 2026-10-14): signed in here but not in the extension, so offer the
    // extension this sign-in, once per page load. The extension checks it with the Worker and only uses it
    // if the student presses "Use my dashboard sign-in" there (extension/lib/auth.js holdOffer). Only the
    // dashboard's own session code, never one the extension gave this page.
    const offeredAuth = useRef(false);
    useEffect(() => {
      if (offeredAuth.current || !info.installed || info.signed_in !== false) return;
      if (auth.source !== "page" || !/^iss_/.test(auth.token || "")) return;
      offeredAuth.current = true;
      IS.ext.call({ type: "auth:offer", token: auth.token }, 10000);
    }, [info.installed, info.signed_in, auth.token, auth.source]);
    useEffect(() => { if (auth.token && p) IS.postDemand(auth.token, p); }, [auth.token, p]);
    // was: const who = auth.token ? (IS.decodeJwt(auth.token) || {}) : null;
    const who = auth.token ? auth.who : null;
    const [meResult, setMeResult] = useState(null), meRequest = useRef(0);
    const me = meResult && meResult.token === auth.token && meResult.generation === authGeneration.current ? meResult.data : null;
    const meStatus = meResult && meResult.token === auth.token && meResult.generation === authGeneration.current ? meResult.status : "loading";
    // An ID token lasts about an hour, a session until sign-out or a year unused. When either runs out
    // (or the Worker refuses it), stop showing "Signed in": take a fresh one from the extension if it
    // has one, otherwise show the sign-in buttons again.
    const dropToken = useCallback(() => {
      // was: IS.signOut(); setAuth(a => ({ ...a, token: null }));
      arrivalFlag("clear"); IS.signOut(); setAuth(a => ({ ...a, token: null, who: null }));
      if (info.installed) askExtension();
    }, [info.installed]);
    const loadMe = useCallback(createLoadMe({
      authRef, authGeneration, meRequest, setMeResult, bounded, IS, runAllowance, dropToken,
    }), [dropToken]);
    useEffect(() => {
      setMeResult(null); setInviteState(null); setInviteNote(""); inviteRequest.current++;
      if (!auth.token) return;
      // was: ... else if (!IS.tokenOk(auth.token)) dropToken(); });
      // authOk is also false once the Worker has answered 401 for this token (a session it ended).
      const load = () => loadMe(auth.token);
      const stopReturns = watchAllowanceReturns(browser, load);
      // was: const ms = ((IS.decodeJwt(auth.token) || {}).exp || 0) * 1000 - Date.now() - 60000;
      // was: const timer = setTimeout(dropToken, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      // An ID token ends within the hour. A session ends up to a year out, past the longest delay
      // setTimeout can hold (about 24.8 days), and the old cap would have signed it out at that
      // point. So a session only gets the timer once its end is within reach; before that the
      // Worker's 401 is what ends it.
      const ms = ((auth.who && auth.who.exp) || 0) - browser.Date.now() - 60000;
      const timer = ms <= 2 ** 31 - 1 ? browser.setTimeout(dropToken, Math.max(0, ms)) : 0;
      return () => { meRequest.current++; browser.clearTimeout(timer); stopReturns(); };
    }, [auth.token, auth.source, authGeneration.current, loadMe]);

    // The extension's Upgrade button (a job paused on a used-up allowance) opens /?upgrade=<plan>.
    // Kept as a notice rather than sent straight on to Stripe: the student sees the plan and what it
    // gives, then presses checkout here themselves.
    const [arrival] = useState(() => ({ search: browser.location.search, returned: arrivalFlag("take") }));
    const [arrivalDismissed, setArrivalDismissed] = useState(false);
    const arrivalEvents = useRef(new Set());
    const countArrival = event => countArrivalOnce(arrivalEvents.current, event);
    const arrivalRoute = allowanceArrival(arrival.search, auth.cfg);
    const upgradeAsk = !arrivalDismissed && (arrivalRoute.plan || arrivalRoute.generic || arrival.returned);
    const [checkoutReturn] = useState(() => new browser.URLSearchParams(browser.location.search).get("upgraded") === "1");
    const dismissArrival = () => { arrivalFlag("clear"); setArrivalDismissed(true); browser.document.getElementById("listings")?.focus(); };
    // The header's sign-in is one quiet button until pressed (2026-10-05); this is whether it has been.
    const [signInOpen, setSignInOpen] = useState(false);
    // was: the plans announcement (2026-10-04), shown above the list until dismissed (plansSeen, hidePlans).
    // Retired on 2026-10-14 (D16, decision 3): the quiet plans line under the counters says the same.
    // The extension notice under the list has a Hide button (D16); hidden for good in this browser.
    const [extHidden, setExtHidden] = useState(() => { try { return browser.localStorage.getItem(EXT_NOTICE_KEY) === "hidden"; } catch (e) { return false; } });
    const hideExt = () => { try { browser.localStorage.setItem(EXT_NOTICE_KEY, "hidden"); } catch (e) { } setExtHidden(true); };
    // The review line (2026-10-07): one quiet sentence for a student whose extension has filled a couple
    // of applications, asking for a Chrome Web Store review. Same words for everyone, nothing offered for
    // it. Hidden for good in this browser by "Hide" or by following it (one setting in local storage), and
    // never shown when the extension says the student already reviewed or chose "Don't ask again" there
    // (the ping's review_line; extension/lib/review.js). An extension too old to say falls back to whether
    // the queue holds a filled application.
    const [reviewHidden, setReviewHidden] = useState(() => { try { return browser.localStorage.getItem(IS.REVIEW_LINE_KEY) === "hidden"; } catch (e) { return false; } });
    const hideReview = () => { try { browser.localStorage.setItem(IS.REVIEW_LINE_KEY, "hidden"); } catch (e) { } setReviewHidden(true); };
    useEffect(() => {
      const keys = [...(arrivalRoute.plan ? ["upgrade"] : []), ...(arrivalRoute.generic ? ["out_of_runs"] : [])];
      if (keys.length) clearArrivalKeys(keys);
    }, [arrivalRoute.plan, arrivalRoute.generic]);

    // Stripe sends the student back to /?upgraded=1. The webhook that records the plan can land a
    // moment later, so check once now and once shortly after before saying anything.
    useEffect(() => {
      if (!checkoutReturn) return;
      clearArrivalKeys(["upgraded"]);
      if (!auth.token) return;
      const token = auth.token; let live = true, timer;
      setNote("Checking your updated plan…");
      const check = async n => {
        const m = await loadMe(token);
        if (!live || token !== authRef.current.token) return;
        if (m && m.plan && m.plan !== "free") setNote(`You're on the ${IS.PLAN_LABELS[m.plan] || m.plan} plan.`);
        else if (n > 0) timer = browser.setTimeout(() => check(n - 1), 3000);
        else setNote("Your plan has not updated yet. Retry your allowance in a minute.");
      };
      check(4);
      return () => { live = false; browser.clearTimeout(timer); };
    }, [auth.token, checkoutReturn, loadMe]);

    // The filters in the address (U10, 2026-10-14; IS.filterSearch in core.js): only what differs from the
    // defaults, so with nothing set the address is plain. replaceState, not pushState: changing a filter
    // doesn't add a Back step, and Back from another page (or a reload) returns to the list as it was left.
    // Defined after the Stripe effects above, which clear the address on their first run.
    useEffect(() => {
      try {
        if (!followSource.canNormalize()) return;
        const search = IS.filterSearch(browser.location.search, f, initF(p));
        if (search !== browser.location.search) browser.history.replaceState(browser.history.state, "", browser.location.pathname + search + browser.location.hash);
      } catch (e) { }
    }, [f, p]);

    // was: // Claim a waiting invite once the student is signed in and the Worker offers invites (its /config
    // was: // says what one is worth). Refusals are final, so the code is dropped, except "use a school
    // was: // account": signing in again with one can still claim it. Unreachable: try again next load.
    // Claim a waiting invite once the student is signed in and the Worker offers invites (its /config
    // says what one is worth). Only answers about the invite itself are final and drop the code:
    // success, bad_invite, own_invite, not_new, already_claimed. "Use a school account" keeps it for
    // a later .edu sign-in. Anything else (unreachable, 5xx, 429, a 401 while Google rotates its
    // keys, an error this page doesn't know) keeps it and tries once more per sign-in or session.
    const INVITE_FINAL = ["bad_invite", "own_invite", "not_new", "already_claimed"];
    const inviteOffer = auth.cfg && auth.cfg.invite && bonusWords(auth.cfg.invite.bonus) ? auth.cfg.invite : null;
    const inviteWords = inviteOffer ? Object.entries(inviteOffer.bonus || {}).map(([k, n]) => `${n} extra ${IS.midSentence(IS.ALLOWANCE_LABELS[k] || k)}`).join(" and ") : "";
    useEffect(() => {
      if (!auth.token || !invited || !inviteOffer) return;
      // This account was already told "use a school account" this session, and the Worker's answer
      // can't change while it stays signed in. A different account (another sub) still tries.
      // was: const sub = (IS.decodeJwt(auth.token) || {}).sub || "";
      // was: const claims = IS.decodeJwt(auth.token) || {}, sub = claims.sub || "";
      // For a session the account stands in for the sub, and `signin` for the ID token's iat.
      const claims = auth.who || {}, sub = claims.sub || "";
      if (sub && IS.ss.get(IS.INVITE_EDU_KEY) === sub) return;
      // A passing failure already happened for this very sign-in (same sub and issue time) and code
      // this session: page reloads reuse the token, so asking again would only repeat it. A new
      // sign-in (new iat, e.g. after the 401) or a new session gets one more try.
      // was: const attempt = `${sub}|${claims.iat || ""}|${invited}`;
      const attempt = `${sub}|${claims.signin || ""}|${invited}`;
      if (IS.ss.get(IS.INVITE_TRIED_KEY) === attempt) return;
      const token = auth.token;
      IS.claimInvite(token, invited).then(r => {
        if (token !== authRef.current.token) return;
        // was: if (!r) return;
        // was: if (r.error === "edu_only") { setNote(r.message); return; }
        // The code is kept for a later school-account sign-in, so the same personal account was asked
        // again and shown the same refusal on every page load. Remembering its sub for the session
        // shows the message once; the code still waits for a .edu sign-in.
        if (r && r.error === "edu_only") { if (sub) IS.ss.set(IS.INVITE_EDU_KEY, sub); setNote(r.message); return; }
        // was: IS.ls.del(IS.INVITE_KEY); setInvited(null);
        // Every non-edu error used to drop the code, so a 401 during a Google key rotation (claimInvite
        // passed any status < 500 through) lost the invite for good. Only final answers drop it now.
        if (!r || !(r.ok || INVITE_FINAL.includes(r.error))) { IS.ss.set(IS.INVITE_TRIED_KEY, attempt); return; }
        IS.ss.del(IS.INVITE_TRIED_KEY); IS.ls.del(IS.INVITE_KEY); setInvited(null);
        if (r.ok) {
          setNote(`Invite accepted: you ${r.inviter_rewarded ? "and your classmate each got" : "got"} ${inviteWords}. They're used after your monthly allowance and don't expire.`);
          loadMe(token);
        } else if (r.error && r.error !== "already_claimed" && r.message) setNote(r.message);
      });
    }, [auth.token, invited, !!inviteOffer]);
    function openInvite(retry = false) {
      return openInviteAction({
        inviteStatus, inviteRequest, setInviteState, authRef, inviteOffer, setInviteNote,
        bounded, IS, validInvite, setNudge,
      }, retry);
    }
    // A good moment just happened (first Auto-Apply queued, first profile saved): offer the invite
    // once, if it can be offered at all. Marked as shown straight away, so a reload never repeats it.
    function offerNudge() {
      if (nudge) return true;
      if (!IS.inviteNudgeDue({ signedIn: !!auth.token, offer: inviteOffer, panelOpen: inviteStatus !== "idle" || !!showAllowance, seen: IS.inviteNudgeSeen() })) return false;
      IS.markInviteNudge(); setNudge(true); return true;
    }
    function offerDigestNudge(action) {
      if (digestPrompt.current.claim(action, { enabled: digestOn, manual: true, blocked: !!(nudge || invite || outOfRuns || upgradeAsk) })) setDigestNudge(true);
    }
    function finishDigestNudge(how) {
      digestPrompt.current.finish(how); setDigestNudge(false);
    }
    function copyInvite() {
      return copyInviteAction({
        invite, inviteState, authRef, browser, setInviteNote,
      });
    }

    async function billing(kind, plan, fromArrival = false) {
      if (checkoutLock.current?.kind === "topup") return;
      const ticket = { kind: "billing" }; checkoutLock.current = ticket;
      try { return await billingAction({
        authRef, meResult, meStatus, upgrades, billingRequest, countArrival, IS, setBusy,
        bounded, browser, setNote,
      }, kind, plan, fromArrival); } finally { if (checkoutLock.current === ticket) checkoutLock.current = null; }
    }

    // profile sync with the extension
    const synced = useRef("");
    useEffect(() => {
      if (!info.installed) return;
      if (p) {
        const body = IS.bridgeProfile(p), k = JSON.stringify(body);
        if (synced.current !== k) { synced.current = k; IS.ext.call({ type: "profile:set", profile: body }, 3000); }
      } else if (!synced.current && !IS.profileDeleted()) {
        synced.current = "asked";
        IS.ext.call({ type: "profile:get" }, 3000).then(r => {
          const got = r && IS.fromBridgeProfile(r.profile);
          if (got && (got.majors.length || got.class_year) && !profileRef.current && !IS.profileDeleted()) { const s = IS.saveProfile(got); profileRef.current = s; setP(s); setSetupOpen(false); setF(x => ({ ...x, ...initF(s) })); }
        });
      }
    }, [info.installed, p]);

    function saveProfile(d) {
      return saveProfileAction({
        p, quickFirstSave, IS, offerNudge, offerDigestNudge, profileRef, setP,
        setSetupOpen, setQuickOpen, setLimit, PAGE, setF, initF, setNote, browser,
        scrollBehavior,
      }, d);
    }
    function saveQuickProfile(patch) {
      return saveQuickProfileAction({
        profileRef, IS, quickProfile, prefill, setP, setF, setLimit, PAGE, quickFirstSave,
        setQuickMessage,
      }, patch);
    }
    function finishQuickProfile() {
      return finishQuickProfileAction({
        setQuickOpen, quickFirstSave, offerNudge, offerDigestNudge, profileRef, IS,
        SKIP_KEY, setSkipped, browser,
      });
    }
    // Focus goes back to the profile editor's opener, or search when the first-visit panel is gone.
    const setupOpener = useRef(null);
    const openSetup = useCallback(() => { setupOpener.current = browser.document.activeElement; setSetupOpen(true); }, []);
    // was: if (!p) IS.ls.set(SKIP_KEY, true); setSetupOpen(false); ...
    function closeSetup() {
      if (!p) { IS.ls.set(SKIP_KEY, true); setSkipped(true); setQuickOpen(false); }
      setSetupOpen(false);
      browser.setTimeout(() => {
        const o = setupOpener.current; setupOpener.current = null;
        const el = o && o.isConnected && o !== browser.document.body ? o : browser.document.getElementById("q");
        if (el) el.focus();
      }, 0);
    }
    function clearTracker() {
      return clearTrackerAction({
        appStatesRef, setAppStates, IS, LS_KEY, keepSaved, SAVED_KEY, roleBookRef,
        setRoleBook, MYLIST_KEY, VISIT_KEY, setPreviousVisit,
      });
    }
    function deleteTracker() {
      if (!browser.confirm("Delete your application statuses, saved roles, saved searches and last-visit timestamp from this browser? This cannot be undone.")) return;
      clearTracker(); browser.setTimeout(() => { const heading = browser.document.getElementById("listings"); if (heading) heading.focus(); }, 0);
    }
    async function deleteData() {
      const { token } = auth;
      const generation = authGeneration.current;
      const currentAccount = () => authRef.current.token === token && authGeneration.current === generation;
      if (!currentAccount()) return;
      // was: const msg = "Delete your InternScout profile from this browser" + (auth.token ? " and your chosen states and past usage from our server (this month's counts go when the month ends)" : "") + "? This can't be undone.";
      // DELETE /me now also removes the Deep Dive saved to the account and signs out every device.
      const msg = "Delete your InternScout profile from this browser" + (auth.token ? " and, from our server, your chosen states, past usage and the Deep Dive saved to your account, and sign you out everywhere (this month's counts go when the month ends)" : "") + "? This can't be undone.";
      if (!browser.confirm(msg)) return;
      const r = await IS.deleteMyData(token, currentAccount);
      if (r.stale || !currentAccount()) return;
      if (r.blocked) {
        setNote(r.reason === "topup_payment_pending" ? PENDING_TOPUP_DELETION : "Cancel your Supporter plan first (Manage plan), then delete. Nothing was deleted.");
        return;
      }
      setDigestNudge(false);
      // Statuses and saved searches are the student's own tracker, so they go only if they say so.
      if ((Object.keys(appStates).length || saved.length || ghToken || Object.keys(roleBook.roles).length || previousVisit || visitStart) && browser.confirm("Also delete your application statuses, saved roles, saved searches and last-visit timestamp from this browser? Cancel keeps them.")) {
        clearTracker();
        try { browser.localStorage.removeItem("internscout.gh_token"); } catch (e) { } setGhToken("");
      }
      // was: setP(null); setAuth(a => ({ ...a, token: null })); setSetupOpen(false); IS.ls.del(SKIP_KEY);
      arrivalFlag("clear"); profileRef.current = null; quickFirstSave.current = false; setP(null); setQuickMessage(""); setAuth(a => ({ ...a, token: null, who: null })); setSetupOpen(false); setQuickOpen(true); IS.ls.del(SKIP_KEY);
      setF(x => ({ ...x, states: [], ...initF(null) }));
      setNote(r.server === false ? "Deleted from this browser. The server delete failed; sign in again and retry, or open a GitHub issue." : (r.server ? "Your data was deleted from this browser and our server." : "Your profile was deleted from this browser.")
        + (info.installed ? " The extension keeps its own copy of your profile and files: removing it at chrome://extensions deletes that copy." : ""));
    }

    // The statuses as of the last render, for listeners added once (the "Did you apply?" check below).
    const appStatesRef = useRef(appStates); appStatesRef.current = appStates;
    const setAppState = useCallback(createSetAppState({
      appStatesRef, setAppStates, IS, LS_KEY, roleBookRef, store, keepRoleBook, publicRole,
    }), [keepRoleBook]);
    // Queue updates and batch Auto-Apply also set statuses; only the student's own status control
    // can offer this invitation. Never perform prompt side effects inside a React state updater.
    // Stable, like the rows' other handlers: rows are memoized, and a new function here each render
    // redrew every row on every keystroke. The ref reads the current notices when it fires.
    // was: const setManualAppState = (id, v) => { ... } (a new function each render, review of #123).
    const setManualAppState = useManualAppState({ useRef, offerDigestNudge, useCallback, appStatesRef, setAppState });
    const upd = (k, v) => { followSource.correct(k, v); setF(s => ({ ...s, [k]: v })); setLimit(PAGE); };
    const myListRef = useRef(myList); myListRef.current = myList;
    const toggleSaved = useCallback(createToggleSaved({
      roleBookRef, keepRoleBook, publicRole, IS, appStatesRef, setManualAppState, setMySel,
      myListRef, browser,
    }), [keepRoleBook, setManualAppState]);
    const showMyList = on => showMyListAction({ myList, IS, setMyLoad, setMyList }, on);
    // "More filters" remembers whether it was open; the count is how many of the controls inside it
    // are set to something other than their default, so a hidden filter is never a silent one.
    const [moreOpen, setMoreOpenRaw] = useState(() => !!IS.ls.get(MORE_KEY, false));
    const setMoreOpen = fn => setMoreOpenRaw(o => { const n = typeof fn === "function" ? fn(o) : fn; IS.ls.set(MORE_KEY, n); return n; });
    const defaults = initF(p);
    const moreCount = ["stage", "year", "sector", "app_state"].filter(k => f[k]).length
      + (f.paid !== (defaults.paid || "") ? 1 : 0) + (f.where ? 1 : 0) + (f.status !== "open" ? 1 : 0)
      + (f.hide_citizen !== defaults.hide_citizen ? 1 : 0) + (f.new_only ? 1 : 0) + (f.eligible ? 1 : 0);
    const anyFilter = moreCount > 0 || !!f.q.trim() || f.fields.length > 0 || f.states.length > 0 || f.company.length > 0;
    // Only a search is set: the count line's button says "Clear search" (D17).
    const onlySearch = !!f.q.trim() && moreCount === 0 && !f.fields.length && !f.states.length && !f.company.length;
    const clearFilters = () => { followSource.correct("fields", []); followSource.correct("states", []); setF(s => ({ ...s, q: "", fields: [], states: [], company: [], where: "", stage: "", year: "", sector: "", status: "open", app_state: "", new_only: false, eligible: false, ...defaults })); setLimit(PAGE); };
    const st = id => appStates[id] || "none";
    const keepSaved = list => { setSaved(list); IS.ls.set(SAVED_KEY, list); };
    function onSaved(v) {
      if (v === "__save") { const name = (browser.prompt("Name this search") || "").trim(); if (name) keepSaved([...saved.filter(s => s.name !== name), { name, f }]); }
      else if (v.startsWith("del:")) keepSaved(saved.filter(s => s.name !== v.slice(4)));
      else { const s = saved.find(x => x.name === v); if (s) { for (const k of ["fields", "states"]) if (Object.hasOwn(s.f, k)) followSource.correct(k, s.f[k]); setF(cur => ({ ...cur, ...s.f })); } }
    }

    const jobs = useMemo(() => {
      const m = {}; Object.values(queue.jobs || {}).forEach(j => { if (j.listingId == null) return; const k = String(j.listingId); if (!m[k] || m[k].updated < j.updated) m[k] = j; });
      return m;
    }, [queue]);
    useEffect(() => { Object.entries(jobs).forEach(([id, j]) => { if (j.status === "submitted" && (appStates[id] || "none") === "none") setAppState(id, "applied"); }); }, [jobs]);

    const all = useMemo(() => store.current.all(), [ver]);
    useEffect(() => {
      const book = roleBookRef.current; let next = book;
      for (const row of all) {
        const old = book.roles[String(row.id)]; if (!old || !old.saved) continue;
        const entry = { ...publicRole(row), saved: true };
        if (JSON.stringify(entry) !== JSON.stringify(old)) { if (next === book) next = { ...book, roles: { ...book.roles } }; next.roles[row.id] = entry; }
      }
      if (next !== book) keepRoleBook(next);
    }, [all, savedIdsKey, keepRoleBook]);
    // anywhere: no states on the profile (or no profile), so no place scores above another.
    const ctx = useMemo(() => { const { direct, related } = IS.profileFields(p, majors); return { p, direct, related, keys: new Set(IS.profileKeys(p)), anywhere: !(p && p.states && p.states.length) }; }, [p, majors]);
    // Which of a listing's places the row shows first: one in the scope, or the place searched for.
    const keySet = useMemo(() => viewSet || new Set(qKeys), [viewSet, qKeysKey]);
    // was: rows in `keys` only. With every state in scope it is every row loaded (less remote-only rows
    // for a profile that turned remote off).
    const inView = useMemo(() => !viewSet
      ? all.filter(x => [...IS.shardKeys(x)].some(k => (!scope.noRemote || (k !== "remote" && k !== "US")) && (everything || legacy || keys.includes(k))))
      : all.filter(x => { for (const k of IS.shardKeys(x)) if (viewSet.has(k)) return true; return false; }), [all, viewSet, scope.noRemote, everything, legacy, keysKey]);
    // was: a Map of every row in view, rebuilt whenever a file landed. Kept per row now, so the 56 files
    // of a nationwide search each score only their own rows.
    const scoreOf = useMemo(() => { const m = new WeakMap(); return x => { let v = m.get(x); if (!v) { v = IS.score(x, ctx); m.set(x, v); } return v; }; }, [ctx]);

    // `base` is what the extension says about the student, or nothing (placeElig below).
    const eligOf = (p, base) => {
      const e = { ...(base || {}) };
      if (p) {
        const gy = parseInt((p.grad_term || "").split(" ")[1], 10); if (gy) e.grad_year = gy;
        if (p.class_year) e.class_year = p.class_year;
        if (p.work_auth === "citizen") e.citizenship = "U.S. citizen";
        else if (p.work_auth === "permanent") e.citizenship = "U.S. permanent resident";
        else if (p.work_auth === "visa") { e.citizenship = "Student visa"; e.needs_sponsorship = true; }
        else if (p.work_auth === "canada") e.citizenship = "Canadian work authorization";
        if (p.class_year === "masters") e.degree = "master's"; else if (p.class_year === "phd") e.degree = "PhD"; else if (p.class_year && !e.degree) e.degree = "bachelor's";
      }
      return e;
    };
    const elig = useMemo(() => (!p && !extProfile ? null : eligOf(p, extProfile)), [p, extProfile]);
    // The paid listing's hide check reads the dashboard's saved profile only, never anything from the
    // extension: the privacy page (#paid-listings) and the Chrome Web Store limited-use promise both say
    // so (legal review 2026-10-14). was: exclude used `elig`, which starts from extProfile.
    const placeElig = useMemo(() => (p ? eligOf(p, null) : null), [p]);

    const opts = useMemo(() => {
      const count = get => { const m = new Map(); inView.forEach(x => (get(x) || []).forEach(t => t && m.set(t, (m.get(t) || 0) + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
      const stateOpts = index
        ? Object.entries(index.files).map(([k, m]) => ({ value: k, label: IS.keyLabel(k), chip: k === "remote" ? "Remote" : k, count: m.open })).sort((a, b) => b.count - a.count)
        : count(x => [...IS.shardKeys(x)]).map(([k, n]) => ({ value: k, label: IS.keyLabel(k), chip: k === "remote" ? "Remote" : k, count: n }));
      // "Everywhere" (2026-10-14): every state, province and remote, the same as picking none.
      if (index) stateOpts.unshift({ value: IS.ALL_KEY, label: "Everywhere", chip: "Everywhere", hint: "every state" });
      return {
        fields: count(x => x.field_tags).map(([v, n]) => ({ value: v, label: IS.fieldLabel(v), count: n })),
        sectors: count(x => [x.sector]),
        stages: count(x => x.stage),
        states: stateOpts,
      };
    }, [inView, index]);

    // Place words for the search ("boston"): what the loaded rows' locations say, worked out only once
    // there is a search, and again only when more rows arrive.
    const words = useMemo(() => f.q.trim() ? IS.placeWords(inView) : null, [inView, !!f.q.trim()]);
    const cq = useMemo(() => IS.compileQuery(f.q, words), [f.q, words]);
    // With words to rank by, the list comes in order of how well each role matches them (title, then
    // field, company, place and skills, then description), with the chosen sort as the tiebreak.
    // The list (2026-10-14, B2 plan section 5): IS.listRows (core.js) applies the search, every filter and the
    // sort, and hands back each row's relevance too. was: the same code inline here, as one useMemo returning
    // rows, with `ranked` worked out just above it. It moved so tests can prove what may and may not change it.
    const listed = useMemo(() => IS.listRows(inView, f, { cq, scoreOf, p, elig, blockers, appStates, jobs }), [inView, cq, f, appStates, jobs, elig, scoreOf, p]);
    const myRows = useMemo(() => savedRoleRows(all, roleBook.roles), [all, roleBook]);
    const rows = myList ? myRows.filter(r => !myProgress || (appStates[r.id] || "none") === myProgress) : listed.rows, ranked = !myList && listed.ranked;

    // Paid listings (2026-10-14, B2 plan section 5; js/placements.js). Everything above (the list, its order,
    // every score and count) is finished before this runs, and nothing here writes to it: ISPlace.pick only
    // reads the rows and names at most one of them for a separate box headed "Paid listing". That listing
    // stays in the list at its own place. The box needs a search or a Field filter (the context gate), waits
    // until the files have settled, and is off while "Your progress" is set. `exclude` is the saved profile's
    // only part: it can hide a paid listing that doesn't fit (class year, citizenship, eligibility, season),
    // never pick one. "Show paid listings" (More filters) is a display setting, not a filter: it is not in
    // `f`, so it never counts as a filter, never goes in a saved search or the address, and never touches
    // `rows`. With no placements.json, or CONFIG.placements === false, none of this shows.
    const PL = browser.ISPlace;
    // was: useState([]). What the page head already read, if it has (ISPlace.loaded, 2026-10-14), so the notice
    // below is in the first draw; load() fills it in otherwise.
    const [placements, setPlacements] = useState(() => (PL && PL.loaded()) || []);
    useEffect(() => { if (PL) PL.load().then(list => setPlacements(list || [])); }, []);
    const [placeHidden, setPlaceHiddenRaw] = useState(() => !!(PL && IS.ls.get(PL.HIDE_KEY, false)));
    // Kept for the session in React state even when the browser blocks storage.
    const setPlaceHidden = on => { setPlaceHiddenRaw(on); if (PL) { if (on) IS.ls.set(PL.HIDE_KEY, true); else IS.ls.del(PL.HIDE_KEY); } };
    const exclude = useCallback(x => !!(scoreOf(x).mismatch
      || IS.citizenBlocked(x, p ? p.work_auth : "")
      || (placeElig && blockers(x, placeElig).length > 0)
      || (p && p.terms && p.terms.length && IS.termFit(x, p.terms) < .8)), [scoreOf, p, placeElig]);
    // The last pick, kept while it still fits, so the box doesn't swap as files land or filters change.
    const placedRef = useRef(null);
    const placed = useMemo(() => PL && !myList ? PL.pick({ placements, rows, rel: listed.rel, ranked, fieldsSet: f.fields.length > 0, appState: f.app_state,
      loading, day: new browser.Date().toISOString().slice(0, 10), exclude, hidden: placeHidden, prev: placedRef.current, rand: Math.random }) : null,
    [placements, listed, loading, placeHidden, exclude, f.fields.length, f.app_state, myList]);
    if (placed) placedRef.current = placed;

    const [expandedRuns, setExpandedRuns] = useState(() => new Set());
    const limit = myList ? myLimit : browseLimit;
    const pageRows = rows.slice(0, limit);
    const { shown, moreAfter } = companyRuns(pageRows, myList ? { sort: "company", q: "" } : f, expandedRuns);
    // Every file loaded: the list itself is the whole country.
    const allLoaded = everything && !loading;
    // was: stats.open, else the sum of index.files[].open, which counts a role filed in two states twice
    // (21,430 for 14,799 roles). No figure until there is a true one.
    const nationwide = stats && stats.open ? stats.open : allLoaded ? all.filter(x => x.status === "open").length : null;
    const figures = useMemo(() => ({
      open: inView.filter(x => x.status === "open").length,
      fresh: inView.filter(x => x.is_new).length,
      applied: Object.values(appStates).filter(v => v === "applied").length,
    }), [inView, appStates]);
    // Nothing to count yet: the figures show a placeholder, not 0 (was: "0 Open in the Northeast").
    const counting = loading && !all.length;
    const gen = (index && index.generated_at) || (stats && stats.generated_at);
    // was: ... : "unknown", so a slow connection read "Updated unknown." for seconds. Nothing until the date is known (D17).
    const genText = gen ? new browser.Date(gen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const jobCounts = useMemo(() => { const c = {}; Object.values(queue.jobs || {}).forEach(j => { c[j.status] = (c[j.status] || 0) + 1; }); return c; }, [queue]);

    const canAuto = info.installed;
    // A desktop browser we know has no extension (a phone can't add one), for the rows' Auto-Apply explainer.
    const canTry = info.checked && !info.installed && !info.stale && !touchOnly();
    const selectionRef = useRef(sel); selectionRef.current = sel;
    // The selection limit message. It used to go in the page notes at the top, often thousands of
    // pixels above the checkbox just clicked, so the click looked like it did nothing. It shows at the
    // bottom of the screen now, where it can be seen from anywhere in the list, and goes after 8 s.
    const [selNote, setSelNote] = useState("");
    const selTimer = useRef(0);
    const flashSelNote = useCallback(text => {
      browser.clearTimeout(selTimer.current); setSelNote(text);
      selTimer.current = browser.setTimeout(() => setSelNote(""), 8000);
    }, []);
    useEffect(() => () => browser.clearTimeout(selTimer.current), []);
    const check = useCallback((id, on) => {
      const n = new Set(selectionRef.current);
      if (on && !n.has(id) && n.size >= IS.SELECT_MAX) { flashSelNote(`Select up to ${IS.SELECT_MAX} applications at a time. Queue these first, then select more.`); return; }
      on ? n.add(id) : n.delete(id); selectionRef.current = n; selectionSetter.current(n);
    }, []);
    const onWhy = useCallback(id => setOpenId(o => o === id ? null : id), []);
    // was: rows with no job of their own. A row whose apply link a job already holds is skipped by the
    // extension too, so the header checkbox no longer picks it.
    const held = useMemo(() => IS.heldUrls(queue), [queue]);
    const selectable = shown.filter(r => !r._savedMissing && r.apply_url && (!jobs[String(r.id)] || jobs[String(r.id)].status === "failed") && !held.has(r.apply_url));
    const selectedRows = all.filter(r => sel.has(r.id) && r.apply_url && (!jobs[String(r.id)] || jobs[String(r.id)].status === "failed") && !held.has(r.apply_url)
      && (!myList || (roleBook.roles[String(r.id)] && roleBook.roles[String(r.id)].saved)));
    // was: selectable.slice(0, 100).every(r => sel.has(r.id)), which could stay unchecked for good (IS.headerChecked).
    const allChecked = IS.headerChecked(selectable, sel);
    const selectShown = on => {
      const { sel: n, omitted } = IS.selectRows(selectionRef.current, selectable, on);
      selectionRef.current = n; setSel(n);
      if (omitted) flashSelNote(`Selected ${n.size} applications. Queue up to ${IS.SELECT_MAX} at a time; ${omitted} more shown are not selected.`);
      else setSelNote("");
    };

    const autoRef = useRef(null);
    const autoPending = useRef(false), [queuing, setQueuing] = useState(false);
    const onAutoRow = useCallback(list => autoRef.current && autoRef.current(list), []);
    async function autoApply(list) {
      if (!info.installed) { setNote("Install the InternScout extension first."); return; }
      if (autoPending.current) return;
      const { batch, remaining } = IS.applicationBatch(list);
      if (!batch.length) return;
      autoPending.current = true; setQueuing(true); setNote("Loading posting details…");
      try {
      // The agent tailors answers from the posting text, which is not in the list rows.
      const ks = new Set(), loaded = new Set(store.current.loadedKeys());
      batch.forEach(r => { if (!r.description) { const k = [...IS.shardKeys(r)].find(k => loaded.has(k)); if (k) ks.add(k); } });
      const bad = await store.current.descs([...ks]);
      if (bad.length) { setNote(`Couldn't load posting details for ${bad.join(", ")}. Check your connection and try Auto-Apply again.`); return; }
      const payload = batch.map(r => ({
        id: r.id, apply_url: r.apply_url, company: r.company_name, title: r.title,
        location: IS.regs(r).map(g => g.loc).filter(Boolean).join("; ") || (r.region_locations || []).join("; ") || r.location_raw || "", description: r.description || "",
      }));
      if (!payload.length) return;
      setNote("Adding to the queue…");
      const res = await IS.ext.call({ type: "enqueue", jobs: payload });
      // res.held (U2, 2026-10-14): an extension that keeps the picked postings until setup is done says how many.
      // was: always "Set up Auto-Apply first (about 2 minutes). It just opened in a new tab."
      if (res.error === "setup_required") { setNote("Set up Auto-Apply first (about 2 minutes). It just opened in a new tab." + (res.held ? ` ${res.held === 1 ? "The posting" : `The ${res.held} postings`} you picked will be waiting there, ready to start when you finish.` : "")); return; }
      if (res.error) { setNote("Couldn't queue: " + res.error); return; }
      const added = (res.added || []).length, skipped = (res.skipped || []).length;
      const current = added || skipped ? await IS.ext.call({ type: "get_queue" }) : null;
      const addedIds = new Set(IS.queuedListingIds(res.added || [], current && current.queue));
      // was: the listing ids of the added and skipped jobs alone, so a listing skipped for sharing its
      // apply link with another listing's job stayed selected for good.
      const handledIds = new Set([...addedIds, ...IS.handledListingIds(batch, res, current && current.queue)]);
      const unhandled = s => new Set([...s].filter(id => !handledIds.has(String(id))));
      setBrowseSel(unhandled); setMySel(unhandled);
      // was: if (added) IS.count("autoapply");
      if (added) { IS.count("autoapply"); offerNudge(); }
      setNote(`Queued ${plural(added, "application")}${skipped ? ` (${skipped} already queued)` : ""}.${remaining.length ? ` ${remaining.length} more remain selected; queue them in the next batch.` : ""} Each one is filled in and left for you to submit.`);
      batch.forEach(r => { if (addedIds.has(String(r.id)) && st(r.id) === "none") setAppState(r.id, "interested"); });
      IS.ext.call({ type: "open_panel" });
      browser.setTimeout(() => setNote(""), 9000);
      } catch (e) { setNote("Couldn't add applications to the queue. Your selections are kept; try again."); }
      finally { autoPending.current = false; setQueuing(false); }
    }

    autoRef.current = autoApply;

    // admin only: trigger the scanner workflow with a GitHub token kept in this browser
    async function rescan() {
      let t = ghToken;
      if (!t) { t = (browser.prompt("Paste a GitHub fine-grained token (Actions: Read and write). Stored only in this browser; sent only to github.com.") || "").trim(); if (!t) return; browser.localStorage.setItem("internscout.gh_token", t); setGhToken(t); }
      const H = { Authorization: "Bearer " + t, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      const api = `https://api.github.com/repos/${C.repo}/actions/workflows/${C.workflow || "ingest.yml"}`;
      try {
        setBusy("Starting…");
        const before = await browser.fetch(`${api}/runs?per_page=1`, { headers: H }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
        const beforeId = before.workflow_runs && before.workflow_runs[0] ? before.workflow_runs[0].id : 0;
        const disp = await browser.fetch(`${api}/dispatches`, { method: "POST", headers: H, body: JSON.stringify({ ref: "main" }) });
        if (disp.status === 401) { browser.localStorage.removeItem("internscout.gh_token"); setGhToken(""); setBusy("Token rejected"); return; }
        if (disp.status !== 204) { setBusy("Failed (HTTP " + disp.status + ")"); return; }
        setBusy("Scanning…");
        for (let i = 0; i < 360; i++) {
          await new Promise(r => browser.setTimeout(r, 5000));
          const runs = await browser.fetch(`${api}/runs?per_page=5`, { headers: H }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
          const run = (runs.workflow_runs || []).find(x => x.id > beforeId); if (!run) continue;
          if (run.status !== "completed") { setBusy("Scanning (" + String(run.status).replace("_", " ") + ")"); continue; }
          if (run.conclusion !== "success") { setBusy("Scan " + run.conclusion); return; }
          setBusy("Loading…"); await new Promise(r => browser.setTimeout(r, 3000)); await reload(true); setBusy("Updated"); browser.setTimeout(() => setBusy(""), 4000); return;
        }
        setBusy("Still running, reload shortly");
      } catch (e) { setBusy("Error: " + e.message); }
    }

    const majorsText = p ? (p.majors.length ? p.majors.join(", ") : p.fields.length ? p.fields.map(IS.fieldLabel).join(", ") : "All fields") : "";
    // was: ... : IS.BASELINE.join(", ") for a profile with no states, which now means every state.
    const whereText = p ? (p.states.length ? [p.states.length <= 5 ? p.states.join(", ") : `${p.states.length} states`, p.remote ? "remote" : ""].filter(Boolean).join(" + ") : p.remote ? "every state and remote" : "every state") : "";
    // A real button inside the header, so the column sorts from the keyboard and a screen reader
    // hears which column the list is sorted by. Each sort here is a fixed order, so "descending"
    // is only an approximation for company (A-Z), but aria-sort has no "custom" value.
    const sortTh = (key, label) => h("th", { className: cx("sort", f.sort === key && "on"), scope: "col",
      "aria-sort": f.sort === key ? (key === "company" ? "ascending" : "descending") : undefined },
      h("button", { type: "button", onClick: () => upd("sort", key) }, label));
    const feedbackUrl = C.formUrl ? C.formUrl.split("{id}").join("") : C.issuesUrl;
    // The weekly email form shows only once window.CONFIG.digest.formAction is filled in, and only
    // for an https address, so a mistyped one can't send a student's email in the clear.
    const digestOn = !!(C.digest && C.digest.formAction && /^https:\/\//.test(C.digest.formAction));
    // The same field tags the ranking treats as the student's own, less "other", and only well-formed
    // keys: an unknown tag name creates a new tag at Buttondown.
    const digestFields = [...ctx.direct].filter(t => t !== "other" && /^[a-z_]{2,32}$/.test(t));
    // Optional paid plans. The Worker only advertises the tiers whose Stripe price it actually has,
    // so a tier that isn't set up yet never appears as a button the student can press.
    const payPlans = configuredPlans(auth.cfg);
    // Only what is actually a step up from the plan they are on: a Supporter sees Pro, not Supporter.
    const myMult = (payPlans.find(pl => pl.plan === (me && me.plan)) || {}).multiplier || 1;
    const upgrades = me && me.can_upgrade ? payPlans.filter(pl => pl.multiplier > myMult) : [];
    const upgradeTitle = pl => `Optional. Covers the AI bill and gives you ${pl.multiplier}× your monthly `
      + "AI allowance. Stripe takes the payment; we never see your card. Cancel any time.";
    // Out of Auto-Apply runs: say when they come back and how to get more now. Only for a real
    // allowance (limit > 0): a limit of 0 is Auto-Apply switched off, and limits.js won't spend
    // invite runs on a switched-off task, so "used up" and "invite a classmate" would both be wrong.
    const allowance = runAllowance(me, auth.cfg);
    // was: ... && !me.paused && inviteOffer && autoAllow && ...: the notice only showed while invites were on,
    // so with invites off a student who ran out heard nothing. Now the invite is one of its options.
    const outOfRuns = !!(auth.token && allowance && allowance.exhausted);
    const showAllowance = !arrivalDismissed && (upgradeAsk || outOfRuns);
    const eligibleTopup = topupEligible({ open: showAllowance, auth, cfgStatus, meStatus, allowance });
    const [topupState, setTopupState] = useState(null);
    const topupContext = useRef(null);
    topupContext.current = { eligible: eligibleTopup, workerUrl: C.workerUrl };
    const topupActions = useRef(null);
    if (!topupActions.current) topupActions.current = createTopupActions(browser, {
      context: () => ({ ...topupContext.current, token: authRef.current.token, generation: authGeneration.current }),
      update: setTopupState, lock: checkoutLock, onPurchase: () => countArrival("out_of_runs_topup"),
    });
    useEffect(() => {
      topupActions.current.cancel(); setTopupState(null);
      if (eligibleTopup) void topupActions.current.load();
      return () => topupActions.current.cancel();
    }, [eligibleTopup, auth.token, authGeneration.current]);
    const topup = eligibleTopup && topupState ? { ...topupState, buy: topupActions.current.buy, retry: topupActions.current.load } : null;
    const canRecover = recoveryEligible(me, meStatus, auth.token);
    const recoveryContext = useRef(null), recoveryActions = useRef(null);
    const [recoveryState, setRecoveryState] = useState(null);
    recoveryContext.current = { eligible: canRecover, workerUrl: C.workerUrl };
    if (!recoveryActions.current) recoveryActions.current = createRecoveryActions(browser, {
      context: () => ({ ...recoveryContext.current, token: authRef.current.token, generation: authGeneration.current }),
      update: state => {
        const restore = state.status === "terminal" && browser.document.activeElement?.id === "checkout-recovery-action";
        setRecoveryState(state);
        if (restore) browser.setTimeout(() => { if (browser.document.activeElement === browser.document.body) browser.document.getElementById("checkout-recovery-status")?.focus(); }, 0);
      }, lock: checkoutLock, refresh: () => loadMe(),
    });
    useEffect(() => {
      recoveryActions.current.cancel(); setRecoveryState(null);
      return () => recoveryActions.current.cancel();
    }, [auth.token, authGeneration.current]);
    const recovering = recoveryState?.status === "checking";
    const arrivalFocused = useRef(false);
    const arrivalInserted = useRef(false), arrivalAnchor = useRef(null);
    if (showAllowance && !arrivalInserted.current) arrivalAnchor.current = visibleFocusAnchor();
    useLayoutEffect(() => {
      if (!showAllowance || arrivalInserted.current) return;
      arrivalInserted.current = true; restoreArrivalAnchor(arrivalAnchor.current); arrivalAnchor.current = null;
    }, [showAllowance]);
    useEffect(() => {
      if (!showAllowance || !upgradeAsk || arrivalFocused.current) return;
      const panel = browser.document.getElementById("allowance-panel");
      if (panel) { arrivalFocused.current = true; focusArrival(panel); }
    }, [showAllowance, upgradeAsk]);
    useEffect(() => {
      if (!showAllowance) return;
      const panel = browser.document.getElementById("allowance-panel"); if (!panel) return;
      if (!browser.IntersectionObserver) {
        const box = panel.getBoundingClientRect(); if (box.bottom > 0 && box.top < browser.innerHeight) countArrival("out_of_runs_view");
        return;
      }
      const observer = new browser.IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { countArrival("out_of_runs_view"); observer.disconnect(); }
      });
      observer.observe(panel); return () => observer.disconnect();
    }, [showAllowance]);
    // Kept as shown only once it is actually on screen, so a higher-priority notice (or setup) that
    // covers it until a reload doesn't use it up unseen. was: kept as shown when offered (review of #123).
    const digestVisible = !!(digestNudge && digestOn && !setupOpen && !nudge && !invite && !outOfRuns && !upgradeAsk);
    useEffect(() => { if (digestVisible && digestPrompt.current.shown) digestPrompt.current.shown(); }, [digestVisible]);
    // The review line (see reviewHidden above). It waits behind any other notice rather than stacking.
    const reviewLine = !reviewHidden && !note && !nudge && !digestNudge && !outOfRuns && !info.stale && IS.reviewLineDue(info, queue);
    // me.month is the Worker's UTC month ("2026-09"); the allowance resets on the 1st of the next one.
    const monthMatch = /^(\d{4})-(\d{2})$/.exec((me && me.month) || "");
    const resetDay = monthMatch
      ? new browser.Date(browser.Date.UTC(+monthMatch[1], +monthMatch[2], 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
      : "the 1st of next month";
    // was: const signInTitle = "Optional. Search works without it. Any Google or Microsoft account works; a school .edu email gets more AI use. Signing in also lets your chosen states count toward where we scan in more detail.";
    // The old wording left "more AI use" vague and the button beside it said "(UMass email)", which
    // together read as a school requirement. worker/src/auth.js only asks for a verified address on a
    // .edu domain, from Google or Microsoft alike, and GENERAL_ALLOWANCE_PCT is "50", so .edu is
    // exactly double and everyone else still gets an allowance. Say both plainly.
    const signInTitle = "Optional and free. Search and this dashboard work without it. Any Google or Microsoft account works, from any school or none; a verified .edu address doubles your free monthly AI allowance. Signing in also lets your chosen states count toward where we scan in more detail.";
    // was: const signInBtn = auth.cfg && !auth.token && auth.cfg.providers.map(pr => h("button", { ... className: "btn" ... }));
    // The two provider buttons, which the footer still shows side by side.
    const signInProviders = auth.cfg && !auth.token && auth.cfg.providers.map(pr =>
      // was: h("button", { ... }, `Sign in with ${IS.PROVIDER_LABELS[pr.id] || pr.id}${pr.id === "google" ? " (UMass email)" : ""}`));
      // The " (UMass email)" suffix was wrong twice over: no account has to be UMass, and nothing has
      // to be .edu at all. A .edu only doubles the allowance, which the tooltip now says.
      h("button", { key: pr.id, type: "button", className: "btn", onClick: () => { if (showAllowance) arrivalFlag("save"); IS.startSignIn(auth.cfg, pr.id); }, title: signInTitle }, `Sign in with ${IS.PROVIDER_LABELS[pr.id] || pr.id}`));
    // In the header, one quiet button until it is pressed (2026-10-05 audit): two full-weight sign-in
    // buttons were the most prominent thing on a page whose point is that search needs no account, and
    // "optional" lived in a tooltip. The note says it in visible words once the choice opens.
    const signInBtn = signInProviders && (signInOpen
      ? h("span", { className: "signin-open" }, signInProviders,
        h("span", { className: "signin-note" }, "Optional and free. Adds a monthly AI allowance for Auto-Apply; a school .edu email gets about twice as much."))
      : h("button", { type: "button", className: "btn quiet", title: signInTitle, onClick: () => setSignInOpen(true) }, "Sign in · optional"));

    // was: const aboutBtn = !landingOpen && h("button", { ... }, "About InternScout");
    // "About" in the nav is the /about/ page now; the in-page strip is what it says, how it works.
    // was: const howBtn = !landingOpen && h("button", { type: "button", onClick: () => setLandingOpen(true) }, "How it works");
    // The strip sits under the list since 2026-10-14 (it filled a phone's first screen), so the button
    // opens it and goes there.
    const showAbout = () => {
      setLandingOpen(true);
      browser.setTimeout(() => { const el = browser.document.getElementById("about"); if (el) { el.scrollIntoView({ block: "start", behavior: scrollBehavior() }); el.focus({ preventScroll: true }); } }, 0);
    };
    const howBtn = h("button", { type: "button", onClick: showAbout }, "How it works");
    // The hero's one action (2026-10-05): straight to the search box. A first visit has the setup card
    // open above the list; closing it is what Skip does, and the list is what was asked for.
    const goSearch = () => {
      if (setupOpen) closeSetup();
      browser.setTimeout(() => { const q = browser.document.getElementById("q"); if (q) { q.focus(); q.scrollIntoView({ block: "center" }); } }, 0);
    };
    const openCount = nationwide ? nationwide.toLocaleString() : null;
    // Keep the quick panel mounted after its first save so optional choices retain keyboard focus.
    const setupAsk = quickOpen && !setupOpen;
    // Existing /config wording and visibility gate, beside footer sign-in; no fallback prices.
    const plansLine = IS.plansBanner(auth.cfg, me);
    const plansEl = plansLine && h("p", { className: "plansline" },
      `Plans: free with any email; ${plansLine.plans.map(pl => `${pl.label} ${pl.price}`).join(" and ")} raise the allowance. `,
      h("a", { href: "pricing/" }, "Prices"));
    // Numbers get thousands separators, "You applied" appears once there is something to count,
    // and the state list is one sentence under the numbers instead of a block floated to the right.
    // A const since 2026-10-05 so it can render before or after the setup card (D2.3).
    // Where the list looks, in words, for the coverage line, the empty list and the live region.
    const placeNames = ks => { const n = ks.map(IS.keyLabel).map(x => x.replace(/ \(([A-Z]{2})\)$/, "")); return n.slice(0, 8).join(", ") + (n.length > 8 ? ` and ${n.length - 8} more` : ""); };
    const scopeKeys = scope.all ? [] : [...new Set([...scope.keys, ...qKeys])];
    // was: "every state" with remote-only roles left out too; the count line says so now that it carries the place.
    const whereWords = scope.all ? (everything ? (scope.noRemote ? "every state, less remote-only roles" : "every state") : "the Northeast and remote") : placeNames(scopeKeys);
    const pr = progress.current;
    // "Show every state" with nothing picked loads the rest; with states picked it picks Everywhere.
    const searchAll = () => { if (scope.all) setAllAsked(true); else upd("states", [IS.ALL_KEY]); };
    // was: always the figure itself, so the page opened on "0 Open in the Northeast" and "0 New this week".
    const fig = (n, label) => h("div", { className: "fig" }, h("div", { className: "n" }, n == null || counting ? "…" : n.toLocaleString()), h("div", { className: "l" }, label));
    // Numbers get thousands separators, "You applied" appears once there is something to count,
    // and the state list is one sentence under the numbers instead of a block floated to the right.
    // A const since 2026-10-05 so it can render before or after the setup card (D2.3).
    // was: "Open in the Northeast + remote" (or your areas), "New this week" and "Open nationwide" in
    // every case. With every state in scope the nationwide figures are the list's own (2026-10-14).
    const figuresEl = h("section", { className: "figures", "aria-label": "Listing counts" },
      h("div", { className: "figrow" },
        scope.all ? fig(nationwide, "Open nationwide") : fig(figures.open, f.states.length ? "Open in picked states" : "Open in your areas"),
        fig(scope.all ? (stats && stats.new != null ? stats.new : allLoaded ? figures.fresh : null) : figures.fresh, "New this week"),
        !scope.all && fig(nationwide, "Open nationwide"),
        figures.applied > 0 && fig(figures.applied, "You applied")),
      // was: "Showing the Northeast and remote first; a search or filter covers every state. Show every state.
      // Updated <time>." The place and "Show every state" moved to the count line over the list (D17), where
      // they sit beside the number they describe; this line keeps the scan time, and nothing until it is
      // known (was "Updated unknown").
      h("div", { className: "coverage" },
        genText && h("span", { className: "updated" }, "Updated ", genText, legacy ? " · single-file data" : "", ".")));
    // The setup card for a first profile opens prefilled from a landing page's ?field= (2026-10-14):
    // "Rank these for your major" on /internships/nursing/ arrives with Nursing as the major.
    const prefill = useMemo(() => {
      if (p || !link.fields || !link.fields.length) return null;
      const m = IS.majorForFields(link.fields, majors);
      return m ? { majors: [m] } : { fields: link.fields.slice() };
    }, [p, majors]);
    const setupEl = setupOpen && h(Setup, { key: p ? p.updated : "new:" + JSON.stringify(prefill), initial: p || prefill, majors, majorsReady, index, stats, statsReady, firstTime: !p, onSave: saveProfile, onClose: closeSetup, onDelete: deleteData, signedIn: !!auth.token });
    const setupAskEl = setupAsk && h(QuickProfile, { profile: p, majors, majorsReady, onChange: saveQuickProfile, onDone: finishQuickProfile, onSetup: openSetup, message: quickMessage });
    // What narrows the list besides the search and the place, in words, for the empty list.
    const filterWords = [
      f.fields.length > 0 && "field " + f.fields.map(IS.fieldLabel).join(" or "),
      f.company.length > 0 && "employer " + f.company[0],
      f.stage && (IS.STAGE_LABEL[f.stage] || f.stage).toLowerCase() + " roles",
      f.year && "open to " + (IS.YEAR_PLURAL[f.year] || f.year),
      f.sector && IS.sectorLabel(f.sector) + " sector",
      f.paid === "paid" ? "pay or stipend listed" : f.paid === "no_unpaid" ? "unpaid roles hidden" : "",
      f.where === "remote" ? "remote only" : f.where === "onsite" ? "in person only" : "",
      f.status === "closed" ? "closed postings" : "",
      f.app_state && "your progress: " + (f.app_state === "auto" ? "in the Auto-Apply queue" : STATE_LABEL[f.app_state]),
      f.new_only && "new this week",
      f.hide_citizen && "citizen-only roles hidden",
      f.eligible && elig && "roles you may not be eligible for hidden",
    ].filter(Boolean);
    const asked = f.q.trim() ? `“${f.q.trim()}”` : "";
    // was: "Nothing matches these filters." whatever had been searched, even with no filter set.
    const emptyText = loading ? `Nothing yet${asked ? " for " + asked : ""}. Still loading listings (${pr.done} of ${pr.total} files)…`
      : !inView.length ? `No listings in ${whereWords} yet.`
      : `No ${f.status === "open" ? "open " : ""}listings match ${asked || "these filters"} in ${whereWords}${filterWords.length ? `, with ${filterWords.join(", ")}` : ""}.`;
    // An empty search that hasn't looked in the descriptions offers that first, as the one primary button
    // (D18, 2026-10-14): it is the action that can turn zero into something. was: it sat only in the notice
    // above, and the empty state offered "Clear search".
    const descOffer = searching && !wantDesc;
    const emptyEl = h("div", { className: "sheet empty" },
      h("p", null, emptyText),
      !loading && h("div", { className: "empty-actions" },
        descOffer && h("button", { type: "button", className: "btn primary", onClick: () => setDescAll(true) }, "Search descriptions too"),
        !everything && h("button", { type: "button", className: cx("btn", !descOffer && "primary"), onClick: searchAll }, "Search every state"),
        asked && h("button", { type: "button", className: "btn", onClick: () => upd("q", "") }, "Clear search"),
        filterWords.length > 0 && h("button", { type: "button", className: "btn", onClick: clearFilters }, "Clear filters")),
      descOffer && !loading && h("p", { className: "meta" }, "Descriptions are a larger download."));
    // The live region (2026-10-14): the count or the empty message, said once the list has settled for
    // a moment after the student changes something, not on every key or file. was: role=status on the
    // count itself, which changed with each file landing and each pause in typing.
    const myChecking = !ready || myLoad.checking;
    const missingText = err || myLoad.failed.length ? "Couldn't check current listing data. Saved information is shown."
      : myChecking ? "Checking current listing data. Saved information is shown."
        : "Not in the current listing data. Current posting status unknown.";
    const myListCount = `${shown.length} of ${rows.length} saved role${rows.length === 1 ? "" : "s"} shown${myProgress ? ` (${savedIds.length} total)` : ""}`;
    const liveText = myList ? `${myListCount}.${myChecking ? " Checking current listing data." : ""}`
      : loading || counting ? "" : rows.length ? `${rows.length.toLocaleString()} listing${rows.length === 1 ? "" : "s"}${anyFilter ? " match" : ""}${asked ? " " + asked : ""} in ${whereWords}.` : emptyText;
    const [spoken, setSpoken] = useState("");
    const expandRun = run => {
      setExpandedRuns(previous => new Set([...previous, run.key]));
      IS.count("group_expand");
      setSpoken(`${run.count} more listing${run.count === 1 ? "" : "s"} from ${run.company} shown. ${(shown.length + run.count).toLocaleString()} of ${rows.length.toLocaleString()} listings shown.`);
      // The expansion button leaves the DOM. Keep keyboard users at the first revealed listing.
      browser.setTimeout(() => { const row = browser.document.getElementById("listing-" + run.firstHidden); if (row) row.focus(); }, 0);
    };
    const firstF = useRef(f), touched = useRef(false);
    if (f !== firstF.current) touched.current = true;
    useEffect(() => {
      if ((!touched.current && !myList) || !liveText) return;
      const t = browser.setTimeout(() => setSpoken(liveText), 900);
      return () => browser.clearTimeout(t);
    }, [liveText]);
    // "Did you apply?" (U9, 2026-10-14). The posting opens in a new tab, so the moment this page knows about
    // is the click on "Open posting"; when the student comes back to this tab (the page was hidden, then
    // shown again), the row asks once: "Did you apply to Acme? Mark applied / Not yet". Mark applied sets
    // the row's status to Applied, kept in this browser like every status; Not yet doesn't ask about that
    // posting again on this page load. Nothing else is stored. The live region says it once, since the line
    // appears while the student is away. Only one row asks at a time: the last posting opened.
    const [askId, setAskId] = useState(null);
    const opened = useRef(null), notYet = useRef(new Set());
    const onOpen = useCallback(r => { opened.current = { id: r.id, company: r.company_name, left: false }; }, []);
    const onAnswer = useCallback((id, applied) => {
      if (applied) setAppState(id, "applied"); else notYet.current.add(id);
      setAskId(null);
    }, [setAppState]);
    useEffect(() => {
      const onVis = () => {
        const o = opened.current;
        if (!o) return;
        if (browser.document.visibilityState === "hidden") { o.left = true; return; }
        if (!o.left) return;
        opened.current = null;
        const s = appStatesRef.current[o.id] || "none";
        if (notYet.current.has(o.id) || (s !== "none" && s !== "interested")) return;
        setAskId(o.id);
        setSpoken(`Did you apply to ${o.company}? You can mark it under that listing.`);
      };
      browser.document.addEventListener("visibilitychange", onVis);
      return () => browser.document.removeEventListener("visibilitychange", onVis);
    }, []);
    // was: on a phone the promotions went under the list and a wide screen kept them above it. Since D16
    // (2026-10-14) they sit under the list on every screen: three promotions above it pushed the first
    // listing to about 794 px on a laptop. Above the list there is at most one standing notice (topNotice).
    const narrow = useNarrow();
    // The paid listing's box (js/placements.js PaidBox), from the organic row's own helpers: factsLine,
    // matchControl and Why, with the same scoreOf result. Hiding it says so in the live region and puts focus
    // on the list's heading, since the button that was pressed goes away.
    const hidePlacements = () => {
      setPlaceHidden(true); setSpoken("Paid listings hidden. You can show them again under More filters.");
      browser.setTimeout(() => { const el = browser.document.getElementById("listings"); if (el && el.focus) el.focus(); }, 0);
    };
    const placeBox = placed && PL ? h(PL.PaidBox, { key: placed.pl.id, x: placed.x, pl: placed.pl, phone: narrow, facts: factsLine(placed.x, keySet),
      renderMatch: (open, toggle, panelId) => matchControl({ r: placed.x, sc: scoreOf(placed.x), scored: !!ctx.p, open, onToggle: toggle, onRank: openSetup, panelId }),
      renderWhy: close => h(Why, { r: placed.x, sc: scoreOf(placed.x), ctx, elig, patterns: stats && stats.skill_patterns, onClose: close, onRank: openSetup }),
      onHide: hidePlacements }) : null;
    // The one standing notice above the list, by priority: the setup line, then "one step left" for an
    // installed extension that isn't set up. Whichever isn't shown there goes under the list.
    const oneStepEl = info.installed && !info.onboarded && h("div", { className: "notice" }, h("b", null, "One step left: "),
      // was: "do the Deep Dive so the agent knows your background. " and "Start the Deep Dive" (D29: the two-minute
      // setup is called what it is; "Deep Dive" is the optional Interview and Voice steps).
      "set up Auto-Apply so it knows your background. ", h("a", { href: "#", onClick: prevent(() => IS.ext.call({ type: "open_deep_dive" })) }, "Set up Auto-Apply (about 2 minutes)"));
    // The paid-listings notice (S8): third in line for the one place above the list.
    const [placeNoticeHidden, setPlaceNoticeHidden] = useState(() => !!IS.ls.get(PLACE_NOTICE_KEY, false));
    const hidePlaceNotice = () => { IS.ls.set(PLACE_NOTICE_KEY, true); setPlaceNoticeHidden(true); };
    const placeNoticeEl = placements.length > 0 && !placeNoticeHidden && h(PlaceNotice, { onHide: hidePlaceNotice });
    // was: const topNotice = setupAsk ? setupAskEl : oneStepEl; (with `setupAsk && oneStepEl` under the list).
    // The first of these that is on goes above the list; the rest go under it (D16: one notice above the list).
    const [topNotice, ...laterNotices] = [setupAskEl, oneStepEl, placeNoticeEl].filter(Boolean);
    const promoEls = h(F, null,
      // was: setupAsk && oneStepEl,
      ...laterNotices,
      // was: info.checked && !info.installed && !info.stale && p && h("div", { className: "notice quietnote" }, "Want help filling applications? The free InternScout extension pre-fills forms and never presses Submit. ", h("a", { href: C.extensionInstallUrl || "install.html" }, "Install guide")),
      // was: // The extension is free to install, but its Auto-Apply and Deep Dive spend the monthly AI
      // was: // allowance, so calling the whole thing "free" stopped being the full story on 2026-09-19.
      // The extension is free to install, but its Auto-Apply spends the monthly AI allowance, so
      // calling the whole thing "free" stopped being the full story on 2026-09-19. The Deep Dive does
      // not: worker/src/config.js gives deep_dive `allowance: null`, i.e. no monthly cap.
      // was: info.checked && !info.installed && !info.stale && p && h("div", { className: "notice quietnote" }, "Want help filling applications? The InternScout extension pre-fills forms and never presses Submit. It's free to install and runs on your free monthly AI allowance. ", h("a", { href: C.extensionInstallUrl || "install.html" }, "Install guide")),
      // The allowance exists only per account: worker/src/index.js signs the user in on every
      // POST /ai and serves the counts from GET /me. This notice sits under copy that promises
      // search is free with no sign-in, so the account has to be named here or it reads as carried
      // over. The account is free, which is why that word stays.
      // was: info.checked && !info.installed && !info.stale && p && h("div", { className: "notice quietnote" }, "Want help filling applications? The InternScout extension pre-fills forms and never presses Submit. It's free to install and runs on the free monthly AI allowance that comes with a free account. ", h("a", { href: C.extensionInstallUrl || "install.html" }, "Install guide")),
      // "Install guide" pointed at the by-hand steps; since 2026-09-22 it's one click in the Web Store.
      // was: info.checked && !info.installed && !info.stale && p && h("div", { className: "notice quietnote" }, "Want help filling applications? The InternScout extension pre-fills forms and never presses Submit. It's free to install and runs on the free monthly AI allowance that comes with a free account. ", h("a", { href: installUrl("dashboard-notice"), target: "_blank", rel: "noopener" }, "Add it to Chrome")),
      // 2026-10-04: no longer waits for a saved profile (`&& p`), so a first visit hears about Auto-Apply
      // before it is asked to fill anything in, and it sits above the plans banner so what the extension
      // does comes before what it costs. was: it came after the plans banner and the stale-extension note.
      // Not on a phone or tablet (2026-10-14), which can't add a Chrome extension; the hero's install
      // button stays for them and goes to the install page.
      // A Hide button since D16 (2026-10-14), kept in this browser.
      info.checked && !info.installed && !info.stale && !touchOnly() && !extHidden && h("div", { className: "notice quietnote ext-notice" },
        h("button", { type: "button", className: "btn quiet small notice-hide", onClick: hideExt, "aria-label": "Hide this suggestion" }, "Hide"),
        "Want help filling applications? The InternScout extension pre-fills forms and never presses Submit. It's free to install and runs on the free monthly AI allowance that comes with a free account. ", h("a", { href: installUrl("dashboard-notice"), target: "_blank", rel: "noopener" }, "Add it to Chrome"),
        // A dated third-party fact beside the store link (2026-10-05 audit): the listing's own rating and
        // count once it has them (CONFIG.storeRating, copied from the store with its date), until then
        // when the store accepted it. Nothing here is made up: the date is the store's approval.
        C.storeRating
          ? `. Rated ${C.storeRating.value} from ${C.storeRating.count} ratings on the Chrome Web Store, as of ${C.storeRating.asOf}.`
          : ". In the Chrome Web Store since September 22, 2026."),
      // was: the plans announcement ("New: Auto-Apply plans now start at ..."), retired 2026-10-14 (D16,
      // decision 3). The quiet plans line under the counters (plansLine) carries the prices from /config.
      // What students say (2026-10-05 audit): only words a student actually wrote, with permission, from
      // CONFIG.testimonials in index.html. The list is empty until there are some, and then this renders
      // nothing, so no invented quote can ever appear here.
      C.testimonials && C.testimonials.length > 0 && h("section", { className: "said", "aria-labelledby": "said-title" },
        h("h2", { id: "said-title" }, "What students say"),
        h("ul", null, C.testimonials.map((t, i) => h("li", { key: i },
          h("blockquote", null, `“${t.quote}”`),
          h("div", { className: "who" }, t.name, t.who ? `, ${t.who}` : ""))))),
      // The review line (2026-10-07). Following the link tells the extension too, so its own card stops
      // asking. Hidden a tick later, not in the click itself: a link taken out of the page mid-click
      // doesn't open. js/count.js counts the click as "review_click", a daily total with nothing about who.
      reviewLine && !upgradeAsk && h("div", { className: "notice quietnote review-line" },
        "Using Auto-Apply? A short review on the Chrome Web Store helps other students find it. ",
        h("a", { href: IS.REVIEWS_URL, target: "_blank", rel: "noopener", onClick: () => { IS.ext.call({ type: "review_ask", action: "review" }); browser.setTimeout(hideReview, 0); } }, "Leave a review"),
        // was: a grey "Hide" link at the end of the sentence; the shared notice Hide button now (D12).
        h("button", { type: "button", className: "btn quiet small notice-hide", onClick: hideReview, "aria-label": "Hide this suggestion" }, "Hide")));
    return h("div", { className: "wrap" },
      // Skip links and a main landmark (2026-10-14): a keyboard took about 750 Tab presses from the search
      // box to "Show more", and there was no landmark or heading to jump to.
      h("a", { className: "skip", href: "#listings" }, "Skip to listings"),
      h("header", { className: "top" },
        // was: one block of h1.mark "InternScout" and .sub, with the h1 the brand name only. The audit
        // (2026-10-05) found no audience, category or promise in the heading, the pain students name
        // (ten job boards, stale postings) nowhere in the hero, and no way to About or Compare from this
        // page but the footer. Now: the brand and a site nav on one line, the controls on the right, and
        // under them the page's h1 with the pain line and the free search as the first action.
        h("div", { className: "brand" },
          h("a", { className: "mark", href: "/" }, "InternScout"),
          h(SiteNav, null, h("nav", { id: "site-links", className: "sitenav", "aria-label": "Site" },
            h("a", { href: "internships/" }, "Browse"),
            // Always shown, like the static nav before the app loads (no flash): /digest/ itself says
            // whether sign-ups are open. was: digestOn && h("a", ...) (review of #123).
            h("a", { href: "digest/?from=dashboard-nav", "data-digest-placement": "nav" }, "Weekly email"),
            h("a", { href: "install.html?from=dashboard-nav" }, "Auto-Apply (free)"),
            h("a", { href: "pricing/" }, "Pricing"),
            h("a", { href: "compare/" }, "Compare"),
            h("a", { href: "about/" }, "About"),
            // 2026-10-23: was: employers could only find the footer link. Revert: omit this anchor.
            h("a", { href: "employers/", "data-employer-entry": "nav" }, "Hire interns")))),
        // was: one flex row of every control (AI cost, Rescan, profile, sign-in state, allowance, invite,
        // each paid plan, Manage plan, Deep Dive, Queue), which wrapped into a long second line. Now the
        // header keeps the everyday actions and the account details live in the Account menu.
        h("div", { className: "top-r" },
          busy && h("span", { className: "busy", role: "status" }, busy),
          info.installed && h("button", { type: "button", className: "btn", onClick: () => IS.ext.call({ type: "open_panel" }) }, "Queue",
            jobCounts.needs_you ? h("span", { className: "count" }, `${jobCounts.needs_you} need you`) : null,
            jobCounts.ready_to_submit ? h("span", { className: "count ok" }, `${jobCounts.ready_to_submit} ready`) : null),
          info.installed && h("button", { type: "button", className: "btn", onClick: () => IS.ext.call({ type: "open_deep_dive" }) }, info.onboarded ? "Edit setup" : "Set up Auto-Apply (about 2 minutes)"),
          // Hidden while the setup card is already open under it, so a first visit shows one way in.
          // Also hidden while the first-visit line offers the same thing just under the counters.
          !setupOpen && !setupAsk && h("button", { type: "button", className: "btn", onClick: openSetup }, p ? "My profile" : "Set up profile"),
          signInBtn,
          (auth.token || ADMIN) && h(AccountMenu, {
            email: who && who.email,
            planLabel: auth.token ? (me && me.plan && me.plan !== "free" ? `${IS.PLAN_LABELS[me.plan] || me.plan} plan` : me && me.tier === "edu" ? "Free plan, school (.edu) allowance" : "Free plan") : "Not signed in",
            // The same lines the allowance tooltip used to hold, now visible.
            hasPurchased: !!(allowance && allowance.purchased > 0),
            purchased: meStatus === "ready" && allowance ? allowance.purchased : 0,
            allowLines: auth.token && me && me.allowance ? IS.allowanceText(me).split("\n") : [],
            resetDay: auth.token && me && me.allowance ? resetDay : null,
            spendText: info.spend && info.spend.calls > 0 ? `Estimated AI cost: $${info.spend.month_usd.toFixed(2)}${info.spend.budget ? ` of $${info.spend.budget}` : ""}` : null,
            items: [
              canRecover && { key: "recover", group: "plan", label: "Check or resume checkout", onClick: () => { browser.document.querySelector(".acct-btn")?.focus(); void recoveryActions.current.recover(); }, disabled: !!busy || recovering || topup?.status === "opening", desc: "Check your existing checkout. No new checkout is created." },
              auth.token && inviteOffer && { key: "invite", group: "share", label: invite ? "Hide your invite link" : "Invite classmates", onClick: openInvite,
                desc: "New .edu classmates can earn extra AI use. Check your reward eligibility." },
              ...(auth.token ? upgrades.map(pl => ({ key: pl.plan, group: "plan", label: `${pl.label}${pl.price ? ` · ${pl.price}` : ""}`, onClick: () => billing("checkout", pl.plan),
                disabled: !!busy, title: upgradeTitle(pl), desc: `${pl.multiplier}× your monthly AI allowance. Cancel any time.` })) : []),
              auth.token && me && me.can_manage && { key: "manage", group: "plan", label: "Manage plan", onClick: () => billing("portal"), disabled: !!busy,
                desc: "Change your card or cancel, on Stripe's own page." },
              // was: onClick: () => { IS.signOut(); setAuth(a => ({ ...a, token: null })); }
              // signOut(true) also ends the session on the Worker, so the code can't be used again.
              auth.token && auth.source === "page" && { key: "out", group: "session", label: "Sign out", onClick: () => { arrivalFlag("clear"); IS.signOut(true); setAuth(a => ({ ...a, token: null, who: null })); } },
            ].filter(Boolean),
            admin: ADMIN ? [
              { key: "rescan", label: "Rescan", desc: "Run the scanner on GitHub now", onClick: rescan, disabled: !!busy },
              // js/count.js reads this setting when a page loads, so a change applies from the next load.
              // Raw localStorage, not IS.ls (which JSON-encodes): count.js and ?nocount=1 store a plain "1".
              { key: "nocount", label: noCount() ? "Count this browser's visits" : "Don't count this browser's visits",
                desc: "For your own visits, so they stay out of the analytics. Applies from the next page load.",
                onClick: () => { const off = noCount(); try { if (off) browser.localStorage.removeItem(NOCOUNT_KEY); else browser.localStorage.setItem(NOCOUNT_KEY, "1"); } catch (e) { }
                  setBusy(off ? "This browser's visits count again" : "This browser's visits won't be counted"); browser.setTimeout(() => setBusy(""), 4000); } },
              ghToken && { key: "forget", label: "Forget token", onClick: () => { browser.localStorage.removeItem("internscout.gh_token"); setGhToken(""); setBusy("Token cleared"); } },
            ].filter(Boolean) : null,
          })),
        h("div", { className: "hero" },
          h("h1", null, "Find student internships, co-ops and research roles in one free search."),
          // was: ... : "Internships, co-ops and research for students in every major, anywhere in the US and Canada.",
          // The listings, majors and states were never UMass-only, and the line read as a gate to everyone else.
          h("p", { className: "sub" }, p ? `${majorsText}${p.class_year ? " · " + IS.YEAR_LABEL[p.class_year] : ""} · ${whereText}`
            // was: `Stop checking ten job boards every morning: ${...}, updated several times a day, no account needed. ...`
            // Two sentences since 2026-10-05, like the static copy in index.html (the audit's sentence length).
            // was: `... ${openCount ? openCount + " open roles are" : "Every open role is"} here, ...`. The count
            // arrived after the first paint and redrew the page's largest text, so Lighthouse timed the page's
            // main paint after the listings; the button under it and the figures carry the count (2026-10-14).
            : "Explore internships, co-ops and research roles across the US and Canada. Listings refresh several times a day. Search free, with no account needed.",
            howBtn && " · ", howBtn),
          !p && h("div", { className: "hero-actions" },
            h("button", { type: "button", className: "btn primary", onClick: goSearch }, `Search ${openCount ? openCount + " " : ""}internships free · no account`),
            // D2.2 (2026-10-05 audit): the second way in, the free extension, had nothing above the fold;
            // the nearest link was the quiet notice under the counters. A plain (not primary) button,
            // so the search stays the first action, and gone once the extension is installed or stale.
            // was: the search button alone.
            // On a phone or tablet, which can't add a Chrome extension, the button says what it can do there and
            // goes straight to install.html's "send it to my laptop" box (D19, 2026-10-14). was: "Add Auto-Apply
            // to Chrome · free" everywhere, a dead end on a phone.
            !(info.installed || info.stale) && (touchOnly()
              ? h("a", { className: "btn", href: (C.extensionInstallUrl || "install.html") + "#phone" }, "Send Auto-Apply to my laptop")
              : h("a", { className: "btn", href: installUrl("hero"), target: "_blank", rel: "noopener" }, "Add Auto-Apply to Chrome · free"))))),

      h("main", { id: "main" },
      h("div", { id: "allowance-announcement", className: "sr", role: "status", "aria-live": "polite", "aria-atomic": true }, showAllowance ? "Auto-Apply allowance options are open." : ""),
      showAllowance && h(AllowancePanel, { signedIn: !!auth.token, me, status: meStatus, cfgStatus, allowance, resetDay,
        plans: [...upgrades].sort((a, b) => Number(b.plan === arrivalRoute.plan) - Number(a.plan === arrivalRoute.plan)), busy: busy || (topup?.status === "opening") || recovering, topup, recovery: canRecover ? recoveryActions.current.recover : null, signIn: signInProviders,
        inviteBlock: inviteOffer && h(InviteBlock, { invite, status: inviteStatus, note: inviteNote, onLoad: () => { countArrival("out_of_runs_invite"); openInvite(true); }, onCopy: () => { countArrival("out_of_runs_invite"); copyInvite(); } }),
        onRetry: () => loadMe(), onConfigRetry: loadConfig, onCheckout: plan => billing("checkout", plan, true), onClose: () => { topupActions.current.cancel(); dismissArrival(); } }),
      // D2.3 (2026-10-05 audit): on a first visit the setup wizard greeted the student before the
      // counters or any statement of what is here. Now the figures come first while the setup card is
      // open with no profile saved; once there is a profile the card is an edit form and the old order
      // (card, then figures) stays. was: Setup, then the figures section, in every case.
      // was: firstVisit && figuresEl, setupOpen && h(Setup, {...}), !firstVisit && figuresEl,
      p && setupEl,
      figuresEl,
      !p && setupEl,
      // was: setupAskEl, (topNotice holds it, below)
      // was: !narrow && promoEls (D16: under the list on every screen now).
      topNotice,
      info.stale && h("div", { className: "notice" }, h("b", null, "The extension was reloaded or updated. "), h("a", { href: "#", onClick: prevent(() => browser.location.reload()) }, "Reload this page"), " to reconnect Auto-Apply."),
      // was: info.installed && !info.onboarded && h("div", { className: "notice" }, h("b", null, "One step left: "), ...): topNotice above.
      h("div", { id: "checkout-recovery-status", tabIndex: -1, className: recoveryState?.message ? "notice" : "sr", role: "status", "aria-live": "polite", "aria-atomic": true }, recoveryState?.message || ""),
      note && h("div", { className: "notice", role: "status" }, note),
      // Always in the page, so a screen reader hears the message when it appears inside.
      h("div", { role: "status" }, selNote && h("div", { className: "selnote" }, h("span", null, selNote),
        h("button", { type: "button", "aria-label": "Close this message", onClick: () => { browser.clearTimeout(selTimer.current); setSelNote(""); } }, h("span", { className: "i i-cross", "aria-hidden": true })))),
      // The one-time invite nudge (2026-10-02), right under the "Queued" or "Profile saved" note it follows.
      // It steps aside for the out-of-runs notice, which already offers the invite, and for the panel itself.
      nudge && auth.token && inviteOffer && inviteStatus === "idle" && !showAllowance && h("div", { className: "notice", role: "status" },
        h("b", null, inviteOffer.bonus && inviteOffer.bonus.autofill ? "Nice work. Want more free Auto-Apply runs? " : "Nice work. Want more free AI use? "),
        // The same terms as the invite panel: the reward lands when a new classmate ("joins": first week,
        // worker/src/referral.js) signs in through the link with a .edu email, for up to REFERRAL.maxRewards.
        `Invite a classmate: when they join through your link with a school (.edu) email, you each get ${inviteWords} (for up to ${inviteOffer.max} classmates).`,
        h("div", { className: "invite-row" },
          h("button", { type: "button", className: "btn primary", onClick: openInvite }, "Get my invite link"),
          h("button", { type: "button", className: "btn", onClick: () => { IS.markInviteNudge("dismissed"); setNudge(false); } }, "Not now"))),
      // Arrived through a classmate's link, not signed in yet: say what signing in gets them.
      invited && !auth.token && inviteOffer && h("div", { className: "notice" }, h("b", null, "A classmate invited you. "),
        // was: `Sign in with Google using your school email and you'll both get ${inviteWords}. Searching needs no account.`),
        `Sign in with your school (.edu) email (Google works for most schools) and you'll both get ${inviteWords}. Searching needs no account.`),
      !showAllowance && auth.token && inviteStatus !== "idle" && h("div", { className: "notice" },
        h(InviteBlock, { invite, status: inviteStatus, note: inviteNote, onLoad: () => openInvite(true), onCopy: copyInvite })),
      !showAllowance && !arrivalDismissed && new browser.URLSearchParams(arrival.search).get("upgrade") && cfgStatus === "error" && h("div", { className: "notice", role: "status" }, "Couldn't load account options. ",
        h("button", { type: "button", className: "btn", onClick: loadConfig }, "Retry account options")),

      h("section", { id: "results", "aria-labelledby": "listings" },
      h("h2", { id: "listings", className: "sr", tabIndex: -1 }, myList ? "My list" : "Listings"),
      h("div", { className: "list-views", role: "group", "aria-label": "Listing views" },
        h("button", { type: "button", className: cx("btn", !myList && "on"), "aria-pressed": !myList, onClick: () => showMyList(false) }, "Browse roles"),
        h("button", { type: "button", className: cx("btn", myList && "on"), "aria-pressed": myList, onClick: () => showMyList(true) }, `My list (${savedIds.length})`)),
      !trackerStored && h("p", { className: "notice", role: "status" }, "Browser storage is unavailable. Changes to My list last only in this tab."),
      myList && h("div", { className: "filters" },
        h(Sel, { label: "My list progress", value: myProgress, onChange: v => { setMyProgress(v); setMyLimit(PAGE); } }, opt("", "Any progress"), APP_STATES.map(s => opt(s, STATE_LABEL[s]))),
        h("span", { className: "muted" }, "Saved roles stay in this browser."),
        h("button", { type: "button", className: "btn quiet", onClick: deleteTracker }, "Delete browser tracker"),
        canAuto && h("button", { type: "button", className: "btn primary", disabled: !selectedRows.length || queuing, onClick: () => autoApply(selectedRows) }, queuing ? "Adding applications…" : "Auto-Apply", selectedRows.length ? ` ${selectedRows.length} selected` : "")),
      digestVisible && h("div", { className: "notice quietnote", role: "note", "aria-label": "Weekly internship email" },
        "Want new internships in your inbox every Monday? ",
        h("a", { href: "/digest/?from=dashboard-contextual", "data-digest-placement": "contextual", onClick: () => finishDigestNudge("opened") }, "Get the free weekly email"),
        ". Everyone gets the same roundup. ",
        h("button", { type: "button", className: "linkbtn", "aria-label": "Dismiss weekly email invitation", onClick: () => finishDigestNudge("dismissed") }, "Dismiss")),
      // Two tiers. The first row is what nearly every visit touches: search, field, state, sort,
      // and the Auto-Apply button. The other nine controls sit behind "More filters", which shows
      // how many of them are set so nothing is hidden by surprise.
      !myList && h("div", { className: "filters", role: "search" },
        h("div", { className: "field search" }, h(SearchBox, { value: f.q, onChange: v => upd("q", v) })),
        f.company.length > 0 && h("button", { type: "button", className: "btn", title: "Show every employer", onClick: () => upd("company", []) },
          "Employer: " + f.company[0], h("span", { className: "i i-cross", "aria-hidden": true })),
        h(MultiSelect, { placeholder: "Field", options: opts.fields, selected: f.fields, count: f.fields.length, onChange: v => upd("fields", v) }),
        // "Everywhere" stands alone: picking it drops the states, and picking a state drops it.
        // was: placeholder: p ? "State (your areas)" : "State"
        // "Everywhere" is no narrowing, so it doesn't count as a set filter.
        h(MultiSelect, { label: "State", placeholder: scope.all ? "State: everywhere" : "State: your areas", options: opts.states, selected: f.states, count: f.states.filter(k => k !== IS.ALL_KEY).length,
          onChange: v => upd("states", v[v.length - 1] === IS.ALL_KEY ? [IS.ALL_KEY] : v.filter(k => k !== IS.ALL_KEY)) }),
        h(Sel, { label: "Sort", value: f.sort, onChange: v => upd("sort", v) }, opt("score", "Sort: best match"), opt("new", "Sort: newest"), opt("company", "Sort: company A–Z"), opt("comp", "Sort: pay listed")),
        // was: the count in a small badge. "More filters · 2" now, the same as Field and State (D8), with the same fill.
        h("button", { type: "button", className: cx("btn morebtn", (moreOpen || moreCount > 0) && "on"), "aria-expanded": moreOpen, onClick: () => setMoreOpen(o => !o) },
          moreOpen ? "Fewer filters" : "More filters", moreCount > 0 ? ` · ${moreCount}` : ""),
        h("span", { className: "spacer" }),
        canAuto && h("button", { type: "button", className: "btn primary", disabled: !selectedRows.length || queuing, onClick: () => autoApply(selectedRows) }, queuing ? "Adding applications…" : "Auto-Apply", selectedRows.length ? ` ${selectedRows.length} selected` : "")),
      !myList && moreOpen && h("div", { className: "filters extra" },
        h(Sel, { label: "Stage", value: f.stage, onChange: v => upd("stage", v) }, opt("", "Any stage"), IS.STAGES.map(([k, l]) => opt(k, (IS.STAGE_LABEL[k] || l)))),
        h(Sel, { label: "Eligible year", value: f.year, onChange: v => upd("year", v) }, opt("", "Any year"), IS.YEARS.map(([k, l]) => opt(k, "Open to " + l.toLowerCase().replace("master's", "master's").replace("phd", "PhD")))),
        opts.sectors.length > 0 && h(Sel, { label: "Sector", value: f.sector, onChange: v => upd("sector", v) }, opt("", "Any sector"), opts.sectors.map(([k, n]) => opt(k, `${IS.sectorLabel(k)} (${n})`))),
        h(Sel, { label: "Pay", value: f.paid, onChange: v => upd("paid", v) }, opt("", "Any pay"), opt("no_unpaid", "Hide unpaid"), opt("paid", "Paid or stipend listed")),
        h(Sel, { label: "In person or remote", value: f.where, onChange: v => upd("where", v) }, opt("", "In person or remote"), opt("onsite", "In person"), opt("remote", "Remote")),
        h(Sel, { label: "Posting status", value: f.status, onChange: v => upd("status", v) }, opt("", "Open or closed"), opt("open", "Open"), opt("closed", "Closed")),
        h(Sel, { label: "Your progress", value: f.app_state, onChange: v => upd("app_state", v) }, opt("", "Any progress"), APP_STATES.map(s => opt(s, STATE_LABEL[s])), opt("auto", "In Auto-Apply queue")),
        h("label", { className: "field toggle", title: "Hide roles limited to U.S. citizens (or citizens and permanent residents) that your work authorization rules out" },
          h("input", { type: "checkbox", checked: f.hide_citizen, onChange: e => upd("hide_citizen", e.target.checked) }), "Hide citizen-only"),
        h("label", { className: "field toggle" }, h("input", { type: "checkbox", checked: f.new_only, onChange: e => upd("new_only", e.target.checked) }), "New only"),
        elig && h("label", { className: "field toggle", title: "Hide postings whose description rules you out (class year, grad year, citizenship, degree, sponsorship, passed deadline)" },
          h("input", { type: "checkbox", checked: f.eligible, onChange: e => upd("eligible", e.target.checked) }), "Hide not eligible"),
        // Only once there are paid listings to show (2026-10-14). Not a filter: see placeHidden above.
        placements.length > 0 && h("label", { className: "field toggle", title: "A paid listing shows in its own box, labelled Ad, and also in the list at its usual place" },
          h("input", { type: "checkbox", checked: !placeHidden, onChange: e => setPlaceHidden(!e.target.checked) }), "Show paid listings"),
        h(Sel, { label: "Saved searches", value: "", onChange: onSaved }, opt("", "Saved searches"), saved.map(s => opt(s.name, s.name)), opt("__save", "+ Save current filters…"),
          saved.length > 0 && h("optgroup", { label: "Delete" }, saved.map(s => h("option", { key: "d" + s.name, value: "del:" + s.name }, `Delete “${s.name}”`))))),
      // The count line (D17, 2026-10-14) says where the list looks, beside the number: "3,126 listings in the
      // Northeast and remote · Show every state". While files are still arriving the number is a floor ("At least
      // 5 so far"). The clear button names what it clears. The description search is offered here, in the line,
      // instead of in a notice of its own above the list (D16).
      // was: "N listings match · loading more states (x of y)…", then "Clear filters" whenever anything was set.
      myList ? h("div", { className: "filterbar-foot" },
        h("span", null, myListCount, myChecking ? " · Checking current listing data…" : ""),
        (myLoad.failed.length > 0 || err) && h("button", { type: "button", className: "btn quiet", onClick: () => { if (err) reload(false); else setMyRetry(n => n + 1); } }, "Retry saved role details")) : h("div", { className: "filterbar-foot" },
        // was: role=status on this span; the live region below says the count once it settles.
        h("span", { className: "countline" }, counting ? "Loading…" : h(F, null,
          loading ? `At least ${rows.length.toLocaleString()} listing${rows.length === 1 ? "" : "s"}${anyFilter ? " match" : ""} so far` : `${rows.length.toLocaleString()} listing${rows.length === 1 ? "" : "s"}${anyFilter ? " match" : ""}`,
          ` in ${whereWords}`,
          moreAfter.size > 0 ? ` · ${shown.length.toLocaleString()} shown; expand company groups for more` : "",
          loading ? ` · loading ${pr.done} of ${pr.total} files` : "",
          !everything && h(F, null, " · ", h("button", { type: "button", className: "linkbtn", onClick: searchAll }, "Show every state")))),
        ranked && rows.length > 1 && h("span", { className: "muted" }, "Closest matches to your search first"),
        shareUrl && h(ShareSearch, { url: shareUrl }),
        onlySearch ? h("button", { type: "button", className: "btn quiet", onClick: () => upd("q", "") }, "Clear search")
          : anyFilter && h("button", { type: "button", className: "btn quiet", onClick: clearFilters }, "Clear filters")),
      !myList && h(DashboardFollow, { filters: f, source: followSource, auth, generation: authGeneration.current, getAuth: () => ({ auth: authRef.current, generation: authGeneration.current }) }),
      h("div", { className: "sr", role: "status", "aria-live": "polite", "aria-atomic": "true" }, spoken),

      // was: `Searching titles, companies and fields in ${keys.length} states. `
      // was: a notice above the list: "Searching titles, companies, fields and places in every state. [Search
      // descriptions too] (a larger download)". One line under the count now (D16), and the empty list offers
      // the same button as its main one (D18).
      !myList && descOffer && rows.length > 0 && h("div", { className: "descline" }, "Searching titles, companies, fields and places. ",
        h("button", { type: "button", className: "linkbtn", onClick: () => setDescAll(true) }, "Search descriptions too"), " (a larger download)."),
      !myList && wantDesc && descLoading && h("div", { className: "notice quietnote", role: "status" }, "Searching titles and fields while descriptions download…"),
      !myList && wantDesc && descFailed.length > 0 && h("div", { className: "notice", role: "alert" }, `Some descriptions couldn't load (${descFailed.join(", ")}). Search results may be incomplete. `,
        h("button", { type: "button", className: "btn quiet", onClick: () => setDescRetry(n => n + 1) }, "Retry descriptions")),
      !myList && failedKeys.length > 0 && h("div", { className: "notice", role: "alert" }, `Couldn't load listings for ${failedKeys.join(", ")}. Check your connection. `,
        h("button", { type: "button", className: "btn quiet", onClick: () => setRetry(n => n + 1) }, "Try again")),
      !myList && err ? h("div", { className: "sheet empty", role: "alert" }, "Couldn't load listings. Check your connection and try again. ",
        h("button", { type: "button", className: "btn", onClick: () => reload(false) }, "Retry listings"))
        : !myList && loading && !all.length ? h("div", { className: "sheet empty" }, "Loading listings…")
          // was: h("div", { className: "sheet empty" }, inView.length ? "Nothing matches these filters." : "No listings in these states yet. Try more states or remote.")
          : rows.length === 0 ? (myList ? h("div", { className: "sheet empty" }, savedIds.length ? "No saved roles have this status." : "No saved roles yet. Save a role to keep it here and track your progress.") : emptyEl)
            // was: the skip link, the table, "End of the N listings shown" and "Show N more" inline here (ListTable now).
            : h(ListTable, { shown, rows, moreAfter, onExpand: expandRun, pageCount: pageRows.length, phone: narrow, box: placeBox, onMore: () => myList ? setMyLimit(l => l + PAGE) : setLimit(l => l + PAGE), columns: canAuto ? 5 : 4,
              inlineSignup: !myList && digestOn && h(Digest, { cfg: C.digest, fields: digestFields, hasProfile: !!p, onSetup: openSetup, placement: "results-inline", compact: true }),
              head: h("thead", null, h("tr", null,
                canAuto && h("th", null, h("input", { type: "checkbox", "aria-label": "Select up to 100 shown applications", checked: allChecked, disabled: !selectable.length,
                  onChange: e => selectShown(e.target.checked) })),
                // was: Company and role, Field, Location and term, Pay, Match, Your status, Links. Field, place, term
                // and pay are one line under the title now (D9); "Sort: pay listed" stays in the Sort picker.
                myList ? h("th", { scope: "col" }, "Company and role") : sortTh("company", "Company and role"), myList ? h("th", { scope: "col" }, "Match") : sortTh("score", "Match"), h("th", { scope: "col" }, h("span", { className: "sr" }, "Links")), h("th", { scope: "col" }, myList ? "Your status" : "Save"))),
              renderRow: r => h(Row, { key: r.id, r, sc: r._savedMissing ? { score: 0, parts: {} } : scoreOf(r), ctx, keys: keySet, state: st(r.id), onState: setManualAppState, job: jobs[String(r.id)],
                saved: !!(roleBook.roles[String(r.id)] && roleBook.roles[String(r.id)].saved), onSave: toggleSaved, myList, fresh: sinceVisit(r, previousVisit, visitStart), missingText,
                checked: sel.has(r.id), onCheck: check, canAuto, canTry, onAuto: onAutoRow, queueBusy: queuing, open: !r._savedMissing && openId === r.id, onWhy, onRank: openSetup, elig: r._savedMissing ? null : elig, patterns: stats && stats.skill_patterns,
                ask: askId === r.id, onOpen, onAnswer }) })),

      // was: narrow && promoEls
      promoEls,
      // was: h(Landing, { open: landingOpen && !setupOpen, setOpen: setLandingOpen, onSetup: () => setSetupOpen(true), hasProfile: !!p, nationwide }),
      // was: h(Landing, { open: landingOpen && !setupOpen, setOpen: setLandingOpen, onSetup: () => setSetupOpen(true), hasProfile: !!p, nationwide, plans: payPlans }),
      // was: h(Landing, { ..., plans: payPlans, installed: info.installed || !!info.stale }),
      // Under the list since 2026-10-14, so "What InternScout does" no longer pushes the search down.
      h(Landing, { open: landingOpen, setOpen: setLandingOpen, onSetup: openSetup, hasProfile: !!p, nationwide, plans: payPlans, installed: info.installed || !!info.stale, inviteOffer, inviteWords }),

      // Below the list and above the footer links, so it never pushes a listing down.
      digestOn && h(Digest, { cfg: C.digest, fields: digestFields, hasProfile: !!p, onSetup: openSetup, placement: "footer" })),

      h("footer", null,
        // Same facts as before, in two short sentences instead of one long one. The plan prices
        // still come from /config so they cannot drift from Stripe.
        h("div", null, `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} shown. Your profile and progress stay in this browser.`, canAuto ? " Auto-Apply never presses Submit; you do." : ""),
        h("div", { style: { marginTop: 6 } }, "Search is free with no sign-in. The AI extras have a free monthly allowance"
          + (payPlans.length ? `; ${payPlans.map(pl => pl.label + (pl.price ? " " + pl.price : "")).join(" or ")} raises it` : "; optional paid plans raise it")
          + ". Made by a UMass student, not affiliated with UMass Amherst."),
        h("nav", { className: "links", "aria-label": "Footer" },
          // The crawlable pages built by backend/internscout/seo_pages.py at deploy time.
          h("a", { href: "internships/" }, "Browse by field, state or major"),
          // The employer index (2026-10-07), so every employer page is two clicks from here.
          h("a", { href: "internships/at/" }, "Employers hiring now"),
          h("a", { href: "privacy.html" }, "Privacy"),
          h("a", { href: "terms.html" }, "Terms"),
          // The employer page (2026-10-13; docs/employers/index.html), as in every landing page's footer.
          h("a", { href: "employers/", "data-employer-entry": "footer" }, "For employers"),
          h("a", { href: feedbackUrl, target: "_blank", rel: "noopener" }, "Feedback"),
          h("a", { href: C.issuesUrl, target: "_blank", rel: "noopener" }, "GitHub Issues"),
          // was: h("a", { href: C.extensionInstallUrl || "install.html" }, "Install extension"),
          h("a", { href: installUrl("dashboard-footer"), target: "_blank", rel: "noopener" }, "Install extension"),
          h("a", { href: "https://github.com/bpmcginley/internships-every-major", "data-distribution": "list" }, "Internships for every major on GitHub"),
          h("a", { href: "widget/builder.html", "data-distribution": "widget" }, "Put live internships on your club or department site"),
          h("a", { href: C.handshakeUrl, target: "_blank", rel: "noopener" }, "Also check Handshake"),
          h("a", { href: C.reuUrl, target: "_blank", rel: "noopener" }, "NSF REU research"),
          C.campusJobsUrl && h("a", { href: C.campusJobsUrl, target: "_blank", rel: "noopener" }, "UMass campus jobs")),
        h("div", { className: "footer-account" }, signInProviders, plansEl)));
  }

  return App;
}
