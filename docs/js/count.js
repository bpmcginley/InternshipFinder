// Exact visit counter (added 2026-09-30; worker/src/visits.js). Cloudflare Web Analytics samples page
// loads, about one in ten, so small visit numbers came in steps of 10. This sends one ping per page
// load to the InternScout Worker, which adds one to a daily total by page kind and where the visit came
// from. Sent: this page's path, the referring site's host name (never its full address) and any
// utm_source / utm_medium on the link. No cookie, no ID, nothing kept in the browser.
//
// Since 2026-10-01 it also counts steps toward using InternScout (window.ISCount("signin") and the
// rest of worker/src/visits.js EVENTS), the same way: a daily total per step, nothing about who.
// Each step counts once per page load, so a double click is one. Clicks on a Chrome Web Store link
// count as "install_click" on every page without the page having to say so.
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
  var done = {};
  // Steps asked for before this file ran (core.js IS.count queues them) are sent now.
  var queued = window.ISCountQ || [];
  window.ISCount = function (event) {
    if (!live || done[event]) return;   // local copies and automated browsers count nothing
    done[event] = true;
    beacon({ e: event, p: location.pathname });
  };
  queued.forEach(function (e) { window.ISCount(e); });
  window.ISCountQ = { push: window.ISCount };
  if (!live) return;
  // Any link to the extension's store page, on any page (landing pages, install guide, dashboard).
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (a && /^https:\/\/chromewebstore\.google\.com\//.test(a.href)) window.ISCount("install_click");
  }, true);
  var send = function () {
    var q = new URLSearchParams(location.search), ref = "";
    try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) {}
    // text/plain keeps this a simple request: no CORS preflight, and the page never waits on it.
    beacon({ p: location.pathname, r: ref, u: q.get("utm_source") || "", m: q.get("utm_medium") || "" });
  };
  // A page Chrome prerenders in case it is opened counts only if it is actually shown.
  if (document.prerendering) document.addEventListener("prerenderingchange", send, { once: true });
  else send();
})();
