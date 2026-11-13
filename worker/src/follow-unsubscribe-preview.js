// Static, send-free GET. The browser alone retains the capability until an explicit action.
const SCRIPT = String.raw`(() => {
  "use strict";
  const path = "/follows/unsubscribe";
  const invalid = "This link is invalid.";
  const unavailable = "Email follows are unavailable. Please try again later.";
  let token = "", retired = false, attempted = false, button, status, controller;
  function capture() {
    const query = location.search, fragment = location.hash;
    let cleared = false;
    try { history.replaceState(null, "", path); cleared = true; } catch {}
    if (!cleared || fragment || location.pathname !== path || query.length > 108) return "";
    const match = /^\?token=([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64})$/.exec(query);
    return match ? match[1] : "";
  }
  token = capture();
  function retire() {
    retired = true; token = ""; controller?.abort();
    try { history.replaceState(null, "", path); } catch {}
    if (button) button.disabled = true;
    if (status) status.textContent = invalid;
  }
  addEventListener("pagehide", retire);
  addEventListener("pageshow", event => { if (event.persisted) retire(); });
  addEventListener("popstate", retire);
  addEventListener("hashchange", () => { if (location.hash !== "#main" || location.search) retire(); });
  document.addEventListener("DOMContentLoaded", () => {
    button = document.getElementById("unsubscribe");
    status = document.getElementById("status");
    button.disabled = !token || retired;
    if (!token || retired) status.textContent = invalid;
    button.addEventListener("click", async () => {
      if (location.search || (location.hash && location.hash !== "#main")) { retire(); return; }
      if (retired || attempted || !token) return;
      attempted = true; button.disabled = true;
      const capability = token;
      token = "";
      controller = new AbortController();
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true; controller.abort();
        if (!retired) status.textContent = unavailable;
      }, 12000);
      try {
        const response = await fetch(path + "?token=" + capability, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click", credentials: "omit", cache: "no-store",
          redirect: "error", mode: "same-origin", referrerPolicy: "no-referrer", signal: controller.signal,
        });
        void response.body?.cancel().catch(() => {});
        if (expired || retired) return;
        if (location.search || (location.hash && location.hash !== "#main")) { retire(); return; }
        status.textContent = response.status === 204
          ? "If this link matched an email subscription, it has been unsubscribed."
          : unavailable;
      } catch {
        if (!retired) status.textContent = unavailable;
      } finally { clearTimeout(timeout); }
    });
  }, { once: true });
})();`;

const STYLE = `:root{color-scheme:light dark;--bg:#f7f5f0;--panel:#fff;--ink:#172b35;--muted:#52626a;--line:#c3c9c6;--accent:#00695d;--button:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#121617;--panel:#1b2021;--ink:#f0f2ed;--muted:#b6c2c1;--line:#5c6c6a;--accent:#85d9c9;--button:#102b26}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.6 system-ui,sans-serif}header,main,footer{width:min(100% - 40px,680px);margin-inline:auto}header{padding-block:28px;font-size:22px;font-weight:750}main{margin-top:36px;padding:32px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}h1{font-size:clamp(28px,5vw,38px);line-height:1.2;margin:0 0 20px}p{margin:16px 0}.eyebrow{color:var(--muted);font-size:15px;margin:0 0 12px}button{font:inherit;font-weight:650;min-height:48px;padding:10px 24px;border:1px solid var(--accent);border-radius:7px;color:var(--button);background:var(--accent);cursor:pointer}button:disabled{opacity:.65;cursor:default}:focus-visible{outline:3px solid var(--accent);outline-offset:4px}#status{min-height:2em}footer{padding-block:28px;font-size:16px}.skip{position:absolute;left:20px;top:-80px;background:var(--panel);padding:8px;color:var(--accent)}.skip:focus{top:4px}@media(max-width:500px){main{margin-top:16px;padding:24px}button{width:100%}}`;

const HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>Unsubscribe | InternScout</title><script>${SCRIPT}</script><style>${STYLE}</style>
</head><body><a class="skip" href="#main">Skip to content</a><header>InternScout</header>
<main id="main" tabindex="-1"><p class="eyebrow">Email follows</p><h1>Unsubscribe</h1>
<p>Select Unsubscribe to stop internship follow emails.</p>
<button id="unsubscribe" type="button" disabled>Unsubscribe</button>
<p id="status" role="status" aria-live="polite" aria-atomic="true"></p>
<noscript><p>JavaScript is needed to use this email link. No action has been taken.</p></noscript>
</main></body></html>`;

const HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'sha256-LolS+V2BiVyxlG3SIm9U0knB42bG1qbpQbAtLBrfLpA='; style-src 'sha256-/WZ1fLN1PkTvpxZwxcEPIEdwX4L0md/tvjJ4jtEjtMI='; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

export async function followUnsubscribePreview(request) {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/follows/unsubscribe")
    return new Response(null, { status: 404, headers: HEADERS });
  return new Response(HTML, { headers: HEADERS });
}
