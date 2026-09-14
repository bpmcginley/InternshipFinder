import { loadStore, hasKey } from "../lib/store.js";
import { spend, perApplication, money } from "../lib/usage.js";

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
