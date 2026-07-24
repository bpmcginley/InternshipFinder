// Content script: fills Greenhouse/Lever applications from your saved profile, adds AI-draft
// buttons to open-ended questions, and can attach your stored resume/transcript. Never submits.
(function () {
  const ATS = location.hostname.includes("myworkdayjobs.com") ? "workday"
    : location.hostname.includes("lever.co") ? "lever" : "greenhouse";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const aiCache = new Map();
  let STORE = null;

  function setNative(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isReactSelectInput(el) {
    return (el.classList && el.classList.contains("select__input")) || !!(el.closest && el.closest(".select-shell"));
  }

  // --- React internals: react-select exposes selectOption() in its fiber props. Using it
  // avoids flaky synthetic mouse/keyboard events. ---
  function getFiber(el) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    return k ? el[k] : null;
  }
  function fiberSelectOption(input) {
    let f = getFiber(input);
    for (let i = 0; i < 25 && f; i++) {
      const p = f.memoizedProps;
      if (p && typeof p.selectOption === "function") return p.selectOption;
      f = f.return;
    }
    return null;
  }

  // Fill a Greenhouse react-select. Strategy: open, type to filter, then commit the matching
  // option via React's selectOption(optionData); fall back to Enter. Bounded (never hangs).
  async function fillReactSelect(input, value) {
    const c = input.closest(".select-shell");
    if (!c) return "";
    const want = String(value).toLowerCase();
    const selOpt = fiberSelectOption(input);
    input.focus(); await sleep(50);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await sleep(120);
    setNative(input, value);
    let opts = [];
    for (let i = 0; i < 12; i++) { await sleep(120); opts = [...c.querySelectorAll(".select__option")]; if (opts.length) break; }
    if (opts.length) {
      const el = opts.find((o) => o.textContent.trim().toLowerCase() === want)
        || opts.find((o) => o.textContent.trim().toLowerCase().includes(want)) || opts[0];
      const data = getFiber(el) && getFiber(el).memoizedProps ? getFiber(el).memoizedProps.data : null;
      try {
        if (selOpt && data) selOpt(data);
        else { ["keydown", "keyup"].forEach((t) => input.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }))); }
      } catch (e) { /* fall through to verify */ }
      await sleep(150);
    }
    const shown = ((c.querySelector(".select__single-value") || {}).textContent || "").trim();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return shown;
  }

  function highlightNeedsInput(el) {
    const box = el.closest(".select-shell") || el.closest(".field, .application-field") || el;
    box.style.outline = "2px dashed #d29922"; box.style.outlineOffset = "2px";
  }

  // Show the recommended value next to a field the extension couldn't auto-fill, so picking
  // it is a 1-click job instead of a guess.
  function hintChip(el, value) {
    const box = el.closest(".select-shell") || el.closest(".field") || el;
    if (!box || box.parentElement.querySelector(".is-hint-chip")) return;
    const chip = document.createElement("span");
    chip.className = "is-hint-chip";
    chip.textContent = "pick: " + value;
    chip.title = "Recommended value from your InternScout profile";
    box.insertAdjacentElement("afterend", chip);
  }

  function fillNativeSelect(el, value) {
    const want = String(value).toLowerCase();
    for (const opt of el.options) {
      if (opt.text.toLowerCase().includes(want) || opt.value.toLowerCase() === want) {
        el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); return true;
      }
    }
    return false;
  }

  // --- File attach (resume / transcript) from stored base64 via DataTransfer ---
  function b64ToFile(f) {
    const b64 = (f.data || "").split(",").pop();
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], f.name || "file.pdf", { type: f.type || "application/pdf" });
  }
  function setFileInput(input, file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.files.length > 0;
    } catch (e) { return false; }
  }
  function fileKeyFor(input) {
    const lab = fieldLabelText(input) + " " + (input.id || "") + " " +
      ((input.closest(".field, .application-field, li, div") || {}).textContent || "").slice(0, 120).toLowerCase();
    if (/transcript|gpa/.test(lab)) return "transcript";
    if (/cover/.test(lab)) return "cover";
    if (/resume|cv|c\.v\./.test(lab)) return "resume";
    return null;
  }
  function attachFiles(store) {
    let attached = 0, missing = 0;
    document.querySelectorAll('input[type="file"]').forEach((inp) => {
      if (inp.disabled) return;
      const key = fileKeyFor(inp);
      const stored = key && store.files ? store.files[key] : null;
      if (stored && stored.data) {
        if (setFileInput(inp, b64ToFile(stored))) { attached++; inp.style.outline = "2px solid #3fb950"; return; }
      }
      inp.style.outline = "2px dashed #d29922"; inp.style.outlineOffset = "2px"; missing++;
    });
    return { attached, missing };
  }

  async function fillField(el, value) {
    if (el.tagName === "SELECT") return fillNativeSelect(el, value);
    if (el.type === "checkbox" || el.type === "radio") return false;
    setNative(el, value);
    return true;
  }

  async function fillAll(profile) {
    const els = [...document.querySelectorAll("input, select, textarea")];
    let filled = 0, flagged = 0;
    const reactSelects = [];
    for (const el of els) {
      if (["hidden", "file", "submit", "button", "search"].includes(el.type) || el.disabled) continue;
      const label = fieldLabelText(el);
      let key = matchProfileKey(label);
      if (key === "full_name" && !profile.full_name && (profile.first_name || profile.last_name)) {
        if (await fillField(el, `${profile.first_name} ${profile.last_name}`.trim())) filled++;
        continue;
      }
      if (!key || !profile[key]) continue;
      if (isReactSelectInput(el)) { reactSelects.push([el, profile[key]]); continue; }
      try { if (await fillField(el, profile[key])) filled++; } catch (e) { /* continue */ }
    }
    // React-selects (education, work-auth, etc.): try React-native fill, then hint chip.
    for (const [el, val] of reactSelects) {
      let ok = false;
      try {
        const shown = await fillReactSelect(el, val);
        ok = !!shown && (shown.toLowerCase().includes(String(val).toLowerCase()) || String(val).toLowerCase().includes(shown.toLowerCase()));
      } catch (e) { ok = false; }
      if (ok) filled++; else { highlightNeedsInput(el); hintChip(el, val); flagged++; }
    }
    const f = attachFiles(profile.files ? profile : { files: (STORE && STORE.files) || {} });
    filled += f.attached;
    flagged += f.missing;
    let msg = `Filled ${filled} field${filled === 1 ? "" : "s"}.`;
    if (flagged) msg += ` ${flagged} highlighted (pick the suggested value / attach files).`;
    toast(msg + " Review before submitting.");
  }

  // ---------- AI answers ----------
  function jobText() {
    const sel = ATS === "lever" ? ".posting-page, .section-wrapper, main" : ".job__description, #content, main, body";
    const node = document.querySelector(sel) || document.body;
    return (node.innerText || "").slice(0, 6000);
  }
  function companyName() {
    const seg = location.pathname.split("/").filter(Boolean);
    return (seg[0] || document.title.split(" at ").pop() || "this company").replace(/-/g, " ");
  }
  function requestAi(question, store) {
    const cacheKey = question + "|" + companyName();
    if (aiCache.has(cacheKey)) return Promise.resolve(aiCache.get(cacheKey));
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "ai", question, company: companyName(), jd: jobText(), profile: store.profile, ai: store.ai },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || resp.error) return reject(new Error(resp ? resp.error : "no response"));
          aiCache.set(cacheKey, resp.text); resolve(resp.text);
        });
    });
  }
  function template(label, profile) {
    const t = profile.templates || {};
    for (const k of Object.keys(t)) if (label.includes(k)) return t[k].replaceAll("{{company}}", companyName());
    return (t.why || "").replaceAll("{{company}}", companyName());
  }
  function getQuestionText(el) {
    let t = fieldLabelText(el);
    if (t && t.length >= 8) return t;
    const card = el.closest("li, .application-question, .field, .form-field, [class*='question']");
    if (card) {
      const lab = card.querySelector(".application-label, label, .text, legend, strong");
      if (lab && lab.textContent.trim().length >= 3) return lab.textContent.replace(/\s+/g, " ").trim();
    }
    let prev = el.previousElementSibling;
    while (prev) { const tx = (prev.textContent || "").trim(); if (tx.length >= 8) return tx.slice(0, 200); prev = prev.previousElementSibling; }
    return t || "this application question";
  }
  function isDraftableTextarea(el) {
    if (el.tagName !== "TEXTAREA") return false;
    if (el.disabled || el.readOnly) return false;
    if (el.offsetParent === null) return false;
    const nm = (el.name || "") + " " + (el.id || "");
    if (/recaptcha|captcha/i.test(nm)) return false;
    return true;
  }
  function addAiButtons(store) {
    document.querySelectorAll("textarea").forEach((ta) => {
      if (ta.dataset.isAi) return;
      if (!isDraftableTextarea(ta)) return;
      ta.dataset.isAi = "1";
      const question = () => getQuestionText(ta);
      const bar = document.createElement("div"); bar.className = "is-ai-bar";
      const gen = document.createElement("button");
      gen.type = "button"; gen.className = "is-ai-btn";
      gen.textContent = store.ai.apiKey ? "✨ Draft answer" : "✨ Insert template";
      gen.addEventListener("click", async () => {
        gen.disabled = true; const old = gen.textContent; gen.textContent = "… thinking";
        try {
          const q = question();
          const text = store.ai.apiKey ? await requestAi(q, store) : template(q, store.profile);
          if (text) setNative(ta, text);
        } catch (e) { toast("AI error: " + e.message); }
        finally { gen.disabled = false; gen.textContent = old; }
      });
      bar.appendChild(gen);
      if (store.ai.apiKey) {
        const re = document.createElement("button");
        re.type = "button"; re.className = "is-ai-btn is-ghost"; re.textContent = "↻ Regenerate";
        re.addEventListener("click", async () => {
          aiCache.delete(question() + "|" + companyName());
          re.disabled = true; re.textContent = "…";
          try { const text = await requestAi(question(), store); if (text) setNative(ta, text); }
          catch (e) { toast("AI error: " + e.message); }
          finally { re.disabled = false; re.textContent = "↻ Regenerate"; }
        });
        bar.appendChild(re);
      }
      ta.insertAdjacentElement("afterend", bar);
    });
  }

  async function runFill(profile) {
    if (ATS === "workday" && typeof fillWorkday === "function") {
      const r = await fillWorkday(profile);
      const f = attachFiles({ files: (STORE && STORE.files) || {} });
      toast(`Filled ${r.filled + f.attached} field(s).${(r.flagged + f.missing) ? " " + (r.flagged + f.missing) + " highlighted to complete." : ""} Review before submitting.`);
      return;
    }
    return fillAll(profile);
  }

  // ---------- AI form mapping (works on ANY site) ----------
  // Scan the DOM for fillable fields, send their labels/types/options to Claude, and apply
  // the returned mapping. No per-site programming needed.
  function collectFields() {
    const fields = [];
    let idx = 0;
    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (["hidden", "submit", "button", "file", "image", "reset", "search", "password"].includes(el.type) || el.disabled) continue;
      if (el.offsetParent === null) continue;                 // not visible
      if (el.type === "checkbox" || el.type === "radio") continue;
      el.setAttribute("data-is-idx", String(idx));
      let options = null;
      if (el.tagName === "SELECT") options = [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 50);
      fields.push({
        idx, tag: el.tagName.toLowerCase(), type: el.type || "",
        label: getQuestionText(el).slice(0, 140), name: (el.name || "").slice(0, 40),
        isSelect: el.tagName === "SELECT" || isReactSelectInput(el),
        options, filled: !!el.value
      });
      idx++;
    }
    return fields;
  }

  async function applyFills(fills) {
    let filled = 0, flagged = 0;
    for (const item of fills) {
      const el = document.querySelector(`[data-is-idx="${item.idx}"]`);
      const value = item && item.value;
      if (!el || !value) continue;
      try {
        if (el.tagName === "SELECT") {
          if (fillNativeSelect(el, value)) filled++; else { highlightNeedsInput(el); hintChip(el, value); flagged++; }
        } else if (isReactSelectInput(el)) {
          const shown = await fillReactSelect(el, value);
          const ok = shown && (shown.toLowerCase().includes(String(value).toLowerCase()) || String(value).toLowerCase().includes(shown.toLowerCase()));
          if (ok) filled++; else { highlightNeedsInput(el); hintChip(el, value); flagged++; }
        } else {
          setNative(el, value); filled++;
        }
      } catch (e) { /* continue */ }
    }
    return { filled, flagged };
  }

  async function aiFill(store) {
    if (!store.ai.apiKey) { toast("Add your Anthropic API key in Options to use AI Autofill."); return; }
    toast("AI scanning the form…");
    const fields = collectFields();
    if (!fields.length) { toast("No fillable fields found on this page."); return; }
    let resp;
    try {
      resp = await new Promise((res, rej) => chrome.runtime.sendMessage(
        { type: "map_fields", fields, profile: store.profile, ai: store.ai },
        (r) => { if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message)); else res(r); }));
    } catch (e) { toast("AI error: " + e.message); return; }
    if (!resp || resp.error) { toast("AI error: " + ((resp && resp.error) || "no response")); return; }
    const { filled, flagged } = await applyFills(resp.fills || []);
    const f = attachFiles({ files: (STORE && STORE.files) || {} });
    toast(`AI filled ${filled + f.attached} field(s).${(flagged + f.missing) ? " " + (flagged + f.missing) + " highlighted (pick suggested / attach files)." : ""} Review before submitting.`);
  }

  // ---------- UI ----------
  function toast(msg) {
    let t = document.getElementById("is-toast");
    if (!t) { t = document.createElement("div"); t.id = "is-toast"; (document.documentElement || document.body).appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 6000);
  }

  // Build/re-attach the panel. Attaches to <html> (outside <body>) so the site's React
  // re-renders can't remove it; re-created by the observer if it ever goes missing.
  function ensurePanel(store, known) {
    if (document.getElementById("is-panel")) return;
    const panel = document.createElement("div");
    panel.id = "is-panel";
    const aiBtn = store.ai.apiKey ? `<button id="is-aifill" type="button">🧠 AI Autofill</button>` : "";
    panel.innerHTML = `<span class="is-logo">InternScout</span>
      ${known ? `<button id="is-fill" type="button">Autofill</button>` : ""}
      ${aiBtn}
      <span class="is-hint">${known ? ATS : "any site"}${store.ai.apiKey ? " · AI on" : ""}</span>`;
    (document.documentElement || document.body).appendChild(panel);
    const fb = panel.querySelector("#is-fill");
    if (fb) fb.addEventListener("click", () => runFill(store.profile));
    const ab = panel.querySelector("#is-aifill");
    if (ab) ab.addEventListener("click", () => aiFill(store));
  }

  async function mount() {
    if (window.__internscoutMounted) return;      // guard against double injection
    window.__internscoutMounted = true;
    const store = await loadStore();
    STORE = store;
    const known = /greenhouse\.io|lever\.co|myworkdayjobs\.com/.test(location.hostname);
    ensurePanel(store, known);
    addAiButtons(store);
    // Re-attach the panel and (re)scan textareas whenever the page mutates (React re-renders).
    let scheduled = false;
    const mo = new MutationObserver(() => {
      if (scheduled) return; scheduled = true;
      setTimeout(() => { scheduled = false; ensurePanel(store, known); addAiButtons(store); }, 300);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("focusin", (e) => { if (e.target && e.target.tagName === "TEXTAREA") addAiButtons(store); });
    chrome.runtime.onMessage.addListener((m) => {
      if (m.type === "fill") runFill(store.profile);
      if (m.type === "aifill") aiFill(store);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
