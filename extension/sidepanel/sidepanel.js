import { loadStore, updateStore, resumeReviewPending, factCheckNote } from "../lib/store.js";
import { spend, perApplication, money } from "../lib/usage.js";
import { requestHostAccess } from "../lib/hosts.js";
import { entryState, EDIT_LABEL } from "../lib/entry.js";
import { LABEL, esc, jobCard } from "./card.js";
import { loadReview, shouldShow, cardCopy, STORE_REVIEWS_URL, FEEDBACK_URL, KEY as REVIEW_KEY } from "../lib/review.js";

const main = document.getElementById("main");
const live = document.getElementById("live");
let tab = "queue";
const drafts = {}; // keep typed answers across re-renders

const GROUPS = [
  ["Needs you", ["needs_you"]],
  ["Ready to submit", ["ready_to_submit"]],
  ["In progress", ["working", "queued"]],
  ["Done", ["submitted", "failed"]],
];
const send = (m) => chrome.runtime.sendMessage(m);
const control = (id, action, answer) => send({ type: "control", id, action, answer });
const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  tab = b.dataset.tab;
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
  render();
}));

// The review card. Same words and same three buttons for everyone who gets it, with the feedback link
// beside them rather than in front of them (lib/review.js says why).
function reviewCard(n) {
  const c = cardCopy(n);
  return `<div class="card review" role="status"><div class="q">${esc(c.title)}</div><div class="msg">${esc(c.body)}</div>`
    + `<div class="row"><button class="btn small primary" data-review="review">${esc(c.review)}</button><button class="btn small" data-review="later">${esc(c.later)}</button><button class="btn small quiet" data-review="never">${esc(c.never)}</button></div>`
    + `<div class="small fb"><a href="#" data-review="feedback">${esc(c.feedback)}</a></div></div>`;
}
// "review" opens the store's reviews page in a new tab; "feedback" opens the feedback form and leaves the
// card as it is. The answer is kept by the background, and the queue redraws when it changes.
async function reviewAction(act) {
  if (act === "feedback") { chrome.tabs.create({ url: FEEDBACK_URL }); return; }
  if (act === "review") chrome.tabs.create({ url: STORE_REVIEWS_URL });
  await send({ type: "review_ask", action: act });
}

// The queue is redrawn about 150 ms after every log line, and the redraw used to replace the button a
// keyboard or screen reader user had just tabbed to, so focus fell back to the page before they could
// press Pause or Take over. Which control had focus, and which Activity lists were open, are noted
// before a redraw and put back after it.
function focusKey(el) {
  if (!el || !main.contains(el)) return null;
  const card = el.closest("[data-id]");
  if (el.dataset.act && card) return `[data-id="${card.dataset.id}"] [data-act="${el.dataset.act}"]`;
  if (el.dataset.review) return `[data-review="${el.dataset.review}"]`;
  if (el.id) return "#" + el.id;
  return null;
}
const openLogs = () => new Set([...main.querySelectorAll("[data-id] details[open]")].map((d) => d.closest("[data-id]").dataset.id));

// Says it out loud when an application starts waiting on the student (role=status, in sidepanel.html).
// The first draw only learns the statuses; nothing is announced for jobs that were already waiting.
let seen = null;
function announce(jobs) {
  const now = new Map(jobs.map((j) => [j.id, j.status]));
  if (seen) {
    const lines = jobs.filter((j) => seen.get(j.id) !== j.status && (j.status === "needs_you" || j.status === "ready_to_submit"))
      .map((j) => `${j.company || "An application"}: ${LABEL[j.status].toLowerCase()}`);
    if (lines.length) live.textContent = lines.join(". ");
  }
  seen = now;
}

async function renderQueue() {
  const q = (await send({ type: "get_queue" })).queue || { order: [], jobs: {} };
  const jobs = q.order.map((id) => q.jobs[id]).filter(Boolean);
  announce(jobs);
  const s = await loadStore();
  let h = "";
  // Setup first, or a replaced resume to review (lib/entry.js). was: "Finish the Deep Dive before using
  // Auto-Apply." with "Start Deep Dive", and "Open Deep Dive" for the resume.
  const e = entryState(s);
  if (e.stage !== "ready") h += `<div class="card needs_you setup"><div class="msg">${esc(e.note)}</div><div class="row"><button class="btn small primary" id="dive">${esc(e.label)}</button></div></div>`;
  // Old eligibility answers nobody confirmed, or a disagreement with the dashboard (store.js factCheckNote).
  // Auto-Apply still runs; those answers are left blank and asked about when a form needs them.
  else if (factCheckNote(s)) h += `<div class="card needs_you"><div class="msg">${factCheckNote(s)}</div><div class="row"><button class="btn small primary" id="facts">Open Quick facts</button></div></div>`;
  if (!jobs.length) h += `<div class="empty">No applications queued.<br>Pick internships on the dashboard and press <b>Auto-Apply</b>.<br><br><a href="https://internscout.org/" target="_blank" style="color:var(--blue)">Open dashboard ↗</a></div>`;
  // The review card (lib/review.js) goes right under the applications that are ready, which is what it
  // is about, and before anything still waiting. shouldShow() keeps it away while a form is being filled.
  const rv = await loadReview();
  const ask = shouldShow(rv, jobs) ? reviewCard(rv.filled) : "";
  for (const [name, sts] of GROUPS) {
    const list = jobs.filter((j) => sts.includes(j.status));
    if (list.length) h += `<div class="group">${name}<span class="n">${list.length}</span></div>` + list.map((j) => jobCard(j, drafts)).join("");
    if (name === "Ready to submit") h += ask;
  }
  h += `<div class="group">Apply to any posting</div><form id="addurl" class="row" style="margin-top:0;flex-wrap:nowrap"><input id="url" type="url" required aria-label="Application link" placeholder="https://… application link"><button class="btn small">Queue</button></form><div class="small" id="addmsg"></div>`;
  const sp = await spend(), avg = perApplication(jobs);
  if (sp.calls) h += `<div class="small" style="margin-top:14px">AI spend this month: <b>${money(sp.month_usd)}</b>${sp.budget ? ` of ${money(sp.budget)} budget` : ""}${avg ? ` · about ${money(avg)} per application` : ""}</div>`;
  // "Edit setup" and "Leave a review" only once setup is done (lib/entry.js). was: "Redo Deep Dive" and the
  // review link for everyone, including a student who had not used anything yet.
  h += `<div class="row" style="justify-content:space-between;margin-top:14px">${e.showEdit ? `<button class="btn small quiet" id="dive2">${EDIT_LABEL}</button>` : "<span></span>"}<button class="btn small quiet" id="clear">Clear finished</button></div>`;
  // Asked or not (lib/review.js), once setup is done.
  if (e.showReview) h += `<div class="foot"><button class="btn small quiet" data-review="review">Leave a review</button></div>`;
  const focused = focusKey(document.activeElement), opened = openLogs();
  main.innerHTML = h;
  for (const id of opened) main.querySelector(`[data-id="${id}"] details`)?.setAttribute("open", "");
  if (focused) main.querySelector(focused)?.focus({ preventScroll: true });
  main.querySelectorAll("[data-review]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); reviewAction(b.dataset.review); }));

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
    } else if (act === "upgrade") {
      const j = jobs.find((x) => x.id === id);
      if (j && j.upgrade) chrome.tabs.create({ url: "https://internscout.org/?upgrade=" + encodeURIComponent(j.upgrade.plan) });
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
  main.querySelector("#dive2")?.addEventListener("click", dive);
  main.querySelector("#facts")?.addEventListener("click", () => send({ type: "open_deep_dive", step: "facts" }));
  main.querySelector("#addurl").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = main.querySelector("#url").value.trim();
    let host = "";
    try { host = new URL(url).hostname; } catch { return; }
    const r = await send({ type: "enqueue", jobs: [{ id: "url:" + url, apply_url: url, company: host, title: "Pasted link" }] });
    main.querySelector("#addmsg").textContent = r.error === "setup_required" ? "Set up Auto-Apply first." : r.error ? "Couldn't queue: " + r.error : r.added?.length ? "" : "Already in the queue.";
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
  let h = `<div class="small" style="margin-bottom:8px">Saved logins for job sites. A pending sign-up still needs to finish on the employer's site. Passwords are stored only in this browser and never sent to the AI.</div>`;
  if (!s.accounts.length) h += `<div class="empty">No accounts yet.</div>`;
  s.accounts.forEach((a, i) => {
    h += `<div class="card" data-i="${i}"><div class="kv"><span class="co">${esc(a.domain)}</span><button class="btn small quiet" data-del>Delete</button></div><div class="small">${esc(a.email)}</div>${a.state === "pending" ? '<div class="small">Sign-up pending · account creation not yet confirmed</div>' : ''}<div class="kv" style="margin-top:4px"><code data-pw>••••••••••••</code><span><button class="btn small" data-show>Show</button> <button class="btn small" data-copy>Copy</button></span></div></div>`;
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

// The queue tab also redraws when the Deep Dive becomes finished or unfinished, which a restore from the
// student's account does (lib/sync.js), so the setup card doesn't linger after one. And when a
// replaced resume's review starts or ends. was: onboarded only.
const doneOf = (v) => !!(v && v.settings && v.settings.onboarded && !resumeReviewPending(v)) && !(v.profile && factCheckNote(v));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  const flipped = ch.store && doneOf(ch.store.oldValue) !== doneOf(ch.store.newValue);
  // was: if ((tab === "queue" && (ch.queue || ch.usage || flipped)) || ...
  if ((tab === "queue" && (ch.queue || ch.usage || ch[REVIEW_KEY] || flipped)) || (tab !== "queue" && ch.store)) { clearTimeout(pending); pending = setTimeout(render, 150); }
});
render();
