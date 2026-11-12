// Dashboard profile, vocabulary and geographic scope.

export function createProfile(browser) {
  const C = browser.CONFIG || {};
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
  // Canada since 2026-09-30: listings are filed by province, and "Canada" holds the ones that name no
  // province (remote ones too). None of these codes is also a US state's.
  const CA_PROVINCES = {
    ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan",
    NS: "Nova Scotia", NB: "New Brunswick", NL: "Newfoundland and Labrador", PE: "Prince Edward Island",
    NT: "Northwest Territories", NU: "Nunavut", YT: "Yukon",
  };
  const CANADA_KEYS = [...Object.keys(CA_PROVINCES), "Canada"];
  const isCanadaKey = k => k === "Canada" || !!CA_PROVINCES[k];
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
    ["Canada", CANADA_KEYS],
    ["Ontario + Quebec", ["ON", "QC"]],
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
  const TERMS = [...upcomingTerms(new browser.Date()), "Year-round"];
  const DEFAULT_TERM = TERMS.find(t => t.startsWith("Summer"));
  const WORK_AUTH = [
    ["citizen", "U.S. citizen"],
    ["permanent", "U.S. permanent resident (green card)"],
    ["visa", "Student visa (e.g. F-1), will need sponsorship"],
    ["canada", "Can work in Canada (citizen, permanent resident or permit)"],
    ["other", "Other / prefer not to say"],
  ];
  const FIELD_NAMES = { swe: "Software", ml: "ML / AI", pm: "Product / program mgmt", hr: "HR", ui: "UI", ux: "UX", co_op: "Co-op" };
  const fieldLabel = t => FIELD_NAMES[t] || (t.length <= 3 ? t.toUpperCase() : (t[0].toUpperCase() + t.slice(1)).replace(/_/g, " "));
  // was: remote, US, then US_STATES only
  const keyLabel = k => k === "remote" ? "US remote" : k === "US" ? "US (no state listed)" : k === "Canada" ? "Canada (no province listed)"
    : US_STATES[k] ? `${US_STATES[k]} (${k})` : CA_PROVINCES[k] ? `${CA_PROVINCES[k]} (${k})` : k;
  const termText = t => t ? String(t).replace(/\s*\bNone\b/g, "").trim() || null : null;

  // ---------- storage ----------
  const ls = {
    get(k, d) { try { const v = browser.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { browser.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { browser.localStorage.removeItem(k); } catch (e) { } },
  };
  const ss = {
    get(k) { try { return browser.sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { browser.sessionStorage.setItem(k, v); } catch (e) { } },
    del(k) { try { browser.sessionStorage.removeItem(k); } catch (e) { } },
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
  const saveProfile = p => { const out = { ...p, v: 1, updated: new browser.Date().toISOString() }; ls.set(PROFILE_KEY, out); ls.del(DELETED_KEY); return out; };
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
      else ks.add(g.kind === "remote" ? "remote" : g.kind === "canada" ? "Canada" : "US");
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
  // What the list covers (2026-10-14). was: the State filter's picks, else profileKeys(p), so with no
  // profile (or a profile with no states) the dashboard held only the eight baseline states and remote,
  // 3,086 of 14,799 open roles, under a hero offering to "Search 14,799 internships". No state picked
  // now means every state; ALL_KEY is the State picker's "Everywhere". { all, keys, noRemote }: keys
  // are the files to show when the scope is not everywhere.
  const ALL_KEY = "all";
  function viewScope(p, picked) {
    if (picked && picked.includes(ALL_KEY)) return { all: true, keys: [], noRemote: false };
    if (picked && picked.length) return { all: false, keys: picked.slice(), noRemote: false };
    if (p && p.states && p.states.length) return { all: false, keys: profileKeys(p), noRemote: false };
    // A profile with no states that turned "U.S. remote" off still leaves the remote files out.
    return { all: true, keys: [], noRemote: !!(p && !p.remote) };
  }
  // With every state in scope, these files load first, so the first rows paint as fast as they did
  // when they were all the page loaded; the rest follow once a search or filter needs them.
  const FIRST_KEYS = [...BASELINE, "remote"];

  // ---------- the dashboard's filters in its address (U10, 2026-10-14) ----------
  // The filters are mirrored in the URL, so a copied link opens on the same list, and a page the browser
  // reloads on Back (when it can't keep it in its back-forward cache) comes back as it was left. The
  // names are the ones the landing pages already link with (field, state, company, new, stage, year,
  // paid), plus q, sort, sector, where, status, progress, eligible and citizen. Only what differs from the
  // student's own defaults is written, so the plain address stays plain and opens the same list as before.
  // Every value read is checked against what the dashboard can show; anything else is ignored.
  const FILTER_PARAMS = ["q", "field", "state", "company", "new", "stage", "year", "paid", "sector", "where", "status", "progress", "eligible", "citizen", "sort"];
  const SORTS = ["score", "new", "company", "comp"];
  const PROGRESS = ["none", "interested", "applied", "interviewing", "rejected", "offer", "auto"];
  // Preserve syntactically valid older/newer tags: dropping one would broaden a shared search.
  // Bound parsing while allowing the entire current picker (66 tags), with room for vocabulary growth.
  function fieldsFromUrl(value) {
    if (!value || value.length > 8192) return [];
    return [...new Set(value.split(",").filter(v => /^[a-z_]{2,32}$/.test(v)))].slice(0, 128);
  }
  function filtersFromUrl(search) {
    // was (in app.js fromLink): field, state, company, new, stage, year and paid=1 only.
    const q = new browser.URLSearchParams(search || ""), list = (k, ok, max = 6) => (q.get(k) || "").split(",").filter(v => ok.test(v)).slice(0, max);
    // ?company= comes from an employer's page (every spelling its listings use) and matches names exactly;
    // ?state=all is the State picker's "Everywhere", from the pages that cover every state.
    const f = { fields: fieldsFromUrl(q.get("field")), states: list("state", /^(?:[A-Z]{2}|remote|Canada|all)$/, 80),
      company: q.getAll("company").filter(c => c && c.length <= 120).slice(0, 8) };
    if (q.get("new") === "1") f.new_only = true;
    const stage = q.get("stage"), year = q.get("year"), paid = q.get("paid"), text = q.get("q"), sort = q.get("sort"), sector = q.get("sector"),
      where = q.get("where"), status = q.get("status"), progress = q.get("progress"), citizen = q.get("citizen");
    if (stage && STAGES.some(([k]) => k === stage)) f.stage = stage;
    if (year && YEARS.some(([k]) => k === year)) f.year = year;
    if (paid === "1") f.paid = "paid"; else if (paid === "no_unpaid") f.paid = "no_unpaid"; else if (paid === "any") f.paid = "";
    if (text && text.trim()) f.q = text.slice(0, 200);
    if (SORTS.includes(sort)) f.sort = sort;
    if (sector && /^[a-z_]{2,40}$/.test(sector)) f.sector = sector;
    if (where === "onsite" || where === "remote") f.where = where;
    if (status === "closed") f.status = "closed"; else if (status === "any") f.status = "";
    if (PROGRESS.includes(progress)) f.app_state = progress;
    if (q.get("eligible") === "1") f.eligible = true;
    if (citizen === "hide") f.hide_citizen = true; else if (citizen === "show") f.hide_citizen = false;
    return f;
  }
  // [name, value] pairs for the filters in `f` that differ from `d` (the defaults: no search, nothing
  // picked, open postings, and the sort, pay and citizen settings the student's profile implies).
  function filterParams(f, d) {
    const out = [], text = String(f.q || "").trim();
    if (text) out.push(["q", text]);
    if (f.fields && f.fields.length) out.push(["field", f.fields.join(",")]);
    if (f.states && f.states.length) out.push(["state", f.states.join(",")]);
    (f.company || []).forEach(c => out.push(["company", c]));
    if (f.new_only) out.push(["new", "1"]);
    if (f.stage) out.push(["stage", f.stage]);
    if (f.year) out.push(["year", f.year]);
    if ((f.paid || "") !== (d.paid || "")) out.push(["paid", f.paid === "paid" ? "1" : f.paid || "any"]);
    if (f.sector) out.push(["sector", f.sector]);
    if (f.where) out.push(["where", f.where]);
    if (f.status !== "open") out.push(["status", f.status || "any"]);
    if (f.app_state) out.push(["progress", f.app_state]);
    if (f.eligible) out.push(["eligible", "1"]);
    if (!!f.hide_citizen !== !!d.hide_citizen) out.push(["citizen", f.hide_citizen ? "hide" : "show"]);
    if (f.sort && f.sort !== d.sort) out.push(["sort", f.sort]);
    return out;
  }
  // The address's query with the filter names replaced by `f`; other names (admin, utm_source...) are kept
  // in their place. Commas stay commas, as the landing pages write them.
  function filterSearch(search, f, d) {
    const q = new browser.URLSearchParams(search || "");
    FILTER_PARAMS.forEach(k => q.delete(k));
    const mine = filterParams(f, d).map(([k, v]) => k + "=" + encodeURIComponent(v).replace(/%2C/gi, ",")).join("&");
    const s = [q.toString(), mine].filter(Boolean).join("&");
    return s ? "?" + s : "";
  }
  // The files to load, in order: `first` (a place named in the search, then the first files or the
  // scoped ones) and `rest` (the remaining states, only once `everything` is asked for).
  function loadPlan(scope, indexKeys, queryKeys, everything) {
    const uniq = a => [...new Set(a)];
    if (!scope.all) return { first: uniq([...queryKeys, ...scope.keys]), rest: [] };
    const all = (indexKeys || []).filter(k => !(scope.noRemote && (k === "remote" || k === "US")));
    const first = uniq([...queryKeys, ...FIRST_KEYS.filter(k => all.includes(k))]);
    return { first, rest: everything ? all.filter(k => !first.includes(k)) : [] };
  }
  // was: every picked state. The Worker's /demand accepts US codes only until it is redeployed with the
  // provinces, and one code it refuses fails the whole save, so provinces stay on this device for now.
  // was: .filter(s => US_STATES[s]). The Worker accepts province codes since 2026-10-01; "Canada" (the
  // file of roles naming no province) is not a place to scan, so it stays on this device.
  const demandStates = p => [...(p.states || []).filter(s => US_STATES[s] || CA_PROVINCES[s]), ...(p.remote ? ["REMOTE"] : [])];
  // A Canadian role is usually open only to people allowed to work in Canada, which a US student
  // generally is not without a permit. The card says so rather than leave it to the posting.
  const inCanadaOnly = x => { const r = regs(x); return r.length > 0 && r.every(g => g.kind === "canada"); };
  const isRemote = x => !!x.is_remote || regs(x).some(g => g.kind === "remote" || g.remote || REMOTE_RE.test(g.loc || ""));
  const realSalary = x => {
    // 2026-10-23: was zero-only. Match backend/pay.py without inventing pay.
    // Revert: restore the zero-only check here and in backend/pay.py together.
    const s = String(x.salary || "").trim(), nums = (s.match(/\d[\d,]*(?:\.\d+)?\s*[kK]?/g) || []).map(n => Number(n.replace(/[,kK\s]/g, "")) * (/[kK]\s*$/.test(n) ? 1000 : 1));
    const tinyAnnual = /\$/.test(s) && /\b(year|yr|annum|annual|annually)\b/i.test(s) && nums.length && Math.max(...nums) < 1000;
    const negative = /^\s*(?:(?:USD|CAD|US|CA)\s*)?-\s*\$|\$\s*-\s*\d/i.test(s);
    return s && !negative && (!nums.length || (nums[0] !== 0 && !tinyAnnual)) ? s : "";
  };

  return {
    C, DAY, US_STATES, CA_PROVINCES, CANADA_KEYS, isCanadaKey, BASELINE, REGION_SHORTCUTS,
    YEARS, YEAR_LABEL, YEAR_PLURAL, STAGES, STAGE_LABEL, STAGE_DEFAULTS, upcomingTerms,
    TERMS, WORK_AUTH, fieldLabel, keyLabel, termText, ls, ss, PROFILE_KEY, emptyProfile,
    loadProfile, DELETED_KEY, saveProfile, profileDeleted, regs, shardKeys, profileKeys,
    ALL_KEY, viewScope, FIRST_KEYS, FILTER_PARAMS, filtersFromUrl, filterParams,
    filterSearch, loadPlan, demandStates, inCanadaOnly, isRemote, realSalary,
  };
}
