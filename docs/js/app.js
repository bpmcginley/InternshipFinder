// InternScout dashboard UI. Plain JS with React.createElement (no build step, no Babel).
(function () {
  "use strict";
  const { useState, useEffect, useMemo, useRef, useCallback, useId } = React;
  const h = React.createElement, F = React.Fragment;
  const IS = window.IS, C = IS.C;
  const ADMIN = new URLSearchParams(location.search).get("admin") === "1";
  // "Don't count this browser" (js/count.js), switched from the admin menu.
  const NOCOUNT_KEY = "internscout.nocount";
  const noCount = () => { try { return localStorage.getItem(NOCOUNT_KEY) === "1"; } catch (e) { return false; } };

  const EXT_NOTICE_KEY = "internscout.extnotice.v1";
  // The one-time notice that paid listings have started (S8, 2026-10-14): hidden for good in this browser.
  const PLACE_NOTICE_KEY = "internscout.placements.notice.v1";
  const LS_KEY = "internscout.appstate.v1", SAVED_KEY = "internscout.saved.v1", LANDING_KEY = "internscout.landing.seen.v1", SKIP_KEY = "internscout.setup.skipped.v1", MORE_KEY = "internscout.filters.more.v1";
  const APP_STATES = ["none", "interested", "applied", "interviewing", "rejected", "offer"];
  const STATE_LABEL = { none: "Not started", interested: "Interested", applied: "Applied", interviewing: "Interviewing", rejected: "Rejected", offer: "Offer" };
  const JOB_LABEL = { queued: "Queued", working: "Agent working", needs_you: "Needs you", ready_to_submit: "Ready to submit", submitted: "Submitted", failed: "Failed" };
  const ATS = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday", smartrecruiters: "SmartRecruiters", icims: "iCIMS", icims_site: "iCIMS", oracle: "Oracle", bamboohr: "BambooHR", workable: "Workable", taleo: "Taleo" };
  // Application sites the extension can fill in out of the box: the `ats` values whose apply hosts are
  // in extension/manifest.json host_permissions (jazzhr is applytojob.com). Not "other" or "icims_site",
  // whose custom domains are only optional permissions. The SEO pages (seo_pages.py) use the same list.
  const SUPPORTED_ATS = new Set(["workday", "greenhouse", "oracle", "icims", "ashby", "lever", "eightfold", "smartrecruiters",
    "successfactors", "taleo", "bamboohr", "rippling", "jazzhr", "workable", "jobvite", "recruitee", "adp", "paylocity"]);
  const ACTIVE = ["queued", "working", "needs_you", "ready_to_submit"];
  const PAGE = 150;
  // Descriptions run about 1 KB per open listing. Up to this many open listings they are downloaded
  // without asking (the eight default states and remote are about 3,200).
  const DESC_AUTO = 5000;

  const DAY = IS.DAY;
  const daysAgo = iso => { if (!iso) return null; const t = new Date(iso).getTime(); return isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / DAY)); };
  const ago = n => n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
  // One formatter each, made once: toLocaleDateString builds a new one on every call, and the list
  // calls these for every row it draws. Same text (toLocaleDateString(undefined, o) is
  // new Intl.DateTimeFormat(undefined, o).format).
  const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  const SHORT_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const fmtDay = d => { const t = new Date(d + "T12:00:00"); return isNaN(t) ? "Invalid Date" : DAY_FMT.format(t); };
  const daysUntil = d => Math.ceil((new Date(d + "T23:59:59").getTime() - Date.now()) / DAY);
  const shortDate = iso => { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : SHORT_FMT.format(d); };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const cx = (...a) => a.filter(Boolean).join(" ");
  const prevent = fn => e => { e.preventDefault(); fn(e); };
  // Smooth scrolling is motion too, so it follows the same prefers-reduced-motion switch as the CSS.
  const scrollBehavior = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  // Where "install the extension" goes: the Chrome Web Store listing on a laptop or desktop, and the
  // install page on a phone or tablet, which can't add extensions (same media query as install.html's
  // phone banner). `from` is the listing's utm_source, so the store counts installs per link.
  const touchOnly = () => !!(window.matchMedia && matchMedia("(pointer:coarse) and (hover:none)").matches);
  const installUrl = from => C.extensionStoreUrl && !touchOnly()
    ? C.extensionStoreUrl + "?utm_source=" + encodeURIComponent(from)
    : C.extensionInstallUrl || "install.html";

  // ---------- search ----------
  // was: parseQuery, PLACES, splitPlaces, NOT_PLACE and the substring "hay" here. The search moved to
  // core.js (IS.compileQuery, IS.matchScore) on 2026-10-14, where it is tested, and ranks by relevance.

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
    // Every location in Canada: a US student generally needs a Canadian work permit to take it.
    if (IS.inCanadaOnly(r)) {
      const c = (p && p.citizenship) || "";
      out.push([/canad/i.test(c) ? "good" : /u\.?\s?s\.?|united states|student visa/i.test(c) ? "warn" : "", "In Canada: needs Canadian work authorization"]);
    }
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
  // `count` (D8, 2026-10-14): the filter bar's pickers say how many values are set ("Field · 2"), with the
  // accent-soft fill, so a filter that is on can be seen at a glance. The setup card's pickers pass none.
  // was: function MultiSelect({ placeholder, options, selected, onChange, label, wide }) {
  function MultiSelect({ placeholder, options, selected, onChange, label, wide, count }) {
    const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [act, setAct] = useState(0);
    const ref = useRef(), input = useRef(), drop = useRef(), id = useId();
    useEffect(() => {
      const hd = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener("mousedown", hd); return () => document.removeEventListener("mousedown", hd);
    }, []);
    const byVal = useMemo(() => new Map(options.map(o => [o.value, o])), [options]);
    const avail = options.filter(o => !selected.includes(o.value));
    const ql = q.toLowerCase();
    const filtered = (q ? avail.filter(o => (o.label || o.value).toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql)) : avail).slice(0, 60);
    const active = Math.max(0, Math.min(act, filtered.length - 1));
    useEffect(() => {
      if (open && drop.current) { const option = drop.current.children[active]; if (option) option.scrollIntoView({ block: "nearest" }); }
    }, [open, active, q, selected.length]);
    const add = v => { onChange([...selected, v]); setQ(""); setAct(0); };
    const rm = v => onChange(selected.filter(x => x !== v));
    const onKey = e => {
      if (e.key === "Enter" && open && filtered[active]) { add(filtered[active].value); e.preventDefault(); }
      else if (e.key === "ArrowDown") { setAct(open ? Math.min(active + 1, Math.max(0, filtered.length - 1)) : 0); setOpen(true); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setAct(open ? Math.max(active - 1, 0) : Math.max(0, filtered.length - 1)); setOpen(true); e.preventDefault(); }
      // was: Escape always handled here. With the list already closed it now goes on to the setup card,
      // whose Escape closes it (D13).
      else if (e.key === "Escape" && open) { setOpen(false); e.preventDefault(); }
      // Tab moves on to the next control and closes the list. was: the list stayed open behind it.
      else if (e.key === "Tab") setOpen(false);
      else if (e.key === "Backspace" && !q && selected.length) rm(selected[selected.length - 1]);
    };
    const name = label || placeholder, set = count > 0;
    return h("div", { className: cx("field ms", wide && "wide", set && "set"), ref, onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); } },
      h("div", { className: "box", onClick: () => { setOpen(true); if (input.current) input.current.focus(); } },
        set && h("span", { className: "ms-count", "aria-hidden": true }, `${name} · ${count}`),
        // The shared cross icon (D15) in place of the "×" character; the button keeps its spoken name.
        selected.map(s => { const o = byVal.get(s); return h("span", { key: s, className: "chip" }, (o && (o.chip || o.label)) || s,
          h("button", { type: "button", "aria-label": "Remove " + ((o && o.label) || s), onClick: e => { e.stopPropagation(); rm(s); } }, h("span", { className: "i i-cross", "aria-hidden": true }))); }),
        // With no options left there is no list: aria-expanded stays false and the "No more matching
        // options" line is a plain status message. was: an empty listbox, which axe reports as critical
        // (aria-required-children: a listbox must own options).
        h("input", { ref: input, value: q, role: "combobox", "aria-autocomplete": "list", "aria-expanded": open && filtered.length > 0,
          "aria-controls": id + "-list", "aria-activedescendant": open && filtered.length ? id + "-option-" + active : undefined,
          "aria-label": set ? `${name}, ${count} picked` : name, placeholder: selected.length ? "" : placeholder,
          onChange: e => { setQ(e.target.value); setOpen(true); setAct(0); }, onFocus: () => setOpen(true), onKeyDown: onKey })),
      open && !filtered.length && h("div", { className: "drop", role: "status" }, h("div", { className: "opt muted" }, "No more matching options")),
      // tabIndex -1: a scrolling box is a Tab stop of its own in Chrome and Firefox, so Tab from the
      // input landed in the list. Arrow keys and Enter on the input still move through it and pick.
      open && filtered.length > 0 && h("div", { className: "drop", ref: drop, id: id + "-list", role: "listbox", "aria-label": label || placeholder, tabIndex: -1 },
        filtered.map((o, i) => h("div", { key: o.value, id: id + "-option-" + i, role: "option", "aria-selected": false, className: cx("opt", i === active && "act"),
          onMouseDown: e => { e.preventDefault(); add(o.value); }, onMouseEnter: () => setAct(i) },
          h("span", null, o.label || o.value), o.count != null ? h("span", { className: "c" }, o.count) : o.hint ? h("span", { className: "c" }, o.hint) : null))));
  }

  // Everything about the signed-in account in one place, behind one button: who is signed in, this
  // month's allowance, invites, plans and sign-out. It used to sit in the header as a dozen buttons and
  // labels in one row that wrapped into a long second line. A disclosure (a button that shows a panel),
  // closed by Escape, a click outside, or choosing an item.
  function AccountMenu({ email, planLabel, allowLines, resetDay, spendText, items, admin }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(), btn = useRef();
    useEffect(() => {
      if (!open) return;
      const down = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      const key = e => { if (e.key === "Escape") { setOpen(false); btn.current && btn.current.focus(); } };
      document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
      return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
    }, [open]);
    const pick = fn => () => { setOpen(false); fn(); };
    const item = it => h("button", { key: it.key, type: "button", className: cx("acct-item", it.danger && "danger"), onClick: pick(it.onClick), disabled: it.disabled, title: it.title },
      h("span", { className: "t" }, it.label), it.desc && h("span", { className: "d" }, it.desc));
    const groups = [items.filter(i => i.group === "share"), items.filter(i => i.group === "plan"), items.filter(i => i.group === "session"), admin || []].filter(g => g.length);
    return h("div", { className: "acct", ref },
      h("button", { type: "button", className: "btn acct-btn", ref: btn, "aria-expanded": open, "aria-controls": "acct-panel", onClick: () => setOpen(o => !o) },
        "Account", h("span", { className: "chev", "aria-hidden": true })),
      open && h("div", { className: "acct-panel", id: "acct-panel" },
        h("div", { className: "acct-sec" },
          h("div", { className: "acct-k" }, email ? "Signed in as" : "Signed in"),
          email && h("div", { className: "acct-email" }, email),
          h("div", { className: "acct-plan" }, planLabel)),
        (allowLines.length > 0 || spendText) && h("div", { className: "acct-sec" },
          h("div", { className: "acct-k" }, "This month"),
          allowLines.map((l, i) => h("div", { key: i, className: "acct-line" }, l)),
          spendText && h("div", { className: "acct-line muted" }, spendText),
          resetDay && h("div", { className: "acct-line muted" }, `Resets ${resetDay}.`)),
        groups.map((g, i) => h("div", { key: i, className: "acct-sec acct-list" }, g.map(item)))));
  }

  const Sel = ({ label, value, onChange, children }) => h("div", { className: "field sel" },
    h("select", { "aria-label": label, value, onChange: e => onChange(e.target.value) }, children));
  const opt = (v, l) => h("option", { key: v, value: v }, l);

  // The listing's place, inline, for the row's facts line (D9, 2026-10-14): "Boston, MA +2". was: two
  // stacked lines in a Location column (the place, then its state or "Remote" under it).
  function Loc({ r, keys }) {
    const all = IS.regs(r), g = all.find(x => keys.has(x.state) || (x.kind === "remote" && keys.has("remote"))) || all[0];
    // was: || "—". A muted word says what is missing; a bare dash only says something is.
    const first = g ? g.loc : ((r.location_raw || "").split(";")[0].trim() || null);
    if (!first) return h("span", { className: "muted" }, "Location not listed");
    // was: remote, else the state when the first line lacks it. A Canadian place also says the country.
    const sub = g && g.kind === "remote" ? (/remote/i.test(first) ? null : "Remote")
      : g && g.kind === "canada" ? (/canada/i.test(first) ? (g.remote || /remote/i.test(first) ? "Remote" : null) : `${g.state && !first.includes(g.state) ? g.state + ", " : ""}Canada`)
      : g && g.state && !first.includes(g.state) ? g.state : null;
    const more = Math.max(0, all.length - 1);
    return h("span", { title: all.map(x => x.loc).join("; ") }, first, sub ? (sub === "Remote" ? " (remote)" : ", " + sub) : "",
      more > 0 && h("span", { className: "muted" }, " +" + more));
  }

  // The Why panel (A2 component 6, D13): a region that takes focus when it opens, closes on Escape and hands
  // focus back to the button that opened it. Its heading is an h3 under the h2 "Listings" (was an h4, a
  // skipped level). Before a profile there is no score to explain (D10), so the first column offers the
  // profile instead of six full bars. "Report" lives here only (D11); it was on every row.
  function Why({ r, sc, ctx, elig, patterns, onClose, onRank }) {
    const W = IS.WEIGHTS, ins = r.insights || {};
    const box = useRef();
    useEffect(() => { if (box.current && box.current.focus) box.current.focus({ preventScroll: true }); }, []);
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
    // The shared check and cross icons (index.html .i) in place of the ✓ and ✗ characters (2026-10-14), with
    // the meaning in words for a screen reader, since the icon itself is silent.
    // was: has ? (has[s.name] ? "✓ " : "✗ ") : "", s.name
    const icon = (name, said) => h(F, null, h("span", { className: "i i-" + name, "aria-hidden": true }), h("span", { className: "sr" }, said));
    const chip = s => h("span", { key: s.name, className: cx("tag", has && (has[s.name] ? "ok" : "miss")), title: has ? (has[s.name] ? "Found on your profile" : "Not on your profile") : "" }, has ? (has[s.name] ? icon("check", "Have: ") : icon("cross", "Missing: ")) : "", s.name);
    const dates = h("div", { className: "meta" }, posted != null ? `Posted ${ago(posted)}` : "Posting date not listed", seen != null ? ` · first seen ${ago(seen)}` : "", r.sector ? ` · ${IS.sectorLabel(r.sector)} sector` : "");
    // was: h("div", { className: "whyg" }, ...) with h4 headings
    return h("div", { className: "whyg", ref: box, tabIndex: -1, role: "region", "aria-label": `Why: ${r.company_name}, ${r.title}`,
      onKeyDown: e => { if (e.key === "Escape") { e.preventDefault(); onClose && onClose(); } } },
      ctx.p
        ? h("div", null, h("h3", null, `Match score ${sc.score} of 100`),
          Object.entries(IS.PART_LABEL).map(([k, l]) => {
            const w = W[k], v = sc.parts[k] || 0;
            return h("div", { className: "part", key: k, title: why[k] || "" }, h("span", null, l), h("span", { className: "bar" }, h("i", { style: { width: (w ? Math.min(100, v / w * 100) : 0) + "%" } })), h("span", { className: "num" }, `${Math.round(v)}/${w}`));
          }),
          h("div", { className: "meta", style: { marginTop: 9 } }, why.field, why.fit ? " · " + why.fit : ""),
          dates)
        : h("div", null, h("h3", null, "No match score yet"),
          h("p", { className: "meta" }, "With no profile every role scores close to 100, so the number would say nothing. Add your major and class year and each role gets a score for you."),
          onRank && h("button", { type: "button", className: "btn small", onClick: onRank }, "Rank for my major"),
          dates),
      h("div", null, h("h3", null, "Skills asked for", has && req.length ? ` · you have ${met} of ${req.length} required` : ""),
        !skills.length && h("div", { className: "meta" }, r.status === "open" ? "No specific skills named in the description." : "Closed posting, so the description isn't kept."),
        req.length > 0 && h("div", null, req.map(chip)),
        pref.length > 0 && h(F, null, h("div", { className: "meta", style: { margin: "4px 0 5px" } }, "Nice to have"), h("div", null, pref.map(chip)))),
      h("div", null, h("h3", null, "Eligibility and deadline"),
        cs.length ? cs.map(([lv, t], i) => h("div", { key: i, className: "flag " + lv }, lv === "bad" ? icon("cross", "Problem: ") : lv === "good" ? icon("check", "Good: ") : lv === "warn" ? icon("alert", "Check: ") : "· ", t))
          : h("div", { className: "meta" }, "No limits or deadline found in the description."),
        h("div", { className: "meta", style: { marginTop: 9 } }, h("a", { href: IS.reportUrl(r), target: "_blank", rel: "noopener" }, "Report a wrong tag or dead link"))));
  }

  // The grey facts line of a listing (D9): field, place, term, then pay (tabular figures, or "Pay not
  // listed"). Shared by Row and the paid box (js/placements.js, 2026-10-14), so the two can never describe
  // one role differently. was: built inside Row.
  function factsLine(r, keys) {
    const tags = r.field_tags || [];
    // Two field tags fit on the line; the rest are a count.
    const fieldText = tags.slice(0, 2).map(IS.fieldLabel).join(", ") + (tags.length > 2 ? ` +${tags.length - 2}` : "");
    const term = [IS.termText(r.term), r.duration].filter(Boolean).join(", ");
    const pay = IS.realSalary(r) ? h("span", { className: "num" }, IS.realSalary(r)) : IS.payOf(r) === "stipend" ? "Stipend" : IS.payOf(r) === "unpaid" ? h("span", { className: "closed" }, "Unpaid") : "Pay not listed";
    const dot = h("span", { className: "dot-sep", "aria-hidden": true }, " · ");
    return h("div", { className: "meta facts" },
      tags.length ? h("span", { title: tags.length > 2 ? tags.map(IS.fieldLabel).join(", ") : undefined }, fieldText) : h("span", { className: "muted" }, "Not tagged"),
      dot, h(Loc, { r, keys }), term && h(F, null, dot, term), dot, pay);
  }

  // The Match control (D9, D10): with a profile, the score button that opens the Why panel (panelId);
  // before one, "Rank for my major" and "Details". Shared by Row and the paid box (2026-10-14), which pass
  // the same scoreOf result, so a paid listing shows exactly the score its own row shows. was: inside Row.
  function matchControl({ r, sc, scored, open, onToggle, onRank, btnRef, onKeyDown, panelId }) {
    const cls = sc.score >= 80 ? "hi" : sc.score >= 60 ? "mid" : "lo";
    const who = `${r.company_name}, ${r.title}`;
    return scored
      // was: no aria-controls, and a name of "98 Why" ("Match" was hidden from it).
      ? h("button", { type: "button", ref: btnRef, className: "score whybtn " + cls, "aria-expanded": !!open, "aria-controls": panelId,
        onClick: onToggle, onKeyDown, title: `Match score ${sc.score} of 100. Click for why.` },
        // The name is the visible text plus words for a screen reader: "Match 98 of 100, Why" (D9). was: an
        // aria-label that left out the visible "Why", which axe reports (label-content-name-mismatch).
        // U12: and the row it is for, after the visible words: "Match 98 of 100, Why: Acme, Data Intern".
        h("span", { className: "match-label" }, "Match "), h("span", { className: "num" }, sc.score), h("span", { className: "sr" }, " of 100, "), h("span", { className: "bar" }, h("i", { style: { width: Math.max(4, Math.min(100, sc.score)) + "%" } })), h("span", { className: "why-l" }, open ? "Hide why" : "Why"), h("span", { className: "sr" }, ": " + who))
      : h("div", { className: "unscored" },
        h("button", { type: "button", className: "rankbtn", onClick: onRank }, "Rank for my major"),
        h("button", { type: "button", ref: btnRef, className: "whybtn details", "aria-expanded": !!open, "aria-controls": panelId, "aria-label": `Details: ${r.company_name}, ${r.title}`,
          onClick: onToggle, onKeyDown }, open ? "Hide details" : "Details"));
  }

  // The listing row (A2 component 4, D9 to D11, 2026-10-14). Three short lines instead of five columns:
  //   1. the company (semibold, ink), then the title;
  //   2. one grey facts line: field, place, term, then pay (tabular figures, or "Pay not listed");
  //   3. one grey line of dates and the application site;
  // then any warning (closed, not for your year, may not be eligible) in red. The actions sit on one line:
  // "Open posting" (a secondary button) and "Auto-Apply" (quiet), with the status select at the right.
  // Match shows only once there is a profile (D10); before that the slot says "Rank for my major" and the
  // panel opens from "Details". "Report" moved into the panel (D11).
  // was: columns Company and role / Field / Location and term / Pay / Match / Your status / Links, and a
  // Report link on every row. Memoised: ticking one checkbox or typing used to redraw all 150 rows.
  // `canTry` (2026-10-04): a desktop browser without the extension. Such a visitor never saw the word
  // Auto-Apply on a row, so a row it could fill now says so and opens a one-line explainer.
  // was: const Row = React.memo(function Row({ r, sc, ctx, keys, state, onState, job, checked, onCheck, canAuto, canTry, onAuto, queueBusy, open, onWhy, elig, patterns }) {
  // `ask`, `onOpen`, `onAnswer` (U9, 2026-10-14): "Did you apply to <Company>?" on this row once the
  // student comes back from its posting (App's askId). Only while the status is still Not started or
  // Interested and no Auto-Apply job holds the row; the answer is the row's status, kept in local storage
  // like every status (LS_KEY), and nothing else is stored.
  // `needsAccess` (U11): with the extension installed, a row whose application is not on a site Auto-Apply
  // already has access to (SUPPORTED_ATS) says, quietly, that it will ask for that site first.
  // was: const Row = React.memo(function Row({ r, sc, ctx, keys, state, onState, job, checked, onCheck, canAuto, canTry, onAuto, queueBusy, open, onWhy, onRank, elig, patterns }) {
  const Row = React.memo(function Row({ r, sc, ctx, keys, state, onState, job, checked, onCheck, canAuto, canTry, onAuto, queueBusy, open, onWhy, onRank, elig, patterns, ask, onOpen, onAnswer }) {
    const [aaOpen, setAaOpen] = useState(false);
    const whyBtn = useRef(), statusSel = useRef();
    const asking = !!ask && (state === "none" || state === "interested") && !job;
    const needsAccess = canAuto && !!r.apply_url && !SUPPORTED_ATS.has(r.ats);
    // Who the row is, for the names of its repeated controls (U12): "Open posting, Acme, Data Intern".
    const who = `${r.company_name}, ${r.title}`;
    // The line goes once answered; focus moves to the row's status, which now shows the answer, rather
    // than falling back to the top of the page.
    const answer = applied => { onAnswer(r.id, applied); setTimeout(() => { if (statusSel.current && statusSel.current.focus) statusSel.current.focus(); }, 0); };
    const tryAuto = !canAuto && canTry && r.apply_url && SUPPORTED_ATS.has(r.ats);
    const scored = !!ctx.p;
    const active = job && ACTIVE.includes(job.status);
    const dl = r.insights && r.insights.deadline;
    const stages = (r.stage || []).filter(s => s !== "internship").map(s => IS.STAGE_LABEL[s] || s);
    const dates = [shortDate(r.posted_at) && `Posted ${shortDate(r.posted_at)}`, dl && daysUntil(dl) >= 0 && `Apply by ${fmtDay(dl)}`, ...stages, r.sector && IS.sectorLabel(r.sector),
      r.ats && r.ats !== "other" && (ATS[r.ats] || r.ats), r.carried && "Not re-checked this scan"].filter(Boolean).join(" · ");
    const bl = elig ? blockers(r, elig).filter(t => !/^For /.test(t)) : [];
    const cols = canAuto ? 5 : 4;
    const dot = h("span", { className: "dot-sep", "aria-hidden": true }, " · ");
    const closeWhy = () => { onWhy(r.id); setTimeout(() => { if (whyBtn.current && whyBtn.current.focus) whyBtn.current.focus(); }, 0); };
    const whyKey = e => { if (e.key === "Escape" && open) { e.preventDefault(); onWhy(r.id); } };
    return h(F, null,
      h("tr", { className: cx(checked && "sel", open && "opened", sc.mismatch && "dim") },
        // was: "aria-label": "Select " + r.company_name, the same name on every row from one employer.
        canAuto && h("td", { className: "c-chk" }, h("input", { type: "checkbox", "aria-label": `Select ${r.company_name}, ${r.title}`, checked,
          disabled: !r.apply_url || active || (job && job.status === "submitted"), onChange: e => onCheck(r.id, e.target.checked) })),
        h("td", { className: "c-co" },
          // A badge that says New has to mean new and still open: is_new alone is only the scan window, and
          // the export keeps closed rows too.
          h("div", { className: "li-head" }, h("span", { className: "co" }, r.company_name), r.is_new && r.status === "open" && h("span", { className: "new" }, "New"),
            h("span", { className: "sr" }, ", "), dot, h("span", { className: "role" }, r.title)),
          // was: the facts line built here; factsLine (above) since 2026-10-14, shared with the paid box.
          factsLine(r, keys),
          (dates || r.status === "closed") && h("div", { className: "meta" }, dates, r.status === "closed" && h("span", { className: "closed" }, (dates ? " · " : "") + "Closed")),
          sc.mismatch && h("div", { className: "meta" }, h("span", { className: "closed" }, `Not for your year: for ${IS.yearsText(r.years)}`)),
          bl.length > 0 && h("div", { className: "meta" }, h("span", { className: "closed", title: bl.join("; ") }, "May not be eligible: " + bl[0]))),
        // was: the score button (or Rank for my major and Details) built here; matchControl (above) since
        // 2026-10-14, shared with the paid box so both show the one score from the same scoreOf.
        h("td", { className: "c-match" }, matchControl({ r, sc, scored, open, onToggle: () => onWhy(r.id), onRank, btnRef: whyBtn, onKeyDown: whyKey, panelId: "why-" + r.id })),
        h("td", { className: "c-links" },
          // data-aa (2026-10-13): an application Auto-Apply fills, so js/offer.js may offer the extension
          // when this is opened. The same rule as the row's "Auto-Apply" explainer (SUPPORTED_ATS).
          // was: an underlined link; a secondary button now (D9), with the shared external-link icon.
          // was: named "Open posting (opens in a new tab)" and "Auto-Apply" on every row; the row is in the name now (U12).
          // onOpen (U9): remembered so the page can ask "Did you apply?" when the student comes back.
          r.apply_url ? h("a", { className: "open-link", href: r.apply_url, target: "_blank", rel: "noopener", "data-aa": SUPPORTED_ATS.has(r.ats) ? "" : undefined, onClick: () => onOpen(r) },
            "Open posting", h("span", { className: "i i-external", "aria-hidden": true }), h("span", { className: "sr" }, `, ${who} (opens in a new tab)`)) : h("span", { className: "muted" }, "No link"),
          !job && canAuto && r.apply_url && h("button", { type: "button", className: "rowbtn", disabled: queueBusy, onClick: () => onAuto([r]), "aria-describedby": needsAccess ? "acc-" + r.id : undefined },
            "Auto-Apply", h("span", { className: "sr" }, ": " + who)),
          !job && needsAccess && h("span", { className: "aa-note", id: "acc-" + r.id, title: "This application is on the employer's own site. The first time, Auto-Apply asks you to allow that one site." }, "asks for site access"),
          tryAuto && h("button", { type: "button", className: "rowbtn try", "aria-expanded": aaOpen, "aria-controls": "aa-" + r.id, onClick: () => setAaOpen(o => !o) }, "Auto-Apply", h("span", { className: "sr" }, ": " + who))),
          // was: h("div", null, h("a", { className: "report", ... }, "Report")): in the Why panel only now (D11).
        h("td", { className: "c-mine" },
          // was: "aria-label": "Your status" on all 150 selects, then "Your status for " + r.title (two employers'
          // "Software Engineering Intern" rows read the same).
          h("select", { className: "mine", ref: statusSel, "aria-label": `Your status for ${r.title} at ${r.company_name}`, value: state, onChange: e => onState(r.id, e.target.value) }, APP_STATES.map(s => opt(s, STATE_LABEL[s]))),
          job && h("div", null, h("span", { className: "st " + job.status, title: job.reason || job.question || job.summary || "" }, JOB_LABEL[job.status] || job.status)))),
      // "Did you apply?" (U9): its own full-width row under the listing, like the Why panel.
      asking && h("tr", { className: "ask", id: "ask-" + r.id }, h("td", { colSpan: cols },
        h("div", { className: "ask-line", role: "group", "aria-label": "Did you apply to " + r.company_name + "?" },
          h("span", null, "Did you apply to ", h("b", null, r.company_name), "?"),
          h("button", { type: "button", className: "btn small", onClick: () => answer(true) }, "Mark applied"),
          h("button", { type: "button", className: "btn quiet small", onClick: () => answer(false) }, "Not yet")))),
      // Its own full-width row, like the Why panel, so the nowrap links column doesn't widen the table.
      tryAuto && aaOpen && h("tr", { className: "aa-info", id: "aa-" + r.id }, h("td", { colSpan: cols },
        "The free InternScout extension fills this application from your resume. You review it and press Submit yourself. Free monthly allowance. ",
        h("a", { href: installUrl("dashboard-row"), target: "_blank", rel: "noopener" }, "Add it to Chrome"))),
      open && h("tr", { className: "why", id: "why-" + r.id }, h("td", { colSpan: cols }, h(Why, { r, sc, ctx, elig, patterns, onClose: closeWhy, onRank }))));
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
    // id: the hero's "Search free" button focuses this box (2026-10-05).
    return h("input", { id: "q", type: "text", "aria-label": "Search", placeholder: 'Search roles or companies', title: 'Use quotes for a phrase or a minus sign to exclude a word, e.g. nursing -unpaid', value: text,
      onChange: e => setText(e.target.value), onKeyDown: e => { if (e.key === "Enter") { sent.current = text; onChange(text); } } });
  }

  // The list itself (2026-10-14): the table of `shown`, the "End of the N listings shown" line and "Show N
  // more", plus the paid listing's box when there is one: above the table on a wide screen, and as its own
  // full-width row after the third card on a phone (after the last, with fewer). The box is never a Row, so
  // every count here, the header checkbox and the Auto-Apply selection come from `shown` alone, the same
  // with or without it (tests/site/placements.test.mjs). was: the same markup inline in App.
  function ListTable({ shown, rows, head, renderRow, box, phone, onMore, inlineSignup, columns = 4 }) {
    const at = Math.min(3, shown.length) - 1;
    // After the tenth row, only when more follow: on a shorter list the footer form comes right after
    // the last row, and two forms in a row read as a mistake. was: Math.min(10, shown.length) - 1.
    const signupAt = shown.length > 10 ? 9 : -1;
    return h(F, null,
      !phone && box,
      h("a", { className: "skip inline", href: "#list-end" }, "Skip past the listings"),
      h("div", { className: "sheet" }, h("div", { className: "tablewrap" }, h("table", { className: "list" }, head,
        h("tbody", null, shown.flatMap((r, i) => [
          renderRow(r),
          phone && box && i === at && h("tr", { key: "placement", className: "paid-row" }, h("td", { colSpan: 5 }, box)),
          inlineSignup && i === signupAt && h("tr", { key: "weekly-email", className: "digest-in-list" }, h("td", { colSpan: columns }, inlineSignup))
        ].filter(Boolean)))))),
      h("div", { id: "list-end", className: "sr", tabIndex: -1 }, `End of the ${shown.length.toLocaleString()} listings shown`),
      rows.length > shown.length && h("div", { className: "more" }, h("button", { type: "button", className: "btn", onClick: onMore }, `Show ${Math.min(PAGE, rows.length - shown.length)} more`)));
  }

  // The notice that paid listings have started (S8, 2026-10-14; the privacy page promises a dashboard notice for
  // big changes). Shown once there are placements, until the student hides it or follows its link; kept
  // hidden in this browser (PLACE_NOTICE_KEY), never sent. It takes the one notice place above the list only
  // when nothing more urgent has it (D16); otherwise it waits under the list.
  function PlaceNotice({ onHide }) {
    return h("div", { className: "notice place-notice" },
      h("button", { type: "button", className: "btn quiet small notice-hide", onClick: onHide, "aria-label": "Hide this notice" }, "Hide"),
      h("b", null, "New: paid listings. "),
      "When you search or pick a field, you may now see one listing an employer paid for, in its own box labelled Ad. Paying never changes your results, their order or any Match score, and it is never chosen from your profile. ",
      h("a", { href: "privacy.html#paid-listings", onClick: onHide }, "How paid listings work"));
  }

  // Whether the window is phone-width (the same 760px as the card layout in index.html).
  function useNarrow() {
    const mq = useMemo(() => window.matchMedia ? matchMedia("(max-width: 760px)") : null, []);
    const [on, setOn] = useState(() => !!(mq && mq.matches));
    useEffect(() => {
      if (!mq) return;
      const f = () => setOn(mq.matches);
      if (mq.addEventListener) mq.addEventListener("change", f); else if (mq.addListener) mq.addListener(f);
      return () => { if (mq.removeEventListener) mq.removeEventListener("change", f); else if (mq.removeListener) mq.removeListener(f); };
    }, [mq]);
    return on;
  }

  // ---------- landing ----------
  // was: function Landing({ open, setOpen, onSetup, hasProfile, nationwide }) {
  // `plans` is the Worker's /config payments.plans, so the prices shown here are the ones Stripe is
  // actually configured with rather than a second copy that can drift.
  // When closed it renders nothing: the "About InternScout" link lives in the header tagline, so
  // the page no longer carries a second strip of small print under the header just to hold it.
  // was: function Landing({ open, setOpen, onSetup, hasProfile, nationwide, plans }) {
  // `installed` hides the Add Auto-Apply button once the extension is there.
  // was: function Landing({ open, setOpen, onSetup, hasProfile, nationwide, plans, installed }) {
  // `inviteOffer` and `inviteWords` are the dashboard's own (from /config invite), for the invite bullet.
  function Landing({ open, setOpen, onSetup, hasProfile, nationwide, plans, installed, inviteOffer, inviteWords }) {
    if (!open) return null;
    // was: "aria-label": "About InternScout" and h2 "Internships, co-ops and research for your major,
    // anywhere in the US and Canada": the header's h1 says that now (2026-10-05), so this strip is
    // what it does and how, under its own name.
    return h("section", { className: "landing", id: "about", tabIndex: -1, "aria-label": "How InternScout works" },
      h("div", { className: "landing-main" },
        h("h2", null, "What InternScout does"),
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
          ". The Deep Dive has no monthly run allowance of its own, though a per-account AI budget still applies, and it runs on the same free account. Made by a UMass student, not affiliated with UMass Amherst."),
        // Who it is not for, in so many words (2026-10-05 audit): the scope was only implied.
        h("p", { className: "fine" }, "Not for experienced job seekers: if you want full-time or senior roles, Simplify and Jobright cover every level. ",
          h("a", { href: "compare/" }, "See how they compare"), ".")),
      // The "Start in 3 steps" list that used to sit here repeated the setup card's own three
      // steps one screen higher. One copy, on the card, is enough.
      h("div", null, h("h3", null, "How it works"),
        h("ul", null,
          h("li", null, "A scanner checks employer career sites and public job boards several times a day and keeps only student roles."),
          h("li", null, "Your profile stays in this browser. Ranking happens on this page; nothing about you is uploaded."),
          h("li", null, "The optional extension fills in applications for you and always stops before Submit."),
          h("li", null, "Signing in with Google or Microsoft is optional. It lets your chosen states count toward where we scan in more detail."),
          // D1.3 (2026-10-05 audit): the invite mechanic was explained only after sign-in (the Account
          // menu and the nudge), nowhere a new visitor reads. The bonus and the cap come from /config;
          // until it answers, the sentence names no number rather than one that could drift.
          h("li", null, inviteOffer
            ? `Invite a classmate: when they join with a school (.edu) email, you each get ${inviteWords}${inviteOffer.max ? ` (for up to ${inviteOffer.max} classmates)` : ""}.`
            : "Invite a classmate: when they join with a school (.edu) email, you each get extra Auto-Apply runs.")),
        h("div", { className: "landing-actions" },
          h("button", { type: "button", className: "btn primary", onClick: onSetup }, hasProfile ? "Edit my profile" : "Set up your profile"),
          // Added 2026-10-04: until now the only way to the extension from here was the footer link.
          !installed && h("a", { className: "btn", href: installUrl("landing"), target: "_blank", rel: "noopener" }, "Add Auto-Apply to Chrome"),
          h("button", { type: "button", className: "btn quiet", onClick: () => setOpen(false) }, "Hide this"))));
  }

  // ---------- weekly email ----------
  // A plain HTML form that posts straight to the email provider (window.CONFIG.digest). Buttondown's
  // docs say not to send it with fetch: the subscriber may have to pass a CAPTCHA or fix a typo on
  // Buttondown's own page, so the browser has to follow the response. target="_blank" puts that page
  // in a new tab and leaves the student's search where it was. Nothing here touches the Worker, so
  // the address never reaches InternScout's servers.
  // `fields` are the profile's field tags (majors' tags plus hand-picked fields, as in scoring). Each
  // ticked box is one `tag` value. The value is the tag key ("swe"), not its label, because the key is
  // what listings carry in field_tags and it never changes wording. Buttondown adds tags on a repeat
  // sign-up rather than replacing them, so unticking a box later cannot remove a tag.
  // The past emails (2026-10-06): Buttondown's public web archive of the newsletter, worked out from the
  // form's address (IS.digestArchive), so a student can see what they'd get before giving an address.
  // js/count.js counts a submit of this form (class "digest") as "digest_signup", with nothing about who.
  function Digest({ cfg, fields = [], hasProfile, onSetup, placement = "footer", compact = false }) {
    const [sent, setSent] = useState(false);
    const prov = cfg.provider || "Buttondown";
    const archive = IS.digestArchive(cfg.formAction);
    const id = "digest-" + placement;
    // Only the form's status line changes on submit. The form and its inputs stay mounted, because
    // React can re-render before the browser has read the fields it is about to send.
    return h("form", { id: id + "-form", className: "notice quietnote digest" + (compact ? " digest-compact" : ""), action: cfg.formAction, method: "post", target: "_blank", rel: "noopener",
      "data-digest-placement": placement, "aria-labelledby": id + "-title", onSubmit: () => setSent(true) },
      h("b", { id: id + "-title" }, "New internships in your inbox every Monday. Free. "),
      compact
        ? "A few new roles and links to the rest. Everyone gets the same email. Confirm by email first; unsubscribe any time. "
        : "A weekly selection of new internships, co-ops and research roles, with links to explore the rest. Everyone gets the same email for now. Confirm by email first; unsubscribe any time. ",
      `Your address${!compact && fields.length ? " and the fields you tick go" : " goes"} to ${prov}, which sends the email. `,
      h("a", { href: "privacy.html#digest" }, "Details"),
      archive && " · ",
      archive && h("a", { href: archive, target: "_blank", rel: "noopener" }, "Browse past emails"),
      // The key remounts the boxes when the profile's fields change, so each new field starts ticked.
      !compact && (fields.length > 0
        // was: h("legend", null, "Fields from your profile")
        ? h("fieldset", { key: fields.join(","), id: id + "-fields" }, h("legend", null, "Optional: save fields from your profile for future email matching (not personalized yet)"),
          h("div", { className: "checks" }, fields.map(t => h("label", { key: t, className: "check" },
            h("input", { type: "checkbox", id: id + "-tag-" + t, name: "tag", value: t, defaultChecked: true }), IS.fieldLabel(t)))))
        // was: "With no fields picked, the email covers every field. ... to narrow it." For now every
        // subscriber gets the same email (growth/digest_send.py), so ticked fields only get saved.
        : h("div", { style: { marginTop: 8 } },
          h("a", { href: "#", onClick: prevent(onSetup) }, hasProfile ? "Add fields to your profile" : "Set up your profile"), " to improve your search results. You can subscribe without a profile.")),
      h("div", { className: "digest-row" },
        h("label", { htmlFor: id + "-email" }, "Email"),
        h("input", { id: id + "-email", type: "email", name: "email", required: true, autoComplete: "email", spellCheck: false }),
        h("button", { id: id + "-submit", type: "submit", className: "btn primary" }, "Email me new internships"),
        sent && h("span", { className: "muted", role: "status" }, `${prov} opened in a new tab. Finish there if it asks, then look for the confirmation email.`)),
      // In every one of Buttondown's sample forms; its docs don't say what it does, so it stays.
      h("input", { type: "hidden", name: "embed", value: "1" }));
  }

  // ---------- setup (3 steps) ----------
  const SEASONS = ["Spring", "Summer", "Fall", "Winter"];
  const GRAD_YEARS = Array.from({ length: 9 }, (_, i) => 2026 + i);

  // was: function Setup({ initial, majors, index, stats, firstTime, onSave, onClose, onDelete, signedIn }) {
  // statsReady says the stats.json fetch has settled. stats === null alone cannot tell "still
  // downloading" from "failed", and coverage() below words those two cases differently.
  // was: function Setup({ initial, majors, index, stats, statsReady, firstTime, onSave, onClose, onDelete, signedIn }) {
  // majorsReady does for majors.json what statsReady does for stats.json: majors === null alone is
  // both "still downloading" and "failed", and step 1 used to say "didn't load" for the first.
  function Setup({ initial, majors, majorsReady, index, stats, statsReady, firstTime, onSave, onClose, onDelete, signedIn }) {
    const [d, setD] = useState(() => ({ ...IS.emptyProfile(), ...(initial || {}) }));
    const [step, setStepRaw] = useState(1);
    // "fwd" or "back" once the student has moved between steps; "" on first open, so the card doesn't
    // slide in on page load. The step body is keyed by step, so each change replays the CSS animation.
    const [dir, setDir] = useState("");
    const setStep = n => { setDir(n > step ? "fwd" : "back"); setStepRaw(n); };
    const [stagesTouched, setStagesTouched] = useState(!!(initial && initial.stages && initial.stages.length));
    const ref = useRef(), stepRef = useRef(), mounted = useRef(false);
    // was: scrollIntoView on every run, the first included, so a first visit opened scrolled 600 px
    // down the page with the headline gone. On opening, the card scrolls only when it is out of
    // sight (opened from a link under the list); a step change still brings its top into view.
    useEffect(() => {
      const el = ref.current, box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const away = box && (box.top < 0 || box.top > (window.innerHeight || 800) - 120);
      if (el && (mounted.current || away)) el.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      mounted.current = true;
      if (stepRef.current) stepRef.current.focus({ preventScroll: true });
    }, [step]);
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
        "Pick a major or a field and we'll show how many open listings we have for it right now. Open the field picker to see counts.");
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
    // Provinces in the order most roles are in (the big metros' provinces first), then "no province".
    const provinceList = useMemo(() => [...Object.entries(IS.CA_PROVINCES), ["Canada", "Canada, no province listed"]], []);
    const shortcut = codes => setD(s => { const all = codes.every(c => s.states.includes(c)); return { ...s, states: all ? s.states.filter(c => !codes.includes(c)) : [...new Set([...s.states, ...codes])] }; });

    const dots = h("div", { className: "steps", "aria-label": `Step ${step} of 3` }, [1, 2, 3].map(i => h("span", { key: i, className: cx("dot", i === step && "on", i < step && "done") }, i)));

    let body;
    if (step === 1) body = h(F, null,
      h("h3", null, "About you"),
      // was: !majors && h("div", { className: "meta" }, "The major list didn't load. Pick the fields you're interested in below instead."),
      !majors && h("div", { className: "meta", role: "status" }, IS.majorsNote(majors, majorsReady)),
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
        // was: the regions, then a quiet "Clear". No state picked means every state (2026-10-14), so
        // that choice has its name and comes first.
        h("button", { type: "button", className: cx("btn small", !d.states.length && "on"), "aria-pressed": !d.states.length, onClick: () => set("states", []) }, "Everywhere"),
        IS.REGION_SHORTCUTS.map(([name, codes]) => h("button", { type: "button", key: name, className: cx("btn small", codes.every(c => d.states.includes(c)) && "on"), onClick: () => shortcut(codes) }, name))),
      h("label", { className: "check remote" }, h("input", { type: "checkbox", checked: !!d.remote, onChange: e => set("remote", e.target.checked) }),
        " U.S. remote", count("remote") != null ? h("span", { className: "c" }, count("remote")) : null),
      h("div", { className: "stategrid" }, stateList.map(([k, n]) => h("label", { key: k, className: cx("check", d.states.includes(k) && "on") },
        h("input", { type: "checkbox", checked: d.states.includes(k), onChange: () => toggle("states", k) }), " ", n,
        count(k) != null ? h("span", { className: "c" }, count(k)) : null))),
      h("fieldset", null, h("legend", null, "Canada"),
        h("div", { className: "stategrid" }, provinceList.map(([k, n]) => h("label", { key: k, className: cx("check", d.states.includes(k) && "on") },
          h("input", { type: "checkbox", checked: d.states.includes(k), onChange: () => toggle("states", k) }), " ", n,
          count(k) != null ? h("span", { className: "c" }, count(k)) : null))),
        h("div", { className: "meta" }, "Most roles in Canada need Canadian work authorization (citizenship, permanent residence or a work permit).")),
      // was: `No states picked: you'll see the baseline area (${IS.BASELINE.join(", ")}).`
      !d.states.length && h("div", { className: "meta" }, "No states picked, so your matches come from every state. That is a larger download (about 3 MB); picking states makes the list load faster."),
      h("fieldset", null, h("legend", null, "Work authorization"),
        h("div", { className: "checks" }, IS.WORK_AUTH.map(([k, l]) => h("label", { key: k, className: "check" },
          h("input", { type: "radio", name: "work_auth", checked: d.work_auth === k, onChange: () => set("work_auth", k) }), " ", l))),
        h("div", { className: "meta" }, "Used only on this page: it hides roles open to U.S. citizens only and flags roles that don't sponsor visas.")),
      signedIn && h("div", { className: "meta" }, "You're signed in, so your chosen states count toward where we scan in more detail."));

    // Escape closes the card (D13, 2026-10-14), as Cancel or "Skip for now" does, and the App puts focus back on
    // what opened it. A picker with its list open takes the Escape for itself first (it calls preventDefault).
    // On a phone the footer with Back, Next and Save sticks to the bottom of the screen (index.html .setup-foot):
    // step 3's Save used to be about 1,350 px below the step's top.
    // was: h("section", { className: "setup sheet", ref, "aria-label": "My profile" },
    return h("section", { className: "setup sheet", ref, "aria-label": "My profile",
      onKeyDown: e => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } } },
      h("div", { className: "setup-head" }, h("h2", null, firstTime ? "Set up InternScout" : "My profile"), dots),
      h("div", { key: step, ref: stepRef, tabIndex: -1, role: "group", "aria-label": `Profile step ${step} of 3: ${["About you", "What you want", "Where"][step - 1]}`, className: cx("step-body", dir) }, body),
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
    const [landingOpen, setLandingOpen] = useState(() => !IS.ls.get(LANDING_KEY, false));
    const initF = prof => ({ sort: prof ? "score" : "new", hide_citizen: !!(prof && prof.work_auth && prof.work_auth !== "citizen"), paid: prof && prof.paid_only ? "no_unpaid" : "" });
    // The landing pages under internships/ link here with ?field=a,b&state=MA, so the list opens on what the
    // student was reading; since U10 (2026-10-14) the dashboard writes its own filters to the address with
    // the same names, so a copied link or a reload opens the same list. IS.filtersFromUrl (core.js) takes
    // only well-formed values; an unknown tag or state matches nothing.
    // was: const fromLink = () => { ... field, state, company, new, stage, year and paid=1 ... };
    const fromLink = () => IS.filtersFromUrl(location.search);
    // The landing link, read once: its fields also prefill the setup card's Major (prefill below).
    const [link] = useState(fromLink);
    const [f, setF] = useState(() => ({ q: "", fields: [], states: [], company: [], where: "", stage: "", year: "", sector: "", status: "open", app_state: "", new_only: false, eligible: false, ...initF(IS.loadProfile()), ...link }));
    const [appStates, setAppStates] = useState(() => IS.ls.get(LS_KEY, {}) || {});
    const [saved, setSaved] = useState(() => IS.ls.get(SAVED_KEY, []) || []);
    const [openId, setOpenId] = useState(null);
    const [limit, setLimit] = useState(PAGE);
    const [sel, setSel] = useState(() => new Set());
    const [note, setNote] = useState("");
    // A classmate's invite code waiting for sign-in, and the student's own invite panel (worker/src/referral.js).
    const [invited, setInvited] = useState(() => IS.ls.get(IS.INVITE_KEY, null));
    const [invite, setInvite] = useState(null);
    const [inviteNote, setInviteNote] = useState("");
    // The one-time invite nudge (added 2026-10-02; core.js inviteNudgeDue): on for the rest of this page
    // load once a first Auto-Apply or first profile triggers it, until Not now or the panel opens.
    const [nudge, setNudge] = useState(false);
    // A browser may still have the previous core.js cached during deployment. The invitation is
    // optional; a missing new helper must never stop the internship dashboard from rendering.
    const digestPrompt = useRef(null);
    if (!digestPrompt.current) digestPrompt.current = typeof IS.createDigestNudge === "function"
      ? IS.createDigestNudge() : { claim: () => false, shown() {}, finish() {} };
    const [digestNudge, setDigestNudge] = useState(false);
    const [busy, setBusy] = useState("");
    const [ghToken, setGhToken] = useState(() => { try { return localStorage.getItem("internscout.gh_token") || ""; } catch (e) { return ""; } });
    // was: const [auth, setAuth] = useState(() => ({ cfg: null, token: IS.storedToken(), source: "page" }));
    // auth.token is the bearer sent to the Worker (a session code or an ID token); auth.who is
    // IS.authInfo() of the sign-in it came from ({ email, sub, exp, signin, session }), because a
    // session code can't be decoded the way an ID token could.
    const [auth, setAuth] = useState(() => { const t = IS.storedToken(); return { cfg: null, token: t, who: IS.authInfo(t), source: "page" }; });
    const signedIn = (x, source) => { const who = IS.authInfo(x); return who ? { token: who.token, who, source } : { token: null, who: null }; };
    // was (twice): IS.ext.call({ type: "auth:token" }, 1500).then(r => { if (r && r.token && IS.tokenOk(r.token)) setAuth(a => ({ ...a, token: r.token, source: "extension" })); });
    // The extension answers { token, email, account, expires } for a session and { token } for an ID token.
    const askExtension = () => IS.ext.call({ type: "auth:token" }, 1500).then(r => { if (r && r.token && IS.authOk(r)) setAuth(a => ({ ...a, ...signedIn(r, "extension") })); });
    const { info, queue, profile: extProfile } = useExtension();

    useEffect(() => { IS.ls.set(LANDING_KEY, true); }, []);
    // was: the landing page's filters were dropped from the address once read ("a reload after changing
    // filters should not bring the landing page's back"). The address now follows the filters instead
    // (the effect after the Stripe ones below), so a reload brings back the current ones.
    useEffect(() => {
      const q = new URLSearchParams(location.search);
      if (!q.has("ref")) return;
      // A classmate's invite (?ref=) waits in this browser until the student signs in (see the claim
      // effect below). Only a code shaped like the Worker's is kept.
      const ref = q.get("ref");
      if (ref && IS.INVITE_CODE.test(ref)) { IS.ls.set(IS.INVITE_KEY, ref); setInvited(ref); }
      q.delete("ref");
      history.replaceState(history.state, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
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
      const paint = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (live) setVer(st.version()); }); };
      // The first files redraw as they land (the list paints from the first one); the rest at most four
      // times a second, so 56 files arriving don't redraw the page 56 times.
      const bump = () => { if (!timer) timer = setTimeout(() => { timer = 0; paint(); }, 250); };
      setLoading(true); setFailedKeys([]);
      (async () => {
        // A first visit paints from the small first-screen file, then fetches the state files (P2).
        if (prime) { await st.primer(); if (!live) return; paint(); }
        const bad = await st.ensure(plan.first, () => { step(); paint(); });
        for (let i = 0; i < plan.rest.length && live; i += 4) bad.push(...await st.ensure(plan.rest.slice(i, i + 4), () => { step(); bump(); }));
        if (!live) return;
        clearTimeout(timer); cancelAnimationFrame(frame); frame = 0; setVer(st.version()); setLoading(false); setFailedKeys(bad || []);
      })();
      return () => { live = false; clearTimeout(timer); cancelAnimationFrame(frame); };
    }, [ready, planKey, retry]);

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
      IS.fetchWorkerConfig().then(cfg => setAuth(a => ({ ...a, cfg })));
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
    const [me, setMe] = useState(null);
    // An ID token lasts about an hour, a session until sign-out or a year unused. When either runs out
    // (or the Worker refuses it), stop showing "Signed in": take a fresh one from the extension if it
    // has one, otherwise show the sign-in buttons again.
    const dropToken = useCallback(() => {
      // was: IS.signOut(); setAuth(a => ({ ...a, token: null }));
      IS.signOut(); setAuth(a => ({ ...a, token: null, who: null }));
      if (info.installed) askExtension();
    }, [info.installed]);
    useEffect(() => {
      setMe(null);
      if (!auth.token) return;
      let live = true, last = Date.now();
      // was: ... else if (!IS.tokenOk(auth.token)) dropToken(); });
      // authOk is also false once the Worker has answered 401 for this token (a session it ended).
      const load = () => IS.fetchMe(auth.token).then(m => { if (!live) return; if (m) setMe(m); else if (!IS.authOk(auth.who)) dropToken(); });
      load();
      // was: const ms = ((IS.decodeJwt(auth.token) || {}).exp || 0) * 1000 - Date.now() - 60000;
      // was: const timer = setTimeout(dropToken, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      // An ID token ends within the hour. A session ends up to a year out, past the longest delay
      // setTimeout can hold (about 24.8 days), and the old cap would have signed it out at that
      // point. So a session only gets the timer once its end is within reach; before that the
      // Worker's 401 is what ends it.
      const ms = ((auth.who && auth.who.exp) || 0) - Date.now() - 60000;
      const timer = ms <= 2 ** 31 - 1 ? setTimeout(dropToken, Math.max(0, ms)) : 0;
      // Coming back to the tab after an Auto-Apply run: the "left this month" text should be current.
      const onVis = () => { if (document.visibilityState === "visible" && Date.now() - last > 60000) { last = Date.now(); load(); } };
      document.addEventListener("visibilitychange", onVis);
      return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
    }, [auth.token, dropToken]);

    // The extension's Upgrade button (a job paused on a used-up allowance) opens /?upgrade=<plan>.
    // Kept as a notice rather than sent straight on to Stripe: the student sees the plan and what it
    // gives, then presses checkout here themselves.
    const [upgradeAsk, setUpgradeAsk] = useState(() => new URLSearchParams(location.search).get("upgrade") || "");
    // The header's sign-in is one quiet button until pressed (2026-10-05); this is whether it has been.
    const [signInOpen, setSignInOpen] = useState(false);
    // was: the plans announcement (2026-10-04), shown above the list until dismissed (plansSeen, hidePlans).
    // Retired on 2026-10-14 (D16, decision 3): the quiet plans line under the counters says the same.
    // The extension notice under the list has a Hide button (D16); hidden for good in this browser.
    const [extHidden, setExtHidden] = useState(() => { try { return localStorage.getItem(EXT_NOTICE_KEY) === "hidden"; } catch (e) { return false; } });
    const hideExt = () => { try { localStorage.setItem(EXT_NOTICE_KEY, "hidden"); } catch (e) { } setExtHidden(true); };
    // The review line (2026-10-07): one quiet sentence for a student whose extension has filled a couple
    // of applications, asking for a Chrome Web Store review. Same words for everyone, nothing offered for
    // it. Hidden for good in this browser by "Hide" or by following it (one setting in local storage), and
    // never shown when the extension says the student already reviewed or chose "Don't ask again" there
    // (the ping's review_line; extension/lib/review.js). An extension too old to say falls back to whether
    // the queue holds a filled application.
    const [reviewHidden, setReviewHidden] = useState(() => { try { return localStorage.getItem(IS.REVIEW_LINE_KEY) === "hidden"; } catch (e) { return false; } });
    const hideReview = () => { try { localStorage.setItem(IS.REVIEW_LINE_KEY, "hidden"); } catch (e) { } setReviewHidden(true); };
    useEffect(() => { if (upgradeAsk) history.replaceState(null, "", location.pathname); }, []);

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

    // The filters in the address (U10, 2026-10-14; IS.filterSearch in core.js): only what differs from the
    // defaults, so with nothing set the address is plain. replaceState, not pushState: changing a filter
    // doesn't add a Back step, and Back from another page (or a reload) returns to the list as it was left.
    // Defined after the Stripe effects above, which clear the address on their first run.
    useEffect(() => {
      try {
        const search = IS.filterSearch(location.search, f, initF(p));
        if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash);
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
    const inviteOffer = auth.cfg && auth.cfg.invite;
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
      IS.claimInvite(auth.token, invited).then(r => {
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
          IS.fetchMe(auth.token).then(m => { if (m) setMe(m); });
        } else if (r.error && r.error !== "already_claimed" && r.message) setNote(r.message);
      });
    }, [auth.token, invited, !!inviteOffer]);
    async function openInvite() {
      if (invite) { setInvite(null); return; }
      setInviteNote("");
      const r = await IS.fetchInvite(auth.token);
      // was: if (r) setInvite(r); else setNote("Couldn't load your invite link. Try again in a minute.");
      // An opened panel (from the nudge or the Account menu) retires the nudge for good, and counts as the
      // "invite_open" step (worker/src/visits.js EVENTS), once per page load like every step.
      if (r) { setInvite(r); setNudge(false); IS.markInviteNudge("opened"); IS.count("invite_open"); }
      else setNote("Couldn't load your invite link. Try again in a minute.");
    }
    // A good moment just happened (first Auto-Apply queued, first profile saved): offer the invite
    // once, if it can be offered at all. Marked as shown straight away, so a reload never repeats it.
    function offerNudge() {
      if (nudge) return true;
      if (!IS.inviteNudgeDue({ signedIn: !!auth.token, offer: inviteOffer, panelOpen: !!invite, seen: IS.inviteNudgeSeen() })) return false;
      IS.markInviteNudge(); setNudge(true); return true;
    }
    function offerDigestNudge(action) {
      if (digestPrompt.current.claim(action, { enabled: digestOn, manual: true, blocked: !!(nudge || invite || outOfRuns || upgradeAsk) })) setDigestNudge(true);
    }
    function finishDigestNudge(how) {
      digestPrompt.current.finish(how); setDigestNudge(false);
    }
    async function shareInvite() {
      // was: const text = `InternScout finds internships for your major. Sign in through my link with your school Google account and we both get ${inviteWords}.`;
      // The Worker gives the .edu tier to any verified school email (Google, or a school Microsoft
      // account whose domain is verified), so eligibility is worded by email, not provider. Google is
      // still the recommended button: many school Microsoft tenants block unverified publishers.
      const text = `InternScout finds internships for your major. Sign in through my link with your school (.edu) email and we both get ${inviteWords}.`;
      if (navigator.share) {
        try { await navigator.share({ title: "InternScout", text, url: invite.link }); setInviteNote("Sent"); return; }
        catch (e) { if (e && e.name === "AbortError") return; }
      }
      try { await navigator.clipboard.writeText(invite.link); setInviteNote("Link copied"); }
      catch (e) { setInviteNote("Select the link above and copy it"); }
    }

    async function billing(kind, plan) {
      if (kind === "checkout") IS.count("checkout");
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
      // was: if (!p) IS.count("profile");   // the first profile on this device, not every edit
      if (!p) { IS.count("profile"); if (!offerNudge()) offerDigestNudge("profile"); } // manual first save; extension sync never prompts
      const s = IS.saveProfile(d);
      setP(s); setSetupOpen(false); setLimit(PAGE);
      setF(x => ({ ...x, states: [], ...initF(s) }));
      setNote(`Profile saved. Ranking for ${s.majors.length ? s.majors.join(", ") : s.fields.length ? s.fields.map(IS.fieldLabel).join(", ") : "all fields"}.`);
      setTimeout(() => setNote(""), 6000);
      // was: focus the search box and centre it, which put the filters mid-screen and, on a phone, the
      // keyboard over the matches. "Save and show matches" lands on the matches now: the top of the
      // list, with focus on its heading (2026-10-14).
      setTimeout(() => requestAnimationFrame(() => { const el = document.getElementById("listings"); if (el) { el.scrollIntoView({ block: "start", behavior: scrollBehavior() }); el.focus({ preventScroll: true }); } }), 0);
    }
    // Focus goes back to what opened the card when it closes (D13, 2026-10-14): the header button, the
    // first-visit line or a row's "Rank for my major". The search box when that is gone (the first-visit
    // line is, once skipped). was: always the search box.
    const setupOpener = useRef(null);
    const openSetup = useCallback(() => { setupOpener.current = document.activeElement; setSetupOpen(true); }, []);
    // was: if (!p) IS.ls.set(SKIP_KEY, true); setSetupOpen(false); ...
    function closeSetup() {
      if (!p) { IS.ls.set(SKIP_KEY, true); setSkipped(true); }
      setSetupOpen(false);
      setTimeout(() => {
        const o = setupOpener.current; setupOpener.current = null;
        const el = o && o.isConnected && o !== document.body ? o : document.getElementById("q");
        if (el) el.focus();
      }, 0);
    }
    async function deleteData() {
      // was: const msg = "Delete your InternScout profile from this browser" + (auth.token ? " and your chosen states and past usage from our server (this month's counts go when the month ends)" : "") + "? This can't be undone.";
      // DELETE /me now also removes the Deep Dive saved to the account and signs out every device.
      const msg = "Delete your InternScout profile from this browser" + (auth.token ? " and, from our server, your chosen states, past usage and the Deep Dive saved to your account, and sign you out everywhere (this month's counts go when the month ends)" : "") + "? This can't be undone.";
      if (!window.confirm(msg)) return;
      const r = await IS.deleteMyData(auth.source === "page" ? auth.token : auth.token);
      if (r.blocked) { setNote("Cancel your Supporter plan first (Manage plan), then delete. Nothing was deleted."); return; }
      setDigestNudge(false);
      // Statuses and saved searches are the student's own tracker, so they go only if they say so.
      if ((Object.keys(appStates).length || saved.length || ghToken) && window.confirm("Also delete your applied/saved statuses and saved searches from this browser? Cancel keeps them.")) {
        setAppStates({}); IS.ls.del(LS_KEY); keepSaved([]); IS.ls.del(SAVED_KEY);
        try { localStorage.removeItem("internscout.gh_token"); } catch (e) { } setGhToken("");
      }
      // was: setP(null); setAuth(a => ({ ...a, token: null })); setSetupOpen(false); IS.ls.del(SKIP_KEY);
      setP(null); setAuth(a => ({ ...a, token: null, who: null })); setSetupOpen(false); IS.ls.del(SKIP_KEY);
      setF(x => ({ ...x, states: [], ...initF(null) }));
      setNote(r.server === false ? "Deleted from this browser. The server delete failed; sign in again and retry, or open a GitHub issue." : (r.server ? "Your data was deleted from this browser and our server." : "Your profile was deleted from this browser.")
        + (info.installed ? " The extension keeps its own copy of your profile and files: removing it at chrome://extensions deletes that copy." : ""));
    }

    // The statuses as of the last render, for listeners added once (the "Did you apply?" check below).
    const appStatesRef = useRef(appStates); appStatesRef.current = appStates;
    const setAppState = useCallback((id, v) => setAppStates(m => { const n = { ...m, [id]: v }; if (v === "none") delete n[id]; IS.ls.set(LS_KEY, n); return n; }), []);
    // Queue updates and batch Auto-Apply also set statuses; only the student's own status control
    // can offer this invitation. Never perform prompt side effects inside a React state updater.
    // Stable, like the rows' other handlers: rows are memoized, and a new function here each render
    // redrew every row on every keystroke. The ref reads the current notices when it fires.
    // was: const setManualAppState = (id, v) => { ... } (a new function each render, review of #123).
    const offerDigestNudgeRef = useRef(offerDigestNudge); offerDigestNudgeRef.current = offerDigestNudge;
    const setManualAppState = useCallback((id, v) => {
      if (v === "interested" && appStatesRef.current[id] !== "interested") offerDigestNudgeRef.current("interested");
      setAppState(id, v);
    }, [setAppState]);
    const upd = (k, v) => { setF(s => ({ ...s, [k]: v })); setLimit(PAGE); };
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
    const clearFilters = () => { setF(s => ({ ...s, q: "", fields: [], states: [], company: [], where: "", stage: "", year: "", sector: "", status: "open", app_state: "", new_only: false, eligible: false, ...defaults })); setLimit(PAGE); };
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
    // anywhere: no states on the profile (or no profile), so no place scores above another.
    const ctx = useMemo(() => { const { direct, related } = IS.profileFields(p, majors); return { p, direct, related, keys: new Set(IS.profileKeys(p)), anywhere: !(p && p.states && p.states.length) }; }, [p, majors]);
    // Which of a listing's places the row shows first: one in the scope, or the place searched for.
    const keySet = useMemo(() => viewSet || new Set(qKeys), [viewSet, qKeysKey]);
    // was: rows in `keys` only. With every state in scope it is every row loaded (less remote-only rows
    // for a profile that turned remote off).
    const inView = useMemo(() => !viewSet
      ? (scope.noRemote ? all.filter(x => [...IS.shardKeys(x)].some(k => k !== "remote" && k !== "US")) : all)
      : all.filter(x => { for (const k of IS.shardKeys(x)) if (viewSet.has(k)) return true; return false; }), [all, viewSet, scope.noRemote]);
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
    const rows = listed.rows, ranked = listed.ranked;

    // Paid listings (2026-10-14, B2 plan section 5; js/placements.js). Everything above (the list, its order,
    // every score and count) is finished before this runs, and nothing here writes to it: ISPlace.pick only
    // reads the rows and names at most one of them for a separate box headed "Paid listing". That listing
    // stays in the list at its own place. The box needs a search or a Field filter (the context gate), waits
    // until the files have settled, and is off while "Your progress" is set. `exclude` is the saved profile's
    // only part: it can hide a paid listing that doesn't fit (class year, citizenship, eligibility, season),
    // never pick one. "Show paid listings" (More filters) is a display setting, not a filter: it is not in
    // `f`, so it never counts as a filter, never goes in a saved search or the address, and never touches
    // `rows`. With no placements.json, or CONFIG.placements === false, none of this shows.
    const PL = window.ISPlace;
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
    const placed = useMemo(() => PL ? PL.pick({ placements, rows, rel: listed.rel, ranked, fieldsSet: f.fields.length > 0, appState: f.app_state,
      loading, day: new Date().toISOString().slice(0, 10), exclude, hidden: placeHidden, prev: placedRef.current, rand: Math.random }) : null,
    [placements, listed, loading, placeHidden, exclude, f.fields.length, f.app_state]);
    if (placed) placedRef.current = placed;

    const shown = rows.slice(0, limit);
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
    const genText = gen ? new Date(gen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
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
      clearTimeout(selTimer.current); setSelNote(text);
      selTimer.current = setTimeout(() => setSelNote(""), 8000);
    }, []);
    useEffect(() => () => clearTimeout(selTimer.current), []);
    const check = useCallback((id, on) => {
      const n = new Set(selectionRef.current);
      if (on && !n.has(id) && n.size >= IS.SELECT_MAX) { flashSelNote(`Select up to ${IS.SELECT_MAX} applications at a time. Queue these first, then select more.`); return; }
      on ? n.add(id) : n.delete(id); selectionRef.current = n; setSel(n);
    }, []);
    const onWhy = useCallback(id => setOpenId(o => o === id ? null : id), []);
    // was: rows with no job of their own. A row whose apply link a job already holds is skipped by the
    // extension too, so the header checkbox no longer picks it.
    const held = useMemo(() => IS.heldUrls(queue), [queue]);
    const selectable = shown.filter(r => r.apply_url && (!jobs[String(r.id)] || jobs[String(r.id)].status === "failed") && !held.has(r.apply_url));
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
      setSel(s => new Set([...s].filter(id => !handledIds.has(String(id)))));
      // was: if (added) IS.count("autoapply");
      if (added) { IS.count("autoapply"); offerNudge(); }
      setNote(`Queued ${plural(added, "application")}${skipped ? ` (${skipped} already queued)` : ""}.${remaining.length ? ` ${remaining.length} more remain selected; queue them in the next batch.` : ""} Each one is filled in and left for you to submit.`);
      batch.forEach(r => { if (addedIds.has(String(r.id)) && st(r.id) === "none") setAppState(r.id, "interested"); });
      IS.ext.call({ type: "open_panel" });
      setTimeout(() => setNote(""), 9000);
      } catch (e) { setNote("Couldn't add applications to the queue. Your selections are kept; try again."); }
      finally { autoPending.current = false; setQueuing(false); }
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
    const payPlans = auth.cfg && auth.cfg.payments && auth.cfg.payments.enabled ? auth.cfg.payments.plans || [] : [];
    // Only what is actually a step up from the plan they are on: a Supporter sees Pro, not Supporter.
    const myMult = (payPlans.find(pl => pl.plan === (me && me.plan)) || {}).multiplier || 1;
    const upgrades = me && me.can_upgrade ? payPlans.filter(pl => pl.multiplier > myMult) : [];
    const upgradeTitle = pl => `Optional. Covers the AI bill and gives you ${pl.multiplier}× your monthly `
      + "AI allowance. Stripe takes the payment; we never see your card. Cancel any time.";
    // Out of Auto-Apply runs: say when they come back and how to get more now. Only for a real
    // allowance (limit > 0): a limit of 0 is Auto-Apply switched off, and limits.js won't spend
    // invite runs on a switched-off task, so "used up" and "invite a classmate" would both be wrong.
    const autoAllow = me && me.allowance && me.allowance.autofill;
    // was: ... && !me.paused && inviteOffer && autoAllow && ...: the notice only showed while invites were on,
    // so with invites off a student who ran out heard nothing. Now the invite is one of its options.
    const outOfRuns = !!(auth.token && me && !me.paused && autoAllow && autoAllow.limit > 0 && IS.leftOf(me, "autofill") === 0);
    // Kept as shown only once it is actually on screen, so a higher-priority notice (or setup) that
    // covers it until a reload doesn't use it up unseen. was: kept as shown when offered (review of #123).
    const digestVisible = !!(digestNudge && digestOn && !setupOpen && !nudge && !invite && !outOfRuns && !upgradeAsk);
    useEffect(() => { if (digestVisible && digestPrompt.current.shown) digestPrompt.current.shown(); }, [digestVisible]);
    // The review line (see reviewHidden above). It waits behind any other notice rather than stacking.
    const reviewLine = !reviewHidden && !note && !nudge && !digestNudge && !outOfRuns && !info.stale && IS.reviewLineDue(info, queue);
    // The next plan up and how many Auto-Apply runs it gives THIS student (the Worker's /me
    // upgrade_offer, at their tier; a Worker from before 2026-09-30 sends none, so no run count).
    const offerPl = upgrades.find(pl => me && me.upgrade_offer && pl.plan === me.upgrade_offer.plan) || upgrades[0] || null;
    const offerRuns = offerPl && me && me.upgrade_offer && me.upgrade_offer.plan === offerPl.plan && me.upgrade_offer.allowance
      ? me.upgrade_offer.allowance.autofill : null;
    // was: const offerBtn = (label) => offerPl && h("button", { ... offerPl ... });
    // `pl` lets the ?upgrade= notice offer the plan /pricing/ named rather than always the next one up.
    const offerBtn = (label, pl = offerPl) => pl && h("button", { type: "button", className: "btn primary", disabled: !!busy, title: upgradeTitle(pl),
      onClick: () => billing("checkout", pl.plan) }, label || `Get ${pl.label}${pl.price ? ` · ${pl.price}` : ""}`);
    // /pricing/ links here as /?upgrade=supporter or /?upgrade=pro (2026-10-05). The named plan, when it
    // is one this student can move up to; otherwise the next one up, as before.
    const askedPl = upgrades.find(pl => pl.plan === upgradeAsk) || offerPl;
    const askedRuns = askedPl && me && me.upgrade_offer && me.upgrade_offer.plan === askedPl.plan && me.upgrade_offer.allowance
      ? me.upgrade_offer.allowance.autofill : null;
    const offerWords = offerPl && (offerRuns ? `${offerPl.label} gives you ${offerRuns} a month. ` : `${offerPl.label} gives you ${offerPl.multiplier}× the allowance. `);
    // me.month is the Worker's UTC month ("2026-09"); the allowance resets on the 1st of the next one.
    const monthMatch = /^(\d{4})-(\d{2})$/.exec((me && me.month) || "");
    const resetDay = monthMatch
      ? new Date(Date.UTC(+monthMatch[1], +monthMatch[2], 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
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
      h("button", { key: pr.id, type: "button", className: "btn", onClick: () => IS.startSignIn(auth.cfg, pr.id), title: signInTitle }, `Sign in with ${IS.PROVIDER_LABELS[pr.id] || pr.id}`));
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
      setTimeout(() => { const el = document.getElementById("about"); if (el) { el.scrollIntoView({ block: "start", behavior: scrollBehavior() }); el.focus({ preventScroll: true }); } }, 0);
    };
    const howBtn = h("button", { type: "button", onClick: showAbout }, "How it works");
    // The hero's one action (2026-10-05): straight to the search box. A first visit has the setup card
    // open above the list; closing it is what Skip does, and the list is what was asked for.
    const goSearch = () => {
      if (setupOpen) closeSetup();
      setTimeout(() => { const q = document.getElementById("q"); if (q) { q.focus(); q.scrollIntoView({ block: "center" }); } }, 0);
    };
    const openCount = nationwide ? nationwide.toLocaleString() : null;
    // was: const firstVisit = setupOpen && !p; (the card opened by itself on a first visit). A first visit
    // gets one line offering the setup instead (2026-10-14), so a phone shows search and listings first.
    const setupAsk = !p && !setupOpen && !skipped;
    // The plans line (D2.3, 2026-10-05 audit): once the announcement is hidden, the price kept no
    // home on this page but the nav's Pricing link. One quiet line under the counters, from the same
    // /config numbers as the announcement (IS.plansBanner, never hardcoded), and nothing at all on a
    // paid plan or before /config answers, exactly as the announcement does.
    // was: plansSeen && IS.plansBanner(auth.cfg, me): only once the announcement was hidden. The
    // announcement is retired (D16), so this line is the price's one place on the page.
    const plansLine = IS.plansBanner(auth.cfg, me);
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
        genText && h("span", { className: "updated" }, "Updated ", genText, legacy ? " · single-file data" : "", ".")),
      plansLine && h("p", { className: "plansline" },
        `Plans: free with any email; ${plansLine.plans.map(pl => `${pl.label} ${pl.price}`).join(" and ")} raise the allowance. `,
        h("a", { href: "pricing/" }, "Prices")));
    // The setup card for a first profile opens prefilled from a landing page's ?field= (2026-10-14):
    // "Rank these for your major" on /internships/nursing/ arrives with Nursing as the major.
    const prefill = useMemo(() => {
      if (p || !link.fields || !link.fields.length) return null;
      const m = IS.majorForFields(link.fields, majors);
      return m ? { majors: [m] } : { fields: link.fields.slice() };
    }, [p, majors]);
    const setupEl = setupOpen && h(Setup, { key: p ? p.updated : "new:" + JSON.stringify(prefill), initial: p || prefill, majors, majorsReady, index, stats, statsReady, firstTime: !p, onSave: saveProfile, onClose: closeSetup, onDelete: deleteData, signedIn: !!auth.token });
    const setupAskEl = setupAsk && h("div", { className: "notice setup-ask" },
      h("button", { type: "button", className: "btn primary", onClick: openSetup }, prefill && prefill.majors ? `Rank these for ${prefill.majors[0]}` : "Rank these for your major"),
      h("span", null, "Three short steps. Your profile stays in this browser."),
      h("button", { type: "button", className: "btn quiet", onClick: () => { IS.ls.set(SKIP_KEY, true); setSkipped(true); } }, "Not now"));
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
    const liveText = loading || counting ? "" : rows.length ? `${rows.length.toLocaleString()} listing${rows.length === 1 ? "" : "s"}${anyFilter ? " match" : ""}${asked ? " " + asked : ""} in ${whereWords}.` : emptyText;
    const [spoken, setSpoken] = useState("");
    const firstF = useRef(f), touched = useRef(false);
    if (f !== firstF.current) touched.current = true;
    useEffect(() => {
      if (!touched.current || !liveText) return;
      const t = setTimeout(() => setSpoken(liveText), 900);
      return () => clearTimeout(t);
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
        if (document.visibilityState === "hidden") { o.left = true; return; }
        if (!o.left) return;
        opened.current = null;
        const s = appStatesRef.current[o.id] || "none";
        if (notYet.current.has(o.id) || (s !== "none" && s !== "interested")) return;
        setAskId(o.id);
        setSpoken(`Did you apply to ${o.company}? You can mark it under that listing.`);
      };
      document.addEventListener("visibilitychange", onVis);
      return () => document.removeEventListener("visibilitychange", onVis);
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
      setTimeout(() => { const el = document.getElementById("listings"); if (el && el.focus) el.focus(); }, 0);
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
        h("a", { href: IS.REVIEWS_URL, target: "_blank", rel: "noopener", onClick: () => { IS.ext.call({ type: "review_ask", action: "review" }); setTimeout(hideReview, 0); } }, "Leave a review"),
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
          h("nav", { className: "sitenav", "aria-label": "Site" },
            h("a", { href: "internships/" }, "Browse"),
            // Always shown, like the static nav before the app loads (no flash): /digest/ itself says
            // whether sign-ups are open. was: digestOn && h("a", ...) (review of #123).
            h("a", { href: "digest/?from=dashboard-nav", "data-digest-placement": "nav" }, "Weekly email"),
            h("a", { href: "install.html?from=dashboard-nav" }, "Auto-Apply (free)"),
            h("a", { href: "pricing/" }, "Pricing"),
            h("a", { href: "compare/" }, "Compare"),
            h("a", { href: "about/" }, "About"),
            // 2026-10-23: was: employers could only find the footer link. Revert: omit this anchor.
            h("a", { href: "employers/", "data-employer-entry": "nav" }, "Hire interns"))),
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
            allowLines: auth.token && me && me.allowance ? IS.allowanceText(me).split("\n") : [],
            resetDay: auth.token && me && me.allowance ? resetDay : null,
            spendText: info.spend && info.spend.calls > 0 ? `Estimated AI cost: $${info.spend.month_usd.toFixed(2)}${info.spend.budget ? ` of $${info.spend.budget}` : ""}` : null,
            items: [
              auth.token && inviteOffer && { key: "invite", group: "share", label: invite ? "Hide your invite link" : "Invite classmates", onClick: openInvite,
                desc: `You and each classmate who joins with a .edu email get ${inviteWords}.` },
              ...(auth.token ? upgrades.map(pl => ({ key: pl.plan, group: "plan", label: `${pl.label}${pl.price ? ` · ${pl.price}` : ""}`, onClick: () => billing("checkout", pl.plan),
                disabled: !!busy, title: upgradeTitle(pl), desc: `${pl.multiplier}× your monthly AI allowance. Cancel any time.` })) : []),
              auth.token && me && me.can_manage && { key: "manage", group: "plan", label: "Manage plan", onClick: () => billing("portal"), disabled: !!busy,
                desc: "Change your card or cancel, on Stripe's own page." },
              // was: onClick: () => { IS.signOut(); setAuth(a => ({ ...a, token: null })); }
              // signOut(true) also ends the session on the Worker, so the code can't be used again.
              auth.token && auth.source === "page" && { key: "out", group: "session", label: "Sign out", onClick: () => { IS.signOut(true); setAuth(a => ({ ...a, token: null, who: null })); } },
            ].filter(Boolean),
            admin: ADMIN ? [
              { key: "rescan", label: "Rescan", desc: "Run the scanner on GitHub now", onClick: rescan, disabled: !!busy },
              // js/count.js reads this setting when a page loads, so a change applies from the next load.
              // Raw localStorage, not IS.ls (which JSON-encodes): count.js and ?nocount=1 store a plain "1".
              { key: "nocount", label: noCount() ? "Count this browser's visits" : "Don't count this browser's visits",
                desc: "For your own visits, so they stay out of the analytics. Applies from the next page load.",
                onClick: () => { const off = noCount(); try { if (off) localStorage.removeItem(NOCOUNT_KEY); else localStorage.setItem(NOCOUNT_KEY, "1"); } catch (e) { }
                  setBusy(off ? "This browser's visits count again" : "This browser's visits won't be counted"); setTimeout(() => setBusy(""), 4000); } },
              ghToken && { key: "forget", label: "Forget token", onClick: () => { localStorage.removeItem("internscout.gh_token"); setGhToken(""); setBusy("Token cleared"); } },
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
      info.stale && h("div", { className: "notice" }, h("b", null, "The extension was reloaded or updated. "), h("a", { href: "#", onClick: prevent(() => location.reload()) }, "Reload this page"), " to reconnect Auto-Apply."),
      // was: info.installed && !info.onboarded && h("div", { className: "notice" }, h("b", null, "One step left: "), ...): topNotice above.
      note && h("div", { className: "notice", role: "status" }, note),
      // Always in the page, so a screen reader hears the message when it appears inside.
      h("div", { role: "status" }, selNote && h("div", { className: "selnote" }, h("span", null, selNote),
        h("button", { type: "button", "aria-label": "Close this message", onClick: () => { clearTimeout(selTimer.current); setSelNote(""); } }, h("span", { className: "i i-cross", "aria-hidden": true })))),
      // The one-time invite nudge (2026-10-02), right under the "Queued" or "Profile saved" note it follows.
      // It steps aside for the out-of-runs notice, which already offers the invite, and for the panel itself.
      nudge && auth.token && inviteOffer && !invite && !outOfRuns && h("div", { className: "notice", role: "status" },
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
      // The invite link hides while the invite panel below is already open; the plan buttons are in the header.
      // was: the invite came first and the plans were "above", which since the Account menu (2026-09-26)
      // they no longer are. The plan now has its own button here, and the invite follows when on.
      outOfRuns && h("div", { className: "notice" }, h("b", null, "This month's Auto-Apply runs are used up. "),
        `They come back on ${resetDay}. `,
        offerPl && h(F, null, offerWords, offerBtn(), " "),
        inviteOffer && (invite ? `${offerPl ? "Or share" : "Share"} your invite link below.` : h(F, null,
          h("a", { href: "#", onClick: prevent(openInvite) }, offerPl ? "Or invite a classmate" : "Invite a classmate"),
          // An inviter is rewarded for their first REFERRAL.maxRewards classmates only (worker/src/referral.js).
          `: they get ${inviteWords}, and so do you, for up to ${inviteOffer.max} classmates.`))),
      // Arrived from the extension's Upgrade button, with runs still left or before /me has loaded.
      !outOfRuns && upgradeAsk && h("div", { className: "notice" },
        !auth.token ? "Sign in (top right) to pick a plan. A plan raises how many Auto-Apply runs you get each month. "
          : !me ? "Loading your plan… "
          // was: offerPl ? ... offerRuns ... offerBtn("Continue to checkout") (always the next plan up)
          : askedPl ? h(F, null, h("b", null, `${askedPl.label}${askedPl.price ? ` · ${askedPl.price}` : ""}. `),
            askedRuns ? `${askedRuns} Auto-Apply runs a month. Cancel any time. ` : `${askedPl.multiplier}× the monthly AI allowance. Cancel any time. `,
            offerBtn("Continue to checkout", askedPl), " ")
          : `You're on the ${IS.PLAN_LABELS[me.plan] || me.plan} plan${me.plan === "free" ? "" : " already"}. `,
        h("a", { href: "#", onClick: prevent(() => setUpgradeAsk("")) }, "Not now")),
      auth.token && invite && h("div", { className: "notice invite" },
        h("b", null, "Invite classmates. "),
        // was: `Each classmate who signs in through your link with a school Google account in their first week gets ${inviteWords}, and so do you`
        `Each classmate who signs in through your link with a school (.edu) email in their first week gets ${inviteWords}, and so do you`
          + ` (for up to ${invite.max} classmates; ${invite.rewarded} so far).`,
        h("div", { className: "invite-row" },
          h("input", { id: "invite-link", type: "text", readOnly: true, value: invite.link, "aria-label": "Your invite link", onFocus: e => e.target.select() }),
          h("button", { type: "button", className: "btn primary", onClick: shareInvite }, navigator.share ? "Share link" : "Copy link"),
          inviteNote && h("span", { className: "muted", role: "status" }, inviteNote))),

      h("section", { id: "results", "aria-labelledby": "listings" },
      h("h2", { id: "listings", className: "sr", tabIndex: -1 }, "Listings"),
      digestVisible && h("div", { className: "notice quietnote", role: "note", "aria-label": "Weekly internship email" },
        "Want new internships in your inbox every Monday? ",
        h("a", { href: "/digest/?from=dashboard-contextual", "data-digest-placement": "contextual", onClick: () => finishDigestNudge("opened") }, "Get the free weekly email"),
        ". Everyone gets the same roundup. ",
        h("button", { type: "button", className: "linkbtn", "aria-label": "Dismiss weekly email invitation", onClick: () => finishDigestNudge("dismissed") }, "Dismiss")),
      // Two tiers. The first row is what nearly every visit touches: search, field, state, sort,
      // and the Auto-Apply button. The other nine controls sit behind "More filters", which shows
      // how many of them are set so nothing is hidden by surprise.
      h("div", { className: "filters", role: "search" },
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
        canAuto && h("button", { type: "button", className: "btn primary", disabled: !sel.size || queuing, onClick: () => autoApply(all.filter(r => sel.has(r.id))) }, queuing ? "Adding applications…" : "Auto-Apply", sel.size ? ` ${sel.size} selected` : "")),
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
      h("div", { className: "filterbar-foot" },
        // was: role=status on this span; the live region below says the count once it settles.
        h("span", { className: "countline" }, counting ? "Loading…" : h(F, null,
          loading ? `At least ${rows.length.toLocaleString()} listing${rows.length === 1 ? "" : "s"}${anyFilter ? " match" : ""} so far` : `${rows.length.toLocaleString()} listing${rows.length === 1 ? "" : "s"}${anyFilter ? " match" : ""}`,
          ` in ${whereWords}`,
          loading ? ` · loading ${pr.done} of ${pr.total} files` : "",
          !everything && h(F, null, " · ", h("button", { type: "button", className: "linkbtn", onClick: searchAll }, "Show every state")))),
        ranked && rows.length > 1 && h("span", { className: "muted" }, "Closest matches to your search first"),
        onlySearch ? h("button", { type: "button", className: "btn quiet", onClick: () => upd("q", "") }, "Clear search")
          : anyFilter && h("button", { type: "button", className: "btn quiet", onClick: clearFilters }, "Clear filters")),
      h("div", { className: "sr", role: "status", "aria-live": "polite", "aria-atomic": "true" }, spoken),

      // was: `Searching titles, companies and fields in ${keys.length} states. `
      // was: a notice above the list: "Searching titles, companies, fields and places in every state. [Search
      // descriptions too] (a larger download)". One line under the count now (D16), and the empty list offers
      // the same button as its main one (D18).
      descOffer && rows.length > 0 && h("div", { className: "descline" }, "Searching titles, companies, fields and places. ",
        h("button", { type: "button", className: "linkbtn", onClick: () => setDescAll(true) }, "Search descriptions too"), " (a larger download)."),
      wantDesc && descLoading && h("div", { className: "notice quietnote", role: "status" }, "Searching titles and fields while descriptions download…"),
      wantDesc && descFailed.length > 0 && h("div", { className: "notice", role: "alert" }, `Some descriptions couldn't load (${descFailed.join(", ")}). Search results may be incomplete. `,
        h("button", { type: "button", className: "btn quiet", onClick: () => setDescRetry(n => n + 1) }, "Retry descriptions")),
      failedKeys.length > 0 && h("div", { className: "notice", role: "alert" }, `Couldn't load listings for ${failedKeys.join(", ")}. Check your connection. `,
        h("button", { type: "button", className: "btn quiet", onClick: () => setRetry(n => n + 1) }, "Try again")),
      err ? h("div", { className: "sheet empty", role: "alert" }, "Couldn't load listings. Check your connection and try again. ",
        h("button", { type: "button", className: "btn", onClick: () => reload(false) }, "Retry listings"))
        : loading && !all.length ? h("div", { className: "sheet empty" }, "Loading listings…")
          // was: h("div", { className: "sheet empty" }, inView.length ? "Nothing matches these filters." : "No listings in these states yet. Try more states or remote.")
          : rows.length === 0 ? emptyEl
            // was: the skip link, the table, "End of the N listings shown" and "Show N more" inline here (ListTable now).
            : h(ListTable, { shown, rows, phone: narrow, box: placeBox, onMore: () => setLimit(l => l + PAGE), columns: canAuto ? 5 : 4,
              inlineSignup: digestOn && h(Digest, { cfg: C.digest, fields: digestFields, hasProfile: !!p, onSetup: openSetup, placement: "results-inline", compact: true }),
              head: h("thead", null, h("tr", null,
                canAuto && h("th", null, h("input", { type: "checkbox", "aria-label": "Select up to 100 shown applications", checked: allChecked, disabled: !selectable.length,
                  onChange: e => selectShown(e.target.checked) })),
                // was: Company and role, Field, Location and term, Pay, Match, Your status, Links. Field, place, term
                // and pay are one line under the title now (D9); "Sort: pay listed" stays in the Sort picker.
                sortTh("company", "Company and role"), sortTh("score", "Match"), h("th", { scope: "col" }, h("span", { className: "sr" }, "Links")), h("th", { scope: "col" }, "Your status"))),
              renderRow: r => h(Row, { key: r.id, r, sc: scoreOf(r), ctx, keys: keySet, state: st(r.id), onState: setManualAppState, job: jobs[String(r.id)],
                checked: sel.has(r.id), onCheck: check, canAuto, canTry, onAuto: onAutoRow, queueBusy: queuing, open: openId === r.id, onWhy, onRank: openSetup, elig, patterns: stats && stats.skill_patterns,
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
          h("a", { href: C.handshakeUrl, target: "_blank", rel: "noopener" }, "Also check Handshake"),
          h("a", { href: C.reuUrl, target: "_blank", rel: "noopener" }, "NSF REU research"),
          C.campusJobsUrl && h("a", { href: C.campusJobsUrl, target: "_blank", rel: "noopener" }, "UMass campus jobs"),
          // was: signInBtn (the same two buttons the header showed; the header's is one quiet button now)
          signInProviders)));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
