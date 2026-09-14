// In-tab status card (ISOLATED world, top frame). Shows what the agent is doing, lets you
// pause / take over / answer, and at ready_to_submit tells you to review and submit yourself.
(function () {
  if (window.__isOverlay) return;
  window.__isOverlay = true;

  const host = document.createElement("div");
  host.setAttribute("data-is-overlay", "1");
  host.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    .card{font:13px/1.45 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;background:#fffefb;color:#17191c;border:1px solid #e2ded4;border-top:2px solid #17191c;border-radius:8px;box-shadow:0 10px 30px rgba(20,20,20,.16);width:300px;padding:11px 13px 12px}
    .top{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .top b{font:600 15px/1 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
    .dot{width:7px;height:7px;border-radius:50%;background:#868b92;flex:none}
    .working .dot{background:#2b5aa0;animation:p 1.2s infinite}.needs_you .dot{background:#9a6412}.ready_to_submit .dot{background:#1f7a4d}.submitted .dot{background:#1f7a4d}.failed .dot{background:#a8362c}
    @keyframes p{50%{opacity:.35}}
    b{font-weight:600}.muted{color:#868b92;font-size:12px}.co{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .msg{margin:6px 0;white-space:pre-wrap}
    ul{margin:4px 0 6px 16px;padding:0;color:#4b5058}
    .row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
    button{background:#fffefb;color:#17191c;border:1px solid #e2ded4;border-radius:6px;padding:5px 10px;font-weight:500;font-size:12px;line-height:1.3;font-family:inherit;cursor:pointer}
    button:hover{border-color:#868b92}
    button.primary{background:#1d5c46;border-color:#1d5c46;color:#fff}
    textarea{width:100%;box-sizing:border-box;background:#fff;color:#17191c;border:1px solid #e2ded4;border-radius:6px;padding:6px 8px;font:inherit;min-height:52px;margin-top:6px}
    .x{margin-left:auto;background:none;border:0;color:#868b92;padding:0 2px}
    .min .body{display:none}
  </style><div class="card" id="card"><div class="top"><span class="dot"></span><b>InternScout</b><span class="muted" id="st"></span><button class="x" id="min" title="Minimize">–</button></div><div class="body" id="body"></div></div>`;
  const $ = (s) => root.querySelector(s);
  let job = null;

  const LABEL = { queued: "Queued", working: "Working", needs_you: "Needs you", ready_to_submit: "Ready to submit", submitted: "Submitted", failed: "Failed" };
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: "control", id: job.id, action, ...extra });

  function render(j) {
    job = j;
    if (!j) { host.remove(); return; }
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    $("#card").className = "card " + j.status + ($("#card").classList.contains("min") ? " min" : "");
    $("#st").textContent = "· " + (LABEL[j.status] || j.status);
    let h = `<div class="co muted">${esc(j.company)} · ${esc(j.title)}</div>`;
    if (j.status === "working") {
      h += `<div class="msg">${esc(j.activity || "Reading the page…")}</div><div class="row"><button id="pause">Pause</button><button id="take">Take over</button></div>`;
    } else if (j.status === "needs_you") {
      if (j.question) h += `<div class="msg"><b>${esc(j.question)}</b></div><div class="muted">${esc(j.reason)}</div><textarea id="ans" placeholder="Your answer (saved to your profile)"></textarea><div class="row"><button class="primary" id="answer">Answer &amp; continue</button></div>`;
      else h += `<div class="msg">${esc(j.reason)}</div><div class="row"><button class="primary" id="resume">Resume</button></div>`;
    } else if (j.status === "ready_to_submit") {
      h += `<div class="msg"><b>Review, then press Submit yourself.</b> Green = filled by the agent, amber = still empty, red = the submit button.</div>`;
      if (j.summary) h += `<div class="muted">${esc(j.summary)}</div>`;
      if (j.double_check && j.double_check.length) h += `<ul>${j.double_check.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
      h += `<div class="row"><button id="more">Keep going</button><button id="done">I submitted it</button></div>`;
    } else if (j.status === "submitted") {
      h += `<div class="msg">Submitted ✓ Marked as applied on your dashboard.</div>`;
    } else if (j.status === "failed") {
      h += `<div class="msg">${esc(j.reason)}</div><div class="row"><button id="retry">Retry</button></div>`;
    } else {
      h += `<div class="msg">Waiting for a free slot…</div>`;
    }
    $("#body").innerHTML = h;
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
  chrome.runtime.sendMessage({ type: "overlay_hello" }, (r) => { void chrome.runtime.lastError; if (r && r.job) render(r.job); });

  // A real click on a final-submit button starts confirmation-page detection.
  document.addEventListener("click", (e) => {
    if (!e.isTrusted || !job || job.status !== "ready_to_submit" || !window.ISGuard) return;
    const t = window.ISGuard.clickTarget(e.target);
    if (t && window.ISGuard.classify(window.ISGuard.describe(t)) !== "ok") chrome.runtime.sendMessage({ type: "maybe_submitted" });
  }, true);
})();
