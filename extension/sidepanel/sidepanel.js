import { loadStore, updateStore, hasKey } from "../lib/store.js";
import { spend, perApplication, money } from "../lib/usage.js";
import { requestHostAccess, hostOf } from "../lib/hosts.js";

const main = document.getElementById("main");
let tab = "queue";
const drafts = {}; // keep typed answers across re-renders

const LABEL = { queued: "Queued", working: "Working", needs_you: "Needs you", ready_to_submit: "Ready to submit", submitted: "Submitted", failed: "Failed" };
const GROUPS = [
  ["Needs you", ["needs_you"]],
  ["Ready to submit", ["ready_to_submit"]],
  ["In progress", ["working", "queued"]],
  ["Done", ["submitted", "failed"]],
];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const send = (m) => chrome.runtime.sendMessage(m);
const control = (id, action, answer) => send({ type: "control", id, action, answer });
const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  tab = b.dataset.tab;
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
  render();
}));

function jobCard(j) {
  // Status is a small pill; the AI cost sits beside it in grey rather than inside it.
  let h = `<div class="card ${j.status}" data-id="${j.id}"><div class="top"><span class="dot"></span><span class="co">${esc(j.company)}</span><span class="st">${LABEL[j.status] || j.status}</span>${j.cost_usd ? `<span class="cost">${money(j.cost_usd)}</span>` : ""}</div><div class="title">${esc(j.title)}${j.location ? " · " + esc(j.location) : ""}</div>`;
  const btns = [];
  if (j.status === "working") {
    h += `<div class="msg small">${esc(j.activity || "Working…")} (step ${j.steps || 0})</div>`;
    btns.push(["pause", "Pause"], ["takeover", "Take over"], ["focus", "Show tab"]);
  } else if (j.status === "needs_you") {
    const t = j.tailored;
    if (t && t.status === "pending") {
      h += `<div class="q">Tailored resume ready for review</div>${t.summary ? `<div class="msg small"><b>Summary:</b> ${esc(t.summary)}</div>` : ""}`;
      if (t.changes && t.changes.length) h += `<ul>${t.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;
      if (t.diff && t.diff.length) h += `<details><summary>Before → after (${t.diff.length})</summary>${t.diff.map((d) => `<div class="small" style="margin:6px 0"><s>${esc(d.before)}</s><br>${esc(d.after)}</div>`).join("")}</details>`;
      // A Word resume is tailored in place and comes back as a .docx, which a tab cannot show.
      const word = /\.docx$/i.test((t.file && t.file.name) || "");
      if (t.note) h += `<div class="msg small">${esc(t.note)}</div>`;
      btns.push(["preview_tailored", word ? "Download Word file" : "Preview PDF"], ["approve_tailored", "Use tailored", "primary"], ["skip_tailored", "Use my original"]);
    } else if (j.question) {
      h += `<div class="q">${esc(j.question)}</div>${j.reason ? `<div class="small">${esc(j.reason)}</div>` : ""}<textarea data-ans="${j.id}" placeholder="Answer (saved to your profile for next time)">${esc(drafts[j.id] || "")}</textarea>`;
      btns.push(["answer", "Answer & continue", "primary"]);
    } else if (j.needs_auth) {
      // The sign-in window has to open from a click, which this button is.
      h += `<div class="msg">${esc(j.reason)}</div>`;
      btns.push(["signin_resume", "Sign in & resume", "primary"]);
    } else if (j.needs_host) {
      // Chrome only grants a site from a click on an extension page, which is what this is.
      h += `<div class="msg">${esc(j.reason)}</div>`;
      btns.push(["allow_host", `Allow ${esc(hostOf(j.needs_host))}`, "primary"]);
    } else {
      h += `<div class="msg">${esc(j.reason)}</div>`;
      btns.push(["resume", "Resume", "primary"]);
    }
    btns.push(["focus", "Show tab"]);
  } else if (j.status === "ready_to_submit") {
    h += `<div class="msg">${esc(j.summary || "Everything is filled. Review it, then press Submit yourself.")}</div>`;
    if (j.double_check && j.double_check.length) h += `<ul>${j.double_check.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
    btns.push(["focus", "Review & submit", "primary"], ["submitted", "I submitted it"], ["resume", "Keep going"]);
  } else if (j.status === "failed") {
    h += `<div class="msg">${esc(j.reason)}</div>`;
    btns.push(["retry", "Retry"], ["focus", "Show tab"]);
  } else if (j.status === "queued") {
    h += `<div class="msg small">Waiting for a free tab…</div>`;
  }
  btns.push(["remove", "Remove", "link"]);
  h += `<div class="row">${btns.map(([a, t, c]) => `<button class="b ${c || ""}" data-act="${a}">${t}</button>`).join("")}</div>`;
  const log = (j.log || []).slice(-12).reverse();
  if (log.length) h += `<details><summary>Activity</summary>${log.map((l) => `<div>${esc(l.kind === "answer" ? `${l.question} → ${l.answer}` : l.text || l.kind)}</div>`).join("")}</details>`;
  return h + "</div>";
}

async function renderQueue() {
  const q = (await send({ type: "get_queue" })).queue || { order: [], jobs: {} };
  const jobs = q.order.map((id) => q.jobs[id]).filter(Boolean);
  const s = await loadStore();
  let h = "";
  if (!s.settings.onboarded || !hasKey(s)) h += `<div class="card needs_you"><div class="msg">Finish the Deep Dive before using Auto-Apply.</div><div class="row"><button class="b primary" id="dive">Start Deep Dive</button></div></div>`;
  if (!jobs.length) h += `<div class="empty">No applications queued.<br>Pick internships on the dashboard and press <b>Auto-Apply</b>.<br><br><a href="https://internscout.org/" target="_blank" style="color:var(--blue)">Open dashboard ↗</a></div>`;
  for (const [name, sts] of GROUPS) {
    const list = jobs.filter((j) => sts.includes(j.status));
    if (list.length) h += `<div class="group">${name}<span class="n">${list.length}</span></div>` + list.map(jobCard).join("");
  }
  h += `<div class="group">Apply to any posting</div><form id="addurl" class="row" style="margin-top:0;flex-wrap:nowrap"><input id="url" type="url" required placeholder="https://… application link"><button class="b">Queue</button></form><div class="small" id="addmsg"></div>`;
  const sp = await spend(), avg = perApplication(jobs);
  if (sp.calls) h += `<div class="small" style="margin-top:14px">AI spend this month: <b>${money(sp.month_usd)}</b>${sp.budget ? ` of ${money(sp.budget)} budget` : ""}${avg ? ` · about ${money(avg)} per application` : ""}</div>`;
  h += `<div class="row" style="justify-content:space-between;margin-top:14px"><button class="b link" id="dive2">Redo Deep Dive</button><button class="b link" id="clear">Clear finished</button></div>`;
  main.innerHTML = h;

  main.querySelectorAll("textarea[data-ans]").forEach((t) => t.addEventListener("input", () => { drafts[t.dataset.ans] = t.value; }));
  main.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest("[data-id]").dataset.id;
    const act = b.dataset.act;
    if (act === "preview_tailored") {
      const r = await send({ type: "get_tailored", id });
      if (!r || !r.file) return;
      const bin = atob(r.file.b64), bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.file.type || "application/pdf" }));
      // PDFs open in a tab as before. Chrome cannot display a .docx, so that one is downloaded.
      if (/\.docx$/i.test(r.file.name || "")) {
        const a = document.createElement("a");
        a.href = url; a.download = r.file.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else chrome.tabs.create({ url });
    } else if (act === "allow_host") {
      const j = jobs.find((x) => x.id === id);
      // Declining is a real answer: leave the job where it is rather than starting a run that cannot work.
      if (j && j.needs_host && await requestHostAccess(j.needs_host)) await control(id, "resume");
      else render();
    } else if (act === "signin_resume") {
      // Same provider as last time (the Worker keeps it); a failed or cancelled sign-in leaves the job waiting.
      const r = await send({ type: "auth:signin" });
      if (r && r.signedIn) await control(id, "resume");
      else render();
    } else if (act === "answer") {
      const v = (drafts[id] || "").trim();
      if (!v) return;
      delete drafts[id];
      await control(id, "answer", v);
    } else {
      await control(id, act);
    }
  }));
  const dive = () => send({ type: "open_deep_dive" });
  main.querySelector("#dive")?.addEventListener("click", dive);
  main.querySelector("#dive2").addEventListener("click", dive);
  main.querySelector("#addurl").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = main.querySelector("#url").value.trim();
    let host = "";
    try { host = new URL(url).hostname; } catch { return; }
    const r = await send({ type: "enqueue", jobs: [{ id: "url:" + url, apply_url: url, company: host, title: "Pasted link" }] });
    main.querySelector("#addmsg").textContent = r.error === "setup_required" ? "Finish the Deep Dive first." : r.error ? "Couldn't queue: " + r.error : r.added?.length ? "" : "Already in the queue.";
  });
  main.querySelector("#clear").addEventListener("click", async () => {
    for (const j of jobs) if (j.status === "submitted" || j.status === "failed") await control(j.id, "remove");
  });
}

async function renderAnswers() {
  const s = await loadStore();
  const list = (s.answers || []).slice().reverse();
  if (!list.length) { main.innerHTML = `<div class="empty">Answers the agent writes on applications show up here, so you can review them before interviews.</div>`; return; }
  let h = "", last = "";
  for (const a of list) {
    const key = `${a.company} · ${a.title}`;
    if (key !== last) { h += `<div class="group">${esc(key)}</div>`; last = key; }
    h += `<div class="card"><div class="q" style="margin:0">${esc(a.question)}</div><div class="msg">${esc(a.answer)}</div><div class="small">${when(a.at)}</div></div>`;
  }
  main.innerHTML = h;
}

async function renderAccounts() {
  const s = await loadStore();
  let h = `<div class="small" style="margin-bottom:8px">Accounts the agent created on job sites. Passwords are stored only in this browser and never sent to the AI.</div>`;
  if (!s.accounts.length) h += `<div class="empty">No accounts yet.</div>`;
  s.accounts.forEach((a, i) => {
    h += `<div class="card" data-i="${i}"><div class="kv"><span class="co">${esc(a.domain)}</span><button class="b link" data-del>Delete</button></div><div class="small">${esc(a.email)}</div><div class="kv" style="margin-top:4px"><code data-pw>••••••••••••</code><span><button class="b" data-show>Show</button> <button class="b" data-copy>Copy</button></span></div></div>`;
  });
  main.innerHTML = h;
  main.querySelectorAll("[data-i]").forEach((card) => {
    const a = s.accounts[+card.dataset.i];
    card.querySelector("[data-show]").onclick = (e) => {
      const pw = card.querySelector("[data-pw]");
      const hidden = pw.textContent.startsWith("•");
      pw.textContent = hidden ? a.password : "••••••••••••";
      e.target.textContent = hidden ? "Hide" : "Show";
    };
    card.querySelector("[data-copy]").onclick = (e) => { navigator.clipboard.writeText(a.password); e.target.textContent = "Copied"; };
    card.querySelector("[data-del]").onclick = async () => {
      if (!confirm(`Forget the saved login for ${a.domain}? The account on that site is not deleted.`)) return;
      await updateStore((st) => { st.accounts = st.accounts.filter((x) => x.domain !== a.domain); });
      render();
    };
  });
}

let pending = null;
function render() {
  // Don't wipe a half-typed answer while the queue updates.
  if (tab === "queue" && document.activeElement && document.activeElement.matches("textarea[data-ans], #url")) {
    clearTimeout(pending); pending = setTimeout(render, 1500); return;
  }
  ({ queue: renderQueue, answers: renderAnswers, accounts: renderAccounts })[tab]();
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if ((tab === "queue" && (ch.queue || ch.usage)) || (tab !== "queue" && ch.store)) { clearTimeout(pending); pending = setTimeout(render, 150); }
});
render();
