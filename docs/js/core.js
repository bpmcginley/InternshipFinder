// InternScout dashboard logic with no UI: profile, data loading, scoring, sign-in, extension bridge.
// Plain browser JS (no build step). Exposes window.IS; reads window.CONFIG from index.html.
(function () {
  "use strict";
  const C = window.CONFIG || {};
  const DAY = 864e5;

  // ---------- vocabularies ----------
  const US_STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
    DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
    IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
    NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
    RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
    VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
    PR: "Puerto Rico",
  };
  const BASELINE = (C.baselineStates && C.baselineStates.length) ? C.baselineStates : ["MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ"];
  const REGION_SHORTCUTS = [
    ["Northeast", ["MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "PA"]],
    ["New England", ["MA", "CT", "RI", "NH", "VT", "ME"]],
    ["Mid-Atlantic", ["NY", "NJ", "PA", "DE", "MD", "DC", "VA"]],
    ["Southeast", ["FL", "GA", "NC", "SC", "TN", "AL", "MS", "KY", "WV", "LA", "AR"]],
    ["Midwest", ["IL", "OH", "MI", "IN", "WI", "MN", "IA", "MO", "KS", "NE", "ND", "SD"]],
    ["Southwest", ["TX", "AZ", "NM", "NV", "OK"]],
    ["West Coast", ["CA", "OR", "WA", "AK", "HI"]],
    ["Mountain West", ["CO", "UT", "ID", "MT", "WY", "NV"]],
  ];
  const YEARS = [["first_year", "First-year"], ["sophomore", "Sophomore"], ["junior", "Junior"], ["senior", "Senior"], ["masters", "Master's"], ["phd", "PhD"]];
  const YEAR_LABEL = Object.fromEntries(YEARS);
  const YEAR_PLURAL = { first_year: "first-years", sophomore: "sophomores", junior: "juniors", senior: "seniors", masters: "master's students", phd: "PhD students" };
  const STAGES = [["internship", "Internship"], ["co_op", "Co-op"], ["research", "Research (REU, RA)"], ["fellowship", "Fellowship"],
    ["early_insight", "Early insight / discovery program"], ["part_time", "Part-time or semester role"], ["apprenticeship", "Apprenticeship"]];
  const STAGE_LABEL = Object.fromEntries(STAGES.map(([k, v]) => [k, v.replace(/ \(.*\)$/, "").replace(/ \/ .*$/, "")]));
  const STAGE_DEFAULTS = {
    first_year: ["early_insight", "research", "internship"],
    sophomore: ["early_insight", "research", "internship"],
    junior: ["internship", "co_op", "research"],
    senior: ["internship", "co_op", "fellowship", "research"],
    masters: ["internship", "co_op", "fellowship", "research"],
    phd: ["research", "internship", "fellowship"],
  };
  const TERMS = ["Summer 2027", "Fall 2026", "Spring 2027", "Year-round"];
  const WORK_AUTH = [
    ["citizen", "U.S. citizen"],
    ["permanent", "U.S. permanent resident (green card)"],
    ["visa", "Student visa (e.g. F-1), will need sponsorship"],
    ["other", "Other / prefer not to say"],
  ];
  const FIELD_NAMES = { swe: "Software", ml: "ML / AI", pm: "Product / program mgmt", hr: "HR", ui: "UI", ux: "UX", co_op: "Co-op" };
  const fieldLabel = t => FIELD_NAMES[t] || (t.length <= 3 ? t.toUpperCase() : (t[0].toUpperCase() + t.slice(1)).replace(/_/g, " "));
  const keyLabel = k => k === "remote" ? "US remote" : k === "US" ? "US (no state listed)" : (US_STATES[k] ? `${US_STATES[k]} (${k})` : k);
  const termText = t => t ? String(t).replace(/\s*\bNone\b/g, "").trim() || null : null;

  // ---------- storage ----------
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } },
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { } },
  };

  const PROFILE_KEY = "internscout.profile.v1";
  const emptyProfile = () => ({
    v: 1, majors: [], minors: [], fields: [], class_year: "", grad_term: "",
    stages: [], terms: ["Summer 2027"], paid_only: false, states: [], remote: true, work_auth: "",
  });
  const loadProfile = () => { const p = ls.get(PROFILE_KEY, null); return p && typeof p === "object" ? { ...emptyProfile(), ...p } : null; };
  const saveProfile = p => { const out = { ...p, v: 1, updated: new Date().toISOString() }; ls.set(PROFILE_KEY, out); return out; };

  // ---------- locations ----------
  const REMOTE_RE = /\b(remote|anywhere|work from home|virtual)\b/i;
  // One entry per location: {loc, kind, state}. Current exports carry x.regions; older data is guessed.
  function regs(x) {
    if (x._regs) return x._regs;
    let out;
    if (x.regions && x.regions.length) out = x.regions;
    else {
      const locs = (x.region_locations && x.region_locations.length ? x.region_locations : (x.location_raw || "").split(";")).map(s => s.trim()).filter(Boolean);
      out = locs.map(loc => {
        const m = /,\s*([A-Z]{2})\b/.exec(loc), s = m && US_STATES[m[1]] ? m[1] : null;
        if (s) return { loc, kind: "us", state: s };
        if (REMOTE_RE.test(loc)) return { loc, kind: "remote", state: "Remote" };
        return null;
      }).filter(Boolean);
      if (!out.length && x.state) out = [{ loc: locs[0] || x.state, kind: x.state === "Remote" ? "remote" : "us", state: x.state }];
    }
    Object.defineProperty(x, "_regs", { value: out, enumerable: false });
    return out;
  }
  // The data files a listing belongs in, same rule as backend export_static.shard_keys.
  function shardKeys(x) {
    if (x._keys) return x._keys;
    const ks = new Set();
    for (const g of regs(x)) {
      if (g.state && g.state !== "Remote") ks.add(g.state);
      else ks.add(g.kind === "remote" ? "remote" : "US");
    }
    if (!ks.size && x.state) ks.add(x.state === "Remote" ? "remote" : x.state);
    Object.defineProperty(x, "_keys", { value: ks, enumerable: false });
    return ks;
  }
  const profileKeys = p => {
    if (!p) return [...BASELINE, "remote"];
    const ks = (p.states && p.states.length ? p.states : BASELINE).slice();
    if (p.remote) ks.push("remote", "US");
    return ks;
  };
  const demandStates = p => [...(p.states || []), ...(p.remote ? ["REMOTE"] : [])];

  // ---------- eligibility helpers ----------
  const restr = x => x.restrictions || [];
  const citizenRule = x => restr(x).includes("us_citizen_only") ? "citizen" : ((x.insights || {}).citizenship || null);
  const noSponsorship = x => restr(x).includes("no_sponsorship") || !!(x.insights || {}).no_sponsorship;
  const payOf = x => {
    const r = restr(x).find(t => t === "paid" || t === "unpaid" || t === "stipend");
    return r || (x.insights || {}).pay || (x.salary ? "paid" : null);
  };
  // Hidden for this student because of citizenship rules. With no work authorization given, hide any citizen rule.
  function citizenBlocked(x, workAuth) {
    const c = citizenRule(x);
    if (!c) return false;
    if (workAuth === "citizen") return false;
    if (workAuth === "permanent") return c === "citizen";
    return true;
  }
  const yearsFit = (x, p) => !p || !p.class_year || !(x.years && x.years.length) || x.years.includes(p.class_year);
  const yearsText = ys => ys.map(y => YEAR_PLURAL[y] || y).join(", ");

  // ---------- scoring (plan 3b) ----------
  const WEIGHTS = { field: 35, fit: 20, location: 20, freshness: 15, openness: 5, source: 5 };
  const PART_LABEL = { field: "Field fit", fit: "Stage and year", location: "Location", freshness: "Freshness", openness: "Still open", source: "Source" };
  const SOURCE_BY_ATS = { greenhouse: 1, lever: 1, ashby: 1, workday: 1, smartrecruiters: .9, icims: .9, taleo: .9, oracle: .9, workable: .9, bamboohr: .9 };

  // Field tags a profile counts as direct (1.0) and related (0.6).
  function profileFields(p, majorsData) {
    const direct = new Set(), related = new Set();
    if (!p) return { direct, related };
    const byName = new Map(((majorsData && majorsData.majors) || []).map(m => [m.name, m]));
    for (const n of p.majors || []) { const m = byName.get(n); if (m) { m.tags.forEach(t => direct.add(t)); m.related.forEach(t => related.add(t)); } }
    for (const t of p.fields || []) direct.add(t);
    for (const n of p.minors || []) { const m = byName.get(n); if (m) m.tags.forEach(t => related.add(t)); }
    direct.forEach(t => related.delete(t));
    return { direct, related };
  }

  function termFit(x, terms) {
    if (!terms || !terms.length) return 1;
    const t = termText(x.term);
    if (!t) return .6;
    const lo = t.toLowerCase();
    if (terms.some(w => w === "Year-round" ? /year[- ]round|academic year/.test(lo) : lo.includes(w.toLowerCase()))) return 1;
    // same season, different or unknown year ("Summer" vs "Summer 2027")
    if (terms.some(w => w !== "Year-round" && lo.split(/[\s/]+/).includes(w.split(" ")[0].toLowerCase()) && !/\d{4}/.test(lo))) return .8;
    return .2;
  }

  // ctx = {p, direct, related, keys:Set}
  function score(x, ctx) {
    const p = ctx.p;
    const tags = x.field_tags || [];
    let field;
    if (ctx.direct.size || ctx.related.size) field = tags.some(t => ctx.direct.has(t)) ? 1 : tags.some(t => ctx.related.has(t)) ? .6 : 0;
    else field = tags.some(t => t !== "other") ? 1 : .4;

    const mismatch = !yearsFit(x, p);
    let fit = 0;
    if (!mismatch) {
      const st = x.stage || [];
      const stageFit = !p || !(p.stages && p.stages.length) ? 1 : !st.length ? .6 : st.some(s => p.stages.includes(s)) ? 1 : .3;
      fit = .6 * stageFit + .4 * termFit(x, p && p.terms);
    }

    const ks = shardKeys(x);
    let location = .3;
    for (const k of ks) {
      if (k !== "remote" && k !== "US" && ctx.keys.has(k)) { location = 1; break; }
      if ((k === "remote" || k === "US") && ctx.keys.has(k)) location = Math.max(location, .8);
    }

    const seen = x.first_seen ? new Date(x.first_seen).getTime() : NaN;
    const freshness = isNaN(seen) ? .5 : Math.max(0, 1 - (Date.now() - seen) / DAY / 21);
    const openness = x.status === "open" ? 1 : 0;
    const sp = x.score_parts && x.score_parts.source;
    const source = sp != null ? Math.min(1, sp / 5) : (SOURCE_BY_ATS[x.ats] || .5);

    const v = { field, fit, location, freshness, openness, source };
    const parts = {};
    let total = 0;
    for (const k in WEIGHTS) { parts[k] = Math.round(WEIGHTS[k] * v[k] * 10) / 10; total += parts[k]; }
    return { score: Math.round(total), parts, mismatch };
  }

  // ---------- data loading (sharded, with the single-file fallback) ----------
  async function getJSON(url, bust) {
    const r = await fetch(url + (bust ? (url.includes("?") ? "&" : "?") + "t=" + Date.now() : ""), { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    return r.json();
  }

  function createStore() {
    let base = C.dataUrl || "./data/";
    let index = null, legacy = false, bust = false;
    const loaded = new Map();   // key -> Promise
    const byId = new Map();
    let version = 0;

    function add(list) { for (const x of list || []) if (x && x.id != null && !byId.has(x.id)) byId.set(x.id, x); version++; }

    async function init(fromRaw) {
      bust = !!fromRaw;
      base = fromRaw ? C.rawDataFallback : (C.dataUrl || "./data/");
      loaded.clear(); byId.clear(); index = null; legacy = false; version++;
      const bases = fromRaw ? [C.rawDataFallback] : [C.dataUrl || "./data/", C.rawDataFallback].filter(Boolean);
      for (const b of bases) {
        for (const path of ["listings/index.json", "index.json"]) {
          try {
            const idx = await getJSON(b + path, bust);
            if (idx && idx.files) { index = idx; base = b; index._dir = path.includes("/") ? "listings/" : ""; return { index, legacy: false }; }
          } catch (e) { /* try next */ }
        }
      }
      // no shards: the old single file
      for (const b of bases) {
        try { const all = await getJSON(b + "listings.json", bust); base = b; legacy = true; add(all); return { index: null, legacy: true }; }
        catch (e) { var last = e; }
      }
      throw last || new Error("No listing data found");
    }

    async function ensure(keys) {
      if (legacy || !index) return;
      const jobs = [];
      for (const k of new Set(keys)) {
        const meta = index.files[k];
        if (!meta || loaded.has(k)) continue;
        const file = meta.file || (index._dir + k + ".json");
        const pr = getJSON(base + file, bust).then(add).catch(e => { loaded.delete(k); console.warn("InternScout: couldn't load", file, e); });
        loaded.set(k, pr);
        jobs.push(pr);
      }
      await Promise.all(jobs);
    }

    return {
      init, ensure,
      all: () => [...byId.values()],
      version: () => version,
      index: () => index,
      isLegacy: () => legacy,
      loadedKeys: () => [...loaded.keys()],
      base: () => base,
    };
  }

  async function loadMajors() {
    for (const b of [C.dataUrl || "./data/", C.rawDataFallback].filter(Boolean)) {
      try { const m = await getJSON(b + "majors.json"); if (m && m.majors) return m; } catch (e) { }
    }
    return null;
  }
  async function loadStats() {
    for (const b of [C.dataUrl || "./data/", C.rawDataFallback].filter(Boolean)) {
      try { return await getJSON(b + "stats.json"); } catch (e) { }
    }
    return null;
  }

  // ---------- extension bridge (extension/bridge/bridge.js relays window messages) ----------
  const ext = (() => {
    let n = 0; const waiting = new Map(); const subs = new Set();
    window.addEventListener("message", e => {
      if (e.source !== window || !e.data || !e.data.__internscout) return;
      const d = e.data;
      if (d.__internscout === "res" && waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id); }
      else if (d.__internscout === "push" || d.__internscout === "hello" || d.__internscout === "gone") subs.forEach(f => f(d));
    });
    return {
      present: () => !!document.documentElement.dataset.internscout,
      call: (msg, timeout = 5000) => new Promise(res => {
        const id = ++n; waiting.set(id, res);
        window.postMessage({ __internscout: "req", id, msg }, location.origin);
        setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); res({ error: "no_extension" }); } }, timeout);
      }),
      on: f => { subs.add(f); return () => subs.delete(f); },
    };
  })();
  const bridgeProfile = p => ({
    majors: p.majors || [], minors: p.minors || [], class_year: p.class_year || "", grad_term: p.grad_term || "",
    stages: p.stages || [], terms: p.terms || [], states: demandStates(p), work_auth: p.work_auth || "",
  });
  const fromBridgeProfile = b => {
    if (!b || typeof b !== "object") return null;
    const states = (b.states || []).filter(s => s !== "REMOTE");
    return { ...emptyProfile(), ...b, states, remote: (b.states || []).includes("REMOTE") || !states.length };
  };

  // ---------- Google / Microsoft sign-in (implicit id_token flow, see worker/API.md) ----------
  const TOKEN_KEY = "internscout.idtoken";
  const workerOn = () => !!C.workerUrl && !/\.example\.|example\.workers\.dev/.test(C.workerUrl);
  function decodeJwt(t) {
    try {
      let s = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      s += "===".slice((s.length + 3) % 4);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))));
    } catch (e) { return null; }
  }
  const tokenOk = t => { const p = t && decodeJwt(t); return !!(p && p.exp && p.exp * 1000 > Date.now() + 60000); };
  const storedToken = () => { const t = ss.get(TOKEN_KEY); if (t && tokenOk(t)) return t; if (t) ss.del(TOKEN_KEY); return null; };
  const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const redirectUri = () => C.redirectUri || (location.origin + location.pathname.replace(/index\.html$/, ""));

  // Reads the #id_token=... hash the provider sends back. Returns null, {token}, or {error}.
  function handleRedirect() {
    const h = location.hash || "";
    if (!/[#&](id_token|error)=/.test(h)) return null;
    const q = new URLSearchParams(h.slice(1));
    history.replaceState(null, "", location.pathname + location.search);
    const state = ss.get("internscout.auth.state"), nonce = ss.get("internscout.auth.nonce");
    ss.del("internscout.auth.state"); ss.del("internscout.auth.nonce");
    if (q.get("error")) return { error: q.get("error_description") || q.get("error") };
    const t = q.get("id_token");
    if (!state || q.get("state") !== state) return { error: "Sign-in state didn't match. Try again." };
    const p = decodeJwt(t);
    if (!p || p.nonce !== nonce) return { error: "Sign-in check failed. Try again." };
    if (!tokenOk(t)) return { error: "Sign-in expired. Try again." };
    ss.set(TOKEN_KEY, t);
    return { token: t };
  }

  async function fetchWorkerConfig() {
    if (!workerOn()) return null;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/config", { signal: ctl.signal });
      if (!r.ok) return null;
      const cfg = await r.json();
      const providers = (cfg && Array.isArray(cfg.providers) ? cfg.providers : []).filter(p => p && p.id && p.client_id && p.authorize_url);
      return providers.length ? { ...cfg, providers } : null;
    } catch (e) { return null; } finally { clearTimeout(timer); }
  }

  const PROVIDER_LABELS = { google: "Google", microsoft: "Microsoft" };

  // Anyone can sign in; a verified school .edu email gets the larger AI allowance (the Worker decides).
  function startSignIn(cfg, providerId) {
    const p = (cfg.providers || []).find(x => x.id === providerId);
    if (!p) return;
    const state = randomHex(), nonce = randomHex();
    ss.set("internscout.auth.state", state); ss.set("internscout.auth.nonce", nonce);
    const q = new URLSearchParams({
      client_id: p.client_id, response_type: "id_token", redirect_uri: redirectUri(),
      scope: (p.scopes || ["openid", "email", "profile"]).join(" "), nonce, state, response_mode: "fragment", prompt: "select_account",
    });
    location.assign(p.authorize_url + (p.authorize_url.includes("?") ? "&" : "?") + q.toString());
  }
  const signOut = () => ss.del(TOKEN_KEY);

  async function postDemand(token, p) {
    if (!workerOn() || !token || !p) return false;
    const states = demandStates(p);
    if (!states.length) return false;
    const sub = (decodeJwt(token) || {}).sub || "";
    const key = sub + "|" + states.slice().sort().join(",");
    if (ls.get("internscout.demand.sent", "") === key) return true;
    try {
      const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/demand", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ states }),
      });
      if (r.ok) { ls.set("internscout.demand.sent", key); return true; }
      if (r.status === 401) signOut();
    } catch (e) { }
    return false;
  }

  // "Delete my data": server rows (if signed in), then everything this page keeps in the browser.
  async function deleteMyData(token) {
    let server = null;
    if (workerOn() && token) {
      try {
        const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/me", { method: "DELETE", headers: { Authorization: "Bearer " + token } });
        server = r.ok;
      } catch (e) { server = false; }
    }
    ls.del(PROFILE_KEY); ls.del("internscout.demand.sent");
    ss.del(TOKEN_KEY);
    return { server };
  }

  // ---------- feedback links ----------
  function reportUrl(x) {
    if (C.formUrl) return C.formUrl.includes("{id}") ? C.formUrl.split("{id}").join(encodeURIComponent(x.id)) : C.formUrl;
    const title = `Wrong tag: listing ${x.id} (${x.company_name} - ${x.title})`;
    return `https://github.com/${C.repo}/issues/new?template=${encodeURIComponent(C.reportTemplate || "wrong_tag.yml")}&title=${encodeURIComponent(title)}`;
  }

  window.IS = {
    C, DAY, US_STATES, BASELINE, REGION_SHORTCUTS, YEARS, YEAR_LABEL, YEAR_PLURAL, STAGES, STAGE_LABEL, STAGE_DEFAULTS, TERMS, WORK_AUTH,
    fieldLabel, keyLabel, termText, ls, ss,
    emptyProfile, loadProfile, saveProfile, profileKeys, demandStates,
    regs, shardKeys, citizenRule, noSponsorship, payOf, citizenBlocked, yearsFit, yearsText,
    WEIGHTS, PART_LABEL, profileFields, score,
    createStore, loadMajors, loadStats,
    ext, bridgeProfile, fromBridgeProfile,
    workerOn, decodeJwt, tokenOk, storedToken, handleRedirect, fetchWorkerConfig, startSignIn, PROVIDER_LABELS, signOut, postDemand, deleteMyData,
    reportUrl, sectorLabel: s => s ? String(s).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "",
  };
})();
