// Content script: fills Greenhouse/Lever applications from your saved profile and adds
// AI-draft buttons to open-ended questions. Never submits. React-select handling and the
// native-setter trick were verified against a live Greenhouse form.
(function () {
  const ATS = location.hostname.includes("lever.co") ? "lever" : "greenhouse";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const aiCache = new Map();

  function setNative(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isReactSelectInput(el) {
    return (el.classList && el.classList.contains("select__input")) || !!(el.closest && el.closest(".select-shell"));
  }

  // Proven method: focus -> ArrowDown to open -> type to filter -> Enter to choose.
  // Best-effort combobox fill via keyboard (focus -> open -> type -> Enter). Returns the
  // committed value string (or "" if nothing committed) so the caller can verify before
  // trusting it. Synthetic events are timing-sensitive; we never leave an unverified pick.
  async function fillReactSelect(input, value) {
    const c = input.closest(".select-shell") || input.closest('[class*="container"]');
    if (!c) return "";
    input.focus(); await sleep(60);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await sleep(140);
    setNative(input, value); await sleep(240);
    ["keydown", "keypress", "keyup"].forEach((t) =>
      input.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })));
    await sleep(160);
    const shown = ((c.querySelector(".select__single-value") || {}).textContent || "").trim();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return shown;
  }

  function highlightNeedsInput(el) {
    const box = el.closest(".select-shell") || el.closest(".field, .application-field") || el;
    box.style.outline = "2px dashed #f5a623"; box.style.outlineOffset = "2px";
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

  async function fillField(el, value) {
    if (el.tagName === "SELECT") return fillNativeSelect(el, value);
    if (el.type === "checkbox" || el.type === "radio") return false;
    setNative(el, value);
    return true;
  }

  function highlightFiles() {
    let any = false;
    document.querySelectorAll('input[type="file"]').forEach((f) => {
      f.style.outline = "2px dashed #f5a623"; f.style.outlineOffset = "2px"; any = true;
    });
    return any;
  }

  const SAFE_RS_KEYS = new Set(["work_authorized", "needs_sponsorship"]);

  async function fillAll(profile) {
    const els = [...document.querySelectorAll("input, select, textarea")];
    let filled = 0, flagged = 0;
    const binaryRS = [];
    for (const el of els) {
      if (["hidden", "file", "submit", "button", "search"].includes(el.type) || el.disabled) continue;
      const label = fieldLabelText(el);
      let key = matchProfileKey(label);
      if (key === "full_name" && !profile.full_name && (profile.first_name || profile.last_name)) {
        if (await fillField(el, `${profile.first_name} ${profile.last_name}`.trim())) filled++;
        continue;
      }
      if (!key || !profile[key]) continue;
      if (isReactSelectInput(el)) {
        if (SAFE_RS_KEYS.has(key)) binaryRS.push([el, profile[key]]);
        else { highlightNeedsInput(el); flagged++; }   // big typeaheads (country/school) -> user picks
        continue;
      }
      try { if (await fillField(el, profile[key])) filled++; } catch (e) { /* continue */ }
    }
    // Binary Yes/No comboboxes: attempt, but only trust a verified commit.
    for (const [el, val] of binaryRS) {
      let ok = false;
      try {
        const shown = await fillReactSelect(el, val);
        ok = shown.toLowerCase() === String(val).toLowerCase() || shown.toLowerCase().includes(String(val).toLowerCase());
      } catch (e) { ok = false; }
      if (ok) filled++; else { highlightNeedsInput(el); flagged++; }
    }
    const files = highlightFiles();
    let msg = `Filled ${filled} field${filled === 1 ? "" : "s"}.`;
    if (flagged || files) msg += ` ${flagged + (files ? 1 : 0)} highlighted for you to complete (dropdowns/files).`;
    msg += " Review before submitting.";
    toast(msg);
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
    // previous sibling text (Lever/Greenhouse sometimes render the prompt as a preceding node)
    let prev = el.previousElementSibling;
    while (prev) { const tx = (prev.textContent || "").trim(); if (tx.length >= 8) return tx.slice(0, 200); prev = prev.previousElementSibling; }
    return t || "this application question";
  }

  function isDraftableTextarea(el) {
    if (el.tagName !== "TEXTAREA") return false;
    if (el.disabled || el.readOnly) return false;
    if (el.offsetParent === null) return false;                 // hidden
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

  // ---------- UI ----------
  function toast(msg) {
    let t = document.getElementById("is-toast");
    if (!t) { t = document.createElement("div"); t.id = "is-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 5000);
  }

  async function mount() {
    const store = await loadStore();
    if (!document.getElementById("is-panel")) {
      const panel = document.createElement("div");
      panel.id = "is-panel";
      panel.innerHTML = `<span class="is-logo">InternScout</span>
        <button id="is-fill" type="button">Autofill</button>
        <span class="is-hint">${ATS}${store.ai.apiKey ? " · AI on" : ""}</span>`;
      document.body.appendChild(panel);
      document.getElementById("is-fill").addEventListener("click", () => fillAll(store.profile));
    }
    addAiButtons(store);
    const mo = new MutationObserver(() => addAiButtons(store));
    mo.observe(document.body, { childList: true, subtree: true });
    chrome.runtime.onMessage.addListener((m) => { if (m.type === "fill") fillAll(store.profile); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
