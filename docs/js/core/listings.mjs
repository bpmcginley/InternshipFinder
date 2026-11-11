// Listing shards and data loading.

export function createListings(browser, { C, fieldLabel }) {
  // ---------- data loading (sharded, with the single-file fallback) ----------
  // timeoutMs is how long a download may go with no bytes at all: before the response, or between two
  // pieces of the body. A slow file that keeps arriving is never cut off. (was: the limit covered the
  // whole download, so on slow Wi-Fi CA.json was cancelled on both tries and California never loaded.)
  // At most this many downloads run at once, below the browser's six connections per host, so the
  // quiet timer never runs while a request is only queued in the browser behind other files (at
  // 50 KB/s the 9th and 10th state files waited more than 15 s for a connection and were retried).
  const MAX_DOWNLOADS = 4;
  let downloads = 0;
  const queued = [];
  async function getJSON(url, bust, timeoutMs = 15000) {
    if (downloads >= MAX_DOWNLOADS) await new Promise(r => queued.push(r));   // handed a slot directly
    else downloads++;
    try { return await download(url, bust, timeoutMs); }
    finally { if (queued.length) queued.shift()(); else downloads--; }
  }
  async function download(url, bust, timeoutMs) {
    const controller = typeof browser.AbortController !== "undefined" ? new browser.AbortController() : null;
    let timer, fail;
    const stalled = new Promise((_, reject) => { fail = reject; });
    const quiet = () => {
      browser.clearTimeout(timer);
      if (timeoutMs) timer = browser.setTimeout(() => { fail(new Error("Download timed out")); if (controller) controller.abort(); }, timeoutMs);
    };
    const request = async () => {
      // A request the page head already started for this address (index.html, window.__early), used once.
      const early = !bust && browser.__early && browser.__early[url];
      if (early) delete browser.__early[url];
      const r = await (early || browser.fetch(url + (bust ? (url.includes("?") ? "&" : "?") + "t=" + browser.Date.now() : ""), { cache: "no-cache", ...(controller ? { signal: controller.signal } : {}) }));
      quiet();
      if (!r.ok) { const e = new Error("HTTP " + r.status + " for " + url); e.status = r.status; throw e; }
      const reader = r.body && typeof r.body.getReader === "function" && typeof browser.TextDecoder !== "undefined" ? r.body.getReader() : null;
      if (!reader) return r.json();   // no streamed body: the timer then covers the rest of the download
      const decoder = new browser.TextDecoder(), parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        quiet();
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return JSON.parse(parts.join(""));
    };
    quiet();
    try {
      return await Promise.race([request(), stalled]);
    } finally { browser.clearTimeout(timer); }
  }

  function createStore({ timeoutMs = 15000, retryDelayMs = 1200 } = {}) {
    let base = C.dataUrl || "./data/";
    let index = null, legacy = false, bust = false;
    const loaded = new Map();   // key -> Promise
    const descd = new Map();    // key -> Promise (description sidecars)
    const byId = new Map();
    let version = 0;
    let generation = 0;

    // apply_url ends up in an href and in the Auto-Apply queue, so anything that is not plain http(s)
    // (javascript:, data:) is dropped here, once, before any of the page sees it.
    function add(list) {
      for (const x of list || []) {
        if (!x || x.id == null || byId.has(x.id)) continue;
        if (x.apply_url && !/^https?:\/\//i.test(x.apply_url)) x.apply_url = "";
        byId.set(x.id, x);
      }
      version++;
    }

    async function init(fromRaw) {
      bust = !!fromRaw;
      base = fromRaw ? C.rawDataFallback : (C.dataUrl || "./data/");
      generation++; loaded.clear(); descd.clear(); failed.clear(); byId.clear(); index = null; legacy = false; version++;
      const bases = fromRaw ? [C.rawDataFallback] : [C.dataUrl || "./data/", C.rawDataFallback].filter(Boolean);
      for (const b of bases) {
        for (const path of ["listings/index.json", "index.json"]) {
          try {
            const idx = await getJSON(b + path, bust, Math.min(timeoutMs, 5000));
            if (idx && idx.files) { index = idx; base = b; index._dir = path.includes("/") ? "listings/" : ""; return { index, legacy: false }; }
          } catch (e) { /* try next */ }
        }
      }
      // no shards: the old single file
      for (const b of bases) {
        try { const all = await getJSON(b + "listings.json", bust, Math.min(timeoutMs, 5000)); base = b; legacy = true; add(all); return { index: null, legacy: true }; }
        catch (e) { var last = e; }
      }
      throw last || new Error("No listing data found");
    }

    // Resolves to the keys that could not be loaded, so the page can say so instead of showing
    // "no listings" for a state whose file simply failed to download.
    const failed = new Set();
    async function ensure(keys, onProgress = () => {}) {
      if (legacy || !index) return [];
      const jobs = [];
      const epoch = generation, requestBase = base, requestBust = bust;
      for (const k of new Set(keys)) {
        const meta = index.files[k];
        if (!meta) continue;
        // Already asked for: wait for it as well. Skipping a shard still in flight painted the list
        // without its rows when states were changed quickly.
        if (loaded.has(k)) { jobs.push(loaded.get(k).then(onProgress)); continue; }
        const file = meta.file || (index._dir + k + ".json");
        const get = () => getJSON(requestBase + file, requestBust, timeoutMs);
        // One quiet retry: a dropped connection is the usual reason a shard fails.
        const pr = get().catch(() => new Promise(r => browser.setTimeout(r, retryDelayMs)).then(get))
          .then(d => { if (epoch === generation) { failed.delete(k); add(d); } })
          .catch(e => { if (epoch === generation) { loaded.delete(k); failed.add(k); browser.console.warn("InternScout: couldn't load", file, e); } });
        loaded.set(k, pr);
        jobs.push(pr.then(onProgress));
      }
      await Promise.all(jobs);
      return [...new Set(keys)].filter(k => failed.has(k));
    }

    // The first screen (2026-10-14, P2): data/first.json, the top rows of a first visit's list (no
    // profile, newest first, the Northeast and remote), written by the export with the state files
    // (backend/internscout/export_static.py first_screen). One small request, so the list can paint
    // before the 550 KB of state files arrive. The rows are copies of rows in those files, and add()
    // keeps the first copy of an id, so nothing changes when the files land. Fetched once per
    // init; a missing or failed file is no loss, the state files carry every row anyway.
    let primed = null;
    function primer() {
      if (legacy || !index || !index.first || !index.first.file || !index.first.rows) return Promise.resolve(false);
      if (primed && primed.epoch === generation) return primed.pr;
      const epoch = generation;
      const pr = getJSON(base + index.first.file, bust, Math.min(timeoutMs, 5000))
        .then(d => { if (epoch !== generation || !Array.isArray(d)) return false; add(d); return true; })
        .catch(() => false);
      primed = { epoch, pr };
      return pr;
    }

    // Descriptions live beside each shard (<file> -> <file>.desc.json, {id: text}) so the list
    // loads without them; they are fetched only for search and Auto-Apply. Older exports carry
    // them inline on the row, and then the sidecar simply doesn't exist.
    async function descs(keys) {
      if (legacy || !index) return [];
      const jobs = [];
      const bad = new Set(), epoch = generation, requestBase = base, requestBust = bust;
      for (const k of new Set(keys)) {
        const meta = index.files[k];
        if (!meta) continue;
        if (descd.has(k)) { jobs.push(descd.get(k).then(ok => { if (!ok) bad.add(k); })); continue; }
        const file = meta.desc || (meta.file || (index._dir + k + ".json")).replace(/\.json$/, ".desc.json");
        const get = () => getJSON(requestBase + file, requestBust, timeoutMs);
        const pr = Promise.resolve(loaded.get(k)).then(() => {
          if (failed.has(k)) throw new Error("Listings have not loaded");
          // The same one quiet retry a listing file gets (was: none, so one dropped connection meant
          // pressing Try again). A missing sidecar (404) is an answer, not a dropped connection.
          return get().catch(e => e.status === 404 ? Promise.reject(e) : new Promise(r => browser.setTimeout(r, retryDelayMs)).then(get));
        }).then(m => {
          if (epoch !== generation) return false;
          let n = 0;
          for (const id in m) {
            const x = byId.get(id) || byId.get(Number(id));
            if (x && !x.description && m[id]) { x.description = m[id]; delete x._hay; n++; }
          }
          if (n) version++;
          return true;
        }).catch(e => {
          if (epoch === generation) descd.delete(k);
          return !meta.desc && e.status === 404; // Legacy exports may keep descriptions inline.
        });
        descd.set(k, pr);
        jobs.push(pr.then(ok => { if (!ok) bad.add(k); }));
      }
      await Promise.all(jobs);
      return [...bad];
    }

    return {
      init, ensure, descs, primer,
      all: () => [...byId.values()],
      version: () => version,
      index: () => index,
      isLegacy: () => legacy,
      loadedKeys: () => [...loaded.keys()],
      base: () => base,
    };
  }

  // The major a landing page's "Rank these for your major" link stands for (?field=nursing), to prefill
  // the setup card with (2026-10-14). A major page sends all of its tags (?field=mechanical,aerospace).
  // The major whose tags are exactly those, else the one major led by the first tag, else one led by it
  // whose name says the field ("Data" in "Statistics and Data Science"); null when it is a guess.
  function majorForFields(fields, majorsData) {
    const list = ((majorsData && majorsData.majors) || []).filter(m => m.tags && m.tags[0] === (fields || [])[0]);
    if (!list.length) return null;
    const same = list.find(m => m.tags.length === fields.length && m.tags.every(t => fields.includes(t)));
    if (same) return same.name;
    if (list.length === 1) return list[0].name;
    const label = fieldLabel(fields[0]).toLowerCase();
    const named = list.filter(m => m.level !== "grad" && m.name.toLowerCase().includes(label));
    return named.length === 1 ? named[0].name : null;
  }

  async function loadMajors() {
    for (const b of [C.dataUrl || "./data/", C.rawDataFallback].filter(Boolean)) {
      try { const m = await getJSON(b + "majors.json"); if (m && m.majors) return m; } catch (e) { }
    }
    return null;
  }
  // What step 1 of the setup card says in place of the major pickers. loadMajors() resolves with null
  // only once every source has failed, but before it resolves the page holds null too, so null alone
  // cannot mean "failed": on a slow first load the card said the list "didn't load" while majors.json
  // was still downloading. `settled` is set when loadMajors() resolves, whichever way it went.
  const majorsNote = (majors, settled) => majors && majors.majors ? null
    : settled ? "The major list didn't load. Pick the fields you're interested in below instead."
      : "Loading the list of majors…";
  async function loadStats() {
    for (const b of [C.dataUrl || "./data/", C.rawDataFallback].filter(Boolean)) {
      try { return await getJSON(b + "stats.json"); } catch (e) { }
    }
    return null;
  }

  return {
    createStore, majorForFields, loadMajors, majorsNote, loadStats,
  };
}
