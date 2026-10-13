// The Auto-Apply offer at the moment of applying (added 2026-10-13). Students open about 100 postings
// a week from the site, and almost none of them ever see the extension. So when a student opens a
// posting the extension can fill, a slim bar appears at the bottom of THIS tab (the posting opens in
// its own tab exactly as before: nothing here touches the click, it only reacts to it):
//   "Applying? Auto-Apply can fill in this application from your resume. You check it and press
//    Submit yourself."  [Add to Chrome, free]  [Dismiss]
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

  // The site's own colour tokens (both the dashboard and the generated pages define them, light and
  // dark), with the light values as fallbacks. Added to the page only when the bar first shows.
  var CSS = ".is-offer{position:fixed;z-index:60;left:16px;right:16px;bottom:16px;max-width:680px;margin:0 auto;" +
    "box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 12px 10px 16px;" +
    "background:var(--panel,#fffefb);color:var(--ink2,#454a52);border:1px solid var(--ink3,#646a73);border-radius:8px;" +
    "box-shadow:0 12px 32px rgba(20,20,20,.12);font-size:14px;line-height:1.45}" +
    ".is-offer p{margin:0;flex:1 1 280px}.is-offer b{color:var(--ink,#17191c)}" +
    ".is-offer .is-offer-go{display:inline-block;padding:7px 12px;border-radius:6px;background:var(--accent,#1d5c46);" +
    "color:var(--paper,#f6f4ef);font-weight:600;text-decoration:none;white-space:nowrap;transition:background-color 140ms ease-out}" +
    ".is-offer .is-offer-go:hover{background:var(--accent-hover,#164a38)}" +
    ".is-offer button{padding:6px 10px;border:1px solid var(--rule,#e2ded4);border-radius:6px;background:transparent;" +
    "color:var(--ink2,#454a52);font:inherit;cursor:pointer;transition:color 140ms ease-out,border-color 140ms ease-out}" +
    ".is-offer button:hover{color:var(--ink,#17191c);border-color:var(--ink3,#646a73)}" +
    "@media (prefers-reduced-motion:reduce){.is-offer .is-offer-go,.is-offer button{transition:none}}";

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
    if (had && from && from.focus) from.focus();
  }

  function show(link, now) {
    from = link;
    try { sessionStorage.setItem(SHOWN_KEY, "1"); } catch (e) {}
    if (!styled) { styled = true; document.head.appendChild(el("style", {}, CSS)); }
    bar = el("div", { "class": "is-offer", role: "status" });
    var p = el("p", {});
    p.appendChild(el("b", {}, "Applying? "));
    p.appendChild(document.createTextNode("Auto-Apply can fill in this application from your resume. You check it and press Submit yourself."));
    var go = el("a", { "class": "is-offer-go", href: storeUrl(), target: "_blank", rel: "noopener" }, "Add to Chrome, free");
    var no = el("button", { type: "button" }, "Dismiss");
    go.addEventListener("click", function () { count("apply_offer_click"); close(Date.now()); });
    no.addEventListener("click", function () { close(Date.now()); });
    bar.addEventListener("keydown", function (e) { if (e.key === "Escape") close(Date.now()); });
    bar.appendChild(p); bar.appendChild(go); bar.appendChild(no);
    document.body.appendChild(bar);
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

  window.ISOffer = { due: due, POSTING: POSTING, DISMISSED_KEY: DISMISSED_KEY, SHOWN_KEY: SHOWN_KEY, QUIET: QUIET };
})();
