// Dashboard extension bridge.

export function createBridge(browser, { emptyProfile }) {
  // ---------- extension bridge (extension/bridge/bridge.js relays window messages) ----------
  const ext = (() => {
    let n = 0; const waiting = new Map(); const subs = new Set();
    browser.addEventListener("message", e => {
      if (e.source !== browser || !e.data || !e.data.__internscout) return;
      const d = e.data;
      if (d.__internscout === "res" && waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id); }
      else if (d.__internscout === "push" || d.__internscout === "hello" || d.__internscout === "gone") subs.forEach(f => f(d));
    });
    return {
      present: () => !!browser.document.documentElement.dataset.internscout,
      call: (msg, timeout = 5000) => new Promise(res => {
        const id = ++n; waiting.set(id, res);
        browser.postMessage({ __internscout: "req", id, msg }, browser.location.origin);
        browser.setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); res({ error: "no_extension" }); } }, timeout);
      }),
      on: f => { subs.add(f); return () => subs.delete(f); },
    };
  })();
  const bridgeProfile = p => ({
    majors: p.majors || [], minors: p.minors || [], class_year: p.class_year || "", grad_term: p.grad_term || "",
    // was: states: demandStates(p). That now leaves provinces out (for the Worker), and the extension's
    // copy is read back into this page, so it gets every picked state and province.
    stages: p.stages || [], terms: p.terms || [], states: [...(p.states || []), ...(p.remote ? ["REMOTE"] : [])], work_auth: p.work_auth || "",
  });
  const fromBridgeProfile = b => {
    if (!b || typeof b !== "object") return null;
    const states = (b.states || []).filter(s => s !== "REMOTE");
    return { ...emptyProfile(), ...b, states, remote: (b.states || []).includes("REMOTE") || !states.length };
  };

  return {
    ext, bridgeProfile, fromBridgeProfile,
  };
}
