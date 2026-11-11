// Listing rows, explanations and table rendering.

export function createRows(browser, {
    h, IS, useRef, useEffect, useMemo, daysAgo, checks, F, cx, ATS, postedTime, ago, useState,
    SUPPORTED_ATS, ACTIVE, daysUntil, fmtDay, blockers, APP_STATES, opt, STATE_LABEL,
    JOB_LABEL, installUrl, PAGE,
  }) {
  const graphemes = typeof browser.Intl.Segmenter === "function" ? new browser.Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const companyHue = name => { let hash = 0; for (const c of name.toLowerCase()) hash = (hash * 31 + c.codePointAt(0)) >>> 0; return hash % 360; };
  function CompanyTile({ name }) {
    const label = String(name || "").trim().normalize("NFC");
    const initial = label ? (graphemes ? graphemes.segment(label)[Symbol.iterator]().next().value.segment : Array.from(label)[0]) : "?";
    return h("span", { className: "company-tile", "aria-hidden": true, style: { "--company-hue": companyHue(label) } }, initial.toUpperCase());
  }

  function compactLocation(g, raw) {
    if (!g) return raw;
    const names = g.kind === "canada" ? IS.CA_PROVINCES : IS.US_STATES;
    const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f.\s]/g, "").toLowerCase();
    const country = g.kind === "canada" ? ["canada"] : ["us", "usa", "unitedstates", "unitedstatesofamerica"];
    let text = raw;
    if (g.kind !== "remote" && names[g.state]) {
      const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
      const suffix = s => { const n = norm(s.replace(/\s*\(remote\)$/i, "")); return n === norm(g.state) || n === norm(names[g.state]) || country.includes(n); };
      // Keep the first token: New York and Washington can be city names as well as states.
      while (parts.length > 1 && suffix(parts[parts.length - 1])) parts.pop();
      text = parts.join(", ");
      if (!parts.some(s => norm(s) === norm(g.state))) text += ", " + g.state;
    }
    if (g.kind === "canada" && !/\bcanada\b/i.test(text)) text += ", Canada";
    if ((g.kind === "remote" || g.remote || /\(remote\)/i.test(raw)) && !/\bremote\b/i.test(text)) text += " (remote)";
    return text;
  }

  // The listing's place, inline, for the row's facts line (D9, 2026-10-14): "Boston, MA +2". was: two
  // stacked lines in a Location column (the place, then its state or "Remote" under it).
  function Loc({ r, keys }) {
    const all = IS.regs(r), g = all.find(x => keys.has(x.state) || (x.kind === "remote" && keys.has("remote"))) || all[0];
    // was: || "—". A muted word says what is missing; a bare dash only says something is.
    const first = g ? g.loc : ((r.location_raw || "").split(";")[0].trim() || null);
    if (!first) return h("span", { className: "muted" }, "Location not listed");
    const more = Math.max(0, all.length - 1);
    return h("span", { title: all.map(x => x.loc).join("; ") || first }, compactLocation(g, first),
      more > 0 && h("span", { className: "muted" }, " +" + more + " more"));
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
    const boardCode = String(r.ats || "").trim(), board = boardCode && !/^other$/i.test(boardCode) ? ATS[boardCode.toLowerCase()] || boardCode : null;
    const dates = h("div", { className: "meta" }, postedTime(r.posted_at) || "Posting date not listed", seen != null ? ` · first seen ${ago(seen)}` : "", r.sector ? ` · ${IS.sectorLabel(r.sector)} sector` : "", board ? ` · Job board: ${board}` : "");
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
    const pay = IS.realSalary(r) ? h("span", { className: "num pay-badge" }, IS.realSalary(r)) : IS.payOf(r) === "stipend" ? h("span", { className: "pay-badge" }, "Stipend") : IS.payOf(r) === "unpaid" ? h("span", { className: "closed pay-badge" }, "Unpaid") : "Pay not listed";
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
  const Row = browser.React.memo(function Row({ r, sc, ctx, keys, state, onState, job, checked, onCheck, canAuto, canTry, onAuto, queueBusy, open, onWhy, onRank, elig, patterns, ask, onOpen, onAnswer, saved, onSave, myList, fresh, missingText }) {
    const [aaOpen, setAaOpen] = useState(false);
    const whyBtn = useRef(), statusSel = useRef();
    const asking = !!ask && (state === "none" || state === "interested") && !job;
    const needsAccess = canAuto && !r._savedMissing && !!r.apply_url && !SUPPORTED_ATS.has(r.ats);
    // Who the row is, for the names of its repeated controls (U12): "Open posting, Acme, Data Intern".
    const who = `${r.company_name}, ${r.title}`;
    // The line goes once answered; focus moves to the row's status, which now shows the answer, rather
    // than falling back to the top of the page.
    const focusProgress = () => browser.setTimeout(() => { const target = statusSel.current || browser.document.getElementById("listings"); if (target && target.focus) target.focus(); }, 0);
    const answer = applied => { onAnswer(r.id, applied); focusProgress(); };
    const tryAuto = !canAuto && canTry && !r._savedMissing && r.apply_url && SUPPORTED_ATS.has(r.ats);
    const scored = !!ctx.p;
    const active = job && ACTIVE.includes(job.status);
    const dl = r.insights && r.insights.deadline;
    const stages = (r.stage || []).filter(s => s !== "internship").map(s => IS.STAGE_LABEL[s] || s);
    const posted = postedTime(r.posted_at);
    const dates = [dl && daysUntil(dl) >= 0 && `Apply by ${fmtDay(dl)}`, ...stages, r.sector && IS.sectorLabel(r.sector), r.carried && "Not re-checked this scan"].filter(Boolean).join(" · ");
    const bl = elig ? blockers(r, elig).filter(t => !/^For /.test(t)) : [];
    const cols = canAuto ? 5 : 4;
    const dot = h("span", { className: "dot-sep", "aria-hidden": true }, " · ");
    const closeWhy = () => { onWhy(r.id); browser.setTimeout(() => { if (whyBtn.current && whyBtn.current.focus) whyBtn.current.focus(); }, 0); };
    const whyKey = e => { if (e.key === "Escape" && open) { e.preventDefault(); onWhy(r.id); } };
    return h(F, null,
      h("tr", { id: "listing-" + r.id, tabIndex: -1, className: cx(checked && "sel", open && "opened", sc.mismatch && "dim") },
        // was: "aria-label": "Select " + r.company_name, the same name on every row from one employer.
        canAuto && h("td", { className: "c-chk" }, h("input", { type: "checkbox", "aria-label": `Select ${r.company_name}, ${r.title}`, checked,
          disabled: r._savedMissing || !r.apply_url || active || (job && job.status === "submitted"), onChange: e => onCheck(r.id, e.target.checked) })),
        h("td", { className: "c-co" },
          // A badge that says New has to mean new and still open: is_new alone is only the scan window, and
          // the export keeps closed rows too.
          h("div", { className: "li-head" }, h(CompanyTile, { name: r.company_name }), h("span", { className: "co" }, r.company_name), fresh && h("span", { className: "new" }, "New since your last visit"),
            h("span", { className: "sr" }, ", "), dot, h("span", { className: "role" }, r.title)),
          // was: the facts line built here; factsLine (above) since 2026-10-14, shared with the paid box.
          r._savedMissing ? h("div", { className: "meta" }, missingText) : factsLine(r, keys),
          (posted || dates || r.status === "closed") && h("div", { className: "meta" }, posted, posted && dates ? " · " : "", dates, r.status === "closed" && h("span", { className: "closed" }, (posted || dates ? " · " : "") + "Closed")),
          sc.mismatch && h("div", { className: "meta" }, h("span", { className: "closed" }, `Not for your year: for ${IS.yearsText(r.years)}`)),
          bl.length > 0 && h("div", { className: "meta" }, h("span", { className: "closed", title: bl.join("; ") }, "May not be eligible: " + bl[0]))),
        // was: the score button (or Rank for my major and Details) built here; matchControl (above) since
        // 2026-10-14, shared with the paid box so both show the one score from the same scoreOf.
        h("td", { className: "c-match" }, !r._savedMissing && matchControl({ r, sc, scored, open, onToggle: () => onWhy(r.id), onRank, btnRef: whyBtn, onKeyDown: whyKey, panelId: "why-" + r.id })),
        h("td", { className: "c-links" },
          // data-aa (2026-10-13): an application Auto-Apply fills, so js/offer.js may offer the extension
          // when this is opened. The same rule as the row's "Auto-Apply" explainer (SUPPORTED_ATS).
          // was: an underlined link; a secondary button now (D9), with the shared external-link icon.
          // was: named "Open posting (opens in a new tab)" and "Auto-Apply" on every row; the row is in the name now (U12).
          // onOpen (U9): remembered so the page can ask "Did you apply?" when the student comes back.
          r.apply_url ? h("a", { className: "open-link", href: r.apply_url, target: "_blank", rel: "noopener", "data-aa": SUPPORTED_ATS.has(r.ats) ? "" : undefined, onClick: () => onOpen(r) },
            "Open posting", h("span", { className: "i i-external", "aria-hidden": true }), h("span", { className: "sr" }, `, ${who} (opens in a new tab)`)) : h("span", { className: "muted" }, "No link"),
          !job && canAuto && !r._savedMissing && r.apply_url && h("button", { type: "button", className: "rowbtn", title: "Fills from your resume. You review and submit.", disabled: queueBusy, onClick: () => onAuto([r]), "aria-describedby": needsAccess ? "acc-" + r.id : undefined },
            "Auto-Apply", h("span", { className: "sr" }, ": " + who)),
          !job && needsAccess && h("span", { className: "aa-note", id: "acc-" + r.id, title: "This application is on the employer's own site. The first time, Auto-Apply asks you to allow that one site." }, "asks for site access"),
          tryAuto && h("button", { type: "button", className: "rowbtn try", title: "Fills from your resume. You review and submit.", "aria-expanded": aaOpen, "aria-controls": "aa-" + r.id, onClick: () => setAaOpen(o => !o) }, "Auto-Apply", h("span", { className: "sr" }, ": " + who))),
          // was: h("div", null, h("a", { className: "report", ... }, "Report")): in the Why panel only now (D11).
        h("td", { className: "c-mine" },
          // was: "aria-label": "Your status" on all 150 selects, then "Your status for " + r.title (two employers'
          // "Software Engineering Intern" rows read the same).
          h("button", { type: "button", className: cx("btn small save-role", saved && "on"), ref: !myList ? statusSel : undefined,
            "aria-pressed": !!saved, "aria-label": `Save ${r.title} at ${r.company_name}`, onClick: () => onSave(r) }, saved ? "Saved" : "Save"),
          myList && h("select", { className: "mine", ref: statusSel, "aria-label": `Your status for ${r.title} at ${r.company_name}`, value: state, onChange: e => { onState(r.id, e.target.value); focusProgress(); } }, APP_STATES.map(s => opt(s, STATE_LABEL[s]))),
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
      const t = browser.setTimeout(() => { sent.current = text; onChange(text); }, 200);
      return () => browser.clearTimeout(t);
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
  // Runs, not a company-wide bucket: a later appearance of the same employer is independent.
  // Work only on the current page; grouping never changes ordering, matching or pagination.
  function companyRuns(rows, filters, expanded = new Set()) {
    const shown = [], moreAfter = new Map();
    if (filters.sort !== "new" || filters.q.trim()) return { shown: rows, moreAfter };
    for (let start = 0; start < rows.length;) {
      const company = rows[start].company_name, key = String(rows[start].id);
      let end = start + 1;
      while (company && end < rows.length && rows[end].company_name === company) end++;
      const cut = expanded.has(key) ? end : Math.min(start + 2, end);
      shown.push(...rows.slice(start, cut));
      if (cut < end) moreAfter.set(rows[cut - 1].id, { key, company, count: end - cut, firstHidden: rows[cut].id });
      start = end;
    }
    return { shown, moreAfter };
  }

  function ListTable({ shown, rows, head, renderRow, box, phone, onMore, inlineSignup, columns = 4, moreAfter = new Map(), onExpand, pageCount = shown.length }) {
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
          moreAfter.has(r.id) && h("tr", { key: "company-run-" + moreAfter.get(r.id).key, className: "company-run" }, h("td", { colSpan: columns },
            h("button", { type: "button", className: "btn quiet", "aria-expanded": false,
              "aria-label": `Show ${moreAfter.get(r.id).count} more listing${moreAfter.get(r.id).count === 1 ? "" : "s"} from ${moreAfter.get(r.id).company}`,
              onClick: () => onExpand(moreAfter.get(r.id)) }, `${moreAfter.get(r.id).count} more from ${moreAfter.get(r.id).company}`))),
          phone && box && i === at && h("tr", { key: "placement", className: "paid-row" }, h("td", { colSpan: 5 }, box)),
          inlineSignup && i === signupAt && h("tr", { key: "weekly-email", className: "digest-in-list" }, h("td", { colSpan: columns }, inlineSignup))
        ].filter(Boolean)))))),
      h("div", { id: "list-end", className: "sr", tabIndex: -1 }, `End of the ${shown.length.toLocaleString()} listings shown`),
      rows.length > pageCount && h("div", { className: "more" }, h("button", { type: "button", className: "btn", onClick: onMore }, `Show ${Math.min(PAGE, rows.length - pageCount)} more`)));
  }

  // The notice that paid listings have started (S8, 2026-10-14; the privacy page promises a dashboard notice for
  // big changes). Shown once there are placements, until the student hides it or follows its link; kept
  // hidden in this browser (PLACE_NOTICE_KEY), never sent. It takes the one notice place above the list only
  // when nothing more urgent has it (D16); otherwise it waits under the list.

  return {
    CompanyTile, compactLocation, Loc, Why, factsLine, matchControl, Row, SearchBox,
    companyRuns, ListTable,
  };
}
