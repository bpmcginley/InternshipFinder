// InternScout dashboard UI. Plain JS with React.createElement (no build step, no Babel).
(function () {
  "use strict";
  const { useState, useEffect, useMemo, useRef, useCallback } = React;
  const h = React.createElement, F = React.Fragment;
  const IS = window.IS, C = IS.C;
  const ADMIN = new URLSearchParams(location.search).get("admin") === "1";

  const LS_KEY = "internscout.appstate.v1", SAVED_KEY = "internscout.saved.v1", LANDING_KEY = "internscout.landing.seen.v1", SKIP_KEY = "internscout.setup.skipped.v1", MORE_KEY = "internscout.filters.more.v1";
  const APP_STATES = ["none", "interested", "applied", "interviewing", "rejected", "offer"];
  const STATE_LABEL = { none: "Not started", interested: "Interested", applied: "Applied", interviewing: "Interviewing", rejected: "Rejected", offer: "Offer" };
  const JOB_LABEL = { queued: "Queued", working: "Agent working", needs_you: "Needs you", ready_to_submit: "Ready to submit", submitted: "Submitted", failed: "Failed" };
  const ATS = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday", smartrecruiters: "SmartRecruiters", icims: "iCIMS", icims_site: "iCIMS", oracle: "Oracle", bamboohr: "BambooHR", workable: "Workable", taleo: "Taleo" };
  const ACTIVE = ["queued", "working", "needs_you", "ready_to_submit"];
  const PAGE = 150;
  // Descriptions run about 1 KB per open listing. Up to this many open listings they are downloaded
  // without asking (the eight default states and remote are about 3,200).
  const DESC_AUTO = 5000;

  const DAY = IS.DAY;
  const daysAgo = iso => { if (!iso) return null; const t = new Date(iso).getTime(); return isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / DAY)); };
  const ago = n => n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
  const fmtDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const daysUntil = d => Math.ceil((new Date(d + "T23:59:59").getTime() - Date.now()) / DAY);
  const shortDate = iso => { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const cx = (...a) => a.filter(Boolean).join(" ");
  const prevent = fn => e => { e.preventDefault(); fn(e); };

  // ---------- search ----------
  // Every word must appear; -word excludes; "quoted phrase" matches exactly. Place words (city or state
  // names seen in a few listings' locations) match the location, company and title, not the description.
  const parseQuery = q => (q.match(/-?"[^"]+"|\S+/g) || []).map(t => { const neg = t.length > 1 && t[0] === "-"; return { t: (neg ? t.slice(1) : t).replace(/"/g, "").toLowerCase(), neg }; }).filter(x => x.t);
  const PLACES = { "new england": { states: ["MA", "CT", "RI", "NH", "VT", "ME"] }, "nyc metro": { kind: "nyc_metro" }, "new york city": { kind: "nyc_metro" }, nyc: { kind: "nyc_metro" }, remote: { kind: "remote" } };
  Object.entries(IS.US_STATES).forEach(([c, n]) => { PLACES[n.toLowerCase()] = { states: [c] }; });
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
  const NOT_PLACE = new Set(["new", "city", "north", "south", "east", "west", "park", "hill", "hills", "beach", "heights", "falls", "center", "village", "island", "lake", "port", "united", "states", "usa", "hybrid", "office", "onsite", "the", "and", "area", "metro", "county", "greater",
    // words the boards put in a "location" that are not places
    "home", "work", "from", "remote", "headquarters", "campus", "corporate", "global", "site", "main", "street", "plant", "laboratory", "lab", "hospital", "university", "college", "school", "medical", "health", "nursing", "research", "science", "technology", "building", "floor", "suite"]);
  const locHay = x => x._loch || (x._loch = [...IS.regs(x).map(g => g.loc), x.location_raw || ""].join(" \n ").toLowerCase());
  const placeHay = x => x._plach || (x._plach = [locHay(x), x.company_name, x.title].filter(Boolean).join(" | ").toLowerCase());
  const hay = x => x._hay || (x._hay = [x.company_name, x.title, (x.field_tags || []).join(" "), (x.stage || []).join(" "), x.sector, x.location_raw, (x.region_locations || []).join(" "), (x.regions || []).map(g => g.loc).join(" "), x.state, x.term, x.ats, x.description, ((x.insights || {}).skills || []).map(s => s.name).join(" ")].filter(Boolean).join(" \n ").toLowerCase());

  // ---------- eligibility and deadline: [level, text], level bad | warn | good | "" ----------
  function checks(r, p) {
    const x = r.insights || {}, out = [];
    if (x.grad_years) {
      const lo = Math.min(...x.grad_years), hi = Math.max(...x.grad_years), gy = p && p.grad_year, t = lo === hi ? `Graduating in ${lo}` : `Graduating ${lo}–${hi}`;
      out.push(gy ? (gy >= lo && gy <= hi ? ["good", t] : ["bad", `${t} (you: ${gy})`]) : ["", t]);
    }
    if (r.years && r.years.length) {
      const t = `For ${IS.yearsText(r.years)}`, cy = p && p.class_year;
      out.push(cy ? (r.years.includes(cy) ? ["good", t] : ["bad", `${t} (you: ${IS.YEAR_LABEL[cy] || cy})`]) : ["", t]);
    } else if (x.class_standing) out.push(["", `For ${x.class_standing.join(" or ")} students`]);
    const cit = IS.citizenRule(r);
    if (cit) {
      const t = cit === "citizen" ? "U.S. citizens only" : "U.S. citizens or permanent residents only", c = p && p.citizenship;
      // "U.S. permanent resident" and "needs a U.S. visa" both contain "U.S.", so rule those out first.
      const resident = /permanent|green card|lawful/i.test(c || "");
      const notCitizen = resident || /visa|\bf-?1\b|\bj-?1\b|\bh-?1b?\b|\bopt\b|\bcpt\b|international|non-?citizen|not a (u\.?\s?s\.? )?citizen/i.test(c || "");
      const citizen = !notCitizen && /\bu\.?\s?s\.?a?\b|united states|american/i.test(c || "");
      const ok = citizen || (cit !== "citizen" && resident);
      out.push(c ? [ok ? "good" : "bad", t] : ["warn", t]);
    }
    if (x.clearance || (r.restrictions || []).includes("clearance")) out.push(["warn", "Needs a security clearance"]);
    if (x.degree_only) {
      const t = x.degree_only === "phd" ? "PhD students only" : "Master's students only";
      out.push(p && p.degree ? [(x.degree_only === "phd" ? /ph\.?d|doctor/i : /master|m\.s\.|m\.eng|mba/i).test(p.degree) ? "good" : "bad", t] : ["warn", t]);
    }
    if (x.gpa_min) { const g = p && p.gpa; out.push(g ? [g >= x.gpa_min ? "good" : "bad", `Minimum GPA ${x.gpa_min} (you: ${g})`] : ["", `Minimum GPA ${x.gpa_min}`]); }
    if (IS.noSponsorship(r)) out.push([p && p.needs_sponsorship && p.needs_sponsorship !== "No" ? "bad" : "", "No visa sponsorship"]);
    const pay = IS.payOf(r);
    if (pay === "unpaid") out.push(["warn", "Unpaid"]); else if (pay === "stipend") out.push(["", "Stipend"]);
    if (x.deadline) { const d = daysUntil(x.deadline); out.push(d < 0 ? ["bad", `Deadline passed (${fmtDay(x.deadline)})`] : [d <= 14 ? "warn" : "", `Apply by ${fmtDay(x.deadline)}${d <= 14 ? ` (${plural(d, "day")} left)` : ""}`]); }
    return out;
  }
  const blockers = (r, p) => checks(r, p).filter(c => c[0] === "bad").map(c => c[1]);

  // ---------- extension ----------
  const same = next => prev => { try { return JSON.stringify(prev) === JSON.stringify(next) ? prev : next; } catch (e) { return next; } };
  function useExtension() {
    const [info, setInfo] = useState({ checked: false, installed: false });
    const [queue, setQueue] = useState({ order: [], jobs: {} });
    const [profile, setProfile] = useState(null);
    // The ping repeats every 20 s and nearly always brings back what we already have. Keeping the old
    // object when nothing changed lets React skip the render; without it the whole page, table
    // included, was redrawn three times every 20 s.
    const ping = useCallback(async () => {
      const r = await IS.ext.call({ type: "ping" }, 1500);
      if (r && r.error === "reload_page") { setInfo(same({ checked: true, installed: false, stale: true })); return; }
      if (r && r.ok) {
        setInfo(same({ checked: true, installed: true, ...r }));
        const q = await IS.ext.call({ type: "get_queue" }); if (q && q.queue) setQueue(same(q.queue));
        if (r.onboarded) { const p = await IS.ext.call({ type: "get_profile_summary" }); if (p && !p.error) setProfile(same(p)); }
      } else setInfo(same({ checked: true, installed: false }));
    }, []);
    useEffect(() => {
      const off = IS.ext.on(d => {
        if (d.__internscout === "push" && d.queue) setQueue(same(d.queue));
        if (d.__internscout === "hello") ping();
        if (d.__internscout === "gone") setInfo({ checked: true, installed: false, stale: true });
      });
      ping();
      const t = setInterval(() => { if (document.visibilityState === "visible") ping(); }, 20000);
      return () => { off(); clearInterval(t); };
    }, [ping]);
    return { info, queue, profile };
  }

  // ---------- small components ----------
  function MultiSelect({ placeholder, options, selected, onChange, label, wide }) {
    const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [act, setAct] = useState(0);
    const ref = useRef();
    useEffect(() => {
      const hd = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener("mousedown", hd); return () => document.removeEventListener("mousedown", hd);
    }, []);
    const byVal = useMemo(() => new Map(options.map(o => [o.value, o])), [options]);
    const avail = options.filter(o => !selected.includes(o.value));
    const ql = q.toLowerCase();
    const filtered = (q ? avail.filter(o => (o.label || o.value).toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql)) : avail).slice(0, 60);
    const add = v => { onChange([...selected, v]); setQ(""); setAct(0); };
    const rm = v => onChange(selected.filter(x => x !== v));
    const onKey = e => {
      if (e.key === "Enter" && filtered[act]) { add(filtered[act].value); e.preventDefault(); }
      else if (e.key === "ArrowDown") { setAct(a => Math.min(a + 1, filtered.length - 1)); setOpen(true); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setAct(a => Math.max(a - 1, 0)); e.preventDefault(); }
      else if (e.key === "Escape") setOpen(false);
      else if (e.key === "Backspace" && !q && selected.length) rm(selected[selected.length - 1]);
    };
    return h("div", { className: cx("field ms", wide && "wide"), ref },
      h("div", { className: "box", onClick: () => setOpen(true) },
        selected.map(s => { const o = byVal.get(s); return h("span", { key: s, className: "chip" }, (o && (o.chip || o.label)) || s,
          h("button", { type: "button", "aria-label": "Remove " + s, onClick: e => { e.stopPropagation(); rm(s); } }, "×")); }),
        h("input", { value: q, "aria-label": label || placeholder, placeholder: selected.length ? "" : placeholder,
          onChange: e => { setQ(e.target.value); setOpen(true); setAct(0); }, onFocus: () => setOpen(true), onKeyDown: onKey })),
      open && filtered.length > 0 && h("div", { className: "drop", role: "listbox" },
        filtered.map((o, i) => h("div", { key: o.value, role: "option", "aria-selected": i === act, className: cx("opt", i === act && "act"),
          onMouseDown: e => { e.preventDefault(); add(o.value); }, onMouseEnter: () => setAct(i) },
          h("span", null, o.label || o.value), o.count != null ? h("span", { className: "c" }, o.count) : o.hint ? h("span", { className: "c" }, o.hint) : null))));
  }

  const Sel = ({ label, value, onChange, children }) => h("div", { className: "field sel" },
    h("select", { "aria-label": label, value, onChange: e => onChange(e.target.value) }, children));
  const opt = (v, l) => h("option", { key: v, value: v }, l);

  function Loc({ r, keys }) {
    const all = IS.regs(r), g = all.find(x => keys.has(x.state) || (x.kind === "remote" && keys.has("remote"))) || all[0];
    const first = g ? g.loc : ((r.location_raw || "").split(";")[0].trim() || "—");
    const sub = g && g.kind === "remote" ? "Remote" : g && g.state && !first.includes(g.state) ? g.state : null;
    const more = Math.max(0, all.length - 1);
    return h(F, null,
      h("div", { title: all.map(x => x.loc).join("; ") }, first, more > 0 && h("span", { className: "muted" }, " +" + more)),
      sub && h("div", { className: "meta" }, sub));
  }

  function Why({ r, sc, ctx, elig, patterns }) {
    const W = IS.WEIGHTS, ins = r.insights || {};
    const has = useMemo(() => {
      if (!elig || !elig.skills_text || !patterns) return null;
      const m = {};
      for (const [n, p] of Object.entries(patterns)) { try { m[n] = new RegExp(p, "i").test(elig.skills_text); } catch (e) { } }
      return m;
    }, [elig, patterns]);
    const skills = ins.skills || [], req = skills.filter(s => s.level === "required"), pref = skills.filter(s => s.level === "preferred");
    const met = has ? req.filter(s => has[s.name]).length : 0;
    const posted = daysAgo(r.posted_at), seen = daysAgo(r.first_seen), cs = checks(r, elig);
    const tags = r.field_tags || [];
    const why = {
      field: !(ctx.direct.size || ctx.related.size) ? (ctx.p ? "No major or fields on your profile yet: any known field counts" : "No profile yet: any known field counts") : tags.some(t => ctx.direct.has(t)) ? "Matches your major or fields" : tags.some(t => ctx.related.has(t)) ? "Related to your major" : "Outside your fields",
      fit: sc.mismatch ? "Not open to your class year" : !ctx.p ? "" : `${(r.stage || []).map(s => IS.STAGE_LABEL[s] || s).join(", ") || "Stage unknown"} · ${IS.termText(r.term) || "term not listed"}`,
      location: "",
      freshness: posted != null ? "Counted from the day it was posted"
        : "No posting date given, so its age counts as unknown rather than new",
      openness: "", source: "",
    };
    const chip = s => h("span", { key: s.name, className: cx("tag", has && (has[s.name] ? "ok" : "miss")), title: has ? (has[s.name] ? "Found on your profile" : "Not on your profile") : "" }, has ? (has[s.name] ? "✓ " : "✗ ") : "", s.name);
    return h("div", { className: "whyg" },
      h("div", null, h("h4", null, `Match score ${sc.score} of 100`),
        Object.entries(IS.PART_LABEL).map(([k, l]) => {
          const w = W[k], v = sc.parts[k] || 0;
          return h("div", { className: "part", key: k, title: why[k] || "" }, h("span", null, l), h("span", { className: "bar" }, h("i", { style: { width: (w ? Math.min(100, v / w * 100) : 0) + "%" } })), h("span", { className: "num" }, `${Math.round(v)}/${w}`));
        }),
        h("div", { className: "meta", style: { marginTop: 9 } }, why.field, why.fit ? " · " + why.fit : ""),
        h("div", { className: "meta" }, posted != null ? `Posted ${ago(posted)}` : "Posting date not listed", seen != null ? ` · first seen ${ago(seen)}` : "", r.sector ? ` · ${IS.sectorLabel(r.sector)} sector` : "")),
      h("div", null, h("h4", null, "Skills asked for", has && req.length ? ` · you have ${met} of ${req.length} required` : ""),
        !skills.length && h("div", { className: "meta" }, r.status === "open" ? "No specific skills named in the description." : "Closed posting, so the description isn't kept."),
        req.length > 0 && h("div", null, req.map(chip)),
        pref.length > 0 && h(F, null, h("div", { className: "meta", style: { margin: "4px 0 5px" } }, "Nice to have"), h("div", null, pref.map(chip)))),
      h("div", null, h("h4", null, "Eligibility and deadline"),
        cs.length ? cs.map(([lv, t], i) => h("div", { key: i, className: "flag " + lv }, lv === "bad" ? "✗ " : lv === "good" ? "✓ " : lv === "warn" ? "! " : "· ", t))
          : h("div", { className: "meta" }, "No limits or deadline found in the description."),
        h("div", { className: "meta", style: { marginTop: 9 } }, h("a", { href: IS.reportUrl(r), target: "_blank", rel: "noopener" }, "Report a wrong tag or dead link"))));
  }

  // Memoised: ticking one checkbox or typing in the search box used to redraw all 150 rows.
  const Row = React.memo(function Row({ r, sc, ctx, keys, state, onState, job, checked, onCheck, canAuto, onAuto, open, onWhy, elig, patterns }) {
    const cls = sc.score >= 80 ? "hi" : sc.score >= 60 ? "mid" : "lo";
    const active = job && ACTIVE.includes(job.status);
    const dl = r.insights && r.insights.deadline;
    const meta = [shortDate(r.posted_at) && `Posted ${shortDate(r.posted_at)}`, dl && daysUntil(dl) >= 0 && `Apply by ${fmtDay(dl)}`, r.ats && r.ats !== "other" && (ATS[r.ats] || r.ats), r.carried && "Not re-checked this scan"].filter(Boolean).join(" · ");
    const bl = elig ? blockers(r, elig).filter(t => !/^For /.test(t)) : [];
    const tags = r.field_tags || [];
    const stages = (r.stage || []).filter(s => s !== "internship").map(s => IS.STAGE_LABEL[s] || s);
    const term = IS.termText(r.term);
    // Term now sits under the location, so the row has one column fewer.
    const cols = canAuto ? 8 : 7;
    // Two field tags is what a row can show without wrapping onto three lines; the rest are a count.
    const fieldText = tags.slice(0, 2).map(IS.fieldLabel).join(", ") + (tags.length > 2 ? ` +${tags.length - 2}` : "");
    return h(F, null,
      h("tr", { className: cx(checked && "sel", open && "opened", sc.mismatch && "dim") },
        canAuto && h("td", { className: "c-chk" }, h("input", { type: "checkbox", "aria-label": "Select " + r.company_name, checked,
          disabled: !r.apply_url || active || (job && job.status === "submitted"), onChange: e => onCheck(r.id, e.target.checked) })),
        h("td", { className: "c-co" },
          // was: h("div", { className: "co" }, r.company_name, r.is_new && h("span", { className: "new" }, "New")),
          // is_new only means we first saw the row inside the new-listing window; the export keeps
          // closed rows too, and 886 of the shard rows in the 2026-09-19 export were closed and still
          // carried is_new. That put a New badge on the same line as the posting's own "Closed" note.
          // A badge that says New has to mean new and still open.
          h("div", { className: "co" }, r.company_name, r.is_new && r.status === "open" && h("span", { className: "new" }, "New")),
          h("div", { className: "role" }, r.title),
          (meta || r.status === "closed") && h("div", { className: "meta" }, meta, r.status === "closed" && h("span", { className: "closed" }, (meta ? " · " : "") + "Closed")),
          sc.mismatch && h("div", { className: "meta" }, h("span", { className: "closed" }, `Not for your year: for ${IS.yearsText(r.years)}`)),
          bl.length > 0 && h("div", { className: "meta" }, h("span", { className: "closed", title: bl.join("; ") }, "May not be eligible: " + bl[0]))),
        h("td", { className: "c-field", title: tags.length > 2 ? tags.map(IS.fieldLabel).join(", ") : undefined }, tags.length ? fieldText : h("span", { className: "muted" }, "—"),
          (stages.length > 0 || r.sector) && h("div", { className: "meta" }, [...stages, r.sector && IS.sectorLabel(r.sector)].filter(Boolean).join(" · "))),
        h("td", { className: "c-loc" }, h(Loc, { r, keys }),
          (term || r.duration) && h("div", { className: "meta" }, [term, r.duration].filter(Boolean).join(" · "))),
        h("td", { className: "c-pay" }, r.salary ? h("span", { className: "num" }, r.salary) : IS.payOf(r) === "stipend" ? "Stipend" : IS.payOf(r) === "unpaid" ? h("span", { className: "closed" }, "Unpaid") : h("span", { className: "muted" }, "—")),
        h("td", { className: "c-match" }, h("button", { type: "button", className: "score whybtn " + cls, "aria-expanded": !!open, onClick: () => onWhy(r.id), title: `Match score ${sc.score} of 100. Click for why.` },
          h("span", { className: "num" }, sc.score), h("span", { className: "bar" }, h("i", { style: { width: Math.max(4, Math.min(100, sc.score)) + "%" } })), h("span", { className: "why-l" }, open ? "Hide why" : "Why"))),
        h("td", { className: "c-mine" },
          h("select", { className: "mine", "aria-label": "Your status", value: state, onChange: e => onState(r.id, e.target.value) }, APP_STATES.map(s => opt(s, STATE_LABEL[s]))),
          job && h("div", null, h("span", { className: "st " + job.status, title: job.reason || job.question || job.summary || "" }, JOB_LABEL[job.status] || job.status))),
        h("td", { className: "c-links" },
          r.apply_url ? h("a", { className: "open-link", href: r.apply_url, target: "_blank", rel: "noopener" }, "Open posting") : h("span", { className: "muted" }, "—"),
          !job && canAuto && r.apply_url && h("div", null, h("button", { type: "button", className: "rowbtn", onClick: () => onAuto([r]) }, "Auto-Apply")),
          h("div", null, h("a", { className: "report", href: IS.reportUrl(r), target: "_blank", rel: "noopener", title: "Wrong tag, dead link or not a student role? Tell us." }, "Report")))),
      open && h("tr", { className: "why" }, h("td", { colSpan: cols }, h(Why, { r, sc, ctx, elig, patterns }))));
  });

  // The list is filtered and re-sorted on every change to the search text, so the box keeps its own
  // text and hands it over once typing pauses instead of on every key.
  function SearchBox({ value, onChange }) {
    const [text, setText] = useState(value);
    const sent = useRef(value);
    useEffect(() => { if (value !== sent.current) { sent.current = value; setText(value); } }, [value]);
    useEffect(() => {
      if (text === sent.current) return;
      const t = setTimeout(() => { sent.current = text; onChange(text); }, 200);
      return () => clearTimeout(t);
    }, [text]);
    return h("input", { type: "text", "aria-label": "Search", placeholder: 'Search: nursing boston -unpaid "research assistant"', value: text,
      onChange: e => setText(e.target.value), onKeyDown: e => { if (e.key === "Enter") { sent.current = text; onChange(text); } } });
  }

  // ---------- landing ----------
  // was: function Landing({ open, setOpen, onSetup, hasProfile, nationwide }) {
  // `plans` is the Worker's /config payments.plans, so the prices shown here are the ones Stripe is
  // actually configured with rather than a second copy that can drift.
  // When closed it renders nothing: the "About InternScout" link lives in the header tagline, so
  // the page no longer carries a second strip of small print under the header just to hold it.
  function Landing({ open, setOpen, onSetup, hasProfile, nationwide, plans }) {
    if (!open) return null;
    return h("section", { className: "landing", "aria-label": "About InternScout" },
      h("div", { className: "landing-main" },
        h("h2", null, "Internships, co-ops and research for your major, anywhere in the US"),
        h("p", null, "InternScout gathers student opportunities from employer career sites and public job boards",
          nationwide ? ` (${nationwide.toLocaleString()} open right now)` : "", " and ranks them for your major, class year and the states you pick."),
        // was: h("p", { className: "fine" }, "Free, made by a UMass student, not affiliated with UMass Amherst.")),
        // Paid plans went live on 2026-09-19 (worker/wrangler.toml PAYMENTS_ENABLED = "1"), so a flat
        // "Free" is no longer true of the whole product. Search and this dashboard still are. The
        // price text comes from /config, and when /config hasn't answered yet we name no figure
        // rather than hardcode one that could go stale against Stripe.
        // was: h("p", { className: "fine" }, "Search and this dashboard are free, with no sign-in. The AI extras (Auto-Apply, tailored resumes, the Deep Dive) come with a free monthly allowance",
        // was:   plans && plans.length ? `; ${plans.map(pl => pl.label + (pl.price ? " " + pl.price : "")).join(" and ")} raise it` : "; optional paid plans raise it",
        // was:   ". Made by a UMass student, not affiliated with UMass Amherst.")),
        // The Deep Dive is out of the capped list: worker/src/config.js gives it `allowance: null`,
        // which config.js:10 defines as "no monthly cap", and worker/src/limits.js:106 returns null
        // for it one line before the plan multiplier, so no paid plan raises it. The same page
        // already says so the other way round - core.js allowanceText renders "Deep Dives:
        // unlimited" in the tooltip on this dashboard. The allowance itself is per account
        // (worker/src/index.js GET /me) and every /ai call signs the user in, so "on a free account"
        // keeps the "no sign-in" clause from being read across the whole sentence.
        h("p", { className: "fine" }, "Search and this dashboard are free, with no sign-in. Auto-Apply and tailored resumes come with a free monthly allowance on a free account",
          plans && plans.length ? `; ${plans.map(pl => pl.label + (pl.price ? " " + pl.price : "")).join(" and ")} raise it` : "; optional paid plans raise it",
        // was: ". The Deep Dive is one-time, runs on the same free account, and has no monthly cap. ..."
        // Two over-claims. "No monthly cap" was true only of the unit allowance: worker/src/config.js
        // says USER_BUDGET_CENTS "is what bounds a task with no unit cap (the Deep Dive)", and records
        // honest use reaching it. And nothing enforces "one-time": onboarding.js clears the run id when
        // a Dive finishes ("the next Deep Dive is a new run") and this same file offers an onboarded
        // student the button again, so it is a habit, not a limit.
          ". The Deep Dive has no monthly run allowance of its own, though a per-account AI budget still applies, and it runs on the same free account. Made by a UMass student, not affiliated with UMass Amherst.")),
      // The "Start in 3 steps" list that used to sit here repeated the setup card's own three
      // steps one screen higher. One copy, on the card, is enough.
      h("div", null, h("h3", null, "How it works"),
        h("ul", null,
          h("li", null, "A scanner checks employer career sites and public job boards several times a day and keeps only student roles."),
          h("li", null, "Your profile stays in this browser. Ranking happens on this page; nothing about you is uploaded."),
          h("li", null, "The optional extension fills in applications for you and always stops before Submit."),
          h("li", null, "Signing in with Google or Microsoft is optional. It lets your chosen states count toward where we scan in more detail.")),
        h("div", { className: "landing-actions" },
          h("button", { type: "button", className: "btn primary", onClick: onSetup }, hasProfile ? "Edit my profile" : "Set up your profile"),
          h("button", { type: "button", className: "btn quiet", onClick: () => setOpen(false) }, "Hide this"))));
  }

  // ---------- setup (3 steps) ----------
  const SEASONS = ["Spring", "Summer", "Fall", "Winter"];
  const GRAD_YEARS = Array.from({ length: 9 }, (_, i) => 2026 + i);

  // was: function Setup({ initial, majors, index, stats, firstTime, onSave, onClose, onDelete, signedIn }) {
  // statsReady says the stats.json fetch has settled. stats === null alone cannot tell "still
  // downloading" from "failed", and coverage() below words those two cases differently.
  function Setup({ initial, majors, index, stats, statsReady, firstTime, onSave, onClose, onDelete, signedIn }) {
    const [d, setD] = useState(() => ({ ...IS.emptyProfile(), ...(initial || {}) }));
    const [step, setStep] = useState(1);
    const [stagesTouched, setStagesTouched] = useState(!!(initial && initial.stages && initial.stages.length));
    const ref = useRef();
    useEffect(() => { if (ref.current) ref.current.scrollIntoView({ block: "start", behavior: "smooth" }); }, [step]);
    const set = (k, v) => setD(s => ({ ...s, [k]: v }));
    const toggle = (k, v) => setD(s => ({ ...s, [k]: s[k].includes(v) ? s[k].filter(x => x !== v) : [...s[k], v] }));

    const majorOpts = useMemo(() => ((majors && majors.majors) || []).map(m => ({ value: m.name, label: m.name, hint: m.level === "grad" ? "graduate" : "" })), [majors]);
    const minorOpts = useMemo(() => majorOpts.filter(o => !o.hint && !/Undeclared|BDIC/.test(o.value)), [majorOpts]);
    const fieldOpts = useMemo(() => {
      const fromMajors = majors && majors.fields ? majors.fields : null;
      const counts = (stats && stats.by_field) || {};
      const list = fromMajors || Object.keys(counts);
      return list.filter(t => t !== "other").map(t => ({ value: t, label: IS.fieldLabel(t), count: counts[t] != null ? counts[t] : undefined }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }, [majors, stats]);

    // What the numbers beside a field actually are. stats.json's by_field is built in
    // backend/internscout/export_static.py from rows where status == "open", one tally per field tag
    // on the listing, so it counts OPEN listings nationwide in the last scan, not everything ever
    // seen. A listing tagged both "swe" and "ml" is tallied under each, so adding a major's tags
    // together inflates the figure: in the export now in docs/data/stats.json (generated_at 2026-09-18)
    // swe 2,097 + ml 776 is not 2,873 distinct roles, and the export carries no way to take the union.
    // was: ...so the headline is the largest single tag and says so, rather than a sum that would
    // flatter us.  -- no longer what the code does. coverage() below heads on the student's OWN primary
    // tag when the export has it, and names the widest sibling beside it, because heading on the widest
    // tag showed a Nursing student "98 open listings tagged Health" and never the 16 tagged Nursing.
    // Still one tag's count, never a sum.
    const byField = (stats && stats.by_field) || null;
    const biggest = tags => { let best = null; for (const t of tags) { const n = byField && byField[t]; if (typeof n === "number" && (!best || n > best.n)) best = { tag: t, n }; } return best; };
    const nOpen = n => `${n.toLocaleString()} open listing${n === 1 ? "" : "s"}`;
    const mineFields = useMemo(() => IS.profileFields(d, majors), [d.majors, d.minors, d.fields, majors]);
    // The student's own tag (majors.json tags[0] of their first major, or the first field they picked
    // if their major carries no tags). mineFields.direct is a Set, so it can only be maximised, and
    // the maximum is a sibling tag: a Nursing student's direct set holds both nursing (16 open in
    // docs/data/stats.json, generated_at 2026-09-18) and health (98), and health is what a maximum
    // returns. See IS.primaryField in core.js.
    const primary = useMemo(() => IS.primaryField(d, majors), [d.majors, d.fields, majors]);
    // InternScout promises every major and keeps that promise, but the coverage behind it is lopsided:
    // was: // in the 2026-09-19 export swe has 2,097 open while nursing, museums, music and theater are in
    // in the export now in docs/data/stats.json (generated_at 2026-09-18) swe has 2,097 open while
    // nursing (16), museums (5), music (3) and theater (2) are in
    // single or double digits. Showing the student their own number in step 1, before they spend
    // three steps on a profile, means nobody is ambushed, and the figure rights itself as the
    // scanner's coverage grows. Below this many a bare number reads like a promise, so under it we
    // say plainly that the list is thin instead of leaving the student to discover it.
    const THIN = 25;
    function coverage() {
      const direct = [...mineFields.direct].filter(t => t !== "other");
      if (!direct.length) return h("div", { className: "meta" },
        "Pick a major or a field and we'll show how many open listings we have for it right now. The same count sits beside each field in the list above.");
      // was: if (!byField) return h("div", { className: "meta" }, "Today's listing counts didn't load, so we can't show how deep your field is right now.");
      // stats is null both before IS.loadStats() settles and after it fails (core.js loadStats
      // returns null when every base URL throws), so the old line told a student on a slow
      // connection that the counts had failed while stats.json was still downloading. statsReady is
      // set in the .then, which runs on success and on failure alike.
      if (!byField) return h("div", { className: "meta" }, statsReady
        ? "Today's listing counts didn't load, so we can't show how deep your field is right now."
        : "Checking today's listing counts…");
      const best = biggest(direct), rel = biggest([...mineFields.related].filter(t => t !== "other"));
      // was: const name = IS.fieldLabel(best ? best.tag : direct[0]);
      // The headline and the THIN test run on the student's own tag, not on the biggest of their
      // tags. A primary tag absent from by_field counts as 0 instead of falling back to the maximum:
      // backend/internscout/export_static.py:397 builds by_field with Counter over open listings
      // only, so a missing key means nothing open carries that tag, which is the case this line
      // exists to report.
      const head = primary && direct.includes(primary)
        ? { tag: primary, n: typeof byField[primary] === "number" ? byField[primary] : 0 }
        : best;
      const name = IS.fieldLabel(head ? head.tag : direct[0]);
      const nat = stats && stats.open ? ` of ${stats.open.toLocaleString()} open nationwide` : "";
      // was: const many = best && direct.length > 1 ? " That's the largest of your field tags, not a total: one listing can carry several." : "";
      // When the student's own tag is not their biggest, both numbers are named: dropping the bigger
      // one would undersell the list, and dropping the smaller one is the ambush this line exists to
      // prevent. `many` only claims "the largest" in the case where the headline really is.
      const wider = best && head && best.tag !== head.tag && best.n > head.n
        ? ` Your widest field tag, ${IS.fieldLabel(best.tag)}, has ${nOpen(best.n)}; one listing can carry several tags, so the two don't add up.` : "";
      const many = !wider && head && direct.length > 1 ? " That's the largest of your field tags, not a total: one listing can carry several." : "";
      const also = rel && rel.n > (best ? best.n : 0) ? ` The related field ${IS.fieldLabel(rel.tag)} has ${nOpen(rel.n)}.` : "";
      // was: if (!best || !best.n) return h("div", { className: "meta" },
      // was:   `Nothing open tagged ${name} in today's scan${nat}. The scanner runs daily and this number moves with it, so the profile is still worth setting up, but we won't pretend the list is there yet.` + also);
      if (!head || !head.n) return h("div", { className: "meta" },
        `Nothing open tagged ${name} in today's scan${nat}. The scanner runs daily and this number moves with it, so the profile is still worth setting up, but we won't pretend the list is there yet.` + wider + also);
      // was: if (best.n < THIN) return h("div", { className: "meta" },
      // was:   `We have very few right now: ${nOpen(best.n)} tagged ${name}${nat}.` + many + also);
      if (head.n < THIN) return h("div", { className: "meta" },
        `We have very few right now: ${nOpen(head.n)} tagged ${name}${nat}.` + wider + many + also);
      // was: return h("div", { className: "meta" }, `${nOpen(best.n)} tagged ${name} right now${nat}.` + many + also);
      return h("div", { className: "meta" }, `${nOpen(head.n)} tagged ${name} right now${nat}.` + wider + many + also);
    }

    const undeclared = !d.majors.length || d.majors.some(n => /Undeclared|BDIC/.test(n));
    const [season, gyear] = (d.grad_term || "").split(" ");
    const setGrad = (s, y) => set("grad_term", s && y ? `${s} ${y}` : s || y ? `${s || "Spring"} ${y || ""}`.trim() : "");
    const setYear = y => setD(s => ({ ...s, class_year: y, stages: stagesTouched || !y ? s.stages : IS.STAGE_DEFAULTS[y].slice() }));

    const files = (index && index.files) || {};
    const count = k => files[k] ? files[k].open : null;
    const stateList = useMemo(() => Object.entries(IS.US_STATES).sort((a, b) => a[1].localeCompare(b[1])), []);
    const shortcut = codes => setD(s => { const all = codes.every(c => s.states.includes(c)); return { ...s, states: all ? s.states.filter(c => !codes.includes(c)) : [...new Set([...s.states, ...codes])] }; });

    const dots = h("div", { className: "steps", "aria-label": `Step ${step} of 3` }, [1, 2, 3].map(i => h("span", { key: i, className: cx("dot", i === step && "on", i < step && "done") }, i)));

    let body;
    if (step === 1) body = h(F, null,
      h("h3", null, "About you"),
      !majors && h("div", { className: "meta" }, "The major list didn't load. Pick the fields you're interested in below instead."),
      majors && h("div", { className: "lbl" }, "Major(s)", h(MultiSelect, { wide: true, label: "Majors", placeholder: "Start typing, e.g. Nursing", options: majorOpts, selected: d.majors, onChange: v => set("majors", v) })),
      majors && h("div", { className: "lbl" }, "Minor(s) ", h("span", { className: "muted" }, "optional"), h(MultiSelect, { wide: true, label: "Minors", placeholder: "Start typing", options: minorOpts, selected: d.minors, onChange: v => set("minors", v) })),
      h("div", { className: "lbl" }, undeclared ? "Fields you're interested in" : h(F, null, "Other fields you're interested in ", h("span", { className: "muted" }, "optional")),
        h(MultiSelect, { wide: true, label: "Fields", placeholder: undeclared ? "e.g. Health, Museums, Data" : "Add a field", options: fieldOpts, selected: d.fields, onChange: v => set("fields", v) })),
      coverage(),
      h("div", { className: "row2" },
        h("label", { className: "lbl" }, "Class year",
          h(Sel, { label: "Class year", value: d.class_year, onChange: setYear }, opt("", "Choose…"), IS.YEARS.map(([k, l]) => opt(k, l)))),
        h("label", { className: "lbl" }, "Graduation term",
          h("div", { className: "row2 tight" },
            h(Sel, { label: "Graduation season", value: season || "", onChange: v => setGrad(v, gyear) }, opt("", "Season"), SEASONS.map(s => opt(s, s))),
            h(Sel, { label: "Graduation year", value: gyear || "", onChange: v => setGrad(season, v) }, opt("", "Year"), GRAD_YEARS.map(y => opt(String(y), String(y))))))));
    else if (step === 2) body = h(F, null,
      h("h3", null, "What you want"),
      h("fieldset", null, h("legend", null, "Kinds of roles", d.class_year && !stagesTouched ? h("span", { className: "muted" }, ` (suggested for ${IS.YEAR_PLURAL[d.class_year]})`) : null),
        h("div", { className: "checks" }, IS.STAGES.map(([k, l]) => h("label", { key: k, className: "check" },
          h("input", { type: "checkbox", checked: d.stages.includes(k), onChange: () => { setStagesTouched(true); toggle("stages", k); } }), " ", l)))),
      h("fieldset", null, h("legend", null, "Terms"),
        h("div", { className: "checks" }, [...IS.TERMS, ...d.terms.filter(t => !IS.TERMS.includes(t))].map(t => h("label", { key: t, className: "check" },
          h("input", { type: "checkbox", checked: d.terms.includes(t), onChange: () => toggle("terms", t) }), " ", t)))),
      h("label", { className: "check" }, h("input", { type: "checkbox", checked: !!d.paid_only, onChange: e => set("paid_only", e.target.checked) }),
        " Paid roles only ", h("span", { className: "muted" }, "(hides roles marked unpaid; many postings don't say)")));
    else body = h(F, null,
      h("h3", null, "Where"),
      h("div", { className: "shortcuts" },
        IS.REGION_SHORTCUTS.map(([name, codes]) => h("button", { type: "button", key: name, className: cx("btn small", codes.every(c => d.states.includes(c)) && "on"), onClick: () => shortcut(codes) }, name)),
        h("button", { type: "button", className: "btn small quiet", onClick: () => set("states", []) }, "Clear")),
      h("label", { className: "check remote" }, h("input", { type: "checkbox", checked: !!d.remote, onChange: e => set("remote", e.target.checked) }),
        " U.S. remote", count("remote") != null ? h("span", { className: "c" }, count("remote")) : null),
      h("div", { className: "stategrid" }, stateList.map(([k, n]) => h("label", { key: k, className: cx("check", d.states.includes(k) && "on") },
        h("input", { type: "checkbox", checked: d.states.includes(k), onChange: () => toggle("states", k) }), " ", n,
        count(k) != null ? h("span", { className: "c" }, count(k)) : null))),
      !d.states.length && h("div", { className: "meta" }, `No states picked: you'll see the baseline area (${IS.BASELINE.join(", ")}).`),
      h("fieldset", null, h("legend", null, "Work authorization"),
        h("div", { className: "checks" }, IS.WORK_AUTH.map(([k, l]) => h("label", { key: k, className: "check" },
          h("input", { type: "radio", name: "work_auth", checked: d.work_auth === k, onChange: () => set("work_auth", k) }), " ", l))),
        h("div", { className: "meta" }, "Used only on this page: it hides roles open to U.S. citizens only and flags roles that don't sponsor visas.")),
      signedIn && h("div", { className: "meta" }, "You're signed in, so your chosen states count toward where we scan in more detail."));

    return h("section", { className: "setup sheet", ref, "aria-label": "My profile" },
      h("div", { className: "setup-head" }, h("h2", null, firstTime ? "Set up InternScout" : "My profile"), dots),
      body,
      h("div", { className: "setup-foot" },
        step > 1 && h("button", { type: "button", className: "btn", onClick: () => setStep(step - 1) }, "Back"),
        step < 3 && h("button", { type: "button", className: "btn primary", onClick: () => setStep(step + 1) }, "Next"),
        step === 3 && h("button", { type: "button", className: "btn primary", onClick: () => onSave(d) }, "Save and show matches"),
        h("span", { className: "spacer" }),
        step < 3 && !firstTime && h("button", { type: "button", className: "btn quiet", onClick: () => onSave(d) }, "Save"),
        h("button", { type: "button", className: "btn quiet", onClick: onClose }, firstTime ? "Skip for now" : "Cancel")),
      !firstTime && h("div", { className: "setup-danger" },
        h("span", { className: "meta" }, "Your profile lives in this browser", signedIn ? "; the server keeps only a hashed ID, usage counts and your chosen states." : "."),
        h("button", { type: "button", className: "btn small danger", onClick: onDelete }, "Delete my data")));
  }

  // ---------- app ----------
  function App() {
    const store = useRef(null); if (!store.current) store.current = IS.createStore();
    const [p, setP] = useState(IS.loadProfile);
    const [majors, setMajors] = useState(null);
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
    const [setupOpen, setSetupOpen] = useState(() => !IS.loadProfile() && !IS.ls.get(SKIP_KEY, false));
    const [landingOpen, setLandingOpen] = useState(() => !IS.ls.get(LANDING_KEY, false));
    const initF = prof => ({ sort: prof ? "score" : "new", hide_citizen: !!(prof && prof.work_auth && prof.work_auth !== "citizen"), paid: prof && prof.paid_only ? "no_unpaid" : "" });
    const [f, setF] = useState(() => ({ q: "", fields: [], states: [], where: "", stage: "", year: "", sector: "", status: "open", app_state: "", new_only: false, eligible: false, ...initF(IS.loadProfile()) }));
    const [appStates, setAppStates] = useState(() => IS.ls.get(LS_KEY, {}) || {});
    const [saved, setSaved] = useState(() => IS.ls.get(SAVED_KEY, []) || []);
    const [openId, setOpenId] = useState(null);
    const [limit, setLimit] = useState(PAGE);
    const [sel, setSel] = useState(() => new Set());
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState("");
    const [ghToken, setGhToken] = useState(() => { try { return localStorage.getItem("internscout.gh_token") || ""; } catch (e) { return ""; } });
    const [auth, setAuth] = useState(() => ({ cfg: null, token: IS.storedToken(), source: "page" }));
    const { info, queue, profile: extProfile } = useExtension();

    useEffect(() => { IS.ls.set(LANDING_KEY, true); }, []);

    // data
    const reload = useCallback(async fromRaw => {
      setLoading(true);
      try {
        const r = await store.current.init(fromRaw);
        setIndex(r.index); setLegacy(r.legacy); setErr(null); setReady(n => n + 1); setVer(store.current.version());
      } catch (e) { setErr(String(e.message || e)); setLoading(false); }
    }, []);
    useEffect(() => {
      reload(false);
      IS.loadMajors().then(setMajors);
      // was: IS.loadStats().then(setStats);
      // loadStats never rejects (core.js catches every base and returns null), so this .then is the
      // one place that knows the fetch has settled, whichever way it went.
      IS.loadStats().then(s => { setStats(s); setStatsReady(true); });
    }, [reload]);

    const keys = useMemo(() => f.states.length ? f.states : IS.profileKeys(p), [f.states, p]);
    const [failedKeys, setFailedKeys] = useState([]); const [retry, setRetry] = useState(0);
    const keysKey = keys.slice().sort().join(",");
    useEffect(() => {
      if (!ready) return;
      let live = true;
      setLoading(true);
      store.current.ensure(keys).then(bad => { if (live) { setVer(store.current.version()); setLoading(false); setFailedKeys(bad || []); } });
      return () => { live = false; };
    }, [ready, keysKey, retry]);

    // Descriptions come in a sidecar per state; fetch them the first time the search box is used.
    // Each description file is about the size of its listing file (MA: 0.9 MB), so they are fetched only
    // for a real search (2+ letters), and only on their own while the chosen states stay under
    // DESC_AUTO listings. Past that the search covers titles, companies and fields until the student
    // asks for descriptions too.
    const [descAll, setDescAll] = useState(false);
    const searching = f.q.trim().length >= 2;
    const descOpen = useMemo(() => keys.reduce((a, k) => a + ((index && index.files && index.files[k] && index.files[k].open) || 0), 0), [keys, index]);
    const wantDesc = searching && (descOpen <= DESC_AUTO || descAll);
    useEffect(() => {
      if (!ready || !wantDesc) return;
      let live = true;
      store.current.descs(keys).then(() => { if (live) setVer(store.current.version()); });
      return () => { live = false; };
    }, [ready, wantDesc, keysKey]);

    // sign-in
    useEffect(() => {
      const r = IS.handleRedirect();
      if (r && r.token) setAuth(a => ({ ...a, token: r.token, source: "page" }));
      if (r && r.error) setNote("Sign-in didn't work: " + r.error);
      IS.fetchWorkerConfig().then(cfg => setAuth(a => ({ ...a, cfg })));
    }, []);
    useEffect(() => {
      if (!info.installed || auth.token) return;
      IS.ext.call({ type: "auth:token" }, 1500).then(r => { if (r && r.token && IS.tokenOk(r.token)) setAuth(a => ({ ...a, token: r.token, source: "extension" })); });
    }, [info.installed]);
    useEffect(() => { if (auth.token && p) IS.postDemand(auth.token, p); }, [auth.token, p]);
    const who = auth.token ? (IS.decodeJwt(auth.token) || {}) : null;
    const [me, setMe] = useState(null);
    // A token lasts about an hour. When it runs out, stop showing "Signed in": take a fresh one from
    // the extension if it has one, otherwise show the sign-in buttons again.
    const dropToken = useCallback(() => {
      IS.signOut(); setAuth(a => ({ ...a, token: null }));
      if (info.installed) IS.ext.call({ type: "auth:token" }, 1500).then(r => { if (r && r.token && IS.tokenOk(r.token)) setAuth(a => ({ ...a, token: r.token, source: "extension" })); });
    }, [info.installed]);
    useEffect(() => {
      setMe(null);
      if (!auth.token) return;
      let live = true, last = Date.now();
      const load = () => IS.fetchMe(auth.token).then(m => { if (!live) return; if (m) setMe(m); else if (!IS.tokenOk(auth.token)) dropToken(); });
      load();
      const ms = ((IS.decodeJwt(auth.token) || {}).exp || 0) * 1000 - Date.now() - 60000;
      const timer = setTimeout(dropToken, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      // Coming back to the tab after an Auto-Apply run: the "left this month" text should be current.
      const onVis = () => { if (document.visibilityState === "visible" && Date.now() - last > 60000) { last = Date.now(); load(); } };
      document.addEventListener("visibilitychange", onVis);
      return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
    }, [auth.token, dropToken]);

    // Stripe sends the student back to /?upgraded=1. The webhook that records the plan can land a
    // moment later, so check once now and once shortly after before saying anything.
    useEffect(() => {
      if (!new URLSearchParams(location.search).has("upgraded")) return;
      history.replaceState(null, "", location.pathname);
      setNote("Thanks for supporting InternScout. Your larger allowance is being switched on…");
      const check = n => IS.fetchMe(auth.token).then(m => {
        if (m) setMe(m);
        if (m && m.plan && m.plan !== "free") setNote(`You're on the ${IS.PLAN_LABELS[m.plan] || m.plan} plan. Your AI allowance is now larger.`);
        else if (n > 0) setTimeout(() => check(n - 1), 3000);
        else setNote("Payment received. If the larger allowance hasn't appeared in a minute, reload the page.");
      });
      if (auth.token) check(4);
    }, [auth.token]);

    async function billing(kind, plan) {
      setBusy(kind === "checkout" ? "Opening Stripe…" : "Opening your billing page…");
      const r = await IS.billingUrl(auth.token, kind, plan);
      setBusy("");
      if (r.url) location.assign(r.url);
      else setNote(r.error);
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
          if (got && (got.majors.length || got.class_year)) { const s = IS.saveProfile(got); setP(s); setSetupOpen(false); setF(x => ({ ...x, ...initF(s) })); }
        });
      }
    }, [info.installed, p]);

    function saveProfile(d) {
      const s = IS.saveProfile(d);
      setP(s); setSetupOpen(false); setLimit(PAGE);
      setF(x => ({ ...x, states: [], ...initF(s) }));
      setNote(`Profile saved. Ranking for ${s.majors.length ? s.majors.join(", ") : s.fields.length ? s.fields.map(IS.fieldLabel).join(", ") : "all fields"}.`);
      setTimeout(() => setNote(""), 6000);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    function closeSetup() { if (!p) IS.ls.set(SKIP_KEY, true); setSetupOpen(false); }
    async function deleteData() {
      const msg = "Delete your InternScout profile from this browser" + (auth.token ? " and your chosen states and past usage from our server (this month's counts go when the month ends)" : "") + "? This can't be undone.";
      if (!window.confirm(msg)) return;
      const r = await IS.deleteMyData(auth.source === "page" ? auth.token : auth.token);
      if (r.blocked) { setNote("Cancel your Supporter plan first (Manage plan), then delete. Nothing was deleted."); return; }
      // Statuses and saved searches are the student's own tracker, so they go only if they say so.
      if ((Object.keys(appStates).length || saved.length || ghToken) && window.confirm("Also delete your applied/saved statuses and saved searches from this browser? Cancel keeps them.")) {
        setAppStates({}); IS.ls.del(LS_KEY); keepSaved([]); IS.ls.del(SAVED_KEY);
        try { localStorage.removeItem("internscout.gh_token"); } catch (e) { } setGhToken("");
      }
      setP(null); setAuth(a => ({ ...a, token: null })); setSetupOpen(false); IS.ls.del(SKIP_KEY);
      setF(x => ({ ...x, states: [], ...initF(null) }));
      setNote(r.server === false ? "Deleted from this browser. The server delete failed; sign in again and retry, or open a GitHub issue." : (r.server ? "Your data was deleted from this browser and our server." : "Your profile was deleted from this browser.")
        + (info.installed ? " The extension keeps its own copy of your profile and files: removing it at chrome://extensions deletes that copy." : ""));
    }

    const setAppState = useCallback((id, v) => setAppStates(m => { const n = { ...m, [id]: v }; if (v === "none") delete n[id]; IS.ls.set(LS_KEY, n); return n; }), []);
    const upd = (k, v) => { setF(s => ({ ...s, [k]: v })); setLimit(PAGE); };
    // "More filters" remembers whether it was open; the count is how many of the controls inside it
    // are set to something other than their default, so a hidden filter is never a silent one.
    const [moreOpen, setMoreOpenRaw] = useState(() => !!IS.ls.get(MORE_KEY, false));
    const setMoreOpen = fn => setMoreOpenRaw(o => { const n = typeof fn === "function" ? fn(o) : fn; IS.ls.set(MORE_KEY, n); return n; });
    const defaults = initF(p);
    const moreCount = ["stage", "year", "sector", "app_state"].filter(k => f[k]).length
      + (f.paid !== (defaults.paid || "") ? 1 : 0) + (f.where ? 1 : 0) + (f.status !== "open" ? 1 : 0)
      + (f.hide_citizen !== defaults.hide_citizen ? 1 : 0) + (f.new_only ? 1 : 0) + (f.eligible ? 1 : 0);
    const anyFilter = moreCount > 0 || !!f.q.trim() || f.fields.length > 0 || f.states.length > 0;
    const clearFilters = () => { setF(s => ({ ...s, q: "", fields: [], states: [], where: "", stage: "", year: "", sector: "", status: "open", app_state: "", new_only: false, eligible: false, ...defaults })); setLimit(PAGE); };
    const st = id => appStates[id] || "none";
    const keepSaved = list => { setSaved(list); IS.ls.set(SAVED_KEY, list); };
    function onSaved(v) {
      if (v === "__save") { const name = (window.prompt("Name this search") || "").trim(); if (name) keepSaved([...saved.filter(s => s.name !== name), { name, f }]); }
      else if (v.startsWith("del:")) keepSaved(saved.filter(s => s.name !== v.slice(4)));
      else { const s = saved.find(x => x.name === v); if (s) setF(cur => ({ ...cur, ...s.f })); }
    }

    const jobs = useMemo(() => {
      const m = {}; Object.values(queue.jobs || {}).forEach(j => { if (j.listingId == null) return; const k = String(j.listingId); if (!m[k] || m[k].updated < j.updated) m[k] = j; });
      return m;
    }, [queue]);
    useEffect(() => { Object.entries(jobs).forEach(([id, j]) => { if (j.status === "submitted" && (appStates[id] || "none") === "none") setAppState(id, "applied"); }); }, [jobs]);

    const all = useMemo(() => store.current.all(), [ver]);
    const ctx = useMemo(() => { const { direct, related } = IS.profileFields(p, majors); return { p, direct, related, keys: new Set(IS.profileKeys(p)) }; }, [p, majors]);
    const keySet = useMemo(() => new Set(keys), [keysKey]);
    const inView = useMemo(() => all.filter(x => { for (const k of IS.shardKeys(x)) if (keySet.has(k)) return true; return false; }), [all, keySet]);
    const scores = useMemo(() => { const m = new Map(); inView.forEach(x => m.set(x.id, IS.score(x, ctx))); return m; }, [inView, ctx]);

    const elig = useMemo(() => {
      if (!p && !extProfile) return null;
      const e = { ...(extProfile || {}) };
      if (p) {
        const gy = parseInt((p.grad_term || "").split(" ")[1], 10); if (gy) e.grad_year = gy;
        if (p.class_year) e.class_year = p.class_year;
        if (p.work_auth === "citizen") e.citizenship = "U.S. citizen";
        else if (p.work_auth === "permanent") e.citizenship = "U.S. permanent resident";
        else if (p.work_auth === "visa") { e.citizenship = "Student visa"; e.needs_sponsorship = true; }
        if (p.class_year === "masters") e.degree = "master's"; else if (p.class_year === "phd") e.degree = "PhD"; else if (p.class_year && !e.degree) e.degree = "bachelor's";
      }
      return e;
    }, [p, extProfile]);

    const opts = useMemo(() => {
      const count = get => { const m = new Map(); inView.forEach(x => (get(x) || []).forEach(t => t && m.set(t, (m.get(t) || 0) + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
      const stateOpts = index
        ? Object.entries(index.files).map(([k, m]) => ({ value: k, label: IS.keyLabel(k), chip: k === "remote" ? "Remote" : k, count: m.open })).sort((a, b) => b.count - a.count)
        : count(x => [...IS.shardKeys(x)]).map(([k, n]) => ({ value: k, label: IS.keyLabel(k), chip: k === "remote" ? "Remote" : k, count: n }));
      return {
        fields: count(x => x.field_tags).map(([v, n]) => ({ value: v, label: IS.fieldLabel(v), count: n })),
        sectors: count(x => [x.sector]),
        stages: count(x => x.stage),
        states: stateOpts,
      };
    }, [inView, index]);

    const rows = useMemo(() => {
      let r = inView.slice();
      if (f.q.trim()) {
        const { rest, places } = splitPlaces(f.q), terms = parseQuery(rest);
        const seen = new Map(); r.forEach(x => new Set(locHay(x).split(/[^a-z]+/)).forEach(t => { if (t.length >= 3 && !NOT_PLACE.has(t)) seen.set(t, (seen.get(t) || 0) + 1); }));
        const words = new Set(); seen.forEach((n, t) => { if (n >= 3) words.add(t); });
        r = r.filter(x => places.every(pl => IS.regs(x).some(g => pl.kind ? g.kind === pl.kind : pl.states.includes(g.state)) !== pl.neg) &&
          terms.every(({ t, neg }) => (words.has(t) ? placeHay(x) : hay(x)).includes(t) !== neg));
      }
      if (f.fields.length) r = r.filter(x => (x.field_tags || []).some(t => f.fields.includes(t)));
      if (f.where === "onsite") r = r.filter(x => IS.regs(x).some(g => g.kind !== "remote"));
      else if (f.where === "remote") r = r.filter(x => IS.regs(x).some(g => g.kind === "remote") || x.is_remote);
      if (f.stage) r = r.filter(x => (x.stage || []).includes(f.stage));
      if (f.year) r = r.filter(x => !(x.years && x.years.length) || x.years.includes(f.year));
      if (f.sector) r = r.filter(x => x.sector === f.sector);
      if (f.paid === "paid") r = r.filter(x => ["paid", "stipend"].includes(IS.payOf(x)));
      else if (f.paid === "no_unpaid") r = r.filter(x => IS.payOf(x) !== "unpaid");
      if (f.hide_citizen) r = r.filter(x => !IS.citizenBlocked(x, p ? p.work_auth : ""));
      if (f.eligible && elig) r = r.filter(x => !scores.get(x.id).mismatch && !blockers(x, elig).length);
      // Looking at your own applications: a posting that has since closed still belongs in the list.
      if (f.status && !f.app_state) r = r.filter(x => x.status === f.status);
      if (f.new_only) r = r.filter(x => x.is_new);
      if (f.app_state === "auto") r = r.filter(x => jobs[String(x.id)]);
      else if (f.app_state) r = r.filter(x => st(x.id) === f.app_state);
      const S = x => scores.get(x.id);
      // Dated postings first, newest first. first_seen is only the scan that found the row, which is
      // today for nearly everything, so using it for undated rows put every undated posting on top.
      const newer = (a, b) => (b.posted_at ? 1 : 0) - (a.posted_at ? 1 : 0) || (b.posted_at || "").localeCompare(a.posted_at || "") || (b.first_seen || "").localeCompare(a.first_seen || "");
      if (f.sort === "score") r.sort((a, b) => (S(a).mismatch - S(b).mismatch) || (S(b).score - S(a).score) || (b.first_seen || "").localeCompare(a.first_seen || ""));
      else if (f.sort === "new") r.sort((a, b) => (S(a).mismatch - S(b).mismatch) || newer(a, b));
      else if (f.sort === "company") r.sort((a, b) => a.company_name.localeCompare(b.company_name));
      else if (f.sort === "comp") r.sort((a, b) => (b.salary ? 1 : 0) - (a.salary ? 1 : 0) || S(b).score - S(a).score);
      return r;
    }, [inView, f, appStates, jobs, elig, scores, p]);

    const shown = rows.slice(0, limit);
    const nationwide = stats && stats.open ? stats.open : index ? Object.values(index.files).reduce((a, m) => a + (m.open || 0), 0) : null;
    const figures = useMemo(() => ({
      open: inView.filter(x => x.status === "open").length,
      fresh: inView.filter(x => x.is_new).length,
      applied: Object.values(appStates).filter(v => v === "applied").length,
    }), [inView, appStates]);
    const gen = (index && index.generated_at) || (stats && stats.generated_at);
    const genText = gen ? new Date(gen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "unknown";
    const jobCounts = useMemo(() => { const c = {}; Object.values(queue.jobs || {}).forEach(j => { c[j.status] = (c[j.status] || 0) + 1; }); return c; }, [queue]);

    const canAuto = info.installed;
    const check = useCallback((id, on) => setSel(s => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; }), []);
    const onWhy = useCallback(id => setOpenId(o => o === id ? null : id), []);
    const selectable = shown.filter(r => r.apply_url && !jobs[String(r.id)]);
    const allChecked = selectable.length > 0 && selectable.every(r => sel.has(r.id));

    const autoRef = useRef(null);
    const onAutoRow = useCallback(list => autoRef.current && autoRef.current(list), []);
    async function autoApply(list) {
      if (!info.installed) { setNote("Install the InternScout extension first."); return; }
      // The agent tailors answers from the posting text, which is not in the list rows.
      const ks = new Set(); list.forEach(r => IS.shardKeys(r).forEach(k => ks.add(k)));
      await store.current.descs([...ks]);
      const payload = list.filter(r => r.apply_url).slice(0, 100).map(r => ({
        id: r.id, apply_url: r.apply_url, company: r.company_name, title: r.title,
        location: (r.region_locations || []).join("; ") || r.location_raw || "", description: r.description || "",
      }));
      if (!payload.length) return;
      setNote("Adding to the queue…");
      const res = await IS.ext.call({ type: "enqueue", jobs: payload });
      if (res.error === "setup_required") { setNote("Finish the Deep Dive first. It just opened in a new tab."); return; }
      if (res.error) { setNote("Couldn't queue: " + res.error); return; }
      setSel(new Set());
      const added = (res.added || []).length, skipped = (res.skipped || []).length;
      setNote(`Queued ${plural(added, "application")}${skipped ? ` (${skipped} already queued)` : ""}. Each one is filled in and left for you to submit.`);
      list.forEach(r => { if (st(r.id) === "none") setAppState(r.id, "interested"); });
      IS.ext.call({ type: "open_panel" });
      setTimeout(() => setNote(""), 9000);
    }

    autoRef.current = autoApply;

    // admin only: trigger the scanner workflow with a GitHub token kept in this browser
    async function rescan() {
      let t = ghToken;
      if (!t) { t = (window.prompt("Paste a GitHub fine-grained token (Actions: Read and write). Stored only in this browser; sent only to github.com.") || "").trim(); if (!t) return; localStorage.setItem("internscout.gh_token", t); setGhToken(t); }
      const H = { Authorization: "Bearer " + t, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      const api = `https://api.github.com/repos/${C.repo}/actions/workflows/${C.workflow || "ingest.yml"}`;
      try {
        setBusy("Starting…");
        const before = await fetch(`${api}/runs?per_page=1`, { headers: H }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
        const beforeId = before.workflow_runs && before.workflow_runs[0] ? before.workflow_runs[0].id : 0;
        const disp = await fetch(`${api}/dispatches`, { method: "POST", headers: H, body: JSON.stringify({ ref: "main" }) });
        if (disp.status === 401) { localStorage.removeItem("internscout.gh_token"); setGhToken(""); setBusy("Token rejected"); return; }
        if (disp.status !== 204) { setBusy("Failed (HTTP " + disp.status + ")"); return; }
        setBusy("Scanning…");
        for (let i = 0; i < 360; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const runs = await fetch(`${api}/runs?per_page=5`, { headers: H }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
          const run = (runs.workflow_runs || []).find(x => x.id > beforeId); if (!run) continue;
          if (run.status !== "completed") { setBusy("Scanning (" + String(run.status).replace("_", " ") + ")"); continue; }
          if (run.conclusion !== "success") { setBusy("Scan " + run.conclusion); return; }
          setBusy("Loading…"); await new Promise(r => setTimeout(r, 3000)); await reload(true); setBusy("Updated"); setTimeout(() => setBusy(""), 4000); return;
        }
        setBusy("Still running, reload shortly");
      } catch (e) { setBusy("Error: " + e.message); }
    }

    const majorsText = p ? (p.majors.length ? p.majors.join(", ") : p.fields.length ? p.fields.map(IS.fieldLabel).join(", ") : "All fields") : "";
    const whereText = p ? [p.states.length ? (p.states.length <= 5 ? p.states.join(", ") : `${p.states.length} states`) : IS.BASELINE.join(", "), p.remote ? "remote" : ""].filter(Boolean).join(" + ") : "";
    // A real button inside the header, so the column sorts from the keyboard and a screen reader
    // hears which column the list is sorted by. Each sort here is a fixed order, so "descending"
    // is only an approximation for company (A-Z), but aria-sort has no "custom" value.
    const sortTh = (key, label) => h("th", { className: cx("sort", f.sort === key && "on"), scope: "col",
      "aria-sort": f.sort === key ? (key === "company" ? "ascending" : "descending") : undefined },
      h("button", { type: "button", onClick: () => upd("sort", key) }, label));
    const feedbackUrl = C.formUrl ? C.formUrl.split("{id}").join("") : C.issuesUrl;
    // Optional paid plans. The Worker only advertises the tiers whose Stripe price it actually has,
    // so a tier that isn't set up yet never appears as a button the student can press.
    const payPlans = auth.cfg && auth.cfg.payments && auth.cfg.payments.enabled ? auth.cfg.payments.plans || [] : [];
    // Only what is actually a step up from the plan they are on: a Supporter sees Pro, not Supporter.
    const myMult = (payPlans.find(pl => pl.plan === (me && me.plan)) || {}).multiplier || 1;
    const upgrades = me && me.can_upgrade ? payPlans.filter(pl => pl.multiplier > myMult) : [];
    const upgradeTitle = pl => `Optional. Covers the AI bill and gives you ${pl.multiplier}× your monthly `
      + "AI allowance. Stripe takes the payment; we never see your card. Cancel any time.";
    // was: const signInTitle = "Optional. Search works without it. Any Google or Microsoft account works; a school .edu email gets more AI use. Signing in also lets your chosen states count toward where we scan in more detail.";
    // The old wording left "more AI use" vague and the button beside it said "(UMass email)", which
    // together read as a school requirement. worker/src/auth.js only asks for a verified address on a
    // .edu domain, from Google or Microsoft alike, and GENERAL_ALLOWANCE_PCT is "50", so .edu is
    // exactly double and everyone else still gets an allowance. Say both plainly.
    const signInTitle = "Optional and free. Search and this dashboard work without it. Any Google or Microsoft account works, from any school or none; a verified .edu address doubles your free monthly AI allowance. Signing in also lets your chosen states count toward where we scan in more detail.";
    const signInBtn = auth.cfg && !auth.token && auth.cfg.providers.map(pr =>
      // was: h("button", { ... }, `Sign in with ${IS.PROVIDER_LABELS[pr.id] || pr.id}${pr.id === "google" ? " (UMass email)" : ""}`));
      // The " (UMass email)" suffix was wrong twice over: no account has to be UMass, and nothing has
      // to be .edu at all. A .edu only doubles the allowance, which the tooltip now says.
      h("button", { key: pr.id, type: "button", className: "btn", onClick: () => IS.startSignIn(auth.cfg, pr.id), title: signInTitle }, `Sign in with ${IS.PROVIDER_LABELS[pr.id] || pr.id}`));

    const aboutBtn = !landingOpen && h("button", { type: "button", onClick: () => setLandingOpen(true) }, "About InternScout");
    return h("div", { className: "wrap" },
      h("header", { className: "top" },
        h("div", null,
          h("h1", { className: "mark" }, "InternScout"),
          h("div", { className: "sub" }, p ? `${majorsText}${p.class_year ? " · " + IS.YEAR_LABEL[p.class_year] : ""} · ${whereText}` : "Internships, co-ops and research for UMass students, anywhere in the US.",
            aboutBtn && " · ", aboutBtn)),
        h("div", { className: "top-r" },
          busy && h("span", { className: "busy" }, busy),
          info.spend && info.spend.calls > 0 && h("span", { className: "busy", title: "Estimated AI cost of Auto-Apply and the Deep Dive this month" }, `AI $${info.spend.month_usd.toFixed(2)} this month${info.spend.budget ? ` of $${info.spend.budget}` : ""}`),
          ADMIN && h("button", { type: "button", className: "btn quiet", onClick: rescan, disabled: !!busy, title: "Run the scanner on GitHub now" }, "Rescan"),
          ADMIN && ghToken && h("button", { type: "button", className: "btn quiet", onClick: () => { localStorage.removeItem("internscout.gh_token"); setGhToken(""); setBusy("Token cleared"); } }, "Forget token"),
          // Hidden while the setup card is already open under it, so a first visit shows one way in.
          !setupOpen && h("button", { type: "button", className: "btn", onClick: () => { setSetupOpen(true); } }, p ? "My profile" : "Set up profile"),
          signInBtn,
          auth.token && h("span", { className: "signed", title: who && who.email ? `Signed in as ${who.email}` : "Signed in" }, "Signed in",
            auth.source === "page" && h("button", { type: "button", className: "btn quiet", onClick: () => { IS.signOut(); setAuth(a => ({ ...a, token: null })); } }, "Sign out")),
          auth.token && me && me.allowance && h("span", { className: "busy", title: IS.allowanceText(me) },
            me.paused ? "AI paused this month" : `${IS.leftOf(me, "autofill")} Auto-Apply · ${IS.leftOf(me, "resume_tailor")} resumes left${me.plan && me.plan !== "free" ? ` (${(IS.PLAN_LABELS[me.plan] || me.plan).toLowerCase()})` : me.tier === "edu" ? " (.edu)" : ""}`),
          auth.token && upgrades.map(pl => h("button", { key: pl.plan, type: "button", className: "btn quiet", onClick: () => billing("checkout", pl.plan), disabled: !!busy, title: upgradeTitle(pl) }, `${pl.label}${pl.price ? ` · ${pl.price}` : ""}`)),
          auth.token && me && me.can_manage && h("button", { type: "button", className: "btn quiet", onClick: () => billing("portal"), disabled: !!busy, title: "Change your card or cancel, on Stripe's own page." }, "Manage plan"),
          info.installed && h("button", { type: "button", className: "btn quiet", onClick: () => IS.ext.call({ type: "open_deep_dive" }) }, info.onboarded ? "Deep Dive" : "Start Deep Dive"),
          info.installed && h("button", { type: "button", className: "btn", onClick: () => IS.ext.call({ type: "open_panel" }) }, "Queue",
            jobCounts.needs_you ? h("span", { className: "count" }, `${jobCounts.needs_you} need you`) : null,
            jobCounts.ready_to_submit ? h("span", { className: "count ok" }, `${jobCounts.ready_to_submit} ready`) : null))),

      // was: h(Landing, { open: landingOpen && !setupOpen, setOpen: setLandingOpen, onSetup: () => setSetupOpen(true), hasProfile: !!p, nationwide }),
      h(Landing, { open: landingOpen && !setupOpen, setOpen: setLandingOpen, onSetup: () => setSetupOpen(true), hasProfile: !!p, nationwide, plans: payPlans }),
      // was: setupOpen && h(Setup, { key: p ? p.updated : "new", initial: p, majors, index, stats, firstTime: !p, onSave: saveProfile, onClose: closeSetup, onDelete: deleteData, signedIn: !!auth.token }),
      setupOpen && h(Setup, { key: p ? p.updated : "new", initial: p, majors, index, stats, statsReady, firstTime: !p, onSave: saveProfile, onClose: closeSetup, onDelete: deleteData, signedIn: !!auth.token }),

      // Numbers get thousands separators, "You applied" appears once there is something to count,
      // and the state list is one sentence under the numbers instead of a block floated to the right.
      h("section", { className: "figures" },
        h("div", { className: "figrow" },
          h("div", { className: "fig" }, h("div", { className: "n" }, figures.open.toLocaleString()), h("div", { className: "l" }, f.states.length ? "Open in picked states" : p ? "Open in your areas" : "Open in the Northeast + remote")),
          h("div", { className: "fig" }, h("div", { className: "n" }, figures.fresh.toLocaleString()), h("div", { className: "l" }, "New this week")),
          nationwide != null && h("div", { className: "fig" }, h("div", { className: "n" }, nationwide.toLocaleString()), h("div", { className: "l" }, "Open nationwide")),
          figures.applied > 0 && h("div", { className: "fig" }, h("div", { className: "n" }, figures.applied.toLocaleString()), h("div", { className: "l" }, "You applied"))),
        h("div", { className: "coverage" },
          loading ? "Loading " : "Showing ", keys.map(IS.keyLabel).map(s => s.replace(/ \(([A-Z]{2})\)$/, "")).slice(0, 8).join(", "), keys.length > 8 ? ` and ${keys.length - 8} more` : "", ". ",
          h("span", { className: "updated" }, "Updated ", genText, legacy ? " · single-file data" : "", "."))),

      info.stale && h("div", { className: "notice" }, h("b", null, "The extension was reloaded or updated. "), h("a", { href: "#", onClick: prevent(() => location.reload()) }, "Reload this page"), " to reconnect Auto-Apply."),
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
      info.checked && !info.installed && !info.stale && p && h("div", { className: "notice quietnote" }, "Want help filling applications? The InternScout extension pre-fills forms and never presses Submit. It's free to install and runs on the free monthly AI allowance that comes with a free account. ", h("a", { href: C.extensionInstallUrl || "install.html" }, "Install guide")),
      info.installed && !info.onboarded && h("div", { className: "notice" }, h("b", null, "One step left: "), "do the Deep Dive so the agent knows your background. ", h("a", { href: "#", onClick: prevent(() => IS.ext.call({ type: "open_deep_dive" })) }, "Start the Deep Dive")),
      note && h("div", { className: "notice", role: "status" }, note),

      // Two tiers. The first row is what nearly every visit touches: search, field, state, sort,
      // and the Auto-Apply button. The other nine controls sit behind "More filters", which shows
      // how many of them are set so nothing is hidden by surprise.
      h("div", { className: "filters", role: "search" },
        h("div", { className: "field search" }, h(SearchBox, { value: f.q, onChange: v => upd("q", v) })),
        h(MultiSelect, { placeholder: "Field", options: opts.fields, selected: f.fields, onChange: v => upd("fields", v) }),
        h(MultiSelect, { placeholder: p ? "State (your areas)" : "State", options: opts.states, selected: f.states, onChange: v => upd("states", v) }),
        h(Sel, { label: "Sort", value: f.sort, onChange: v => upd("sort", v) }, opt("score", "Sort: best match"), opt("new", "Sort: newest"), opt("company", "Sort: company A–Z"), opt("comp", "Sort: pay listed")),
        h("button", { type: "button", className: cx("btn morebtn", moreOpen && "on"), "aria-expanded": moreOpen, onClick: () => setMoreOpen(o => !o) },
          moreOpen ? "Fewer filters" : "More filters", moreCount > 0 && h("span", { className: "count ok" }, moreCount)),
        h("span", { className: "spacer" }),
        canAuto && h("button", { type: "button", className: "btn primary", disabled: !sel.size, onClick: () => autoApply(all.filter(r => sel.has(r.id))) }, "Auto-Apply", sel.size ? ` ${sel.size} selected` : "")),
      moreOpen && h("div", { className: "filters extra" },
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
        h(Sel, { label: "Saved searches", value: "", onChange: onSaved }, opt("", "Saved searches"), saved.map(s => opt(s.name, s.name)), opt("__save", "+ Save current filters…"),
          saved.length > 0 && h("optgroup", { label: "Delete" }, saved.map(s => h("option", { key: "d" + s.name, value: "del:" + s.name }, `Delete “${s.name}”`))))),
      h("div", { className: "filterbar-foot" },
        h("span", null, loading && !all.length ? "Loading…" : `${rows.length.toLocaleString()} listing${rows.length === 1 ? "" : "s"}${anyFilter ? " match" : ""}`),
        anyFilter && h("button", { type: "button", className: "btn quiet", onClick: clearFilters }, "Clear filters")),

      searching && !wantDesc && h("div", { className: "notice" }, `Searching titles, companies and fields in ${keys.length} states. `,
        h("button", { type: "button", className: "btn quiet", onClick: () => setDescAll(true) }, "Search descriptions too"), " (a larger download)"),
      failedKeys.length > 0 && h("div", { className: "notice", role: "alert" }, `Couldn't load listings for ${failedKeys.join(", ")}. Check your connection. `,
        h("button", { type: "button", className: "btn quiet", onClick: () => setRetry(n => n + 1) }, "Try again")),
      err ? h("div", { className: "sheet empty" }, "Couldn't load listings: ", err)
        : loading && !all.length ? h("div", { className: "sheet empty" }, "Loading listings…")
          : rows.length === 0 ? h("div", { className: "sheet empty" }, inView.length ? "Nothing matches these filters." : "No listings in these states yet. Try more states or remote.")
            : h("div", { className: "sheet" }, h("div", { className: "tablewrap" }, h("table", { className: "list" },
              h("thead", null, h("tr", null,
                canAuto && h("th", null, h("input", { type: "checkbox", "aria-label": "Select all shown", checked: allChecked, disabled: !selectable.length,
                  onChange: e => { const on = e.target.checked; setSel(s => { const n = new Set(s); selectable.slice(0, 100).forEach(r => on ? n.add(r.id) : n.delete(r.id)); return n; }); } })),
                sortTh("company", "Company and role"), h("th", { scope: "col" }, "Field"), h("th", { scope: "col" }, "Location and term"),
                sortTh("comp", "Pay"), sortTh("score", "Match"), h("th", { scope: "col" }, "Your status"), h("th", { scope: "col" }, h("span", { className: "sr" }, "Links")))),
              h("tbody", null, shown.map(r => h(Row, { key: r.id, r, sc: scores.get(r.id), ctx, keys: keySet, state: st(r.id), onState: setAppState, job: jobs[String(r.id)],
                checked: sel.has(r.id), onCheck: check, canAuto, onAuto: onAutoRow, open: openId === r.id, onWhy, elig, patterns: stats && stats.skill_patterns }))))),
              rows.length > shown.length && h("div", { className: "more" }, h("button", { type: "button", className: "btn", onClick: () => setLimit(l => l + PAGE) }, `Show ${Math.min(PAGE, rows.length - shown.length)} more`))),

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
          h("a", { href: "privacy.html" }, "Privacy"),
          h("a", { href: "terms.html" }, "Terms"),
          h("a", { href: feedbackUrl, target: "_blank", rel: "noopener" }, "Feedback"),
          h("a", { href: C.issuesUrl, target: "_blank", rel: "noopener" }, "GitHub Issues"),
          h("a", { href: C.extensionInstallUrl || "install.html" }, "Install extension"),
          h("a", { href: C.handshakeUrl, target: "_blank", rel: "noopener" }, "Also check Handshake"),
          h("a", { href: C.reuUrl, target: "_blank", rel: "noopener" }, "NSF REU research"),
          C.campusJobsUrl && h("a", { href: C.campusJobsUrl, target: "_blank", rel: "noopener" }, "UMass campus jobs"),
          signInBtn)));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
