// Dashboard bridge: relays window.postMessage <-> extension, so the page never needs the extension ID.
// Page sends {__internscout:"req", id, msg}; gets {__internscout:"res", id, result} and {__internscout:"push", queue}.
// When the extension is reloaded or updated, this copy of the script is orphaned ("Extension context
// invalidated"): it answers every request with {error:"reload_page"} and tells the page once.
// It can also arrive twice in one page (2026-10-14, U1): the manifest puts it into pages loaded after
// install, and background/install.js puts it into the internscout.org tabs that were already open. A copy
// that finds a live one already here does nothing; one that finds a dead one here retires it, so only one
// copy answers the page. (A copy from before a reinstall may sit in a separate world, which this can't see.)
(function () {
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  const prev = globalThis.__internscoutBridge;
  try { if (prev && prev.live()) return; if (prev) prev.retire(); } catch (e) {}
  let retired = false;
  // getManifest() can still throw "Extension context invalidated" even right after alive() returns
  // true: invalidation isn't atomic, so a reload/update can land between the two calls. Guard both.
  let VERSION;
  try {
    if (!alive()) return;
    VERSION = chrome.runtime.getManifest().version;
    document.documentElement.dataset.internscout = VERSION;
  } catch (e) { return; }
  let port = null, dead = false;
  globalThis.__internscoutBridge = { live: () => !dead && !retired && alive(), retire: () => { retired = true; } };

  function gone() {
    if (dead || retired) return;   // a retired copy leaves the page to the copy that replaced it
    dead = true; port = null;
    delete document.documentElement.dataset.internscout;
    window.postMessage({ __internscout: "gone" }, location.origin);
  }

  function connect() {
    if (!alive()) { gone(); return null; }
    try {
      port = chrome.runtime.connect({ name: "bridge" });
    } catch (e) { gone(); return null; }
    port.onMessage.addListener((m) => {
      if (retired) return;
      if (m.push === "queue") window.postMessage({ __internscout: "push", queue: m.queue }, location.origin);
      else window.postMessage({ __internscout: "res", id: m.reqId, result: m.result }, location.origin);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (!alive()) gone();
    });
    return port;
  }

  function send(id, msg) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = port || connect();
      if (!p) break;
      try { p.postMessage({ reqId: id, msg }); return; } catch (e) { port = null; }
    }
    gone();
    window.postMessage({ __internscout: "res", id, result: { error: "reload_page" } }, location.origin);
  }

  window.addEventListener("message", (e) => {
    if (retired || e.source !== window || !e.data || e.data.__internscout !== "req") return;
    if (dead) { window.postMessage({ __internscout: "res", id: e.data.id, result: { error: "reload_page" } }, location.origin); return; }
    send(e.data.id, e.data.msg);
  });

  const hello = () => alive() && window.postMessage({ __internscout: "hello", version: VERSION }, location.origin);
  hello();
  document.addEventListener("DOMContentLoaded", hello);
})();
