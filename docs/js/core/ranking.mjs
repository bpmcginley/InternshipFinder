// Listing search, selection and ranking.

export function createRanking(browser, { US_STATES, CA_PROVINCES, CANADA_KEYS, isRemote, regs, fieldLabel, STAGE_LABEL, realSalary, YEAR_PLURAL, termText, shardKeys, DAY }) {
  // ---------- search (moved here from app.js 2026-10-14, so it can be tested) ----------
  // Every word must appear; -word excludes; "quoted phrase" matches as a phrase. Place names (states,
  // provinces, "new england", "nyc", "remote") filter by location, and the words seen in a few
  // listings' locations ("boston") match anything but the description.
  const parseQuery = q => (q.match(/-?"[^"]+"|\S+/g) || []).map(t => { const neg = t.length > 1 && t[0] === "-"; return { t: (neg ? t.slice(1) : t).replace(/"/g, "").toLowerCase(), neg }; }).filter(x => x.t);
  const PLACES = { "new england": { states: ["MA", "CT", "RI", "NH", "VT", "ME"] }, "nyc metro": { kind: "nyc_metro" }, "new york city": { kind: "nyc_metro" }, nyc: { kind: "nyc_metro" }, remote: { kind: "remote" } };
  Object.entries(US_STATES).forEach(([c, n]) => { PLACES[n.toLowerCase()] = { states: [c] }; });
  Object.entries(CA_PROVINCES).forEach(([c, n]) => { PLACES[n.toLowerCase()] = { states: [c] }; });
  PLACES.canada = { states: CANADA_KEYS };
  ["ma", "ct", "ri", "nh", "vt", "nj", "ny", "ca", "tx", "fl", "nv", "wa", "il", "ga", "nc", "az", "dc", "mi", "mn", "md", "pa", "va", "tn"].forEach(c => { PLACES[c] = { states: [c.toUpperCase()] }; });
  const PLACE_KEYS = Object.keys(PLACES).sort((a, b) => b.length - a.length);
  function splitPlaces(q) {
    const places = []; let rest = " " + q + " ";
    for (const k of PLACE_KEYS) {
      const re = new RegExp(`\\s(-?)${k.replace(/[-.]/g, "\\$&")}(?=\\s)`, "gi");
      rest = rest.replace(re, (m, neg) => { places.push({ ...PLACES[k], neg: !!neg }); return " "; });
    }
    return { rest, places };
  }
  // The data files a place in the search lives in (2026-10-14). was: none, so "nursing alabama" looked
  // only through the files already loaded (the Northeast) and found nothing while 18 existed.
  const PLACE_KIND_KEYS = { nyc_metro: ["NY", "NJ", "CT"], remote: ["remote"] };
  const queryKeys = q => [...new Set(splitPlaces(q || "").places.filter(pl => !pl.neg).flatMap(pl => pl.states || PLACE_KIND_KEYS[pl.kind] || []))];
  const placeHit = (x, pl) => pl.kind === "remote" ? isRemote(x) : regs(x).some(g => pl.kind ? g.kind === pl.kind : pl.states.includes(g.state));
  const NOT_PLACE = new Set(["new", "city", "north", "south", "east", "west", "park", "hill", "hills", "beach", "heights", "falls", "center", "village", "island", "lake", "port", "united", "states", "usa", "hybrid", "office", "onsite", "the", "and", "area", "metro", "county", "greater",
    // words the boards put in a "location" that are not places
    "home", "work", "from", "remote", "headquarters", "campus", "corporate", "global", "site", "main", "street", "plant", "laboratory", "lab", "hospital", "university", "college", "school", "medical", "health", "nursing", "research", "science", "technology", "building", "floor", "suite"]);
  const locText = x => [...regs(x).map(g => g.loc), x.location_raw || ""].join(" \n ").toLowerCase();
  // Words seen in at least three listings' locations ("boston", "austin").
  function placeWords(rows) {
    const seen = new Map();
    for (const x of rows) new Set(locText(x).split(/[^a-z]+/)).forEach(t => { if (t.length >= 3 && !NOT_PLACE.has(t)) seen.set(t, (seen.get(t) || 0) + 1); });
    const words = new Set(); seen.forEach((n, t) => { if (n >= 3) words.add(t); });
    return words;
  }

  // Matching by word start, ranked by where a word matched (2026-10-14). was: each word a substring of
  // one long text that included the description, and the list sorted by date alone, so "cs" matched
  // 994 roles through "physics" and "analytics", "nurse" (28) and "nursing" (11) found different sets,
  // and 7 of the top 20 for "software" had software in the title or field.
  // Text is lowercased, accents and punctuation become spaces (c++ and c# keep theirs), and each part
  // is padded with spaces so " word" finds a word start.
  const norm = s => " " + String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim() + " ";
  // Light stemming, so one word finds its other forms by prefix: nurse, nurses, nursing -> "nurs";
  // engineering -> "engineer"; finance -> "financ" (financial); biology -> "biolog" (biological).
  // Five letters or more, and never shorter than four ("sales" stays "sales").
  function stem(t) {
    if (t.length < 5 || /[^a-z]/.test(t)) return t;
    const s = t.replace(/(?:ings?|ies|es|ed|(?<!s)s|e|y)$/, "");
    return s.length >= 4 ? s : t;
  }
  // Short forms students type, also searched as what they stand for. "cs" includes the Software field
  // (tag "swe"), which every computer science role carries.
  const ALIASES = { cs: ["computer science", "swe"], swe: ["software engineer"], ml: ["machine learning"], ai: ["artificial intelligence"],
    ux: ["user experience"], ui: ["user interface"], hr: ["human resources"], ee: ["electrical engineer"],
    pm: ["product manag", "program manag", "project manag"], rn: ["registered nurse"], bsn: ["nursing"] };
  // The " word" needles for one search word. `exact` is the word as typed, `loose` its stem or a looser
  // prefix, which counts for less: "marketing" puts Marketing roles ahead of "Capital Markets", while
  // "nurse" still finds Nursing. Two letters match only a whole word, so "cs" is no longer inside
  // "physics"; three letters match a whole word or its plural first ("art", "arts") and a longer word
  // only loosely ("artificial").
  function needles(t) {
    let exact, loose = [];
    if (t.includes(" ")) exact = [" " + t];
    else if (t.length <= 2) exact = [" " + t + " "];
    else if (t.length === 3) { exact = [" " + t + " ", " " + t + "s "]; loose = [" " + t]; }
    else { exact = [" " + t]; const st = stem(t); if (st !== t) loose = [" " + st]; }
    for (const a of ALIASES[t] || []) exact.push(" " + a + (a.length <= 3 ? " " : ""));
    return { exact, loose };
  }
  const hit = (s, ns) => { for (const n of ns) if (s.includes(n)) return true; return false; };
  // A listing's searchable text, by part, kept beside the row (a WeakMap, so it goes with the row).
  const SX = new WeakMap();
  function sx(x) {
    let s = SX.get(x);
    if (!s) {
      const tags = x.field_tags || [];
      s = {
        title: norm(x.title),
        field: norm(tags.map(t => t + " " + fieldLabel(t)).join(" ")),
        company: norm(x.company_name),
        meta: norm([(x.stage || []).join(" "), (x.stage || []).map(st => STAGE_LABEL[st] || "").join(" "), x.sector, locText(x), (x.region_locations || []).join(" "),
          x.state, x.term, x.ats, ((x.insights || {}).skills || []).map(k => k.name).join(" ")].filter(Boolean).join(" ")),
        descSrc: null, desc: " ",
      };
      SX.set(x, s);
    }
    // The description arrives later, from a sidecar file (createStore().descs).
    if (s.descSrc !== (x.description || "")) { s.descSrc = x.description || ""; s.desc = norm(s.descSrc); }
    return s;
  }
  // Where a word matched, best first. A word as typed scores its part's weight; matched only by its
  // stem, 3 less (never under 1). Matching in both the title and a field tag adds 1.
  const PARTS = [["title", 10], ["field", 8], ["company", 6], ["meta", 4], ["desc", 2]];
  function termScore(s, tm) {
    let best = 0, title = false, field = false;
    for (const [part, w] of PARTS) {
      if (part === "desc" && (tm.place || best)) break;
      const text = s[part];
      const v = hit(text, tm.ns.exact) ? w : tm.ns.loose.length && hit(text, tm.ns.loose) ? Math.max(1, w - 3) : 0;
      if (v) { if (part === "title") title = true; if (part === "field") field = true; if (v > best) best = v; }
    }
    return best ? best + (title && field ? 1 : 0) : 0;
  }
  // `words`: placeWords() of the loaded rows. Returns null for an empty search.
  function compileQuery(q, words) {
    if (!q || !q.trim()) return null;
    const { places, rest } = splitPlaces(q);
    const terms = parseQuery(rest).map(({ t, neg }) => {
      const n = norm(t).trim();
      return n ? { neg, place: !!(words && words.has(n)), ns: needles(n) } : null;
    }).filter(Boolean);
    return { places, terms };
  }
  // 0 when the listing doesn't match. Otherwise how well it does, higher first: 100 times the weakest
  // word's score plus all of them, so a role with every word in its title beats one with a word only in
  // the description. A search of place names only (or none) gives every match 1, so the sort decides.
  function matchScore(x, cq) {
    if (!cq) return 1;
    for (const pl of cq.places) if (placeHit(x, pl) === pl.neg) return 0;
    const s = cq.terms.length ? sx(x) : null;
    let min = Infinity, sum = 0, any = false;
    for (const tm of cq.terms) {
      const v = termScore(s, tm);
      if (tm.neg) { if (v) return 0; continue; }
      if (!v) return 0;
      if (tm.place) continue;
      any = true; if (v < min) min = v; sum += v;
    }
    return any ? min * 100 + sum : 1;
  }

  const applicationBatch = (list, max = 100) => {
    const unique = [...new Map(list.filter(x => x.apply_url).map(x => [String(x.id), x])).values()];
    return { batch: unique.slice(0, max), remaining: unique.slice(max) };
  };
  const queuedListingIds = (ids, queue) => ids.map(id => queue && queue.jobs && queue.jobs[id]).filter(j => j && j.listingId != null).map(j => String(j.listingId));
  // The rows of a batch the extension took care of: added, or skipped because a job already holds the
  // same listing or the same apply link (extension/background/queue.js addJobs). 85 apply links are
  // shared by two or more listings; matching on the listing id alone left the second one selected for
  // good. Answers listing ids as strings.
  function handledListingIds(batch, res, queue) {
    const jobs = (queue && queue.jobs) || {};
    const held = [...((res && res.added) || []), ...((res && res.skipped) || [])].map(id => jobs[id]).filter(Boolean);
    const ids = new Set(held.filter(j => j.listingId != null).map(j => String(j.listingId)));
    const urls = new Set(held.map(j => j.apply_url).filter(Boolean));
    return batch.filter(r => ids.has(String(r.id)) || (r.apply_url && urls.has(r.apply_url))).map(r => String(r.id));
  }
  // Apply links held by a queued, running or finished job. The extension skips a listing with one of
  // these, so the header checkbox leaves it alone.
  const heldUrls = queue => new Set(Object.values((queue && queue.jobs) || {}).filter(j => j && j.apply_url && j.status !== "failed").map(j => j.apply_url));

  // ---------- selecting rows for Auto-Apply ----------
  const SELECT_MAX = 100;
  // The header checkbox. Checked when it has nothing left to add: every shown row that can be picked is
  // picked, or the selection is full and holds some of them. was: checked only when the first 100
  // shown were all picked, which stayed false once a row picked further down filled the selection, so
  // a click could never clear it.
  const headerChecked = (selectable, sel, max = SELECT_MAX) => selectable.length > 0
    && (selectable.every(r => sel.has(r.id)) || (sel.size >= max && selectable.some(r => sel.has(r.id))));
  // A header click: add the shown rows up to the limit, or take them all off.
  function selectRows(sel, selectable, on, max = SELECT_MAX) {
    const n = new Set(sel); let omitted = 0;
    selectable.forEach(r => { if (!on) n.delete(r.id); else if (n.has(r.id) || n.size < max) n.add(r.id); else omitted++; });
    return { sel: n, omitted };
  }

  // ---------- list order ----------
  // The list's sort, with each row's keys worked out once instead of in every comparison. On a slowed
  // CPU the old comparators (two score lookups and up to two localeCompare calls each, hundreds of
  // thousands of calls for 28,000 rows) took most of the time spent as each state's file landed.
  // The order is the same as before (tests/site/core.test.mjs checks it against the old comparators
  // on the real data):
  //  - the same expressions on the same values, and Array.prototype.sort is stable;
  //  - posted_at and first_seen are ISO 8601 text, where localeCompare and plain comparison agree;
  //  - company names go through one Intl.Collator, which is what localeCompare uses with no arguments.
  // Sorts `list` in place and returns it, like Array.prototype.sort.
  let collator = null;
  const textCmp = (a, b) => (collator || (collator = new Intl.Collator())).compare(a, b);
  const codeCmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function sortRows(list, sort, scoreOf, rel) {
    if (!["score", "new", "company", "comp"].includes(sort)) return list;
    const d = list.map(x => {
      const s = sort === "company" ? null : scoreOf(x);
      return {
        x, mm: s && s.mismatch, sc: s && s.score, rel: rel ? rel.get(x) : 0,
        dated: x.posted_at ? 1 : 0, pa: x.posted_at || "", fs: x.first_seen || "",
        pay: sort === "comp" && realSalary(x) ? 1 : 0, co: x.company_name,
      };
    });
    const R = (a, b) => rel ? b.rel - a.rel : 0;
    const newer = (a, b) => (b.dated - a.dated) || codeCmp(b.pa, a.pa) || codeCmp(b.fs, a.fs);
    if (sort === "score") d.sort((a, b) => (a.mm - b.mm) || R(a, b) || (b.sc - a.sc) || newer(a, b));
    else if (sort === "new") d.sort((a, b) => (a.mm - b.mm) || R(a, b) || newer(a, b));
    else if (sort === "company") d.sort((a, b) => textCmp(a.co, b.co));
    else d.sort((a, b) => (b.pay - a.pay) || R(a, b) || b.sc - a.sc);
    for (let i = 0; i < d.length; i++) list[i] = d[i].x;
    return list;
  }

  // The dashboard's list (2026-10-14, B2 plan section 5): every search word, filter and the chosen sort,
  // applied to the rows in view. Moved here from app.js unchanged, so it can be tested on its own
  // (tests/site/core.test.mjs checks it against the old inline code). It reads only its three arguments:
  //   inView: the loaded rows the scope covers; f: the filters (app.js `f`);
  //   env: { cq, scoreOf, p, elig, blockers, appStates, jobs }: the compiled search (or null), the
  //   memoised IS.score, the saved profile, the eligibility profile, app.js blockers(), the student's own
  //   marks and the Auto-Apply jobs by listing id.
  // Returns { rows, rel, ranked }: the list in order; each row's search relevance (a Map, or null with no
  // search); and whether the search has words to rank by.
  // was (app.js): const ranked = ...; const rows = useMemo(() => { ... IS.sortRows(...); return r; }, [...]);
  function listRows(inView, f, env) {
    const { cq, scoreOf, p, elig, blockers, appStates, jobs } = env;
    const st = id => appStates[id] || "none";
    const ranked = !!(cq && cq.terms.some(t => !t.neg && !t.place));
    let r, rel = null;
    if (cq) { rel = new Map(); r = []; for (const x of inView) { const m = matchScore(x, cq); if (m) { rel.set(x, m); r.push(x); } } }
    else r = inView.slice();
    if (f.company.length) r = r.filter(x => f.company.includes(x.company_name));
    if (f.fields.length) r = r.filter(x => (x.field_tags || []).some(t => f.fields.includes(t)));
    if (f.where === "onsite") r = r.filter(x => regs(x).some(g => g.kind !== "remote"));
    else if (f.where === "remote") r = r.filter(isRemote);
    if (f.stage) r = r.filter(x => (x.stage || []).includes(f.stage));
    if (f.year) r = r.filter(x => !(x.years && x.years.length) || x.years.includes(f.year));
    if (f.sector) r = r.filter(x => x.sector === f.sector);
    if (f.paid === "paid") r = r.filter(x => ["paid", "stipend"].includes(payOf(x)));
    else if (f.paid === "no_unpaid") r = r.filter(x => payOf(x) !== "unpaid");
    if (f.hide_citizen) r = r.filter(x => !citizenBlocked(x, p ? p.work_auth : ""));
    if (f.eligible && elig) r = r.filter(x => !scoreOf(x).mismatch && !blockers(x, elig).length);
    // Looking at your own applications: a posting that has since closed still belongs in the list.
    if (f.status && !f.app_state) r = r.filter(x => x.status === f.status);
    if (f.new_only) r = r.filter(x => x.is_new);
    if (f.app_state === "auto") r = r.filter(x => jobs[String(x.id)]);
    else if (f.app_state) r = r.filter(x => st(x.id) === f.app_state);
    // The order: newest first means dated postings first, newest first. first_seen is only the scan
    // that found the row, which is today for nearly everything, so using it for undated rows put every
    // undated posting on top. A search ranks by how well each role matches it, with the chosen sort as
    // the tiebreak.
    sortRows(r, f.sort, scoreOf, ranked ? rel : null);
    return { rows: r, rel, ranked };
  }

  // ---------- eligibility helpers ----------
  const restr = x => x.restrictions || [];
  const citizenRule = x => restr(x).includes("us_citizen_only") ? "citizen" : ((x.insights || {}).citizenship || null);
  const noSponsorship = x => restr(x).includes("no_sponsorship") || !!(x.insights || {}).no_sponsorship;
  const payOf = x => {
    const r = restr(x).find(t => t === "paid" || t === "unpaid" || t === "stipend");
    return r || (x.insights || {}).pay || (realSalary(x) ? "paid" : null);
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

  // ctx = {p, direct, related, keys:Set, anywhere?}
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
    // ctx.anywhere (2026-10-14): no states picked, so no place is preferred. was: the baseline states
    // scored full marks and every other state .3, for a student who never chose the Northeast.
    if (ctx.anywhere) location = 1;
    else for (const k of ks) {
      if (k !== "remote" && k !== "US" && ctx.keys.has(k)) { location = 1; break; }
      if ((k === "remote" || k === "US") && ctx.keys.has(k)) location = Math.max(location, .8);
    }

    // Counted from the day the employer posted it, not the day we found it: 2,800 open listings
    // were first seen more than the whole 21-day window after they were posted, and 568 of those
    // more than six months after, so a job posted in March scored as new. With no posting date the
    // age is unknown, which is worth the same .5 a listing with no date at all has always been
    // worth; giving it the benefit of first_seen would rank the boards that withhold the date
    // above the ones that publish it. Keep this in step with _freshness() in backend score.py.
    const postedAt = x.posted_at ? new browser.Date(x.posted_at).getTime() : NaN;
    const seen = x.first_seen ? new browser.Date(x.first_seen).getTime() : NaN;
    const decay = t => Math.max(0, 1 - (browser.Date.now() - t) / DAY / 21);
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

  return {
    parseQuery, splitPlaces, queryKeys, placeWords, stem, compileQuery, matchScore,
    applicationBatch, queuedListingIds, handledListingIds, heldUrls, SELECT_MAX,
    headerChecked, selectRows, sortRows, listRows, citizenRule, noSponsorship, payOf,
    citizenBlocked, yearsFit, yearsText, WEIGHTS, PART_LABEL, profileFields, primaryField,
    termFit, score,
  };
}
