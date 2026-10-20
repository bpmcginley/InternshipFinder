// The employer buy page, /employers/buy/ (added 2026-10-19; worker/ORDERS.md). An employer picks one of
// its open roles, or three, a start day, and gives a work email; the Worker emails a link, and that link
// brings them back here to confirm the address and go on to Stripe. The same page shows where Stripe and
// the Worker's emails send people back to: ?order=&t= (confirm the email), ?paid=, ?cancelled=1 and
// ?credit=&t= (a role closed early: refund or credit).
//
// What it asks the Worker (worker/src/orders.js), and nothing else:
//   GET  /employer/config                      prices (cents), days, field_cap, max_start_days, terms_version
//   GET  /employer/availability?shard=&ids=&start=
//   POST /employer/order                       {name, email, company, public_body, package, shard, listing_ids,
//                                               start, accept_terms, terms_version, pilot_code, website}
//   POST /employer/order/confirm               {order, token} -> {url} (Stripe) or {done: "pilot"}
//   GET  /employer/credit?credit=&t=           the unused-days offer
//   POST /employer/credit                      {credit, token, choice: "refund" or "credit"}
// and two site files from the build (backend/internscout/role_index.py): /data/roles/index.json and
// /data/roles/<shard>.json. Prices always come from /employer/config, never from this file.
//
// Everything that comes from data (company names, titles, places, server messages) goes on the page as
// text (textContent), never as HTML. The pure parts are on window.ISBuy for tests/site/buy.test.mjs; the
// page part runs only when the page has <main id="buy">.
(function (root) {
  "use strict";
  var API = "https://internscout-api.bpmcginley.workers.dev";
  var CONTACT = "brucepmcginley@gmail.com";
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
  var SAFE_ID = /^[A-Za-z0-9_.~-]{1,200}$/;

  // ---------- pure helpers (tested) ----------

  // Lower case, accents and punctuation gone, "&" read as "and": "Procter & Gamble" finds "procter and".
  function norm(s) {
    s = String(s == null ? "" : s).toLowerCase();
    if (s.normalize) s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    return s.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  }

  // The employer list from /data/roles/index.json, keeping only entries this page can use: a key, a name
  // and a one-character shard (a-z, 0-9 or _), so a shard can never be a path.
  function prepareIndex(data) {
    var list = data && Array.isArray(data.employers) ? data.employers : [];
    var out = [];
    list.forEach(function (e) {
      if (!e || typeof e.k !== "string" || !e.k || typeof e.n !== "string" || !e.n.trim()) return;
      if (typeof e.s !== "string" || !/^[a-z0-9_]$/.test(e.s)) return;
      out.push({ k: e.k, n: e.n.trim(), c: Number(e.c) > 0 ? Math.floor(Number(e.c)) : 0, s: e.s, key: norm(e.n) });
    });
    return out;
  }

  // Type-ahead: names that start with the query first, then a word that starts with it, then anywhere
  // (spaces ignored); within each, the employer with more open roles first, then by name.
  function searchEmployers(list, query, limit) {
    var q = norm(query);
    if (!q) return [];
    var flat = q.replace(/ /g, "");
    var hits = [];
    (list || []).forEach(function (e) {
      var key = e.key != null ? e.key : norm(e.n);
      var tier = key.indexOf(q) === 0 ? 0 : (" " + key).indexOf(" " + q) >= 0 ? 1 : key.replace(/ /g, "").indexOf(flat) >= 0 ? 2 : -1;
      if (tier >= 0) hits.push({ e: e, tier: tier });
    });
    hits.sort(function (a, b) { return a.tier - b.tier || (b.e.c || 0) - (a.e.c || 0) || (a.e.n < b.e.n ? -1 : a.e.n > b.e.n ? 1 : 0); });
    return hits.slice(0, limit || 8).map(function (h) { return h.e; });
  }

  // One employer's open roles from its shard file, by title.
  function rolesFor(shard, key) {
    var list = shard && Array.isArray(shard.roles) ? shard.roles : [];
    return list.filter(function (r) { return r && r.k === key && r.id != null && typeof r.t === "string" && r.t.trim(); })
      .sort(function (a, b) { var x = a.t.toLowerCase(), y = b.t.toLowerCase(); return x < y ? -1 : x > y ? 1 : String(a.id) < String(b.id) ? -1 : 1; });
  }

  // The same field names the dashboard uses (docs/js/core.js fieldLabel). A role with no field tag counts
  // under "other", as the Worker counts it.
  var FIELD_NAMES = { swe: "Software", ml: "ML / AI", pm: "Product / program mgmt", hr: "HR", ui: "UI", ux: "UX", co_op: "Co-op" };
  function fieldLabel(t) {
    t = String(t || "");
    if (!t) return "";
    return FIELD_NAMES[t] || (t.length <= 3 ? t.toUpperCase() : (t[0].toUpperCase() + t.slice(1)).replace(/_/g, " "));
  }
  function roleFields(r) {
    var f = r && Array.isArray(r.f) ? r.f.filter(function (t) { return typeof t === "string" && t; }) : [];
    return f.length ? f : ["other"];
  }
  function locText(r) {
    var l = r && r.loc;
    if (Array.isArray(l)) return l.filter(function (x) { return typeof x === "string" && x.trim(); }).join("; ");
    return typeof l === "string" ? l.trim() : "";
  }
  function joinWords(a) {
    return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  }

  var UNPAID_NOTE = "The posting doesn't say this role is paid. Only a nonprofit or a public body can buy a paid listing for it.";
  function canPick(r, publicBody) {
    if (r && r.unpaid === true && !publicBody) return { ok: false, reason: UNPAID_NOTE };
    return { ok: true, reason: "" };
  }

  // One role is the "one" package and three are "three". Anything else isn't a package.
  function packageFor(n) { return n === 1 ? "one" : n === 3 ? "three" : null; }

  // The price in cents from /employer/config. Read as {one, three, one_public, three_public}; also accepts
  // {one: {standard, public_body}, ...} and {standard: {one, three}, public_body: {...}}. Null when missing.
  function priceCents(cfg, pkg, publicBody) {
    var p = cfg && cfg.prices;
    if (!p || typeof p !== "object" || (pkg !== "one" && pkg !== "three")) return null;
    var o = p[pkg] && typeof p[pkg] === "object" ? p[pkg] : {};
    var c = publicBody
      ? [p[pkg + "_public"], p[pkg + "_public_body"], o.public_body, o.public, p.public_body && p.public_body[pkg], p.public && p.public[pkg]]
      : [p[pkg], o.standard, o.price, p.standard && p.standard[pkg]];
    for (var i = 0; i < c.length; i++) if (typeof c[i] === "number" && Number.isInteger(c[i]) && c[i] > 0) return c[i];
    return null;
  }
  function money(cents) {
    if (typeof cents !== "number" || !isFinite(cents) || cents < 0) return "";
    return "$" + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
  }
  // The page needs all of these before it offers anything for sale.
  function configOk(cfg) {
    if (!cfg || cfg.enabled !== true) return false;
    for (var pub = 0; pub < 2; pub++) for (var k = 0; k < 2; k++) if (priceCents(cfg, k ? "three" : "one", !!pub) == null) return false;
    return Number.isInteger(cfg.days) && cfg.days > 0 && Number.isInteger(cfg.max_start_days) && cfg.max_start_days >= 0 &&
      (typeof cfg.terms_version === "string" ? !!cfg.terms_version : typeof cfg.terms_version === "number");
  }

  function priceLine(cfg, publicBody) {
    var one = money(priceCents(cfg, "one", publicBody)), three = money(priceCents(cfg, "three", publicBody)), d = cfg.days;
    return "One role: " + one + " for " + d + " days. Three roles: " + three + ", " + d + " days each.";
  }
  function pickMessage(n, cfg, publicBody) {
    var one = money(priceCents(cfg, "one", publicBody)), three = money(priceCents(cfg, "three", publicBody));
    if (n === 0) return "Pick one role, or three for the three-role price.";
    if (n === 1) return "One role picked: " + one + " for " + cfg.days + " days.";
    if (n === 2) return "You've picked two roles. A paid listing is for one role (" + one + ") or three roles (" + three + "), not two. Pick one more role for the three-role price, or untick one.";
    if (n === 3) return "Three roles picked: " + three + " for " + cfg.days + " days each.";
    return "You've picked " + n + " roles. The most is three. Untick " + (n - 3) + ".";
  }
  function buttonText(cfg, pkg, publicBody, pilot) {
    if (!pkg) return "Order";
    if (pilot) return "Order with pilot code";
    return "Order for " + money(priceCents(cfg, pkg, publicBody));
  }

  // Dates are "YYYY-MM-DD" strings, counted in whole days (UTC arithmetic, so no clock change moves them).
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function isoLocal(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function addDays(iso, n) {
    var d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 864e5);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  function validIso(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s; }
  function fmtDate(iso) { return validIso(iso) ? MONTHS[+iso.slice(5, 7) - 1] + " " + +iso.slice(8, 10) + ", " + iso.slice(0, 4) : ""; }
  function startRange(cfg, now) { var min = isoLocal(now || new Date()); return { min: min, max: addDays(min, cfg.max_start_days) }; }
  function inRange(iso, range) { return validIso(iso) && iso >= range.min && iso <= range.max; }
  function runText(start, days) {
    return "Runs " + fmtDate(start) + " to " + fmtDate(addDays(start, days)) + " (" + days + " days). If our review finishes after the start day, the " +
      days + " days start from the day we approve it instead, so no paid day is lost.";
  }

  // GET /employer/availability, per role: fits, or the full fields and the first day it would fit.
  // Read as {roles: [{id, fits, full, next_start}]}; also accepts a bare array, "results", or an object
  // keyed by id, and "full_fields" for "full".
  function readAvailability(out, ids) {
    var list = Array.isArray(out) ? out : out && typeof out === "object" ? out.roles || out.results || out.availability || out : null;
    var byId = {};
    if (Array.isArray(list)) list.forEach(function (x) { if (x && x.id != null) byId[String(x.id)] = x; });
    else if (list && typeof list === "object") byId = list;
    return ids.map(function (id) {
      var x = Object.prototype.hasOwnProperty.call(byId, String(id)) ? byId[String(id)] : null;
      if (!x || typeof x !== "object") return { id: id, known: false, fits: null, full: [], next_start: null };
      var full = x.full != null ? x.full : x.full_fields != null ? x.full_fields : [];
      full = (Array.isArray(full) ? full : [full]).filter(function (t) { return typeof t === "string" && t; });
      var next = validIso(x.next_start) ? x.next_start : null;
      var fits = x.fits === true ? true : x.fits === false ? false : !full.length && !next;
      return { id: id, known: true, fits: fits, full: full, next_start: fits ? null : next };
    });
  }
  function availText(a) {
    if (!a || !a.known) return "";
    if (a.fits) return "Fits: there's room from this start day.";
    var fields = a.full.length ? joinWords(a.full.map(fieldLabel)) : "its field";
    return a.next_start ? "Paid listings in " + fields + " are full until " + fmtDate(a.next_start) + "."
      : "Paid listings in " + fields + " are full on these dates.";
  }

  // Which state the address bar asks for. Ids and tokens are checked for shape before anything uses them.
  function landingState(search) {
    var q = new URLSearchParams(search || "");
    var ok = function (v) { return typeof v === "string" && SAFE_ID.test(v); };
    if (q.has("order") || (q.has("t") && !q.has("credit"))) {
      return ok(q.get("order")) && ok(q.get("t")) ? { kind: "confirm", order: q.get("order"), token: q.get("t") } : { kind: "badlink" };
    }
    if (q.has("credit")) return ok(q.get("credit")) && ok(q.get("t")) ? { kind: "credit", credit: q.get("credit"), token: q.get("t") } : { kind: "badlink" };
    if (q.has("paid")) return { kind: "paid", order: ok(q.get("paid")) ? q.get("paid") : null };
    if (q.get("cancelled") === "1") return { kind: "cancelled" };
    return { kind: "buy" };
  }
  function hasToken(state) { return state.kind === "confirm" || state.kind === "credit" || state.kind === "badlink"; }

  // The Worker's 400s name the field; this is the box on the page that shows its message.
  var FIELD_FOR = { name: "name", email: "email", company: "company", pilot_code: "pilot", start: "start", accept_terms: "terms",
    terms_version: "terms", listing_ids: "roles", package: "roles", shard: "roles", public_body: "roles", employer: "co-q" };
  function errorTarget(field) { return Object.prototype.hasOwnProperty.call(FIELD_FOR, field) ? FIELD_FOR[field] : null; }
  function serverMessage(out) {
    var m = out && (typeof out.message === "string" ? out.message : typeof out.error === "string" ? out.error : "");
    return m ? m.slice(0, 300) : "";
  }

  function orderBody(o) {
    return {
      name: o.name, email: o.email, company: o.company, public_body: !!o.publicBody, package: packageFor(o.roles.length),
      shard: o.shard, listing_ids: o.roles.map(function (r) { return r.id; }), start: o.start, accept_terms: true,
      terms_version: o.cfg.terms_version, pilot_code: o.pilot || "", website: o.website || "",
    };
  }

  // Only a Stripe Checkout address is followed after confirming, and only http(s) links are shown.
  function safeCheckoutUrl(u) {
    try { var x = new URL(String(u)); } catch (e) { return null; }
    return x.protocol === "https:" && (x.hostname === "checkout.stripe.com" || /\.stripe\.com$/.test(x.hostname)) ? x.href : null;
  }
  function httpUrl(u) {
    try { var x = new URL(String(u)); } catch (e) { return null; }
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  }

  // GET /employer/credit: the amount in cents ("amount_cents" or "amount"), and what was already chosen.
  function readCredit(out) {
    out = out || {};
    var cents = Number.isInteger(out.amount_cents) ? out.amount_cents : Number.isInteger(out.amount) ? out.amount : null;
    return {
      cents: cents, title: typeof out.title === "string" ? out.title : "", company: typeof out.company === "string" ? out.company : "",
      choice: out.choice === "refund" || out.choice === "credit" ? out.choice : null, code: typeof out.code === "string" ? out.code : "",
    };
  }

  var B = {
    API: API, norm: norm, prepareIndex: prepareIndex, searchEmployers: searchEmployers, rolesFor: rolesFor, fieldLabel: fieldLabel,
    roleFields: roleFields, locText: locText, canPick: canPick, packageFor: packageFor, priceCents: priceCents, money: money,
    configOk: configOk, priceLine: priceLine, pickMessage: pickMessage, buttonText: buttonText, addDays: addDays, validIso: validIso,
    fmtDate: fmtDate, isoLocal: isoLocal, startRange: startRange, inRange: inRange, runText: runText, readAvailability: readAvailability,
    availText: availText, landingState: landingState, hasToken: hasToken, errorTarget: errorTarget, serverMessage: serverMessage,
    orderBody: orderBody, safeCheckoutUrl: safeCheckoutUrl, httpUrl: httpUrl, readCredit: readCredit, UNPAID_NOTE: UNPAID_NOTE, EMAIL: EMAIL,
  };
  root.ISBuy = B;

  var doc = root.document;
  if (doc && doc.getElementById && doc.getElementById("buy")) start();

  // ---------- the page ----------
  function start() {
    var $ = function (id) { return doc.getElementById(id); };
    // An element with text children only: data is only ever set as text, never parsed as markup.
    function el(tag, props) {
      var n = doc.createElement(tag);
      Object.keys(props || {}).forEach(function (k) {
        if (k.indexOf("aria-") === 0 || k.indexOf("data-") === 0 || k === "role") n.setAttribute(k, props[k]);
        else n[k] = props[k];
      });
      for (var i = 2; i < arguments.length; i++) {
        var c = arguments[i];
        if (c == null || c === false) continue;
        n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
      }
      return n;
    }
    function call(method, path, body) {
      var init = method === "GET" ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      return fetch(API + path, init).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (out) { return { ok: r.ok, status: r.status, out: out || {} }; });
      });
    }
    function show(id, on) { var n = $(id); if (n) n.hidden = !on; }

    // ----- where Stripe and our emails send people back to -----
    var state = landingState(root.location.search);
    if (hasToken(state) && root.history && root.history.replaceState) {
      try { root.history.replaceState(null, "", root.location.pathname); } catch (e) {}
    }
    if (state.kind !== "buy") { landing(state); return; }

    // ----- the order form -----
    var S = { cfg: null, index: null, emp: null, roles: [], picked: [], pub: false, avail: null, rseq: 0, aseq: 0, timer: 0, shards: {}, prefill: "", matches: [], active: -1 };
    var form = $("order"), q = $("co-q"), list = $("co-list"), coMsg = $("co-msg"), roleList = $("role-list"), pickMsg = $("pick-msg");
    var pub = $("pub"), startIn = $("start"), availBox = $("avail"), send = $("send"), status = $("status");

    call("GET", "/employer/config").then(function (res) {
      if (!res.ok || !configOk(res.out)) return closed();
      S.cfg = res.out;
      open();
    }).catch(closed);

    function closed() { show("boot", false); show("closed", true); }

    function open() {
      var cfg = S.cfg;
      show("boot", false);
      form.hidden = false;
      if (Number.isInteger(cfg.field_cap) && cfg.field_cap > 0) $("cap").textContent = String(cfg.field_cap);
      Array.prototype.forEach.call(doc.querySelectorAll(".days"), function (n) { n.textContent = String(cfg.days); });
      $("pub-hint").textContent = "Then: " + money(priceCents(cfg, "one", true)) + " for one role, " + money(priceCents(cfg, "three", true)) + " for three.";
      var range = startRange(cfg);
      startIn.min = range.min; startIn.max = range.max; startIn.value = range.min;
      $("start-hint").textContent = "From today up to " + fmtDate(range.max) + ".";
      updatePrices();
      updateRun();
      fetch("/data/roles/index.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
        S.index = prepareIndex(d);
        q.disabled = false;
        if (q.value.trim()) search();
      }).catch(function () {
        coMsg.textContent = "";
        coMsg.appendChild(el("span", {}, "We couldn't load the list of employers. Reload the page to try again, or email "));
        coMsg.appendChild(el("a", { href: "mailto:" + CONTACT }, CONTACT));
        coMsg.appendChild(doc.createTextNode("."));
      });
    }

    // Company search: an ARIA combobox with a list box (arrow keys, Enter, Escape).
    function search() {
      if (!S.index) return;
      S.matches = searchEmployers(S.index, q.value, 8);
      S.active = -1;
      drawList();
      coMsg.textContent = "";
      if (S.matches.length) coMsg.textContent = S.matches.length === 1 ? "1 match. Use the arrow keys or tap it to choose." : S.matches.length + " matches. Use the arrow keys or tap one to choose.";
      else if (norm(q.value).length >= 2) {
        coMsg.appendChild(el("span", {}, "No employer by that name has open roles on InternScout right now. We can only sell a paid listing for a role we already list. To ask us to add your job board, which is free, use the form on "));
        coMsg.appendChild(el("a", { href: "/employers/#interest" }, "the employers page"));
        coMsg.appendChild(doc.createTextNode("."));
      }
    }
    function drawList() {
      list.textContent = "";
      S.matches.forEach(function (e, i) {
        var li = el("li", { id: "co-opt-" + i, role: "option", "aria-selected": String(i === S.active), className: i === S.active ? "on" : "" },
          el("span", { className: "co-n" }, e.n), e.c ? el("span", { className: "co-c" }, e.c === 1 ? "1 open role" : e.c + " open roles") : null);
        li.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
        li.addEventListener("click", function () { choose(e); });
        list.appendChild(li);
      });
      var openList = S.matches.length > 0;
      list.hidden = !openList;
      q.setAttribute("aria-expanded", String(openList));
      if (S.active >= 0) q.setAttribute("aria-activedescendant", "co-opt-" + S.active); else q.removeAttribute("aria-activedescendant");
    }
    function closeList() { S.matches = []; S.active = -1; drawList(); }
    q.addEventListener("input", function () { mark("co-q", ""); search(); });
    q.addEventListener("keydown", function (ev) {
      var n = S.matches.length;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (!n) { search(); n = S.matches.length; if (!n) return; }
        S.active = ev.key === "ArrowDown" ? (S.active + 1) % n : (S.active <= 0 ? n - 1 : S.active - 1);
        drawList();
        var on = $("co-opt-" + S.active);
        if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter") {
        ev.preventDefault();   // Enter here chooses a company; it never sends the form
        if (S.active >= 0 && S.matches[S.active]) choose(S.matches[S.active]);
        else if (n === 1) choose(S.matches[0]);
      } else if (ev.key === "Escape") {
        if (n) { ev.preventDefault(); closeList(); }
      }
    });
    q.addEventListener("blur", function () { closeList(); });

    function choose(e) {
      q.value = e.n;
      closeList();
      coMsg.textContent = "";
      S.emp = e; S.roles = []; S.picked = []; S.avail = null;
      var company = form.elements.company;
      if (!company.value.trim() || company.value === S.prefill) { company.value = e.n; S.prefill = e.n; }
      $("roles-legend").textContent = "Open roles at " + e.n;
      show("roles-box", true);
      roleList.textContent = "";
      pickMsg.textContent = "Loading the open roles at " + e.n + ".";
      var seq = ++S.rseq;
      var got = S.shards[e.s] ? Promise.resolve(S.shards[e.s]) : fetch("/data/roles/" + e.s + ".json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
      got.then(function (d) {
        S.shards[e.s] = d;
        if (seq !== S.rseq || S.emp !== e) return;
        S.roles = rolesFor(d, e.k);
        renderRoles();
        show("step2", true); show("step3", true);
        updatePick();
      }).catch(function () {
        if (S.emp !== e) return;
        pickMsg.textContent = "We couldn't load the roles. Choose the company again to retry.";
      });
    }

    function isPicked(r) { return S.picked.some(function (x) { return String(x.id) === String(r.id); }); }
    function renderRoles() {
      roleList.textContent = "";
      if (!S.roles.length) {
        roleList.appendChild(el("li", { className: "role" }, el("p", { className: "hint" }, "We don't list any open roles at " + S.emp.n + " right now, so there's nothing to buy for it today.")));
        return;
      }
      S.roles.forEach(function (r, i) {
        var id = "role-" + i, ok = canPick(r, S.pub), meta = [];
        var loc = locText(r);
        if (loc) meta.push(loc);
        meta.push(roleFields(r).map(fieldLabel).join(", "));
        var box = el("input", { type: "checkbox", id: id, value: String(r.id), checked: isPicked(r), disabled: !ok.ok });
        if (!ok.ok) box.setAttribute("aria-describedby", id + "-why");
        box.addEventListener("change", function () {
          if (box.checked) { if (!isPicked(r)) S.picked.push(r); }
          else S.picked = S.picked.filter(function (x) { return String(x.id) !== String(r.id); });
          mark("roles", "");
          updatePick();
        });
        var href = httpUrl(r.u);
        roleList.appendChild(el("li", { className: "role" + (ok.ok ? "" : " off") },
          box,
          el("div", { className: "role-b" },
            el("label", { htmlFor: id, className: "role-t" }, r.t),
            el("p", { className: "role-m" }, meta.join(" · ")),
            r.unpaid === true ? el("p", { className: "role-why", id: id + "-why" }, ok.ok ? "The posting doesn't say this role is paid. You can pick it as a nonprofit or public body." : UNPAID_NOTE) : null,
            href ? el("a", { href: href, target: "_blank", rel: "noopener", className: "role-a" }, "See the posting", el("span", { className: "vh" }, " for " + r.t), " ", el("span", { className: "i i-external", "aria-hidden": "true" })) : null)));
      });
    }

    pub.addEventListener("change", function () {
      S.pub = pub.checked;
      // Unpaid roles can't stay picked once the box is unticked.
      var before = S.picked.length;
      if (!S.pub) S.picked = S.picked.filter(function (r) { return r.unpaid !== true; });
      if (S.emp) renderRoles();
      updatePrices();
      updatePick();
      if (S.picked.length < before) pickMsg.textContent = "We unticked the roles whose postings don't say they are paid. " + pickMsg.textContent;
    });

    function updatePrices() {
      $("prices").textContent = priceLine(S.cfg, S.pub);
    }
    function updatePick() {
      if (!S.emp) return;
      pickMsg.textContent = S.roles.length ? pickMessage(S.picked.length, S.cfg, S.pub) : "";
      updateButton();
      checkAvail();
    }
    function updateButton() {
      send.textContent = buttonText(S.cfg, packageFor(S.picked.length), S.pub, form.elements.pilot.value.trim());
    }
    form.elements.pilot.addEventListener("input", updateButton);

    function updateRun() {
      var v = startIn.value;
      $("run").textContent = validIso(v) ? runText(v, S.cfg.days) : "";
    }
    startIn.addEventListener("change", function () { mark("start", ""); updateRun(); checkAvail(); });
    startIn.addEventListener("input", function () { updateRun(); });

    // Room for the picked roles on the chosen start day (FIELD_CAP per field).
    function checkAvail() {
      clearTimeout(S.timer);
      S.aseq++;   // an answer still on its way is for the old roles or day
      S.avail = null;
      availBox.textContent = "";
      var roles = S.picked.slice(), startDay = startIn.value;
      if (!S.emp || !roles.length || roles.length > 3 || !inRange(startDay, startRange(S.cfg))) return;
      S.timer = setTimeout(function () {
        var seq = ++S.aseq;
        var ids = roles.map(function (r) { return r.id; });
        var qs = new URLSearchParams({ shard: S.emp.s, ids: ids.join(","), start: startDay }).toString();
        availBox.textContent = "Checking room on " + fmtDate(startDay) + ".";
        call("GET", "/employer/availability?" + qs).then(function (res) {
          if (seq !== S.aseq) return;
          availBox.textContent = "";
          if (!res.ok) { availBox.appendChild(el("p", {}, "We couldn't check room for this day just now. We check again when you order.")); return; }
          S.avail = readAvailability(res.out, ids);
          var ul = el("ul", { className: "avail" });
          S.avail.forEach(function (a, i) {
            if (!a.known) return;
            var li = el("li", { className: a.fits ? "fits" : "full" },
              el("span", { className: "i " + (a.fits ? "i-check" : "i-alert"), "aria-hidden": "true" }), " ",
              el("strong", {}, roles[i].t), ": " + availText(a));
            if (!a.fits && a.next_start && inRange(a.next_start, startRange(S.cfg))) {
              var day = a.next_start;
              var b = el("button", { type: "button", className: "cta alt small" }, "Start on " + fmtDate(day));
              b.addEventListener("click", function () { startIn.value = day; updateRun(); checkAvail(); startIn.focus(); });
              li.appendChild(doc.createTextNode(" "));
              li.appendChild(b);
            }
            ul.appendChild(li);
          });
          if (ul.children.length) availBox.appendChild(ul);
        }).catch(function () {
          if (seq !== S.aseq) return;
          availBox.textContent = "We couldn't check room for this day just now. We check again when you order.";
        });
      }, 250);
    }

    // ----- field messages, like the interest form on /employers/ -----
    function mark(id, msg) {
      var input = id === "roles" ? null : $(id), err = $(id + "-err");
      if (!err) return;
      if (input) {
        var hint = $(id + "-hint");
        var by = ((hint ? hint.id + " " : "") + (msg ? err.id : "")).trim();
        if (by) input.setAttribute("aria-describedby", by); else input.removeAttribute("aria-describedby");
        if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      }
      err.textContent = msg || "";
      err.hidden = !msg;
    }
    function focusFor(id) {
      if (id === "roles") {
        var first = roleList.querySelector("input:not([disabled])");
        (first || q).focus();
      } else if ($(id)) $(id).focus();
    }
    ["name", "email", "company", "pilot"].forEach(function (id) {
      $(id).addEventListener("input", function () { if ($(id).getAttribute("aria-invalid") === "true") mark(id, ""); });
    });
    $("terms").addEventListener("change", function () { if ($("terms").checked) mark("terms", ""); });

    function check() {
      var bad = [], val = function (id) { return $(id).value.trim(); };
      var put = function (id, msg) { mark(id, msg); if (msg) bad.push(id); };
      put("co-q", S.emp ? "" : "Type your company's name and choose it from the list.");
      var n = S.picked.length;
      put("roles", !S.emp ? "" : !S.roles.length ? "There are no open roles to pick." : packageFor(n) ? "" : pickMessage(n, S.cfg, S.pub));
      if (!bad.length && !S.pub && S.picked.some(function (r) { return r.unpaid === true; })) put("roles", UNPAID_NOTE);
      var range = startRange(S.cfg);
      var full = (S.avail || []).filter(function (a) { return a.known && !a.fits; });
      put("start", !inRange(startIn.value, range) ? "Pick a start day from " + fmtDate(range.min) + " to " + fmtDate(range.max) + "."
        : full.length ? "Not every role you picked has room on this day. Pick a later start day." : "");
      put("name", val("name") ? "" : "Enter your name.");
      put("email", !val("email") ? "Enter your work email." : EMAIL.test(val("email")) ? "" : "That email address doesn't look right.");
      put("company", val("company") ? "" : "Enter your company.");
      put("pilot", "");
      put("terms", $("terms").checked ? "" : "Tick this box to order.");
      return bad;
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      status.textContent = "";
      var bad = check();
      if (bad.length) { focusFor(bad[0]); return; }
      var v = function (id) { return $(id).value.trim(); };
      var body = orderBody({ name: v("name"), email: v("email"), company: v("company"), publicBody: S.pub, shard: S.emp.s, roles: S.picked,
        start: startIn.value, cfg: S.cfg, pilot: v("pilot"), website: form.elements.website.value });
      var label = send.textContent;
      send.disabled = true;
      send.textContent = "Sending";
      call("POST", "/employer/order", body).then(function (res) {
        if (res.ok) {
          $("sent-text").textContent = "We sent a link to " + body.email + ". It works for 48 hours.";
          form.hidden = true;
          var done = $("sent");
          done.hidden = false;
          done.focus();
          return;
        }
        var msg = serverMessage(res.out), target = res.status === 400 ? errorTarget(res.out.field) : null;
        if (target) { mark(target, msg || "Check this."); focusFor(target); }
        else if (res.status === 404) { form.hidden = true; show("closed", true); }
        else if (msg && (res.status === 400 || res.status === 409 || res.status === 429)) status.textContent = msg;
        else status.textContent = "That didn't go through. Please try again, or email " + CONTACT + ".";
      }).catch(function () {
        status.textContent = "That didn't go through. Check your connection and try again, or email " + CONTACT + ".";
      }).then(function () { send.disabled = false; send.textContent = label === "Sending" ? "Order" : label; });
    });
  }

  // ----- the pages Stripe and our emails link to -----
  function landing(state) {
    var $ = function (id) { return doc.getElementById(id); };
    var box = $("landing"), head = $("landing-h"), body = $("landing-body");
    ["boot", "order", "how"].forEach(function (id) { if ($(id)) $(id).hidden = true; });
    box.hidden = false;
    function el(tag, props) {
      var n = doc.createElement(tag);
      Object.keys(props || {}).forEach(function (k) { if (k.indexOf("aria-") === 0) n.setAttribute(k, props[k]); else n[k] = props[k]; });
      for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); }
      return n;
    }
    function say(h) {
      head.textContent = h;
      body.textContent = "";
      for (var i = 1; i < arguments.length; i++) body.appendChild(typeof arguments[i] === "string" ? el("p", {}, arguments[i]) : arguments[i]);
      box.focus();
    }
    function call(method, path, data) {
      var init = method === "GET" ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
      return fetch(API + path, init).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (out) { return { ok: r.ok, status: r.status, out: out || {} }; });
      });
    }
    var contact = function (prefix) { return el("p", {}, prefix, el("a", { href: "mailto:" + CONTACT }, CONTACT), "."); };
    var again = el("p", {}, el("a", { href: "/employers/buy/" }, "Start a new order"));
    var failed = "That didn't go through. Check your connection and reload the page, or email " + CONTACT + ".";

    if (state.kind === "badlink") {
      say("This link doesn't look complete", "Open the link from your email again. If you copied it, check you copied all of it.", contact("If it still doesn't work, email "));
    } else if (state.kind === "paid") {
      say("Payment received", "We review every paid listing before it goes live, usually within 2 business days. You'll get an email when it's approved, with its dates.",
        "If we can't run it, you get a full refund.");
    } else if (state.kind === "cancelled") {
      say("Nothing was charged", "You left the payment page before paying. The link in your email still works for 48 hours from when we sent it, so you can open it again to pay.", again);
    } else if (state.kind === "confirm") {
      say("Confirming your email", "One moment.");
      call("POST", "/employer/order/confirm", { order: state.order, token: state.token }).then(function (res) {
        var url = res.ok ? safeCheckoutUrl(res.out.url) : null;
        if (url) {
          say("Email confirmed", el("p", {}, "Taking you to Stripe to pay. If nothing happens, ", el("a", { href: url }, "open the payment page"), "."));
          root.location.assign(url);
        } else if (res.ok && res.out.done === "pilot") {
          say("Your pilot is booked", "Thanks for confirming your email. We review every listing before it goes live, usually within 2 business days. You'll get an email when it's approved, with its dates.");
        } else {
          say("We couldn't confirm this link", serverMessage(res.out) || "The link may have expired. It works for 48 hours.", again, contact("Questions? Email "));
        }
      }).catch(function () { say("We couldn't confirm this link", failed); });
    } else if (state.kind === "credit") {
      say("Your unused days", "Loading your offer.");
      var qs = new URLSearchParams({ credit: state.credit, t: state.token }).toString();
      call("GET", "/employer/credit?" + qs).then(function (res) {
        if (!res.ok) return say("This link doesn't work any more", serverMessage(res.out) || "It may have expired or already been used.", contact("Questions? Email "));
        var c = readCredit(res.out);
        if (c.choice) return result(c.choice, c.cents, c.code);
        var amount = money(c.cents);
        if (!amount) return say("Your unused days", failed);
        var what = c.title && c.company ? c.title + " at " + c.company : c.title || "Your role";
        var refund = el("button", { type: "button", className: "cta" }, "Refund " + amount);
        var credit = el("button", { type: "button", className: "cta alt" }, "Get a code worth " + amount);
        say("Your unused days",
          what + " closed early, so its paid listing stopped. The unused days are worth " + amount + ". Choose one:",
          el("ul", { className: "plain" },
            el("li", {}, el("strong", {}, "A refund of " + amount), ", back to the way you paid."),
            el("li", {}, el("strong", {}, "A one-time code worth " + amount), " for another paid listing.")),
          el("p", { className: "choices" }, refund, " ", credit),
          "If you don't choose within 30 days, we refund it.");
        var pick = function (choice) {
          refund.disabled = credit.disabled = true;
          call("POST", "/employer/credit", { credit: state.credit, token: state.token, choice: choice }).then(function (r) {
            if (!r.ok) { refund.disabled = credit.disabled = false; return say("That didn't go through", serverMessage(r.out) || failed, contact("Questions? Email ")); }
            var out = readCredit(r.out);
            result(out.choice || choice, out.cents != null ? out.cents : c.cents, out.code);
          }).catch(function () { refund.disabled = credit.disabled = false; say("That didn't go through", failed); });
        };
        refund.addEventListener("click", function () { pick("refund"); });
        credit.addEventListener("click", function () { pick("credit"); });
      }).catch(function () { say("Your unused days", failed); });
    }

    function result(choice, cents, code) {
      var amount = money(cents);
      if (choice === "refund") return say("Refund on its way", "We've asked Stripe to refund " + (amount || "the unused days") + " to the way you paid.");
      if (code) {
        return say("Your code", el("p", {}, "Your one-time code" + (amount ? ", worth " + amount : "") + ": ", el("strong", { className: "code" }, code)),
          "Use it on the Stripe payment page when you pay for another paid listing. Keep it somewhere safe; it works once.", again);
      }
      return say("Your code", "We've made your code" + (amount ? ", worth " + amount : "") + ".", contact("If you don't have it, email "));
    }
  }
})(typeof window !== "undefined" ? window : this);
