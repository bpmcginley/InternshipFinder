// One application in the side panel's queue, as HTML. Kept out of sidepanel.js (which needs a page to run)
// so the tests can load it.
//
// Layout (A2 component 8, D25 in the 2026-10-14 design review): company and title on the first line, then
// the status chip, then one row of actions, all with the shared theme.css buttons (.btn.small, 32px).
// was: a coloured dot, the company and the chip on one line, the title under it, and the side panel's own
// 26px button.b.
//
// On "Ready to submit" the order is "I submitted it" (the main button), "Review and submit", then "Check
// the form again". was: "Review & submit", "I submitted it", "Keep going". "Keep going" sat beside "I
// submitted it" at the moment a student is about to send, and read like "go on and submit"; what it does
// is start another pass over the form (control "resume").
import { money } from "../lib/usage.js";
import { hostOf } from "../lib/hosts.js";

export const LABEL = { queued: "Queued", working: "Working", needs_you: "Needs you", ready_to_submit: "Ready to submit", submitted: "Submitted", failed: "Failed" };
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The ready_to_submit actions, in order: [control action, label, style].
export const READY_ACTIONS = [
  ["submitted", "I submitted it", "primary"],
  ["focus", "Review and submit", ""],
  ["resume", "Check the form again", "quiet"],
];

// [action, label, style] for one job, in the order they are shown. style: "primary", "quiet" or "".
// The labels are already escaped where they hold job data.
export function jobActions(j) {
  const btns = [];
  if (j.status === "working") {
    btns.push(["pause", "Pause"], ["takeover", "Take over"], ["focus", "Show tab"]);
  } else if (j.status === "needs_you") {
    const t = j.tailored;
    if (t && t.status === "pending") {
      // A Word resume is tailored in place and comes back as a .docx, which a tab cannot show.
      const word = /\.docx$/i.test((t.file && t.file.name) || "");
      btns.push(["approve_tailored", "Use tailored", "primary"], ["preview_tailored", word ? "Download Word file" : "Preview PDF"], ["skip_tailored", "Use my original"]);
      // U5: one answer for every application queued with this one (background/queue.js setBatchTailor).
      if (j.batch_left > 0) btns.push(["approve_tailored_all", `Use tailored for all ${j.batch_left + 1}`], ["skip_tailored_all", `Use my original for all ${j.batch_left + 1}`]);
    } else if (j.question) btns.push(["answer", "Answer and continue", "primary"]);
    // The sign-in window has to open from a click, which this button is.
    else if (j.needs_auth) btns.push(["signin_resume", "Sign in and resume", "primary"]);
    // Chrome only grants a site from a click on an extension page, which is what this is.
    else if (j.needs_host) btns.push(["allow_host", `Allow ${esc(hostOf(j.needs_host))}`, "primary"]);
    // Out of this month's Auto-Apply runs, with a bigger plan on offer: checkout is on the dashboard
    // (it holds the sign-in Stripe needs). Resume once the plan is active, or after the 1st.
    else if (j.upgrade) btns.push(["upgrade", esc(`Get ${j.upgrade.label}${j.upgrade.price ? ` · ${j.upgrade.price}` : ""}`), "primary"], ["resume", "Resume"]);
    else btns.push(["resume", "Resume", "primary"]);
    btns.push(["focus", "Show tab"]);
  } else if (j.status === "ready_to_submit") {
    btns.push(...READY_ACTIONS);
  } else if (j.status === "failed") {
    btns.push(["retry", "Retry", "primary"], ["focus", "Show tab"]);
  }
  btns.push(["remove", "Remove", "quiet"]);
  return btns;
}

export function jobCard(j, drafts = {}) {
  const where = j.location ? " · " + esc(j.location) : "";
  let h = `<div class="card ${esc(j.status)}" data-id="${esc(j.id)}">`
    + `<div class="head"><span class="co">${esc(j.company)}</span> <span class="title">${esc(j.title)}${where}</span></div>`
    + `<div class="meta"><span class="st">${esc(LABEL[j.status] || j.status)}</span>${j.cost_usd ? `<span class="cost">${money(j.cost_usd)}</span>` : ""}</div>`;
  if (j.status === "working") {
    h += `<div class="msg small">${esc(j.activity || "Working…")} (step ${j.steps || 0})</div>`;
  } else if (j.status === "needs_you") {
    const t = j.tailored;
    if (t && t.status === "pending") {
      h += `<div class="q">Tailored resume ready for review</div>${t.summary ? `<div class="msg small"><b>Summary:</b> ${esc(t.summary)}</div>` : ""}`;
      if (t.changes && t.changes.length) h += `<ul>${t.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;
      if (t.diff && t.diff.length) h += `<details><summary>Before → after (${t.diff.length})</summary>${t.diff.map((d) => `<div class="small" style="margin:6px 0"><s>${esc(d.before)}</s><br>${esc(d.after)}</div>`).join("")}</details>`;
      if (t.note) h += `<div class="msg small">${esc(t.note)}</div>`;
      // U5: say why the others queued with it haven't started.
      if (j.batch_left > 0) h += `<div class="msg small">${j.batch_left === 1 ? "1 more application" : `${j.batch_left} more applications`} you queued with this one ${j.batch_left === 1 ? "waits" : "wait"} for this choice. Answer "for all" to use it for every one of them.</div>`;
    } else if (j.question) {
      h += `<div class="q">${esc(j.question)}</div>${j.reason ? `<div class="small">${esc(j.reason)}</div>` : ""}<textarea data-ans="${esc(j.id)}" aria-label="Your answer" placeholder="Answer (saved to your profile for next time)">${esc(drafts[j.id] || "")}</textarea>`;
    } else {
      h += `<div class="msg">${esc(j.reason)}</div>`;
    }
  } else if (j.status === "ready_to_submit") {
    h += `<div class="msg">${esc(j.summary || "Everything is filled. Review it, then press Submit yourself.")}</div>`;
    if (j.double_check && j.double_check.length) h += `<ul>${j.double_check.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
  } else if (j.status === "failed") {
    h += `<div class="msg">${esc(j.reason)}</div>`;
  } else if (j.status === "queued") {
    // was: always "Waiting for a free tab…". U5: held back by another job's tailored-resume question.
    h += `<div class="msg small">${j.tailor_wait ? "Waiting for your choice about the tailored resume on an application queued with this one." : "Waiting for a free tab…"}</div>`;
  }
  h += `<div class="row">${jobActions(j).map(([a, t, c]) => `<button class="btn small${c ? " " + c : ""}" data-act="${a}">${t}</button>`).join("")}</div>`;
  const log = (j.log || []).slice(-12).reverse();
  if (log.length) h += `<details><summary>Activity</summary>${log.map((l) => `<div>${esc(l.kind === "answer" ? `${l.question} → ${l.answer}` : l.text || l.kind)}</div>`).join("")}</details>`;
  return h + "</div>";
}
