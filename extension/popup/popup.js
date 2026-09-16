import { loadStore, hasKey, isWorker } from "../lib/store.js";
import { spend, perApplication, money } from "../lib/usage.js";
import { allowanceLines, tierNote, MAIN_TASKS } from "../lib/auth.js";

const DASHBOARD = "https://bpmcginley.github.io/InternshipFinder/";
const $ = (id) => document.getElementById(id);
$("ver").textContent = "v" + chrome.runtime.getManifest().version;

(async () => {
  const s = await loadStore();
  if (!s.settings.onboarded || !hasKey(s)) {
    $("note").hidden = false;
    $("note").textContent = "Finish the Deep Dive to turn on Auto-Apply.";
    $("dive").textContent = "Start Deep Dive";
    $("dive").classList.add("primary");
    $("queue").classList.remove("primary");
    return;
  }
  const q = (await chrome.storage.local.get("queue")).queue || { jobs: {} };
  const jobs = Object.values(q.jobs);
  const set = (id, n) => { $(id).textContent = n; $(id).parentElement.classList.toggle("zero", !n); };
  set("n-need", jobs.filter((j) => j.status === "needs_you").length);
  set("n-ready", jobs.filter((j) => j.status === "ready_to_submit").length);
  set("n-work", jobs.filter((j) => j.status === "working" || j.status === "queued").length);
  $("figs").hidden = false;
  const sp = await spend(), avg = perApplication(jobs);
  if (sp.calls) {
    $("spend").hidden = false;
    $("spend").textContent = `AI this month: ${money(sp.month_usd)}${sp.budget ? ` of ${money(sp.budget)}` : ""}${avg ? ` · ~${money(avg)}/application` : ""}${sp.over ? " · budget reached" : ""}`;
  }
})();

// Account: sign-in and this month's allowance. Only for the InternScout AI; your-own-key setups don't sign in.
(async () => {
  if (!isWorker((await loadStore()).ai)) return;
  $("acct").hidden = false;
  const a = await chrome.runtime.sendMessage({ type: "auth:me" }).catch((e) => ({ error: e.message }));
  if (!a || a.error || !a.signedIn) {
    $("acct-out").hidden = false;
    if (a && a.error) { $("tier").hidden = false; $("tier").className = "err"; $("tier").textContent = a.error; }
    return;
  }
  $("acct-in").hidden = false;
  $("acct-email").textContent = a.email || "Signed in";
  $("acct-email").title = a.email ? `Signed in with ${a.provider === "microsoft" ? "Microsoft" : "Google"} as ${a.email}` : "";
  const lines = allowanceLines(a.me, MAIN_TASKS);
  if (lines.length) {
    $("allow").hidden = false;
    $("allow").replaceChildren(...lines.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  }
  $("tier").hidden = false;
  if (!a.me || a.me.error) $("tier").className = "err";
  $("tier").textContent = tierNote(a.me);
})();

document.querySelectorAll("[data-signin]").forEach((b) => b.addEventListener("click", () => {
  // The background runs the sign-in window; this popup closes as soon as that window takes focus.
  $("acct-out").querySelectorAll("button").forEach((x) => { x.disabled = true; });
  $("tier").hidden = false; $("tier").className = "muted";
  $("tier").textContent = "Finish signing in in the window that opened, then click the InternScout icon again.";
  chrome.runtime.sendMessage({ type: "auth:signin", provider: b.dataset.signin }).then((r) => {
    if (r && r.error) { $("tier").className = "err"; $("tier").textContent = r.error; }
    else location.reload();
  }).catch(() => {}).finally(() => { $("acct-out").querySelectorAll("button").forEach((x) => { x.disabled = false; }); });
}));

$("signout").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "auth:signout" });
  location.reload();
});

$("queue").addEventListener("click", async () => {
  const win = await chrome.windows.getCurrent();
  try { await chrome.sidePanel.open({ windowId: win.id }); }
  catch (e) { await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html") }); }
  window.close();
});

$("dash").addEventListener("click", async () => {
  await chrome.tabs.create({ url: DASHBOARD });
  window.close();
});

$("dive").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "open_deep_dive" });
  window.close();
});
