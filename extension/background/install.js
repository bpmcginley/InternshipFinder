// U1 (2026-10-14 UX audit): connect the internscout.org tabs that were already open when the extension
// was installed. Chrome adds a manifest content script only to pages loaded after the install, so a
// dashboard tab the student installed from kept saying "Add Auto-Apply to Chrome" until they reloaded it,
// which read as "the install didn't work". The same bridge (bridge/bridge.js) is put into each open tab
// now; it says "hello", and the dashboard's own listener (docs/js/app.js useExtension) takes it from there.
// The bridge guards against running twice in one page.
//
// The manifest's content_scripts match is the host access this needs: Chrome counts a content script's
// match patterns as host access for chrome.scripting, so nothing is added to host_permissions and the
// install prompt does not change.
//
// U2: while it is in each tab, it also takes the posting the offer bar remembered there (held.js
// WANTED_KEY) and removes it from the page's storage, so it is read once.
import { WANTED_KEY } from "./held.js";

// The pages the bridge runs on (manifest.json content_scripts), from the manifest itself.
export function bridgeMatches(manifest) {
  const cs = (manifest && manifest.content_scripts) || [];
  const entry = cs.find((c) => (c.js || []).includes("bridge/bridge.js"));
  return entry ? entry.matches.slice() : [];
}

// Runs in the page's isolated world: the remembered posting (as text, or null), removed as it is read.
export function takeWantedInPage(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) localStorage.removeItem(key);
    return v;
  } catch (e) { return null; }
}

// Puts the bridge into every open tab the manifest would have, and returns what the offer bar
// remembered in them (raw text, unchecked: held.js wantedJob checks it). One tab failing (a page still
// loading, a discarded tab) never stops the others.
export async function connectOpenTabs({ tabs = chrome.tabs, scripting = chrome.scripting, manifest = chrome.runtime.getManifest() } = {}) {
  const matches = bridgeMatches(manifest);
  if (!matches.length) return { connected: 0, wanted: [] };
  const open = await tabs.query({ url: matches }).catch(() => []);
  let connected = 0;
  const wanted = [];
  for (const t of open) {
    if (t.id == null || t.discarded) continue;
    try {
      await scripting.executeScript({ target: { tabId: t.id }, files: ["bridge/bridge.js"] });
      connected++;
      const [r] = await scripting.executeScript({ target: { tabId: t.id }, func: takeWantedInPage, args: [WANTED_KEY] });
      if (r && typeof r.result === "string") wanted.push(r.result);
    } catch (e) { /* not scriptable right now: that tab picks the bridge up on its next load */ }
  }
  return { connected, wanted };
}
