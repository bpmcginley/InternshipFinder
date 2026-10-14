// The Auto-Apply offer at the moment of applying (added 2026-10-13). Students open about 100 postings
// a week from the site, and almost none of them ever see the extension. So when a student opens a
// posting the extension can fill, a slim bar appears at the bottom of THIS tab (the posting opens in
// its own tab exactly as before: nothing here touches the click, it only reacts to it):
//   "Back from Acme? Next time, Auto-Apply can fill in an application like this one from your resume.
//    You check it and press Submit yourself."  [Add to Chrome, free]  [Dismiss]
//   "When you add it, Chrome will say it can "Read and change your data on a number of websites" and
//    "Read your browsing history". That is how it fills in job application sites and finds the
//    application tab."
// Worded for when it is seen (U6, 2026-10-14): the posting opens in the foreground, so the student
// reads this on coming back, often after applying by hand. was: "Applying? Auto-Apply can fill in this
// application from your resume. ...", which no longer fit by then. The second line prepares them for
// Chrome's permission dialog (extension/manifest.json: tabs and webNavigation, and 19 job sites), a
// common place to back out. The company is the row's own (.co in the dashboard row or the landing
// page's li.job); without one it says "Back from the posting?".
// While it shows, the page's scroll padding keeps a focused link from sitting under it (WCAG 2.4.11).
// Loaded by the dashboard (docs/index.html) and by every generated page with such a posting
// (backend/internscout/seo_pages.py OFFER_TAG). Shown only when all of these hold:
//   - the link is a posting link, the same ones js/count.js counts as "posting_click" (a.go on the
//     generated pages, a.open-link on the dashboard), and it carries data-aa: its application is on a
//     site Auto-Apply fills (seo_pages.autofills, the dashboard's SUPPORTED_ATS);
//   - a desktop browser: not touch-only (the media query js/app.js touchOnly and install.html use)
//     and not a mobile browser by its own client hints;
//   - a Chromium browser (Chrome, Edge, Brave, Opera), which can add a Chrome Web Store extension.
//     navigator.userAgentData exists only there, so Firefox and Safari never see it;
//   - the extension is not installed: its bridge (extension/bridge/bridge.js) sets data-internscout on
//     <html> at document_start on every internscout.org page and posts "hello"; an orphaned copy
//     removes the attribute but still posts "gone" or answers "reload_page", so any message from it
//     counts as installed;
//   - not dismissed (or its store link pressed) in the last 14 days, and not shown before in this
//     browser session. Both live in browser storage; where storage is blocked it is not shown at all,
//     since a dismissal could not be kept.
// Whenever any of this cannot be told, it is not shown.
// Counted with js/count.js, a daily total with nothing about who: "apply_offer_shown" when the bar
// appears and "apply_offer_click" when its store link is pressed (count.js also counts that same click
// as install_click, like any store link). The store link's utm_source is "apply-offer".
(function () {
  "use strict";
  var STORE = "https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi";
  var POSTING = "a.go[href], a.open-link[href]";
  var DISMISSED_KEY = "internscout.applyoffer.dismissed", SHOWN_KEY = "internscout.applyoffer.shown";
  var QUIET = 14 * 864e5;
  var TOUCH_ONLY = "(pointer:coarse) and (hover:none)";

  // from: the posting link the bar was shown for. Once set, the bar is done for this page load.
  var bridge = false, bar = null, from = null, styled = false;
  window.addEventListener("message", function (e) {
    // "req" is the page's own request to the bridge (js/core.js); everything else comes from the bridge.
    if (e.source === window && e.data && e.data.__internscout && e.data.__internscout !== "req") bridge = true;
  });

  var count = function (event) { (window.ISCountQ = window.ISCountQ || []).push(event); };
  var storeUrl = function () {
    var c = window.CONFIG && window.CONFIG.extensionStoreUrl;
    return (typeof c === "string" && /^https:\/\/chromewebstore\.google\.com\//.test(c) ? c : STORE) + "?utm_source=apply-offer";
  };

  function chromium() {
    var d = navigator.userAgentData;
    if (!d || d.mobile !== false || !d.brands || !d.brands.some) return false;
    return d.brands.some(function (b) { return !!b && /^(Chromium|Google Chrome|Microsoft Edge)$/.test(b.brand); });
  }
  var desktop = function () { return typeof window.matchMedia === "function" && !window.matchMedia(TOUCH_ONLY).matches; };
  var installed = function () { return bridge || document.documentElement.hasAttribute("data-internscout"); };

  // Whether the offer may show now. Exposed (window.ISOffer.due) for the tests.
  function due(now) {
    if (bar || from || installed() || !chromium() || !desktop()) return false;
    try {
      var t = Number(localStorage.getItem(DISMISSED_KEY)) || 0;
      if (t && now - t < QUIET) return false;
      if (sessionStorage.getItem(SHOWN_KEY)) return false;
    } catch (e) { return false; }
    return true;
  }

  // The site's own design tokens (the dashboard, the generated pages and /employers/ all define them, light
  // and dark), with the light values as fallbacks. Added to the page only when the bar first shows.
  // Restyled 2026-10-14 (A2 component 7): the large radius and the floating shadow every pop-up uses (it was
  // a fixed rgba that vanished on a dark page), one primary button and a quiet Dismiss (was a bordered one).
  var CSS = ".is-offer{position:fixed;z-index:60;left:16px;right:16px;bottom:16px;max-width:680px;margin:0 auto;" +
    "box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 12px 12px 16px;" +
    "background:var(--panel,#fffefb);color:var(--ink2,#454a52);border:1px solid var(--rule,#e2ded4);border-radius:var(--r-lg,8px);" +
    "box-shadow:var(--shadow-pop,0 10px 30px rgba(23,25,28,.14));font-size:var(--fs-3,15px);line-height:1.45}" +
    ".is-offer p{margin:0;flex:1 1 280px}.is-offer b{color:var(--ink,#17191c)}" +
    ".is-offer .is-offer-perm{display:block;margin-top:4px;font-size:var(--fs-2,13px);color:var(--ink3,#646a73)}" +
    ".is-offer .is-offer-go{display:inline-flex;align-items:center;min-height:var(--h-ctl,36px);padding:0 14px;border-radius:var(--r,6px);" +
    "background:var(--accent,#1d5c46);color:var(--accent-ink,#fff);font-weight:600;text-decoration:none;white-space:nowrap;transition:background-color 140ms ease-out}" +
    ".is-offer .is-offer-go:hover{background:var(--accent-hover,#164a38)}" +
    ".is-offer button{min-height:var(--h-ctl,36px);padding:0 8px;border:0;border-radius:var(--r,6px);background:transparent;" +
    "color:var(--accent,#1d5c46);font:inherit;font-weight:500;cursor:pointer}" +
    ".is-offer button:hover{text-decoration:underline;text-underline-offset:3px}" +
    ".is-offer :focus-visible{outline:2px solid var(--accent,#1d5c46);outline-offset:2px}" +
    "@media (prefers-reduced-motion:reduce){.is-offer .is-offer-go{transition:none}}";

  // While the bar shows, nothing that has keyboard focus may sit under it (WCAG 2.4.11, 2026-10-14). The page
  // gets a bottom scroll padding of the bar's height plus its 16px gap, so the browser scrolls a link reached
  // with Tab clear of it, and a focus that still lands under the bar (a click, a script) is scrolled up.
  // The page's own scroll padding is put back when the bar goes.
  var padWas = null;
  function barTop() { try { return bar.getBoundingClientRect().top; } catch (e) { return null; } }
  function pad() {
    try {
      var root = document.documentElement, h = Math.ceil(bar.getBoundingClientRect().height) + 24;
      if (padWas === null) padWas = root.style.scrollPaddingBottom || "";
      root.style.scrollPaddingBottom = h + "px";
    } catch (e) {}
  }
  function unpad() {
    try { if (padWas !== null) document.documentElement.style.scrollPaddingBottom = padWas; } catch (e) {}
    padWas = null;
  }
  document.addEventListener("focusin", function (e) {
    try {
      var t = e.target;
      if (!bar || !t || !t.getBoundingClientRect || (bar.contains && bar.contains(t))) return;
      var top = barTop(), r = t.getBoundingClientRect();
      if (top !== null && r.bottom > top - 8) window.scrollBy(0, Math.ceil(r.bottom - top + 8));
    } catch (err) {}
  });

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text) n.textContent = text;
    return n;
  }

  // Gone for 14 days, whether waved off or taken up (the store link). Focus goes back to the posting
  // link when it was inside the bar, so a keyboard user is not left at the top of the page.
  function close(now) {
    if (!bar) return;
    try { localStorage.setItem(DISMISSED_KEY, String(now)); } catch (e) {}
    var had = bar.contains && bar.contains(document.activeElement);
    if (bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
    unpad();
    if (had && from && from.focus) from.focus();
  }

  // The company named on the posting's own row, or "" when there is none to read.
  function companyOf(link) {
    try {
      var row = link.closest && link.closest("tr, li.job");
      var co = row && row.querySelector && row.querySelector(".co");
      var first = co && co.firstChild;
      var name = String((first && first.textContent) || "").replace(/\s+/g, " ").trim();
      return name.length > 0 && name.length <= 80 ? name : "";
    } catch (e) { return ""; }
  }

  function show(link, now) {
    from = link;
    try { sessionStorage.setItem(SHOWN_KEY, "1"); } catch (e) {}
    if (!styled) { styled = true; document.head.appendChild(el("style", {}, CSS)); }
    bar = el("div", { "class": "is-offer", role: "status" });
    var p = el("p", {});
    var co = companyOf(link);
    p.appendChild(el("b", {}, co ? "Back from " + co + "? " : "Back from the posting? "));
    p.appendChild(document.createTextNode("Next time, Auto-Apply can fill in an application like this one from your resume. You check it and press Submit yourself."));
    p.appendChild(el("span", { "class": "is-offer-perm" }, "When you add it, Chrome will say it can \u201cRead and change your data on a number of websites\u201d and \u201cRead your browsing history\u201d. That is how it fills in job application sites and finds the application tab."));
    var go = el("a", { "class": "is-offer-go", href: storeUrl(), target: "_blank", rel: "noopener" }, "Add to Chrome, free");
    var no = el("button", { type: "button" }, "Dismiss");
    go.addEventListener("click", function () { count("apply_offer_click"); close(Date.now()); });
    no.addEventListener("click", function () { close(Date.now()); });
    bar.addEventListener("keydown", function (e) { if (e.key === "Escape") close(Date.now()); });
    bar.appendChild(p); bar.appendChild(go); bar.appendChild(no);
    document.body.appendChild(bar);
    pad();
    count("apply_offer_shown");
  }

  // Bubbling, after count.js has counted the posting_click, and never preventDefault: the posting
  // opens exactly as it did. Anything that goes wrong here stays here.
  document.addEventListener("click", function (ev) {
    try {
      var t = ev.target && ev.target.closest ? ev.target : null;
      var a = t ? t.closest(POSTING) : null;
      if (!a || !a.hasAttribute("data-aa")) return;
      var now = Date.now();
      if (due(now)) show(a, now);
    } catch (e) {}
  });

  // Remembering the posting (2026-10-14, U2). When the bar's store link is pressed, or a landing page's
  // "Auto-Apply this" link, the posting it was about is kept in this browser's localStorage as
  // {url, company, title, at}. Once installed, the extension reads it from the internscout.org tabs that are
  // open (extension/background/install.js), removes it, and offers to Auto-Apply that posting after setup.
  // Only while the extension isn't installed; nothing is sent anywhere. The extension checks it all again
  // (extension/background/held.js wantedJob) and forgets it after three days.
  var WANTED_KEY = "internscout.wanted";
  // The same three days here (held.js WANTED_TTL_MS): if the extension never read it, every page that loads
  // this file deletes it once it is older than that, or unreadable, as the privacy page says.
  var WANTED_TTL = 3 * 864e5;
  try {
    var kept = localStorage.getItem(WANTED_KEY);
    if (kept != null) {
      var at = null;
      try { at = Number(JSON.parse(kept).at); } catch (e) {}
      if (!isFinite(at) || at === null || Date.now() - at > WANTED_TTL) localStorage.removeItem(WANTED_KEY);
    }
  } catch (e) {}
  function remember(link) {
    try {
      var row = link.closest("tr, li.job");
      var text = function (sel) { var n = row && row.querySelector(sel); return n ? n.textContent.replace(/\s+/g, " ").trim().slice(0, 160) : ""; };
      localStorage.setItem(WANTED_KEY, JSON.stringify({ url: link.href, company: text(".co"), title: text(".role"), at: Date.now() }));
    } catch (e) {}
  }
  document.addEventListener("click", function (ev) {
    try {
      var t = ev.target && ev.target.closest ? ev.target : null;
      if (!t || installed()) return;
      if (from && t.closest(".is-offer-go")) { remember(from); return; }
      var aa = t.closest("a.aa"), job = aa && aa.closest("li.job");
      var go = job && job.querySelector("a.go[data-aa][href]");
      if (go) remember(go);
    } catch (e) {}
  }, true);

  window.ISOffer = { due: due, POSTING: POSTING, DISMISSED_KEY: DISMISSED_KEY, SHOWN_KEY: SHOWN_KEY, QUIET: QUIET, WANTED_KEY: WANTED_KEY, WANTED_TTL: WANTED_TTL };
})();
