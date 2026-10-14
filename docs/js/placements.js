// InternScout paid listings ("placements") on the dashboard. Plain browser JS, no build step (2026-10-14,
// B2 plan section 5, rows S6 to S8 of the 2026-10-14 approvals).
//
// The rule: payment never changes any score, order, filter, count or what Auto-Apply does. So this file
// sits outside the ranking code. app.js builds its list first (IS.listRows in core.js, which never names
// this file), then hands the finished rows to pick(), which only reads them and says which one paid
// listing, if any, the student may also see in a separate box. The same listing stays in the results at
// its usual place, with the same Match score.
//
// The code says "placement", never "paid": "paid" already means a role that pays (the Pay filter,
// IS.payOf). Only the words a student reads say "Paid listing" and "Ad".
//
// Where the data comes from: the site build writes /data/placements.json from the Worker's public list
// (backend/internscout/seo_pages.py write_placements, after placements.resolve has checked each one
// against the listings). When the file is missing, empty or malformed, nothing shows and nothing is said.
// CONFIG.placements === false in index.html turns the whole thing off without a fetch.
//
// What selection may read: the placements, the student's own filtered and sorted rows, each row's search
// relevance, whether a search or a Field filter is set, today's date, and a hide-only check app.js passes
// in (the saved profile can take a paid listing away, never choose one). Nothing here reads the extension,
// the sign-in, the Deep Dive, the student's marks or anything else in the browser, and nothing is sent.
(function () {
  "use strict";

  // One paid box per page. The Worker's page_cap column is held at 1 too.
  const MAX_PER_PAGE = 1;
  // With a search, a paid listing must already be among the 50 best matches by relevance.
  const FLOOR_RANK = 50;
  // "Show paid listings" off, kept in this browser only (IS.ls in app.js) and never sent.
  const HIDE_KEY = "internscout.placements.hidden.v1";
  const FILE = "placements.json";
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  // The same apply link, a trailing slash aside (backend placements.same_url).
  const sameUrl = (a, b) => { a = String(a || "").trim().replace(/\/+$/, ""); b = String(b || "").trim().replace(/\/+$/, ""); return !!a && a === b; };

  // The well-formed placements in a placements.json body, public fields only. Anything else is dropped.
  function clean(body) {
    const list = body && Array.isArray(body.placements) ? body.placements : [];
    const out = [], seen = new Set();
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.id !== "string" || !ID_RE.test(p.id) || seen.has(p.id)) continue;
      if (typeof p.listing_id !== "string" || !p.listing_id) continue;
      if (typeof p.apply_url !== "string" || !/^https:\/\//.test(p.apply_url)) continue;
      if (typeof p.start !== "string" || !DAY_RE.test(p.start) || typeof p.end !== "string" || !DAY_RE.test(p.end)) continue;
      seen.add(p.id);
      out.push({ id: p.id, listing_id: p.listing_id, apply_url: p.apply_url, employer: typeof p.employer === "string" ? p.employer : "", start: p.start, end: p.end });
    }
    return out;
  }

  // Which paid listing, if any, may show beside these rows. Reads only its argument:
  //   placements: clean()'s list; rows: the student's list (IS.listRows); rel and ranked: its relevance
  //   Map and whether the search has words to rank by; fieldsSet: a Field filter is set; appState: the
  //   "Your progress" filter; loading: files still arriving; day: today (UTC, YYYY-MM-DD); exclude(x): the
  //   hide-only check; hidden: "Show paid listings" is off; prev: the last pick; rand: Math.random.
  // Returns { pl, x } (the placement and its row) or null. Never writes to anything it is given.
  function pick(inp) {
    if (inp.hidden || inp.loading) return null;                 // hidden; and decided once the files settle
    if (inp.appState) return null;                              // the student's own marks never choose an ad
    if (!inp.ranked && !inp.fieldsSet) return null;             // only once the student has said what they want
    const placements = inp.placements || [];
    if (!placements.length) return null;
    const rows = inp.rows, at = new Map();
    for (let i = 0; i < rows.length; i++) at.set(String(rows[i].id), i);
    // The 50th best relevance among the rows, whatever the sort (the company sort is not relevance order).
    let floor = -Infinity;
    if (inp.ranked && rows.length) {
      const v = rows.map(x => inp.rel.get(x)).sort((a, b) => b - a);
      floor = v[Math.min(FLOOR_RANK, v.length) - 1];
    }
    const ok = [];
    for (const pl of placements) {
      if (!(pl.start <= inp.day && inp.day < pl.end)) continue;            // its dates
      const i = at.get(String(pl.listing_id)); if (i == null) continue;    // in the student's own rows
      const x = rows[i];
      if (x.status !== "open" || !sameUrl(x.apply_url, pl.apply_url)) continue;
      const dl = x.insights && x.insights.deadline;
      if (dl && String(dl).slice(0, 10) < inp.day) continue;
      if (inp.ranked && !(inp.rel.get(x) >= floor)) continue;             // already a close match
      if (inp.exclude(x)) continue;                                        // the profile may only hide
      ok.push({ pl, x });
    }
    if (!ok.length) return null;
    // The same one as last time while it still fits, so the box doesn't change as files land.
    const keep = inp.prev && ok.find(o => o.pl.id === inp.prev.pl.id);
    if (keep) return keep;
    // Equal chance for each, never by price or score. MAX_PER_PAGE is 1, so one.
    return ok[Math.min(ok.length - 1, Math.floor(inp.rand() * ok.length))];
  }

  // placements.json, fetched once per page load, with no retry, fallback or message. Resolves to clean()'s list.
  let loading = null;
  function load() {
    if (loading) return loading;
    const C = window.CONFIG || {};
    if (C.placements === false || typeof fetch !== "function") return (loading = Promise.resolve([]));
    loading = fetch((C.dataUrl || "./data/") + FILE, { cache: "no-cache" })
      .then(r => r && r.ok ? r.json() : null)
      .then(clean)
      .catch(() => []);
    return loading;
  }

  // The box (B1 product design 4.1 and 4.2). Its parts come from app.js so the facts and the Match control
  // are the organic row's own (the same helpers, the same scoreOf), never a second copy:
  //   x: the row; facts: the row's grey facts line; renderMatch(open, toggle): the Match control;
  //   renderWhy(close): the Why panel; onHide: "Hide paid listings"; phone: the narrow layout.
  // It has no checkbox, no status, no Auto-Apply button and no data-aa (so js/offer.js never pitches the
  // extension from it), and its link is rel="sponsored noopener".
  function PaidBox({ x, facts, renderMatch, renderWhy, onHide, phone }) {
    const React = window.React, h = React.createElement, F = React.Fragment;
    const [why, setWhy] = React.useState(false);
    const [about, setAbout] = React.useState(false);
    const id = "pl-" + String(x.id).replace(/[^A-Za-z0-9_-]/g, "");
    const who = `${x.company_name}, ${x.title}`;
    return h("section", { className: cx("paid", phone && "phone"), "aria-label": "Paid listing, not part of the ranked results" },
      h("div", { className: "paid-top" },
        h("h3", { className: "paid-h" }, "Paid listing"),
        h("button", { type: "button", className: "linkbtn quietlink", "aria-expanded": about, "aria-controls": id + "-about", onClick: () => setAbout(o => !o) }, "Why am I seeing this?"),
        h("button", { type: "button", className: "linkbtn quietlink", onClick: onHide }, "Hide paid listings")),
      about && h("div", { className: "paid-about", id: id + "-about" },
        h("p", null, "An employer paid to show this listing here. Paying doesn't change match scores, order or filters. It showed because it fits your search and filters, and it also appears in the results at its usual place. Your saved profile can hide a paid listing that doesn't fit you, but it is never used to pick one, and it stays in your browser."),
        // was: href "privacy.html#paid", which is the paid plans section; the ad disclosure is #paid-listings.
        h("p", null, h("a", { href: "privacy.html#paid-listings" }, "More about paid listings"))),
      h("div", { className: "paid-body" },
        h("div", { className: "paid-main" },
          h("div", { className: "li-head" }, h("span", { className: "ad" }, "Ad"), " ", h("span", { className: "co" }, x.company_name),
            h("span", { className: "sr" }, ", "), h("span", { className: "dot-sep", "aria-hidden": true }, " · "), h("span", { className: "role" }, x.title)),
          facts,
          h("div", { className: "meta" }, phone ? "Also in the list at its usual place." : "Also in the results below at its usual place.")),
        h("div", { className: "paid-acts" },
          renderMatch(why, () => setWhy(o => !o), id + "-why"),
          h("a", { className: "open-link", href: x.apply_url, target: "_blank", rel: "sponsored noopener" },
            "Open posting", h("span", { className: "i i-external", "aria-hidden": true }), h("span", { className: "sr" }, `, ${who}, paid listing (opens in a new tab)`)))),
      why && h("div", { className: "paid-why", id: id + "-why" }, renderWhy(() => setWhy(false))));
  }
  const cx = (...a) => a.filter(Boolean).join(" ");

  window.ISPlace = { pick, PaidBox, load, clean, HIDE_KEY, MAX_PER_PAGE, FLOOR_RANK };
})();
