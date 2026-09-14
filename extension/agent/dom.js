// Page model for the agent (MAIN world, every frame). Needs guard.js + actions.js first.
// snapshot() -> compact list of interactive elements with stable refs; act() runs one action
// with verify-after-set; fastFill() fills obvious contact fields without a model call.
(function () {
  const V = 3; // bump when this file changes, so a reloaded extension replaces the old copy in open tabs
  if (window.ISDom && window.ISDom.v >= V) return;
  const A = window.ISActions, G = window.ISGuard, norm = A.norm;
  const refs = new Map();
  let seq = 0;

  const txt = (el) => (el ? norm(el.innerText || el.textContent) : "");
  const cut = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);
  const byIds = (ids) => ids.split(/\s+/).map((i) => txt(document.getElementById(i))).filter(Boolean).join(" ");
  function refOf(el) {
    let r = el.getAttribute("data-is-ref");
    if (!r) { r = String(++seq); el.setAttribute("data-is-ref", r); }
    return r;
  }
  const isField = (el) => el.matches("input, select, textarea");

  function questionLabel(el, scope = el) {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = byIds(lb); if (t) return t; }
    if (isField(el)) {
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (txt(l)) return txt(l); }
      const w = el.closest("label"); if (txt(w)) return txt(w);
    }
    const fs = el.closest("fieldset");
    if (fs) { const lg = fs.querySelector("legend"); if (txt(lg)) return txt(lg); }
    const wd = el.closest('[data-automation-id^="formField-"]');
    if (wd) { const l = wd.querySelector("label, legend"); if (txt(l)) return txt(l); }
    if (el.getAttribute("aria-label")) return norm(el.getAttribute("aria-label"));
    let p = scope.parentElement;
    for (let i = 0; i < 5 && p && p !== document.body; i++, p = p.parentElement) {
      for (const l of p.querySelectorAll('label, legend, [class*="label"], [class*="Label"], [class*="question"], h3, h4, p')) {
        if (scope.contains(l) || l.contains(scope)) continue;
        const t = txt(l);
        if (t && t.length < 400) return t;
      }
    }
    return norm(el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "");
  }

  function optLabel(r) {
    if (r.id) { const l = document.querySelector(`label[for="${CSS.escape(r.id)}"]`); if (txt(l)) return txt(l); }
    const w = r.closest("label"); if (txt(w)) return txt(w);
    if (r.getAttribute("aria-label")) return norm(r.getAttribute("aria-label"));
    const lb = r.getAttribute("aria-labelledby"); if (lb && byIds(lb)) return byIds(lb);
    if (txt(r.nextElementSibling)) return txt(r.nextElementSibling);
    return norm(r.value || txt(r));
  }

  function fieldError(el) {
    if (el.getAttribute && el.getAttribute("aria-invalid") !== "true") return "";
    const d = el.getAttribute("aria-describedby");
    return d ? cut(byIds(d), 160) : "invalid";
  }

  function labelVisible(el) {
    const l = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label");
    return l && A.visible(l);
  }

  function kindOf(el) {
    const tag = el.tagName, type = (el.getAttribute("type") || "").toLowerCase(), role = el.getAttribute("role");
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "BUTTON") return "listbox";
    if (type === "radio" || role === "radio") return "radio_group";
    if (type === "checkbox" || role === "checkbox") return "checkbox";
    if (type === "file") return "file";
    if (type === "password") return "password";
    if (tag !== "INPUT" && el.isContentEditable) return "rich_text";
    if (A.isReactSelect(el)) return "react_select";
    if (role === "combobox" || el.getAttribute("aria-autocomplete") === "list" || el.getAttribute("data-uxi-widget-type") === "selectinput") return "combobox";
    return "text";
  }

  function valueOf(el, kind) {
    switch (kind) {
      case "select": return el.selectedIndex > 0 || (el.value && el.selectedIndex >= 0) ? norm(el.options[el.selectedIndex].text) : "";
      case "react_select": return A.reactSelectValue(el);
      case "listbox": { const t = txt(el); return /^select one$|^select\b/i.test(t) ? "" : t; }
      case "checkbox": return el.type === "checkbox" ? el.checked : el.getAttribute("aria-checked") === "true";
      case "file": {
        const names = el.files ? [...el.files].map((f) => f.name) : [];
        if (names.length) return names.join(", ");
        const zone = el.closest('[data-automation-id^="formField-"], .field, [class*="upload"]');
        const m = zone && txt(zone).match(/[\w\-. ]+\.(pdf|docx?|txt|rtf)/i);
        return m ? m[0] : "";
      }
      case "password": return el.value ? "(filled)" : "";
      case "rich_text": return cut(txt(el), 300);
      default: return cut(el.value || "", 400);
    }
  }

  function collect() {
    refs.clear();
    const elements = [], seen = new Set();
    const nodes = document.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"], [role="radio"], [role="checkbox"], [contenteditable="true"]');
    for (const el of nodes) {
      if (el.closest("[data-is-overlay]")) continue;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && ["hidden", "submit", "button", "image", "reset", "search"].includes(type)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const kind = kindOf(el);
      if (kind === "file") {
        // Real dropzones hide the <input> itself, but a field on a hidden step has a hidden parent too.
        if (!A.visible(el) && !labelVisible(el) && !A.visible(el.parentElement)) continue;
      } else if (!A.visible(el) && !((kind === "radio_group" || kind === "checkbox") && labelVisible(el))) continue;
      if (kind === "react_select" || kind === "text") {
        // react-select renders a hidden <input> for form value next to the visible one
        if (el.closest('[class*="select__control"]') && !el.matches('input[id], input[class*="input"]')) continue;
      }
      if (kind === "file") {
        const zone = el.closest('[data-automation-id^="formField-"], .field, [class*="upload"], div');
        if (zone && seen.has(zone)) continue;
        if (zone) seen.add(zone);
      }
      const rec = { kind };
      if (kind === "radio_group") {
        const container = el.closest('[role="radiogroup"], fieldset, [data-automation-id^="formField-"]');
        const name = el.getAttribute("name");
        let els = name ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)]
          : container ? [...container.querySelectorAll('[role="radio"]')] : [el];
        const key = els[0];
        if (seen.has(key)) continue;
        seen.add(key);
        let scope = container;
        if (!scope) { scope = el.parentElement; while (scope && !els.every((r) => scope.contains(r))) scope = scope.parentElement; }
        rec.els = els;
        rec.options = els.map(optLabel);
        rec.label = questionLabel(scope || el, scope || el);
        rec.value = (els.find((r) => r.checked || r.getAttribute("aria-checked") === "true") && optLabel(els.find((r) => r.checked || r.getAttribute("aria-checked") === "true"))) || "";
        rec.el = key;
        rec.required = els.some((r) => r.required || r.getAttribute("aria-required") === "true") || /\*/.test(rec.label);
      } else {
        rec.el = el;
        rec.label = questionLabel(el);
        if (kind === "checkbox") {
          const fs = el.closest('fieldset, [role="group"], [data-automation-id^="formField-"]');
          const q = fs && txt(fs.querySelector("legend, label"));
          if (q && q !== rec.label) rec.question = cut(q, 300);
        }
        if (kind === "react_select") {
          const o = A.reactSelectOptions(el);
          if (o.options.length) rec.options = o.options.slice(0, 80);
          if (o.searchable) rec.searchable = true;
        }
        if (kind === "select") rec.options = [...el.options].map((o) => norm(o.text)).filter((t) => t && !/^(select|choose|--|please select)/i.test(t)).slice(0, 80);
        rec.value = valueOf(el, kind);
        rec.required = el.required || el.getAttribute("aria-required") === "true" || /\*\s*$|\(required\)/i.test(rec.label);
        if (kind === "text") rec.type = type || "text";
        if (el.maxLength > 0 && el.maxLength < 100000) rec.maxlength = el.maxLength;
      }
      rec.label = cut(rec.label || "", 300);
      rec.error = fieldError(rec.el);
      const ref = refOf(rec.el);
      refs.set(ref, rec);
      elements.push({ ref, kind, type: rec.type, label: rec.label, question: rec.question, required: !!rec.required,
        value: rec.value, options: rec.options, searchable: rec.searchable || undefined, maxlength: rec.maxlength, error: rec.error || undefined });
    }
    return elements;
  }

  const LINK_RE = /apply|next|continue|sign ?(in|up)|create|account|log ?in|register|start|begin|submit|review|upload|autofill|manual|add|save|back|resume|proceed|interested|forgot/i;
  function collectButtons(ctx) {
    const out = [], seenText = new Set();
    for (const el of document.querySelectorAll('button:not([aria-haspopup="listbox"]), input[type="submit"], input[type="button"], [role="button"], a[href]')) {
      if (out.length >= 50) break;
      if (el.closest("[data-is-overlay]") || !A.visible(el) || el.disabled) continue;
      if (el.closest('[role="listbox"], [role="menu"]')) continue;
      const text = cut(norm(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || ""), 80);
      if (!text) continue;
      if (el.tagName === "A" && !LINK_RE.test(text)) continue;
      const key = text + "|" + el.tagName;
      if (seenText.has(key) && el.tagName === "A") continue;
      seenText.add(key);
      const ref = refOf(el);
      refs.set(ref, { kind: "button", el, label: text });
      const b = { ref, text };
      if (!G.allowClick(G.describe(el), ctx).allowed) b.blocked = true;
      out.push(b);
    }
    return out;
  }

  function snapshot() {
    G.installClickBlock(document);
    const elements = collect();
    const ctx = G.pageContext(document);
    const buttons = collectButtons(ctx);
    const headings = [...document.querySelectorAll('h1, h2, [data-automation-id="pageHeaderTitleText"], [role="heading"]')]
      .filter(A.visible).map(txt).filter(Boolean).slice(0, 6).map((t) => cut(t, 120));
    const step = cut(txt([...document.querySelectorAll('[aria-current="step"], [data-automation-id="progressBarActiveStep"], [class*="step"][class*="active"]')].find(A.visible)), 120);
    const errors = [...new Set([...document.querySelectorAll('[role="alert"], [data-automation-id="errorMessage"], .error, .field-error, [class*="error-message"], [class*="errorMessage"], [class*="ErrorMessage"]')]
      .filter(A.visible).map(txt).filter(Boolean).map((t) => cut(t, 160)))].slice(0, 12);
    const captcha = [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile')].some(A.visible);
    const text = elements.length < 4 ? cut(txt(document.body), 2500) : "";
    return { url: location.href, title: document.title, headings, step, errors, captcha, elements, buttons, text, filledFields: ctx.filledFields };
  }

  function fillText(rec, text, secret) {
    const el = rec.el;
    if (rec.kind === "rich_text") {
      el.focus(); el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return { ok: true };
    }
    A.setNative(el, text); A.blur(el);
    const v = el.value || "";
    if (v === text) return { ok: true };
    if (!v) return { ok: false, error: "Value did not stick." };
    return secret ? { ok: true } : { ok: true, note: "The page reformatted or truncated the value.", value: cut(v, 200) };
  }

  async function pick(rec, value) {
    const el = rec.el;
    switch (rec.kind) {
      case "select": return A.nativeSelect(el, value);
      case "react_select": return A.reactSelectPick(el, value);
      case "listbox": return A.workdayPick(el, value);
      case "radio_group": return A.radioPick(rec.els, rec.options, value);
      case "combobox": {
        let r = await A.ariaComboPick(el, value);
        if (!r.ok && el.getAttribute("data-uxi-widget-type")) {
          // Workday search inputs search on Enter (synthetic keys never trigger native form submit)
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
          await A.sleep(900);
          const opts = [...document.querySelectorAll('[data-automation-id="promptOption"], [role="option"]')].filter(A.visible);
          const pk = A.best(opts, value, (o) => o.textContent);
          if (pk) { A.mouseClick(pk); await A.sleep(300); r = { ok: true, chosen: norm(pk.textContent) }; }
          else r = { ok: false, options: opts.map((o) => norm(o.textContent)).slice(0, 40) };
        }
        return r;
      }
      case "checkbox": return A.setChecked(el, /^(y|yes|true|on|checked|agree|i agree)/i.test(String(value)));
      default: return fillText(rec, value);
    }
  }

  function upload(rec, file) {
    let input = rec.el;
    if (!(input.tagName === "INPUT" && input.type === "file")) {
      const zone = input.closest('[data-automation-id^="formField-"], .field, [class*="upload"], div') || document;
      input = zone.querySelector('input[type="file"]');
    }
    if (!input) return { ok: false, error: "No file input found here." };
    const f = A.b64ToFile(file);
    A.setFileInput(input, f);
    return { ok: input.files.length > 0, value: f.name };
  }

  async function act(ref, action, p = {}) {
    let rec = refs.get(ref);
    if (!rec || !rec.el.isConnected) {
      collect(); collectButtons(G.pageContext(document));
      rec = refs.get(ref);
      if (!rec || !rec.el.isConnected) return { ok: false, error: "Element is no longer on the page. Use the latest snapshot." };
    }
    const el = rec.el;
    try {
      try { el.scrollIntoView({ block: "center" }); } catch (e) {}
      let r;
      if (action === "click") {
        const t = G.clickTarget(el) || el;
        const verdict = G.allowClick(G.describe(t), G.pageContext(document));
        if (!verdict.allowed) return { ok: false, blocked: true, error: "BLOCKED: " + verdict.reason };
        G.installClickBlock(document);
        A.mouseClick(t);
        return { ok: true };
      }
      if (action === "fill") r = ["select", "react_select", "listbox", "radio_group", "combobox"].includes(rec.kind) ? await pick(rec, p.text) : fillText(rec, p.text, p.secret);
      else if (action === "select") r = ["text", "textarea", "rich_text", "password"].includes(rec.kind) ? fillText(rec, p.option) : await pick(rec, p.option);
      else if (action === "check") r = rec.kind === "radio_group" ? A.radioPick(rec.els, rec.options, p.checked ? "Yes" : "No") : A.setChecked(el, !!p.checked);
      else if (action === "upload") r = upload(rec, p.file);
      else return { ok: false, error: "Unknown action " + action };
      if (r.ok) (rec.els || [el]).forEach((x) => x.setAttribute("data-is-filled", "1"));
      await A.sleep(150);
      const err = fieldError(el);
      if (err) r.field_error = err;
      return r;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  const FAST = [
    [/given-name|first.?name|firstname|legalname--firstname/, "first_name"],
    [/family-name|last.?name|family.?name|surname|lastname|legalname--lastname/, "last_name"],
    [/^\s*(full ?name|name|your name|legal name)\s*\*?\s*$/, "full_name"],
    [/\bemail\b|e-mail/, "email"],
    [/\btel\b|phone|mobile|telephone/, "phone"],
    [/linkedin/, "linkedin"],
    [/github/, "github"],
    [/portfolio|personal (web)?site|website/, "website"],
  ];
  const SKIP = /refer|emergency|reference|manager|supervisor|recruiter|company|employer|school|parent|guardian|middle|preferred|nick|confirm|search|verif|code|password|extension|country|device|type|other/;

  function fastFill(facts) {
    const done = [];
    for (const rec of (collect(), refs.values())) {
      if (rec.kind !== "text" || rec.el.value) continue;
      const el = rec.el;
      const hint = [rec.label, el.getAttribute("autocomplete"), el.name, el.id, el.getAttribute("data-automation-id")].filter(Boolean).join(" ").toLowerCase();
      if (SKIP.test(hint)) continue;
      const hit = FAST.find(([re]) => re.test(hint) || re.test(rec.label.toLowerCase()));
      if (!hit) continue;
      const key = hit[1];
      const v = key === "full_name" ? [facts.first_name, facts.last_name].filter(Boolean).join(" ") : facts[key];
      if (!v) continue;
      A.setNative(el, v); A.blur(el);
      if (el.value) { el.setAttribute("data-is-filled", "1"); done.push(`${rec.label || key} = ${v}`); }
    }
    return done;
  }

  function highlight() {
    if (!document.getElementById("is-hl-style")) {
      const s = document.createElement("style");
      s.id = "is-hl-style";
      s.textContent = ".is-filled{outline:2px solid #2ea043!important;outline-offset:2px}" +
        ".is-missing{outline:2px dashed #d29922!important;outline-offset:2px}" +
        ".is-final{outline:3px solid #f85149!important;outline-offset:3px;box-shadow:0 0 0 6px rgba(248,81,73,.25)!important}";
      document.head.appendChild(s);
    }
    const box = (el) => el.closest('[data-automation-id^="formField-"], .select-shell, [class*="select__control"]') || el;
    document.querySelectorAll("[data-is-filled]").forEach((el) => box(el).classList.add("is-filled"));
    collect();
    let missing = 0;
    for (const rec of refs.values()) {
      const v = valueOf(rec.el, rec.kind);
      if (rec.required && (v === "" || v === false) && rec.kind !== "radio_group") { box(rec.el).classList.add("is-missing"); missing++; }
      if (rec.kind === "radio_group" && rec.required && !rec.els.some((r) => r.checked || r.getAttribute("aria-checked") === "true")) { box(rec.el).classList.add("is-missing"); missing++; }
    }
    const ctx = G.pageContext(document);
    let final = null;
    for (const el of document.querySelectorAll('button, input[type="submit"], [role="button"]')) {
      if (A.visible(el) && !G.allowClick(G.describe(el), ctx).allowed) { el.classList.add("is-final"); final = final || el; }
    }
    if (final) try { final.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    return { missing, final: !!final };
  }

  window.ISDom = { v: V, snapshot, act, fastFill, highlight };
})();
