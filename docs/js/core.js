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
  // The terms still worth applying for, worked out from today's date so the list never goes stale
  // (it was a fixed list that ended at Summer 2027, while the data already had Winter and Fall 2027).
  // Each season stays on the list until about a month after it starts: [season, last month shown, 0-11].
  const SEASONS = [["Winter", 0], ["Spring", 1], ["Summer", 5], ["Fall", 9]];
  function upcomingTerms(now) {
    const out = [], y0 = now.getFullYear(), m0 = now.getMonth();
    for (let y = y0; out.length < 5; y++) for (const [season, last] of SEASONS) if ((y > y0 || last >= m0) && out.length < 5) out.push(`${season} ${y}`);
    return out;
  }
  const TERMS = [...upcomingTerms(new Date()), "Year-round"];
  const DEFAULT_TERM = TERMS.find(t => t.startsWith("Summer"));
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
    stages: [], terms: [DEFAULT_TERM], paid_only: false, states: [], remote: true, work_auth: "",
  });
  const loadProfile = () => { const p = ls.get(PROFILE_KEY, null); return p && typeof p === "object" ? { ...emptyProfile(), ...p } : null; };
  // Set by "Delete my data" and cleared by the next save. Without it the next page load asked the
  // extension for its copy of the profile and the deleted profile was back.
  const DELETED_KEY = "internscout.profile.deleted";
  const saveProfile = p => { const out = { ...p, v: 1, updated: new Date().toISOString() }; ls.set(PROFILE_KEY, out); ls.del(DELETED_KEY); return out; };
  const profileDeleted = () => !!ls.get(DELETED_KEY, false);

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
  const SOURCE_BY_ATS = { greenhouse: 1, lever: 1, ashby: 1, workday: 1, smartrecruiters: .9, icims: .9, icims_site: .9, taleo: .9, oracle: .9, workable: .9, bamboohr: .9 };

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

  // The single tag a student's own coverage should be judged by. profileFields above returns a Set,
  // which loses both order and which major a tag came from, so anything reading it can only take a
  // maximum, and the maximum is the wrong number here. majors.json lists a major's own field first
  // and its broader siblings after ("Nursing" is ["nursing", "health"], "Art (Studio)" is
  // ["arts", "design"]), and in docs/data/stats.json (generated_at 2026-09-18) nursing has 16 open
  // against health's 98, so the largest tag is usually a sibling shared with dozens of other majors.
  // tags[0] is the field the student actually came for. "Exploratory / Undeclared" and "Individual
  // Concentration (BDIC)" are the only two majors in majors.json with an empty tags array, so for
  // them the answer is the first field the student picked by hand.
  function primaryField(p, majorsData) {
    if (!p) return null;
    const byName = new Map(((majorsData && majorsData.majors) || []).map(m => [m.name, m]));
    for (const n of p.majors || []) {
      const m = byName.get(n), t = m && (m.tags || []).find(x => x && x !== "other");
      if (t) return t;
    }
    for (const t of p.fields || []) if (t && t !== "other") return t;
    return null;
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

    // Counted from the day the employer posted it, not the day we found it: 2,800 open listings
    // were first seen more than the whole 21-day window after they were posted, and 568 of those
    // more than six months after, so a job posted in March scored as new. With no posting date the
    // age is unknown, which is worth the same .5 a listing with no date at all has always been
    // worth; giving it the benefit of first_seen would rank the boards that withhold the date
    // above the ones that publish it. Keep this in step with _freshness() in backend score.py.
    const postedAt = x.posted_at ? new Date(x.posted_at).getTime() : NaN;
    const seen = x.first_seen ? new Date(x.first_seen).getTime() : NaN;
    const decay = t => Math.max(0, 1 - (Date.now() - t) / DAY / 21);
    const freshness = !isNaN(postedAt) ? decay(postedAt) : isNaN(seen) ? .5 : Math.min(.5, decay(seen));
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
    const descd = new Map();    // key -> Promise (description sidecars)
    const byId = new Map();
    let version = 0;

    // apply_url ends up in an href and in the Auto-Apply queue, so anything that is not plain http(s)
    // (javascript:, data:) is dropped here, once, before any of the page sees it.
    function add(list) {
      for (const x of list || []) {
        if (!x || x.id == null || byId.has(x.id)) continue;
        if (x.apply_url && !/^https?:\/\//i.test(x.apply_url)) x.apply_url = "";
        byId.set(x.id, x);
      }
      version++;
    }

    async function init(fromRaw) {
      bust = !!fromRaw;
      base = fromRaw ? C.rawDataFallback : (C.dataUrl || "./data/");
      loaded.clear(); descd.clear(); byId.clear(); index = null; legacy = false; version++;
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

    // Resolves to the keys that could not be loaded, so the page can say so instead of showing
    // "no listings" for a state whose file simply failed to download.
    const failed = new Set();
    async function ensure(keys) {
      if (legacy || !index) return [];
      const jobs = [];
      for (const k of new Set(keys)) {
        const meta = index.files[k];
        if (!meta) continue;
        // Already asked for: wait for it as well. Skipping a shard still in flight painted the list
        // without its rows when states were changed quickly.
        if (loaded.has(k)) { jobs.push(loaded.get(k)); continue; }
        const file = meta.file || (index._dir + k + ".json");
        const get = () => getJSON(base + file, bust);
        // One quiet retry: a dropped connection is the usual reason a shard fails.
        const pr = get().catch(() => new Promise(r => setTimeout(r, 1200)).then(get))
          .then(d => { failed.delete(k); add(d); })
          .catch(e => { loaded.delete(k); failed.add(k); console.warn("InternScout: couldn't load", file, e); });
        loaded.set(k, pr);
        jobs.push(pr);
      }
      await Promise.all(jobs);
      return [...new Set(keys)].filter(k => failed.has(k));
    }

    // Descriptions live beside each shard (<file> -> <file>.desc.json, {id: text}) so the list
    // loads without them; they are fetched only for search and Auto-Apply. Older exports carry
    // them inline on the row, and then the sidecar simply doesn't exist.
    async function descs(keys) {
      if (legacy || !index) return;
      const jobs = [];
      for (const k of new Set(keys)) {
        const meta = index.files[k];
        if (!meta || descd.has(k)) continue;
        const file = meta.desc || (meta.file || (index._dir + k + ".json")).replace(/\.json$/, ".desc.json");
        const pr = Promise.resolve(loaded.get(k)).then(() => getJSON(base + file, bust)).then(m => {
          let n = 0;
          for (const id in m) {
            const x = byId.get(id) || byId.get(Number(id));
            if (x && !x.description && m[id]) { x.description = m[id]; delete x._hay; n++; }
          }
          if (n) version++;
        }).catch(() => { /* no sidecar: descriptions are inline, or this shard has none */ });
        descd.set(k, pr);
        jobs.push(pr);
      }
      await Promise.all(jobs);
    }

    return {
      init, ensure, descs,
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

  // GET /me: this month's allowance ({tier, paused, allowance:{task:{used,limit}}}), or null.
  async function fetchMe(token) {
    if (!workerOn() || !token) return null;
    try {
      const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/me", { headers: { Authorization: "Bearer " + token } });
      if (r.status === 401) { signOut(); return null; }
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  // Referral credits (worker/src/referral.js). A classmate's invite code rides in on ?ref= and waits
  // here until the student signs in; GET /invite is the student's own link, POST /invite/claim uses one.
  const INVITE_KEY = "internscout.invite.v1";
  // sessionStorage: the sign-in sub of the account the Worker last answered "edu_only" for, so the
  // dashboard asks for that account once per session instead of on every page load.
  const INVITE_EDU_KEY = "internscout.invite.edu_only";
  const INVITE_CODE = /^[a-hj-km-np-z2-9]{8}$/;
  async function fetchInvite(token) {
    if (!workerOn() || !token) return null;
    try {
      const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/invite", { headers: { Authorization: "Bearer " + token } });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  // { ok, bonus } or { error, message } from the Worker; null when it couldn't be reached (try later).
  async function claimInvite(token, code) {
    if (!workerOn() || !token) return null;
    try {
      const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/invite/claim", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      });
      if (r.status >= 500) return null;
      return await r.json().catch(() => null);
    } catch (e) { return null; }
  }
  const ALLOWANCE_LABELS = { autofill: "Auto-Apply runs", resume_tailor: "Tailored resumes", deep_dive: "Deep Dives" };
  // A label as it reads mid-sentence: "tailored resumes", but Auto-Apply and the Deep Dive keep their capitals.
  const midSentence = l => /^(Auto-Apply|Deep Dive)/.test(l) ? l : l.charAt(0).toLowerCase() + l.slice(1);
  // Fallback names for the paid tiers. /config carries the real labels; this is for when it hasn't
  // loaded yet, or an older page meets a tier it doesn't know.
  const PLAN_LABELS = { supporter: "Supporter", pro: "Pro" };
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
      const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/billing/" + kind, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(plan ? { plan } : {}),
      });
      if (r.status === 401) { signOut(); return { error: "Sign in again." }; }
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
        const r = await fetch(C.workerUrl.replace(/\/$/, "") + "/me", { method: "DELETE", headers: { Authorization: "Bearer " + token } });
        server = r.ok;
        // A live subscription would keep billing a card for an account we'd just erased, so the
        // Worker refuses until it is cancelled. Leave the browser copy alone and say so.
        if (r.status === 409) return { server: false, blocked: true };
      } catch (e) { server = false; }
    }
    ls.del(PROFILE_KEY); ls.del("internscout.demand.sent"); ls.del(INVITE_KEY); ls.set(DELETED_KEY, true);
    // was: ss.del(TOKEN_KEY);
    // The invite check now keeps the account's sub for the session; it comes from the token and goes with it.
    ss.del(TOKEN_KEY); ss.del(INVITE_EDU_KEY);
    return { server };
  }

  // ---------- feedback links ----------
  function reportUrl(x) {
    if (C.formUrl) return C.formUrl.includes("{id}") ? C.formUrl.split("{id}").join(encodeURIComponent(x.id)) : C.formUrl;
    const title = `Wrong tag: listing ${x.id} (${x.company_name} - ${x.title})`;
    return `https://github.com/${C.repo}/issues/new?template=${encodeURIComponent(C.reportTemplate || "wrong_tag.yml")}&title=${encodeURIComponent(title)}`;
  }

  window.IS = {
    C, DAY, US_STATES, BASELINE, REGION_SHORTCUTS, YEARS, YEAR_LABEL, YEAR_PLURAL, STAGES, STAGE_LABEL, STAGE_DEFAULTS, TERMS, upcomingTerms, WORK_AUTH,
    fieldLabel, keyLabel, termText, ls, ss,
    emptyProfile, loadProfile, saveProfile, profileKeys, demandStates,
    regs, shardKeys, citizenRule, noSponsorship, payOf, citizenBlocked, yearsFit, yearsText,
    // was: WEIGHTS, PART_LABEL, profileFields, score,
    // primaryField is exported because the dashboard's coverage line (docs/js/app.js) needs the
    // student's own tag, not the biggest one in the Set profileFields returns.
    WEIGHTS, PART_LABEL, profileFields, primaryField, score,
    createStore, loadMajors, loadStats,
    ext, bridgeProfile, fromBridgeProfile,
    workerOn, decodeJwt, tokenOk, storedToken, handleRedirect, fetchWorkerConfig, startSignIn, PROVIDER_LABELS, signOut, postDemand, deleteMyData, profileDeleted,
    fetchMe, leftOf, allowanceText, billingUrl, PLAN_LABELS, INVITE_KEY, INVITE_EDU_KEY, INVITE_CODE, fetchInvite, claimInvite, ALLOWANCE_LABELS, midSentence,
    reportUrl, sectorLabel: s => s ? String(s).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "",
  };
})();
