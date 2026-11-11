// Local application and saved-role data.

export function createTracker(browser, {
    IS,
  }) {
  const LS_KEY = "internscout.appstate.v1", SAVED_KEY = "internscout.saved.v1", LANDING_KEY = "internscout.landing.seen.v1", SKIP_KEY = "internscout.setup.skipped.v1", MORE_KEY = "internscout.filters.more.v1";
  const APP_STATES = ["none", "interested", "applied", "interviewing", "rejected", "offer"];
  const MYLIST_KEY = "internscout.mylist.v1", VISIT_KEY = "internscout.visit.v1";
  // Saved SEARCHES keep SAVED_KEY. Membership is independent of application history in LS_KEY.
  const publicRole = r => ({ company: typeof r.company_name === "string" ? r.company_name.slice(0, 200) : "",
    title: typeof r.title === "string" ? r.title.slice(0, 300) : "",
    url: typeof r.apply_url === "string" && r.apply_url.length <= 2000 && /^https?:\/\//i.test(r.apply_url) ? r.apply_url : "",
    shards: [...IS.shardKeys(r)].filter(k => /^(?:[A-Z]{2}|remote|Canada)$/.test(k)) });
  function readMyList(raw, states) {
    if (!raw || raw.version !== 1 || !raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) {
      return { version: 1, roles: Object.fromEntries(Object.entries(states).filter(([, s]) => s !== "none" && APP_STATES.includes(s)).map(([id]) => [id, { saved: true }])) };
    }
    return { version: 1, roles: Object.fromEntries(Object.entries(raw.roles).filter(([, r]) => r && typeof r.saved === "boolean").map(([id, r]) => [id, {
      saved: r.saved, ...publicRole({ company_name: r.company, title: r.title, apply_url: r.url }),
      shards: Array.isArray(r.shards) ? r.shards.filter(k => typeof k === "string" && /^(?:[A-Z]{2}|remote|Canada)$/.test(k)) : [],
    }])) };
  }
  function writeLocal(key, value) { try { browser.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } }
  function savedRoleRows(rows, roles) {
    const current = new Map(rows.map(r => [String(r.id), r]));
    return Object.entries(roles).filter(([, r]) => r.saved).map(([id, r]) => current.get(id) || {
      id, company_name: r.company || "Saved role " + id, title: r.title || "Listing details unavailable", apply_url: r.url || "", _savedMissing: true,
    });
  }
  function sinceVisit(row, previous, now) {
    // Exported SQL timestamps omit an offset but are UTC; do not interpret them as local wall time.
    const value = row.first_seen, seen = browser.Date.parse(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value + "Z" : value);
    return row.status === "open" && Number.isFinite(previous) && previous > 0 && previous <= now && Number.isFinite(seen) && seen > previous && seen <= now;
  }
  // Current rows first, then one location hint per unresolved role, then the remaining public shards.
  // Await even an in-flight key: loadedKeys() includes promises that have not settled yet.
  async function resolveSavedRoles(store, index, roles, paint, live) {
    const ids = Object.keys(roles).filter(id => roles[id].saved), failed = new Set();
    const missing = () => { const known = new Set(store.all().map(r => String(r.id))); return ids.filter(id => !known.has(id)); };
    if (!missing().length || !index || !index.files) return [];
    const valid = new Set(Object.keys(index.files));
    const hints = [...new Set(missing().map(id => (roles[id].shards || []).find(k => valid.has(k))).filter(Boolean))];
    for (const phase of [hints, [...valid].filter(k => !hints.includes(k))]) {
      for (let i = 0; i < phase.length && live() && missing().length; i += 4) {
        const bad = await store.ensure(phase.slice(i, i + 4));
        if (!live()) return null;
        bad.forEach(k => failed.add(k)); paint();
      }
    }
    return missing().length ? [...failed] : [];
  }

  return {
    LS_KEY, SAVED_KEY, LANDING_KEY, SKIP_KEY, MORE_KEY, APP_STATES, MYLIST_KEY, VISIT_KEY,
    publicRole, readMyList, writeLocal, savedRoleRows, sinceVisit, resolveSavedRoles,
  };
}

export function clearTrackerAction({
  appStatesRef, setAppStates, IS, LS_KEY, keepSaved, SAVED_KEY, roleBookRef, setRoleBook,
  MYLIST_KEY, VISIT_KEY, setPreviousVisit,
}) {
    appStatesRef.current = {}; setAppStates({}); IS.ls.del(LS_KEY); keepSaved([]); IS.ls.del(SAVED_KEY);
    const empty = { version: 1, roles: {} }; roleBookRef.current = empty; setRoleBook(empty); IS.ls.del(MYLIST_KEY); IS.ls.del(VISIT_KEY); setPreviousVisit(null);
  }

export function createSetAppState({
  appStatesRef, setAppStates, IS, LS_KEY, roleBookRef, store, keepRoleBook, publicRole,
}) {
  return (id, v) => {
    // Compose queue, prompt and Save callbacks before React renders the batch. Save must never
    // initialize Interested over a newer Applied/Interviewing/Offer update in that same batch.
    const n = { ...appStatesRef.current, [id]: v }; if (v === "none") delete n[id];
    appStatesRef.current = n; setAppStates(n); IS.ls.set(LS_KEY, n);
    // Queue and return-prompt updates preserve an explicit unsave, while new history joins My list.
    const book = roleBookRef.current;
    if (v !== "none" && !Object.hasOwn(book.roles, String(id))) {
      const row = store.current.all().find(r => String(r.id) === String(id));
      keepRoleBook({ ...book, roles: { ...book.roles, [id]: { saved: true, ...(row ? publicRole(row) : {}) } } });
    }
  };
}

export function createToggleSaved({
  roleBookRef, keepRoleBook, publicRole, IS, appStatesRef, setManualAppState, setMySel,
  myListRef, browser,
}) {
  return r => {
    const book = roleBookRef.current, before = book.roles[String(r.id)], on = !(before && before.saved);
    keepRoleBook({ ...book, roles: { ...book.roles, [r.id]: { ...(before || {}), ...(!r._savedMissing ? publicRole(r) : {}), saved: on } } });
    if (on) { IS.count("save_role"); if (!appStatesRef.current[r.id] || appStatesRef.current[r.id] === "none") setManualAppState(r.id, "interested"); }
    if (!on) setMySel(previous => new Set([...previous].filter(id => String(id) !== String(r.id))));
    if (!on && myListRef.current) browser.setTimeout(() => { const heading = browser.document.getElementById("listings"); if (heading) heading.focus(); }, 0);
  };
}

export function useManualAppState({ useRef, offerDigestNudge, useCallback, appStatesRef, setAppState }) {
  const offerDigestNudgeRef = useRef(offerDigestNudge); offerDigestNudgeRef.current = offerDigestNudge;
  const setManualAppState = useCallback((id, v) => {
    if (v === "interested" && appStatesRef.current[id] !== "interested") offerDigestNudgeRef.current("interested");
    setAppState(id, v);
  }, [setAppState]);
  return setManualAppState;
}

export function showMyListAction({ myList, IS, setMyLoad, setMyList }, on) { if (on && !myList) { IS.count("mylist_open"); setMyLoad({ checking: true, failed: [] }); } setMyList(on); }
