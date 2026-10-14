// In-tab status card (ISOLATED world, top frame). Shows what the agent is doing, lets you
// pause / take over / answer, and at ready_to_submit tells you to review and submit yourself.
(function () {
  if (window.__isOverlay) return;
  window.__isOverlay = true;

  const host = document.createElement("div");
  host.setAttribute("data-is-overlay", "1");
  host.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  // The colours are extension/lib/theme.css's (and the dashboard's) design tokens, set on the shadow host so
  // the employer's page can't change them, light and dark (2026-10-14; tests/site/tokens.test.mjs keeps them
  // equal). was: hex values typed in, with amber #9a6412 and green #1f7a4d under WCAG AA, ink3 #868b92 (3.2:1),
  // light only. The page's own fonts can't be loaded inside a shadow root, so the faces fall back to the system's.
  root.innerHTML = `<style>
    :host{--paper:#f6f4ef;--panel:#fffefb;--sunk:#efece5;--ink:#17191c;--ink2:#454a52;--ink3:#646a73;--rule:#e2ded4;--rule2:#ece9e1;--field-border:#80858c;--accent:#1d5c46;--accent-ink:#fff;--accent-hover:#164a38;--accent-soft:#e3eee8;--blue:#2b5aa0;--amber:#8c5a0f;--amber-soft:#f6ecd9;--green:#1d7549;--red:#a8362c;--sans:"IBM Plex Sans","Plex Fallback",system-ui,-apple-system,"Segoe UI",sans-serif;--serif:"Source Serif 4","Serif Fallback",Georgia,"Times New Roman",serif;--fs-1:12px;--fs-2:13px;--fs-3:15px;--r-sm:4px;--r:6px;--r-lg:8px;--shadow-pop:0 10px 30px color-mix(in srgb,var(--ink) 14%,transparent)}
    @media (prefers-color-scheme:dark){:host{--paper:#131416;--panel:#1a1b1e;--sunk:#232427;--ink:#ecebe6;--ink2:#b8b6af;--ink3:#95948e;--rule:#2c2d31;--rule2:#232427;--field-border:#6e7077;--accent:#7cc3a1;--accent-ink:#0f1a15;--accent-hover:#95d2b3;--accent-soft:#1c2a24;--blue:#8fb2e8;--amber:#e0b25e;--amber-soft:#2e2717;--green:#7cc3a1;--red:#e48a80}}
    .card{font:var(--fs-2)/1.45 var(--sans);background:var(--panel);color:var(--ink);border:1px solid var(--rule);border-top:2px solid var(--ink);border-radius:var(--r-lg);box-shadow:var(--shadow-pop);width:300px;padding:11px 13px 12px}
    .top{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .top b{font:600 var(--fs-3)/1 var(--serif)}
    .dot{width:7px;height:7px;border-radius:50%;background:var(--ink3);flex:none}
    .working .dot{background:var(--blue);animation:p 1.2s infinite}.needs_you .dot{background:var(--amber)}.ready_to_submit .dot{background:var(--green)}.submitted .dot{background:var(--green)}.failed .dot{background:var(--red)}
    @keyframes p{50%{opacity:.35}}
    @media (prefers-reduced-motion:reduce){.working .dot{animation:none}}
    b{font-weight:600}.muted{color:var(--ink3);font-size:var(--fs-1)}
    .co{color:var(--ink2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.co b{color:var(--ink)}
    .st{display:inline-flex;align-items:center;gap:4px;margin-top:4px;font-size:var(--fs-1);font-weight:500;color:var(--ink2);white-space:nowrap;background:var(--sunk);padding:2px 8px 2px 6px;border-radius:var(--r-sm)}
    .needs_you .st{color:var(--amber);background:var(--amber-soft)}.ready_to_submit .st,.submitted .st{color:var(--green);background:var(--accent-soft)}.failed .st{color:var(--red)}
    .msg{margin:6px 0;white-space:pre-wrap}
    ul{margin:4px 0 6px 16px;padding:0;color:var(--ink2)}
    .row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
    button{background:var(--panel);color:var(--ink);border:1px solid var(--field-border);border-radius:var(--r);min-height:32px;padding:0 10px;font-weight:500;font-size:var(--fs-1);line-height:1.3;font-family:inherit;cursor:pointer}
    button:hover{border-color:var(--ink3)}
    button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
    button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
    button.quiet{background:transparent;border-color:transparent;color:var(--accent);padding:0 6px}
    button.quiet:hover{border-color:transparent;text-decoration:underline;text-underline-offset:3px}
    :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    textarea{width:100%;box-sizing:border-box;background:var(--panel);color:var(--ink);border:1px solid var(--field-border);border-radius:var(--r);padding:6px 8px;font:inherit;min-height:52px;margin-top:6px}
    .x{margin-left:auto;background:none;border:0;color:var(--ink3);min-height:0;padding:0 2px}
    .min .body{display:none}
  </style><div class="card" id="card"><div class="top"><span class="dot"></span><b>InternScout</b><button class="x" id="min" title="Minimize" aria-label="Minimize">–</button></div><div class="body" id="body"></div></div>`;
  const $ = (s) => root.querySelector(s);
  let job = null, lastHtml = "";

  const LABEL = { queued: "Queued", working: "Working", needs_you: "Needs you", ready_to_submit: "Ready to submit", submitted: "Submitted", failed: "Failed" };
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // After the extension is reloaded or updated, this old copy of the script stays on the page with
  // a dead connection: chrome.runtime.sendMessage throws "Extension context invalidated". Say so on
  // the card instead of failing silently. The callback also reads lastError, so a page that goes into
  // the back/forward cache doesn't log "message channel is closed".
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  function stale() {
    if (!host.isConnected) return;
    $("#card").className = "card failed";
    $("#body").innerHTML = `<div><span class="st">Reload this page</span></div><div class="msg">InternScout was updated or reloaded, so this card lost its connection. Reload this page, then use the side panel to resume.</div>`;
  }
  function msg(m, cb) {
    if (!alive()) { stale(); return; }
    try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; if (cb) cb(r); }); }
    catch { stale(); }
  }
  const send = (action, extra = {}) => msg({ type: "control", id: job.id, action, ...extra });

  function render(j) {
    job = j;
    if (!j) { host.remove(); return; }
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    $("#card").className = "card " + j.status + ($("#card").classList.contains("min") ? " min" : "");
    // Company and title on the first line, then the status chip, then one row of actions (A2 component 8,
    // D25). was: the status beside "InternScout" and the company and title in small grey text.
    let h = `<div class="co"><b>${esc(j.company)}</b> · ${esc(j.title)}</div><div><span class="st">${esc(LABEL[j.status] || j.status)}</span></div>`;
    if (j.status === "working") {
      h += `<div class="msg">${esc(j.activity || "Reading the page…")}</div><div class="row"><button id="pause">Pause</button><button id="take">Take over</button></div>`;
    } else if (j.status === "needs_you") {
      if (j.question) h += `<div class="msg"><b>${esc(j.question)}</b></div><div class="muted">${esc(j.reason)}</div><textarea id="ans" placeholder="Your answer (saved to your profile)"></textarea><div class="row"><button class="primary" id="answer">Answer &amp; continue</button></div>`;
      else h += `<div class="msg">${esc(j.reason)}</div><div class="row"><button class="primary" id="resume">Resume</button></div>`;
    } else if (j.status === "ready_to_submit") {
      h += `<div class="msg"><b>Review, then press Submit yourself.</b> Green = filled by the agent, amber = still empty, red = the submit button.</div>`;
      if (j.summary) h += `<div class="muted">${esc(j.summary)}</div>`;
      if (j.double_check && j.double_check.length) h += `<ul>${j.double_check.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
      // "I submitted it" first and as the main button; "Check the form again" last and quiet. was: "Keep going"
      // first, which read like "go on and submit" at the moment the student is about to; it starts another
      // pass over the form (control "resume"). The side panel adds "Review and submit" between them
      // (sidepanel/card.js); here the student is already on the form.
      h += `<div class="row"><button class="primary" id="done">I submitted it</button><button class="quiet" id="more">Check the form again</button></div>`;
    } else if (j.status === "submitted") {
      h += `<div class="msg">Submitted ✓ Marked as applied on your dashboard.</div>`;
    } else if (j.status === "failed") {
      h += `<div class="msg">${esc(j.reason)}</div><div class="row"><button id="retry">Retry</button></div>`;
    } else {
      h += `<div class="msg">Waiting for a free slot…</div>`;
    }
    // A redraw comes with every log line. Unchanged, it is skipped; otherwise the focused button and a
    // half-typed answer are put back, so Pause and Take over stay reachable from the keyboard.
    // was: $("#body").innerHTML = h; every time.
    if (h === lastHtml) return;
    lastHtml = h;
    const had = root.activeElement && root.activeElement.id, typed = root.getElementById("ans") && root.getElementById("ans").value;
    $("#body").innerHTML = h;
    if (typed && root.getElementById("ans")) root.getElementById("ans").value = typed;
    if (had && root.getElementById(had)) root.getElementById(had).focus({ preventScroll: true });
    const on = (id, fn) => { const b = root.getElementById(id); if (b) b.onclick = fn; };
    on("pause", () => send("pause"));
    on("take", () => send("takeover"));
    on("resume", () => send("resume"));
    on("answer", () => { const v = root.getElementById("ans").value.trim(); if (v) send("answer", { answer: v }); });
    on("more", () => send("resume"));
    on("done", () => send("submitted"));
    on("retry", () => send("retry"));
  }

  $("#min").onclick = () => $("#card").classList.toggle("min");

  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "overlay") render(m.job); });
  msg({ type: "overlay_hello" }, (r) => { if (r && r.job) render(r.job); });

  // A real click on a final-submit button starts confirmation-page detection.
  document.addEventListener("click", (e) => {
    if (!e.isTrusted || !job || job.status !== "ready_to_submit" || !window.ISGuard) return;
    const t = window.ISGuard.clickTarget(e.target);
    if (t && window.ISGuard.classify(window.ISGuard.describe(t)) !== "ok") msg({ type: "maybe_submitted" });
  }, true);
})();
