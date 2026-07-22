// Content script: injects a panel, fills structured fields, and adds AI buttons to
// open-ended questions. Never submits the form.
(function () {
  const ATS = location.hostname.includes("lever.co") ? "lever" : "greenhouse";

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillSelect(el, value) {
    const want = String(value).toLowerCase();
    for (const opt of el.options) {
      if (opt.text.toLowerCase().includes(want) || opt.value.toLowerCase() === want) {
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function fillAll(profile) {
    const fields = document.querySelectorAll("input, textarea, select");
    let filled = 0;
    fields.forEach((el) => {
      if (el.type === "hidden" || el.type === "file" || el.type === "submit" || el.disabled) return;
      const label = fieldLabelText(el);
      let key = matchProfileKey(label);
      // full name fallback
      if (key === "full_name" && !profile.full_name && (profile.first_name || profile.last_name)) {
        if (setValue(el, `${profile.first_name} ${profile.last_name}`.trim())) filled++;
        return;
      }
      if (key && profile[key]) {
        if (setValue(el, profile[key])) filled++;
      }
    });
    toast(`Filled ${filled} field${filled === 1 ? "" : "s"}. Review everything before submitting.`);
  }

  function setValue(el, value) {
    if (el.tagName === "SELECT") return fillSelect(el, value);
    if (el.type === "checkbox" || el.type === "radio") return false; // skip; user handles
    if (!el.value) { setNativeValue(el, value); return true; }
    setNativeValue(el, value); return true;
  }

  // ---- AI buttons on open-ended textareas ----
  function jobDescription() {
    const sel = ATS === "lever" ? ".posting-page, .section-wrapper" : ".job__description, #content, main";
    const node = document.querySelector(sel) || document.body;
    return (node.innerText || "").slice(0, 6000);
  }
  function companyName() {
    if (ATS === "lever") {
      const m = location.pathname.split("/").filter(Boolean)[0];
      return (m || "this company").replace(/-/g, " ");
    }
    const seg = location.pathname.split("/").filter(Boolean);
    return (seg[0] || "this company").replace(/-/g, " ");
  }

  function addAiButtons(store) {
    document.querySelectorAll("textarea").forEach((ta) => {
      if (ta.dataset.isAi) return;
      const label = fieldLabelText(ta);
      if (!looksLikeQuestion(label)) return;
      ta.dataset.isAi = "1";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "is-ai-btn";
      btn.textContent = store.ai.apiKey ? "✨ Draft answer" : "✨ Insert template";
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "…thinking";
        try {
          let text;
          if (store.ai.apiKey) {
            text = await requestAi(label, companyName(), jobDescription(), store);
          } else {
            text = template(label, store.profile, companyName());
          }
          if (text) { setNativeValue(ta, text); }
        } catch (e) {
          toast("AI error: " + e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = store.ai.apiKey ? "✨ Draft answer" : "✨ Insert template";
        }
      });
      ta.insertAdjacentElement("afterend", btn);
    });
  }

  function template(label, profile, company) {
    const t = profile.templates || {};
    for (const k of Object.keys(t)) if (label.includes(k)) return t[k].replaceAll("{{company}}", company);
    return (t.why || "").replaceAll("{{company}}", company);
  }

  function requestAi(question, company, jd, store) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "ai", question, company, jd, profile: store.profile, ai: store.ai },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || resp.error) return reject(new Error(resp ? resp.error : "no response"));
          resolve(resp.text);
        }
      );
    });
  }

  // ---- UI ----
  function toast(msg) {
    let t = document.getElementById("is-toast");
    if (!t) { t = document.createElement("div"); t.id = "is-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 4000);
  }

  async function mountPanel() {
    const store = await loadStore();
    const panel = document.createElement("div");
    panel.id = "is-panel";
    panel.innerHTML = `<span class="is-logo">InternScout</span>
      <button id="is-fill" type="button">Autofill this page</button>
      <span class="is-hint">${ATS}</span>`;
    document.body.appendChild(panel);
    document.getElementById("is-fill").addEventListener("click", () => fillAll(store.profile));
    addAiButtons(store);
    // re-scan for late-rendered questions
    const mo = new MutationObserver(() => addAiButtons(store));
    mo.observe(document.body, { childList: true, subtree: true });

    chrome.runtime.onMessage.addListener((m) => { if (m.type === "fill") fillAll(store.profile); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountPanel);
  else mountPanel();
})();
