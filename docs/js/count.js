// Exact visit counter (added 2026-09-30; worker/src/visits.js). Cloudflare Web Analytics samples page
// loads, about one in ten, so small visit numbers came in steps of 10. This sends one ping per page
// load to the InternScout Worker, which adds one to a daily total by page kind and where the visit came
// from. Sent: this page's path, the referring site's host name (never its full address) and any
// utm_source / utm_medium on the link. No cookie or ID is used. Since 2026-10-27, a campaign's
// short source/medium/campaign/content tags stay only in this tab's session storage so a later
// install, digest form submission or employer order attempt can still be counted under the link
// that brought the visitor here. Closing the tab clears them.
//
// Since 2026-10-01 it also counts steps toward using InternScout (window.ISCount("signin") and the
// rest of worker/src/visits.js EVENTS), the same way: a daily total per step, nothing about who.
// Each step counts once per page load, so a double click is one. Clicks on a Chrome Web Store link
// count as "install_click" on every page without the page having to say so, and since 2026-10-04 a
// click on "Open posting" (a.go on the generated landing pages, a.open-link on the dashboard) counts as
// "posting_click" the same way, once per page load like every step. Since 2026-10-06 sending a weekly
// email sign-up form (form.digest: the dashboard's, and the landing pages' and /digest/'s from
// backend/internscout/seo_pages.py signup_form) counts as "digest_signup", once per page load. Only
// that the form was sent goes, with this page's path like every step: never the address or a field.
// Since 2026-10-07 a click on a link to the listing's reviews page counts as "review_click" rather than
// "install_click" (the dashboard's review line, the install page's review links), once per page load.
// Since 2026-10-14 (S9) a paid listing's box is counted the same way: "shown" once per page load when the
// box is at least half on screen, and "open" once when its posting link is pressed. Only the placement's
// id goes, with this page's path: never the listing, a search, a filter or anything about who.
// Since 2026-10-15 digest placements also count an observed view (at least 25% visible), a link
// click and a form submission separately. These are page-load totals, never unique people or
// confirmed subscribers. The legacy digest_signup still means only that a form was submitted.
(function () {
  var API = "https://internscout-api.bpmcginley.workers.dev/hit";
  // "Don't count this browser" (2026-10-01), for the owner's own visits: ?nocount=1 on any page turns
  // it on, ?nocount=0 off, and the dashboard's admin menu (?admin=1) has a switch. One setting in
  // local storage; the load that sets it is not counted either.
  var KEY = "internscout.nocount", off = false;
  try {
    var nc = new URLSearchParams(location.search).get("nocount");
    if (nc === "1") localStorage.setItem(KEY, "1");
    else if (nc === "0") localStorage.removeItem(KEY);
    off = localStorage.getItem(KEY) === "1";
  } catch (e) {}
  // was: var live = /^(...)$/.test(location.hostname) && !navigator.webdriver && !!navigator.sendBeacon;
  var live = /^(internscout\.org|bpmcginley\.github\.io)$/.test(location.hostname) && !navigator.webdriver && !!navigator.sendBeacon && !off;
  var beacon = function (data) {
    try { navigator.sendBeacon(API, new Blob([JSON.stringify(data)], { type: "text/plain" })); } catch (e) {}
  };
  // 2026-10-27: keep only bounded UTM slugs, never a URL, form value or visitor id. Revert: remove
  // ATTR_KEY/campaignContext and send ordinary event beacons again.
  var ATTR_KEY = "internscout.campaign", safeTag = function (value) {
    value = String(value || "").toLowerCase().trim();
    return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(value) ? value : "";
  };
  // Counting off means attribution off too: erase a campaign retained earlier in this tab.
  if (!live) { try { sessionStorage.removeItem(ATTR_KEY); } catch (e) {} }
  var campaignContext = function () {
    var q = new URLSearchParams(location.search), ref = "", saved = {};
    try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) {}
    try { saved = JSON.parse(sessionStorage.getItem(ATTR_KEY) || "{}") || {}; } catch (e) {}
    var tagged = ["utm_source", "utm_medium", "utm_campaign", "utm_content"].some(function (key) { return q.get(key); });
    var continuing = /(^|\.)(internscout\.org|bpmcginley\.github\.io)$|^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|checkout\.stripe\.com|billing\.stripe\.com)$/.test(ref);
    if (tagged) {
      saved = { r: ref, u: safeTag(q.get("utm_source")), m: safeTag(q.get("utm_medium")),
        c: safeTag(q.get("utm_campaign")), t: safeTag(q.get("utm_content")) };
      try { sessionStorage.setItem(ATTR_KEY, JSON.stringify(saved)); } catch (e) {}
    } else if (ref && !continuing) {
      saved = { r: ref, u: "", m: "", c: "", t: "" };
      try { sessionStorage.setItem(ATTR_KEY, JSON.stringify(saved)); } catch (e) {}
    }
    return { r: String(saved.r || "").slice(0, 253), u: safeTag(saved.u), m: safeTag(saved.m),
      c: safeTag(saved.c), t: safeTag(saved.t) };
  };
  var attribution = live ? campaignContext() : {};
  var attributedEvents = { install_click: true, digest_signup: true, employer_order_submit: true };
  var addAttribution = function (data, attr) {
    ["r", "u", "m", "c", "t"].forEach(function (key) { if (attr[key]) data[key] = attr[key]; });
    return data;
  };
  var done = {};
  // 2026-10-23: new employer steps use fixed paths, so even public employer keys stay out of pings.
  // was: every step sent location.pathname. Revert: use the ordinary path for employer steps too.
  var employerPage = function () {
    var path = String(location.pathname || "/").replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/\/+$/, "") || "/";
    if (path === "/employers/buy") return "/employers/buy/";
    if (path === "/employers") return "/employers/";
    if (path === "/internships" || path.indexOf("/internships/") === 0) return "/internships/";
    if (path === "/" || path === "/install" || path === "/privacy" || path === "/terms" || path === "/digest") return path;
    return "/other";
  };
  // Steps asked for before this file ran (core.js IS.count queues them) are sent now.
  var queued = window.ISCountQ || [];
  window.ISCount = function (event) {
    if (!live || done[event]) return;   // local copies and automated browsers count nothing
    done[event] = true;
    var data = { e: event, p: /^employer_/.test(event) ? employerPage() : location.pathname };
    beacon(attributedEvents[event] ? addAttribution(data, attribution) : data);
  };
  queued.forEach(function (e) { window.ISCount(e); });
  window.ISCountQ = { push: window.ISCount };
  // Paid listings (S9, 2026-10-14). A box carries data-placement="<id>": the dashboard's (js/placements.js
  // PaidBox, which hands its element over through window.ISPlacementQ once it is on the page) and the
  // landing pages' (backend/internscout/seo_pages.py placement_box, in the page from the start). The Worker
  // keeps a count only for a placement that is on today (worker/src/visits.js).
  var plDone = {};
  var plSend = function (id, e) {
    if (!live || !id || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || plDone[id + " " + e]) return;
    plDone[id + " " + e] = true;
    beacon({ s: id, e: e, p: location.pathname });
  };
  var plSeen = live && window.IntersectionObserver ? new IntersectionObserver(function (list) {
    list.forEach(function (en) {
      if (!en.isIntersecting || en.intersectionRatio < 0.5) return;
      plSend(en.target.getAttribute("data-placement"), "shown");
      plSeen.unobserve(en.target);
    });
  }, { threshold: [0.5] }) : null;
  var plWatch = function (el) { if (plSeen && el && el.getAttribute && el.getAttribute("data-placement")) plSeen.observe(el); };
  var plQueued = window.ISPlacementQ || [];
  window.ISPlacementQ = { push: plWatch };
  if (!live) return;
  if (plQueued.forEach) plQueued.forEach(plWatch);
  if (document.querySelectorAll) Array.prototype.forEach.call(document.querySelectorAll("[data-placement]"), plWatch);
  var digestPlacements = ["footer", "results-inline", "digest-page", "landing", "contextual", "nav"];
  // 2026-10-23: employer entry totals are finite anonymous steps, not unique people or purchases.
  // was: no employer entry attribution. Revert: remove employerEntry/employerCount and their calls.
  var employerEntries = ["hero", "packages", "contact", "nav", "employer", "footer", "report"];
  var employerEntry = function (el) {
    var value = el && el.getAttribute ? el.getAttribute("data-employer-entry") : "";
    return employerEntries.indexOf(value) >= 0 ? value : "";
  };
  var employerCount = function (step, el) {
    var entry = employerEntry(el);
    if (entry) window.ISCount("employer_" + step + "_" + entry);
  };
  var digestPlacement = function (el) {
    var value = el && el.getAttribute ? el.getAttribute("data-digest-placement") : "";
    return digestPlacements.indexOf(value) >= 0 ? value.replace(/-/g, "_") : "";
  };
  var digestCount = function (step, el) {
    var placement = digestPlacement(el);
    if (placement) window.ISCount("digest_" + step + "_" + placement);
  };
  // Observe actual exposure, including forms React inserts later. Without IntersectionObserver,
  // views stay unknown: being in the DOM is not evidence that someone saw a form below the list.
  // Inspect only newly added subtrees, not every result row on every React update.
  if (window.IntersectionObserver && document.querySelectorAll) {
    var observed = new WeakSet();
    var views = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.25) {
          digestCount("view", entry.target);
          employerCount("view", entry.target);
          views.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });
    var watch = function (el) {
      if ((!digestPlacement(el) && !employerEntry(el)) || observed.has(el)) return;
      observed.add(el);
      views.observe(el);
    };
    var scan = function (node) {
      if (!node || node.nodeType !== 1) return;
      watch(node);
      if (node.querySelectorAll) node.querySelectorAll("[data-digest-placement], [data-employer-entry]").forEach(watch);
    };
    document.querySelectorAll("[data-digest-placement], [data-employer-entry]").forEach(watch);
    if (window.MutationObserver && document.body) {
      var mounts = new MutationObserver(function (changes) {
        changes.forEach(function (change) {
          change.removedNodes.forEach(function (node) {
            if (node.nodeType !== 1) return;
            views.unobserve(node);
            observed.delete(node);
            if (node.querySelectorAll) node.querySelectorAll("[data-digest-placement], [data-employer-entry]").forEach(function (el) { views.unobserve(el); observed.delete(el); });
          });
          change.addedNodes.forEach(scan);
        });
      });
      mounts.observe(document.body, { childList: true, subtree: true });
    }
  }
  // Any link to the extension's store page, on any page (landing pages, install guide, dashboard).
  // And a posting opened from a landing page or the dashboard: the step after a search, which the
  // counts could not see before.
  document.addEventListener("click", function (ev) {
    // was: var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    var t = ev.target && ev.target.closest ? ev.target : null;
    var a = t ? t.closest("a[href]") : null;
    if (a) digestCount("click", a);
    if (a) employerCount("click", a);
    // was: if (a && /^https:\/\/chromewebstore\.google\.com\//.test(a.href)) window.ISCount("install_click");
    // Since 2026-10-07 a link to the listing's reviews page (".../reviews") is a "review_click" instead:
    // someone who already has the extension going to review it, not someone going to install it.
    if (a && /^https:\/\/chromewebstore\.google\.com\//.test(a.href)) {
      window.ISCount(/^https:\/\/chromewebstore\.google\.com\/detail\/[^?#]*\/reviews\/?([?#]|$)/.test(a.href) ? "review_click" : "install_click");
    }
    // A paid listing's box (li.paid, seo_pages.placement_box) uses the same "go" link, but payment must
    // never change a count, so its clicks are left out.
    if (t && t.closest("a.go[href], a.open-link[href]") && !t.closest(".paid")) window.ISCount("posting_click");
    // A paid listing's own posting link (rel="sponsored"), not its "Why am I seeing this?" link.
    var box = a && a.closest && a.getAttribute ? a.closest("[data-placement]") : null;
    if (box && /(^|\s)sponsored(\s|$)/.test(a.getAttribute("rel") || "")) plSend(box.getAttribute("data-placement"), "open");
  }, true);
  // A sign-up form sent. "submit" fires only once the browser has passed the form's own checks (the
  // email box is required), and the form still posts to Buttondown in its new tab as before.
  document.addEventListener("submit", function (ev) {
    var f = ev.target;
    if (f && f.matches && f.matches("form.digest")) {
      window.ISCount("digest_signup");
      digestCount("submit", f);
    }
  }, true);
  var send = function () {
    var q = new URLSearchParams(location.search), ref = "";
    try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) {}
    // text/plain keeps this a simple request: no CORS preflight, and the page never waits on it.
    var data = { p: location.pathname, r: ref, u: safeTag(q.get("utm_source")), m: safeTag(q.get("utm_medium")) };
    addAttribution(data, { c: safeTag(q.get("utm_campaign")), t: safeTag(q.get("utm_content")) });
    beacon(data);
  };
  // A page Chrome prerenders in case it is opened counts only if it is actually shown.
  if (document.prerendering) document.addEventListener("prerenderingchange", send, { once: true });
  else send();
})();
