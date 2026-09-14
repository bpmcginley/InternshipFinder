// Dashboard bridge: relays window.postMessage <-> extension, so the page never needs the extension ID.
// Page sends {__internscout:"req", id, msg}; gets {__internscout:"res", id, result} and {__internscout:"push", queue}.
(function () {
  const VERSION = chrome.runtime.getManifest().version;
  document.documentElement.dataset.internscout = VERSION;
  let port = null;

  function connect() {
    port = chrome.runtime.connect({ name: "bridge" });
    port.onMessage.addListener((m) => {
      if (m.push === "queue") window.postMessage({ __internscout: "push", queue: m.queue }, location.origin);
      else window.postMessage({ __internscout: "res", id: m.reqId, result: m.result }, location.origin);
    });
    port.onDisconnect.addListener(() => { port = null; });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__internscout !== "req") return;
    if (!port) connect();
    try { port.postMessage({ reqId: e.data.id, msg: e.data.msg }); }
    catch (err) { connect(); port.postMessage({ reqId: e.data.id, msg: e.data.msg }); }
  });

  const hello = () => window.postMessage({ __internscout: "hello", version: VERSION }, location.origin);
  hello();
  document.addEventListener("DOMContentLoaded", hello);
})();
