// Exact visit counter (added 2026-09-30; worker/src/visits.js). Cloudflare Web Analytics samples page
// loads, about one in ten, so small visit numbers came in steps of 10. This sends one ping per page
// load to the InternScout Worker, which adds one to a daily total by page kind and where the visit came
// from. Sent: this page's path, the referring site's host name (never its full address) and any
// utm_source / utm_medium on the link. No cookie, no ID, nothing kept in the browser.
(function () {
  try {
    if (!/^(internscout\.org|bpmcginley\.github\.io)$/.test(location.hostname)) return;   // not local copies
    if (navigator.webdriver || !navigator.sendBeacon) return;                              // not automated browsers
    var send = function () {
      var q = new URLSearchParams(location.search), ref = "";
      try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) {}
      var body = JSON.stringify({ p: location.pathname, r: ref, u: q.get("utm_source") || "", m: q.get("utm_medium") || "" });
      // text/plain keeps this a simple request: no CORS preflight, and the page never waits on it.
      navigator.sendBeacon("https://internscout-api.bpmcginley.workers.dev/hit", new Blob([body], { type: "text/plain" }));
    };
    // A page Chrome prerenders in case it is opened counts only if it is actually shown.
    if (document.prerendering) document.addEventListener("prerenderingchange", send, { once: true });
    else send();
  } catch (e) {}
})();
