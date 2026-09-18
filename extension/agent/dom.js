// Page model for the agent (MAIN world, every frame). Needs guard.js + actions.js first.
// snapshot() -> compact list of interactive elements with stable refs; act() runs one action
// with verify-after-set; fastFill() fills obvious contact fields without a model call.
(function () {
  const V = 13; // bump when this file changes, so a reloaded extension replaces the old copy in open tabs
  if (window.ISDom && window.ISDom.v >= V) return;
  const A = window.ISActions, G = window.ISGuard, norm = A.norm;
  const refs = new Map();
  const fps = new Map(); // ref -> fingerprint; outlives refs.clear() so a re-rendered field keeps its ref
  const lastEl = new Map(); // ref -> the node it last pointed at
  let seq = 0;

  // Some ATS platforms (SmartRecruiters oneclick-ui, Oracle JET) render real form fields inside
  // shadow roots on custom elements, invisible to plain document.querySelectorAll. Walk shadow
  // trees too. rootOf() scopes id/for lookups to the same root as the element being labeled,
  // since ids are only unique within one root.
  function deepQueryAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) out.push(...deepQueryAll(selector, el.shadowRoot));
    }
    return out;
  }
  const rootOf = (el) => (el && el.getRootNode ? el.getRootNode() : document);

  const txt = (el) => (el ? norm(el.innerText || el.textContent) : "");
  const cut = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);
  const byIds = (ids, root = document) => ids.split(/\s+/).map((i) => txt(root.getElementById ? root.getElementById(i) : document.getElementById(i))).filter((t) => t && !HINT_RE.test(t)).join(" ");
  function refOf(el) {
    let r = el.getAttribute("data-is-ref");
    if (!r) { r = String(++seq); el.setAttribute("data-is-ref", r); }
    return r;
  }
  // What a field IS, independent of the DOM node: React forms (Ashby after "Autofill from resume",
  // Workday after a section save) re-render and replace every input, which orphaned every ref the
  // model had just been given. act() uses this to find the replacement node under the same ref.
  const fingerprint = (rec) => [rec.kind, rec.el.id || "", rec.el.getAttribute("name") || "", rec.label || ""].join("|");
  const isField = (el) => el.matches("input, select, textarea");
  // "Is there a second question in this box?" — asked while climbing towards a caption. Hidden and
  // disabled controls do not count: a form library parks a shadow <input> beside every widget it
  // draws, and a step that has not been reached yet is not competing for the caption either.
  const OTHER_FIELD_SEL = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select, [role="radio"], [role="checkbox"]';
  const otherFieldIn = (box, scope) => [...box.querySelectorAll(OTHER_FIELD_SEL)]
    .some((f) => f !== scope && !scope.contains(f) && !f.contains(scope) && !f.disabled && A.visible(f));
  // Required-field markers aren't always ASCII "*" — Lever uses U+2731 HEAVY ASTERISK ("✱").
  const REQUIRED_MARK_RE = /[*✱∗⁎]\s*$/;
  // Upload widgets label the <input type=file> with the button text ("Attach", "Choose a file or drop
  // it here"), which tells the model nothing about WHICH file. Look past those to the group label.
  // "File" on its own belongs to this list too. Jobvite gives both of its uploads the same
  // <label for>, reading just "File", and puts the only thing that tells them apart — "Type or paste
  // your Resume here" against "...your Cover Letter here" — one box further out. Two fields called
  // File is a coin toss over which one the résumé goes in.
  const GENERIC_LABEL_RE = /^(attach|upload|browse|(choose|select|add)\s+(a\s+)?files?|drop|drag|click to (upload|attach|browse)|enter manually|or|files?|attachments?|documents?)\b[^?]{0,40}$/i;
  const HINT_RE = /^(no file (selected|chosen)|accepted file types|allowed (file )?types|max(imum)? (file )?size|file size|supported formats|total \d+ files? (selected|attached|uploaded)|drag (and|&) drop|drop (your )?files? here)\b/i;
  const useful = (t) => !!t && !HINT_RE.test(t) && !(GENERIC_LABEL_RE.test(t) && !/r[eé]sum[eé]|\bcv\b|cover|transcript|letter|portfolio|writing|photo|certificat/i.test(t));

  function questionLabel(el, scope = el) {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = byIds(lb, rootOf(el)); if (useful(t)) return t; }
    if (isField(el)) {
      if (el.id) { const l = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`); if (useful(txt(l))) return txt(l); }
      const w = el.closest("label");
      // Rippling puts aria-labelledby on the <label> wrapping a hidden file input, not on the input; its
      // text is the upload chip ("test-resume.pdf remove"), so the reference wins.
      if (w && w.getAttribute("aria-labelledby")) { const t = byIds(w.getAttribute("aria-labelledby"), rootOf(w)); if (useful(t)) return t; }
      if (useful(txt(w))) return txt(w);
    }
    const fs = el.closest("fieldset");
    if (fs) { const lg = fs.querySelector("legend"); if (useful(txt(lg))) return txt(lg); }
    const wd = el.closest('[data-automation-id^="formField-"]');
    if (wd) { const l = wd.querySelector("label, legend"); if (useful(txt(l))) return txt(l); }
    // A developer slug ("file-input", "text_field_3") is not a question; keep looking for the visible caption.
    const aria = el.getAttribute("aria-label");
    const slug = !!aria && /^[a-z0-9]+([-_][a-z0-9]+)+$/.test(aria.trim());
    if (useful(aria) && !slug) return norm(aria);
    // Greenhouse wraps an upload in role=group aria-labelledby="upload-label-resume"; walking up
    // blindly hit the "Accepted file types: pdf, doc…" hint first, so the model never saw "Resume/CV".
    const grp = el.parentElement && el.parentElement.closest('[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]');
    if (grp) { const t = byIds(grp.getAttribute("aria-labelledby"), rootOf(grp)); if (useful(t)) return t; }
    let p = scope.parentElement;
    // Upload widgets nest the input deeper under their "Resume*" caption (BambooHR: 6 levels).
    const depth = el.type === "file" ? 7 : 5;
    for (let i = 0; i < depth && p && p !== document.body; i++, p = p.parentElement) {
      // Stop at the first box that holds a second field. A caption in there is over both of them, so
      // it names neither: JazzHR draws the street, city, state and postal boxes in one row under a
      // single "Address", and the walk handed "Address" back for all four. Three fields with the
      // same label is a guess for the model and nothing at all for the rule-based contact fill,
      // which matches on the label — while the boxes' own placeholders say City, State/Province and
      // Postal. One field in the box is what makes a caption a label.
      if (otherFieldIn(p, scope)) break;
      for (const l of p.querySelectorAll('label, legend, [class*="label"], [class*="Label"], [class*="question"], h3, h4, p')) {
        if (scope.contains(l) || l.contains(scope)) continue;
        const t = txt(l);
        if (useful(t) && t.length < 400) return t;
      }
    }
    return norm(el.getAttribute("placeholder") || aria || el.getAttribute("name") || el.id || "");
  }

  // jQuery select2 / chosen / selectize / bootstrap-select / Choices.js hide the real <select> and draw
  // their own box beside it (Lever's school picker). The hidden <select> is still the source of truth
  // and these libraries all listen for its change event, so we drive the select and ignore the drawing.
  const PROXY_RE = /(^|\s)(select2|select2-container|chosen-container|selectize-control|bootstrap-select|choices|ss-main|ts-wrapper)(\s|$|-)/;
  // The library's own search box. With options already in the <select> it is a duplicate of it; with
  // options loaded from the server as you type, it is the only way to answer.
  const realOptions = (sel) => [...sel.options].filter((o) => o.value && norm(o.text)).length;
  function libSelectOf(input) {
    const box = input.closest(A.LIB_BOX_SEL);
    if (!box) return null;
    const prev = box.previousElementSibling;
    return box.querySelector("select") || (prev && prev.tagName === "SELECT" ? prev : null);
  }
  function selectProxy(el) {
    if (el.tagName !== "SELECT") return null;
    const cands = [el.nextElementSibling, el.parentElement, el.parentElement && el.parentElement.parentElement];
    return cands.find((c) => c && typeof c.className === "string" && PROXY_RE.test(c.className) && A.visible(c)) || null;
  }
  // Inputs no human can reach: react-select's "requiredInput" validation shadow (aria-hidden, tabindex -1)
  // was listed as a second copy of every Greenhouse dropdown, labeled with the NEXT question's text.
  const unreachable = (el) => el.getAttribute("aria-hidden") === "true" && el.getAttribute("tabindex") === "-1";
  // Parked off the page where nobody can see it. Breezy's spam trap is <input name="hp_7f2b"> at
  // left:-9999px inside a zero-height box: display, visibility and opacity are all normal, which is
  // the whole point, so every "is it visible" test passes it and the model was handed an unlabeled
  // required-looking text field. Filling one gets the application thrown away without a word.
  // Measure where the box actually lands on the page instead: right edge at document x -9749 is not
  // somewhere a student could ever type. A screen-reader-only field would be caught too, but an
  // unfilled one costs a question; a filled honeypot costs the whole application.
  const offDocument = (el) => {
    const r = el.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0);
  };
  // A video player's seek/volume sliders are not questions (and their values made a job page look filled).
  const mediaControl = (el) => {
    if (el.type !== "range") return false;
    for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) if (p.querySelector("video, audio")) return true;
    return false;
  };

  function optLabel(r) {
    if (r.id) { const l = rootOf(r).querySelector(`label[for="${CSS.escape(r.id)}"]`); if (txt(l)) return txt(l); }
    const w = r.closest("label"); if (txt(w)) return txt(w);
    if (r.getAttribute("aria-label")) return norm(r.getAttribute("aria-label"));
    const lb = r.getAttribute("aria-labelledby"); if (lb && byIds(lb, rootOf(r))) return byIds(lb, rootOf(r));
    if (txt(r.nextElementSibling)) return txt(r.nextElementSibling);
    return norm(r.value || txt(r));
  }

  function fieldError(el) {
    if (el.getAttribute && el.getAttribute("aria-invalid") !== "true") return "";
    const d = el.getAttribute("aria-describedby");
    return d ? cut(byIds(d), 160) : "invalid";
  }

  function labelVisible(el) {
    const l = (el.id && rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label");
    return l && A.visible(l);
  }

  // BambooHR's fab-SelectToggle is a <button aria-haspopup="true"> showing "–Select–" that opens a
  // role=menu of menuitems; the real <select> beside it stays empty until the menu is opened. Without
  // this it was offered as a plain button and State / Highest Education were never answered.
  const PLACEHOLDER_RE = /^[-–—\.\s]*(select( one)?|choose( one)?|please select)\b[-–—\.\s]*$/i;
  // Menus of actions ("Apply now ▾" on SuccessFactors, Jobvite "Add Resume") are buttons, not questions,
  // even when styled as a .dropdown-toggle.
  const ACTION_TEXT_RE = /^(apply|add|upload|attach|start|sign|log ?in|create|share|save|more|menu|options|actions|download|print|email|send|view|open)\b/i;
  // Jobvite's "Add Resume: Select ▾" opens a pop-up (upload / Dropbox / paste) whose file input lives
  // elsewhere in the page. It is a file field, not a list to pick from.
  const ATTACH_RE = /r[ée]sum[ée]|\bcv\b|cover letter|transcript|attachment|portfolio|writing sample/i;
  function attachMenu(el) {
    if (el.tagName !== "BUTTON" || !/^(true|menu|dialog)$/.test(el.getAttribute("aria-haspopup") || "")) return false;
    const lb = el.getAttribute("aria-labelledby");
    const cap = (lb && byIds(lb, rootOf(el))) || el.getAttribute("aria-label") || el.getAttribute("attachment-label") || "";
    return ATTACH_RE.test(cap) && !ACTION_TEXT_RE.test(cap.replace(/^(add|upload|attach)\s+/i, "x "));
  }
  function selectLikeButton(el) {
    if (el.getAttribute("aria-haspopup") === "listbox") return true;
    if (ACTION_TEXT_RE.test(txt(el) || el.getAttribute("aria-label") || "")) return false;
    return /(^|[\s_-])(select|dropdown)/i.test(String(el.className || "")) || PLACEHOLDER_RE.test(txt(el));
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
      case "listbox": { const t = txt(el); return /^select one$|^select\b/i.test(t) || PLACEHOLDER_RE.test(t) ? "" : t; }
      case "checkbox": return el.type === "checkbox" ? el.checked : el.getAttribute("aria-checked") === "true";
      case "file": {
        const names = el.files ? [...el.files].map((f) => f.name) : [];
        if (names.length) return names.join(", ");
        // Many widgets clear the input and show the file as a chip instead (Rippling: "test-resume...pdf remove").
        const zone = el.closest('[data-automation-id^="formField-"], .field, [data-testid="field"], label, [class*="upload"]');
        const found = zone ? txt(zone).match(/[\w\-()]*\w[\w\-.()]*\.(pdf|docx?|txt|rtf)\b/gi) || [] : [];
        return found.find((n) => !n.includes("..")) || found[0] || "";
      }
      case "password": return el.value ? "(filled)" : "";
      case "rich_text": return cut(txt(el), 300);
      default: return cut(el.value || "", 400);
    }
  }

  function collect() {
    refs.clear();
    const elements = [], seen = new Set(), claimed = new Set();
    const nodes = deepQueryAll('input, textarea, select, button[aria-haspopup="listbox"], button[aria-haspopup="true"], button[aria-haspopup="menu"], [role="radio"], [role="checkbox"], [contenteditable="true"]');
    for (const el of nodes) {
      if (el.closest("[data-is-overlay]")) continue;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && ["hidden", "submit", "button", "image", "reset", "search"].includes(type)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const attach = el.tagName === "BUTTON" && attachMenu(el);
      if (el.tagName === "BUTTON" && !attach && el.getAttribute("aria-haspopup") !== "listbox" && !selectLikeButton(el)) continue;
      if (G.notApplication && G.notApplication(el)) continue;
      let kind = attach ? "file" : kindOf(el);
      if (kind === "text" && el.tagName === "INPUT" && A.LIB_BOX_SEL && el.closest(A.LIB_BOX_SEL)) {
        const sel = libSelectOf(el);
        if (sel && realOptions(sel)) continue; // answered through the <select> itself
        kind = "combobox";
      }
      // Anti-spam honeypots ("Please leave this field blank", BambooHR) sit in an aria-hidden box;
      // filling one gets the application silently discarded.
      //
      // Workday's is not hidden by any of those means and is not named after a honeypot either. Its
      // sign-in page carries an input called "website", data-automation-id="beecatcher", drawn
      // display:block and visibility:visible at full opacity, in the middle of the form - one pixel
      // wide and none tall. Nothing about it reads as hidden except its size, and a box with no room
      // for a character in it is a box no student could ever have typed into. So the test is the size
      // itself rather than the name: names are a list that only ever grows, and the next site's
      // honeypot will have a different one.
      const box = el.getBoundingClientRect();
      const noRoom = box.width < 4 || box.height < 4;
      if ((kind === "text" || kind === "textarea") && (el.closest('[aria-hidden="true"]') || offDocument(el) || noRoom || /honey.?pot|^hp[_-]|beecatcher/i.test([el.name, el.id, el.className, el.getAttribute("data-automation-id") || ""].join(" ")))) continue;
      const proxy = kind === "select" && selectProxy(el);
      if (proxy && !realOptions(el) && [...proxy.querySelectorAll("input")].some((i) => i.type !== "hidden" && A.visible(i))) continue;
      if (kind === "file") {
        // Real dropzones hide the <input> itself, but a field on a hidden step has a hidden parent too.
        if (!A.visible(el) && !labelVisible(el) && !A.visible(el.parentElement)) continue;
      } else if (proxy) {
        // drawn by a select library; visible through its proxy box
      } else if (!A.visible(el) && !((kind === "radio_group" || kind === "checkbox") && labelVisible(el))) continue;
      if (kind !== "file" && !proxy && (unreachable(el) || mediaControl(el))) continue;
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
        let els = name ? [...rootOf(el).querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)]
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
        rec.required = els.some((r) => r.required || r.getAttribute("aria-required") === "true") || REQUIRED_MARK_RE.test(rec.label);
      } else {
        rec.el = el;
        rec.label = questionLabel(el);
        // A menu button's aria-label repeats its current value ("Highest Education Obtained –Select–").
        if (kind === "listbox") { const t = txt(el); if (t && rec.label.length > t.length && rec.label.endsWith(t)) rec.label = norm(rec.label.slice(0, -t.length)); }
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
        // A dial-code picker beside the phone box is often captioned only "Search" (Rippling); say what it is.
        if (/^(search|select|choose|textbox|type to search|search\.\.\.)?$/i.test(rec.label.trim()) && /^\+\d{1,4}\b/.test(String(rec.value || ""))) rec.label = "Phone country code";
        rec.required = el.required || el.getAttribute("aria-required") === "true" || REQUIRED_MARK_RE.test(rec.label) || /\(required\)/i.test(rec.label);
        if (kind === "text") rec.type = type || "text";
        // Split dates share one caption ("End date" -> MM, YYYY); the placeholder is what tells them apart.
        const ph = norm(el.getAttribute("placeholder") || "");
        if ((kind === "text" || kind === "combobox") && ph && !rec.label.toLowerCase().includes(ph.toLowerCase())) rec.placeholder = cut(ph, 80);
        if (el.maxLength > 0 && el.maxLength < 100000) rec.maxlength = el.maxLength;
      }
      rec.label = cut(rec.label || "", 300);
      rec.error = fieldError(rec.el);
      rec.fp = fingerprint(rec);
      if (!rec.el.hasAttribute("data-is-ref")) {
        // A replacement node for a field that was re-rendered away inherits the old ref.
        for (const [r, f] of fps) {
          if (f === rec.fp && !claimed.has(r) && !(lastEl.get(r) && lastEl.get(r).isConnected)) { rec.el.setAttribute("data-is-ref", r); break; }
        }
      }
      const ref = refOf(rec.el);
      claimed.add(ref);
      if (!fps.has(ref)) fps.set(ref, rec.fp);
      lastEl.set(ref, rec.el);
      refs.set(ref, rec);
      elements.push({ ref, kind, type: rec.type, label: rec.label, question: rec.question, required: !!rec.required,
        value: rec.value, options: rec.options, searchable: rec.searchable || undefined, placeholder: rec.placeholder, maxlength: rec.maxlength, error: rec.error || undefined });
    }
    return elements;
  }

  const LINK_RE = /apply|next|continue|sign ?(in|up)|create|account|log ?in|register|start|begin|submit|review|upload|autofill|manual|add|save|back|resume|proceed|interested|forgot/i;
  function collectButtons(ctx) {
    const out = [], seenText = new Set();
    for (const el of deepQueryAll('button:not([aria-haspopup="listbox"]), input[type="submit"], input[type="button"], [role="button"], a[href]')) {
      if (el.tagName === "BUTTON" && el.hasAttribute("aria-haspopup") && selectLikeButton(el) && el.closest("form")) continue;
      if (out.length >= 50) break;
      if (el.closest("[data-is-overlay]") || !A.visible(el) || el.disabled) continue;
      if (el.closest('[role="listbox"], [role="menu"]')) continue;
      const text = cut(norm(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || ""), 80);
      if (!text) continue;
      if (G.consentGiveaway(el, text)) continue;
      if (el.tagName === "A" && !LINK_RE.test(text)) continue;
      const key = text + "|" + el.tagName;
      if (seenText.has(key) && el.tagName === "A") continue;
      seenText.add(key);
      const ref = refOf(el);
      refs.set(ref, { kind: "button", el, label: text });
      const b = { ref, text };
      // An "Apply now" dropdown toggle (SuccessFactors) reads the same as its first item; clicking it
      // again just closes the menu, so say when it is already open.
      if (el.getAttribute("aria-expanded") === "true" && (el.hasAttribute("aria-haspopup") || /dropdown-toggle/.test(String(el.className)))) b.menu = "open";
      if (!G.allowClick(G.describe(el), ctx).allowed) b.blocked = true;
      out.push(b);
    }
    return out;
  }

  // A robot check the human has to solve. Invisible/badge CAPTCHAs (reCAPTCHA v3, Lever's invisible
  // hCaptcha with a 0px-tall box) sit on nearly every Greenhouse and Lever form and only matter at
  // submit, so they don't count: reporting them made the agent pause on page one.
  const CAPTCHA_SEL = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], ' +
    'iframe[src*="captcha-delivery.com"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], #px-captcha, #challenge-form, #cf-challenge-running, .g-recaptcha, .h-captcha, .cf-turnstile, [id^="awswaf"]';
  function captchaShown() {
    return deepQueryAll(CAPTCHA_SEL).some((el) => {
      if (!A.visible(el) || el.closest(".grecaptcha-badge") || /size=invisible|checkbox-invisible/.test(el.src || "")) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 30) return false;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (+getComputedStyle(n).opacity === 0) return false;
      return true;
    });
  }
  // Frames that belong to a CAPTCHA provider: their "Verify" / "Refresh challenge" buttons are not ours to press.
  const CAPTCHA_FRAME = /(^|\.)(hcaptcha\.com|recaptcha\.net|captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com)$|^challenges\.cloudflare\.com$/.test(location.hostname) ||
    (/(^|\.)google\.com$/.test(location.hostname) && /^\/recaptcha\//.test(location.pathname));
  // Chrome stops requestAnimationFrame in a tab the student has switched away from, and every
  // renderer that paints inside a frame stops with it. On Pinpoint (Rails/Turbo) the Apply link
  // changed the URL and then drew nothing at all: the old job page stayed on screen until the tab
  // came back to the front, so the agent would have clicked Apply against a page that could not
  // move, once per turn, until it ran out of turns. A heartbeat measures the stall itself rather
  // than inferring it, and pairing it with visibilityState keeps a merely slow page out.
  let lastFrame = 0;
  const beat = () => { lastFrame = Date.now(); requestAnimationFrame(beat); };
  requestAnimationFrame(beat);
  const frozen = () => document.visibilityState === "hidden" && (!lastFrame || Date.now() - lastFrame > 1500);

  // Nothing to fill yet because the page is still drawing (Workday and Oracle load the job after the tab says complete).
  function busy() {
    if (deepQueryAll('[aria-busy="true"], [data-automation-id*="loading" i], [class*="spinner" i], [class*="loading" i]:not(body):not(html)').some(A.visible)) return true;
    const t = txt(document.body);
    return t.length < 400 && /\bloading\b/i.test(t);
  }

  // What the page looks like from outside, in one short string, so a click that did something can be
  // told from one that did nothing at all. Qorvo's SuccessFactors site draws its "Apply now" as a
  // dropdown whose menu is bound by a script that arrives after the page is otherwise ready: click it
  // a moment too early and there is no error, no navigation and no menu — just the same page again.
  // A snapshot alone does not say that, because nothing in it announces that it is the old one.
  function mark() {
    const n = (sel) => deepQueryAll(sel).filter(A.visible).length;
    return cut([location.href, n("input, textarea, select"), n('button, a, [role="button"]'),
      deepQueryAll('h1, h2, [role="heading"]').filter(A.visible).map(txt).join("|")].join("~"), 400);
  }

  function snapshot() {
    if (CAPTCHA_FRAME) return { url: location.href, title: document.title, headings: [], step: "", errors: [], captcha: false, elements: [], buttons: [], text: "", filledFields: 0, captchaFrame: true };
    G.installClickBlock(document);
    const elements = collect();
    const ctx = G.pageContext(document);
    const buttons = collectButtons(ctx);
    const headings = deepQueryAll('h1, h2, [data-automation-id="pageHeaderTitleText"], [role="heading"]')
      .filter(A.visible).map(txt).filter(Boolean).slice(0, 6).map((t) => cut(t, 120));
    const step = cut(txt(deepQueryAll('[aria-current="step"], [data-automation-id="progressBarActiveStep"], [class*="step"][class*="active"]').find(A.visible)), 120);
    const errors = [...new Set(deepQueryAll('[role="alert"], [data-automation-id="errorMessage"], .error, .field-error, [class*="error-message"], [class*="errorMessage"], [class*="ErrorMessage"]')
      .filter(A.visible).map(txt).filter(Boolean).map((t) => cut(t, 160)))].slice(0, 12);
    const captcha = captchaShown();
    const text = elements.length < 4 ? cut(txt(document.body), 2500) : "";
    return { url: location.href, title: document.title, headings, step, errors, captcha, elements, buttons, text, filledFields: ctx.filledFields, busy: !elements.length && busy(), frozen: frozen() };
  }

  async function fillText(rec, text, secret) {
    const el = rec.el;
    if (rec.kind === "rich_text") {
      el.focus(); el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return { ok: true };
    }
    A.setNative(el, text); A.blur(el);
    let v = el.value || "";
    if (v === text) return { ok: true };
    // A plain box that wipes itself on blur is a type-ahead with no ARIA (Lever "Current location"):
    // it only keeps a value picked from its suggestion list.
    if (!v && !secret && text && el.tagName === "INPUT") {
      const t = await A.typeahead(el, text);
      if (t.ok || (t.options && t.options.length)) return t;
      v = el.value || "";
    }
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
        if (A.LIB_BOX_SEL && el.closest(A.LIB_BOX_SEL)) return A.searchSelectPick(el, value);
        let r = await A.ariaComboPick(el, value);
        if (!r.ok && el.getAttribute("data-uxi-widget-type")) {
          // Workday search inputs search on Enter (synthetic keys never trigger native form submit)
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
          await A.sleep(900);
          const opts = deepQueryAll('[data-automation-id="promptOption"], [role="option"]').filter(A.visible);
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

  async function upload(rec, file) {
    let input = rec.el;
    if (input.tagName === "BUTTON") {
      // Open the attachment pop-up and use the file input that just became reachable.
      const shown = () => deepQueryAll('input[type="file"]').filter((i) => A.visible(i) || A.visible(i.parentElement));
      const before = new Set(shown());
      A.mouseClick(input);
      const fresh = await A.waitFor(() => shown().filter((i) => !before.has(i)), 2000);
      input = fresh[0] || null;
      if (!input) return { ok: false, error: "The attachment menu did not offer a file upload." };
      const f = A.b64ToFile(file);
      A.setFileInput(input, f);
      await A.sleep(300);
      if (rec.el.isConnected && rec.el.getAttribute("aria-expanded") === "true") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return { ok: input.files.length > 0, value: f.name };
    }
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
      const fp = fps.get(ref);
      if ((!rec || !rec.el.isConnected) && fp) {
        const same = [...new Map([...refs.values()].filter((x) => x.fp === fp && x.el.isConnected).map((x) => [x.el, x])).values()];
        if (same.length === 1) { rec = same[0]; refs.set(ref, rec); }
      }
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
      if (action === "fill") r = ["select", "react_select", "listbox", "radio_group", "combobox"].includes(rec.kind) ? await pick(rec, p.text) : await fillText(rec, p.text, p.secret);
      else if (action === "select") r = ["text", "textarea", "rich_text", "password"].includes(rec.kind) ? await fillText(rec, p.option) : await pick(rec, p.option);
      else if (action === "check") r = rec.kind === "radio_group" ? A.radioPick(rec.els, rec.options, p.checked ? "Yes" : "No") : A.setChecked(el, !!p.checked);
      else if (action === "upload") r = await upload(rec, p.file);
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
    [/^\s*(full ?name|name|your name|legal name)\s*[*✱∗⁎]?\s*$/, "full_name"],
    [/\bemail\b|e-mail/, "email"],
    [/\btel\b|phone|mobile|telephone/, "phone"],
    [/linkedin/, "linkedin"],
    [/github/, "github"],
    [/portfolio|personal (web)?site|website/, "website"],
  ];
  const SKIP = /refer|emergency|reference|manager|supervisor|recruiter|company|employer|school|parent|guardian|middle|preferred|nick|confirm|search|verif|code|password|extension|country|device|type|other/;


  // The one file field this is safe to fill without asking the model: exactly one empty box on the
  // page says resume, and nothing else does.
  function loneResumeField() {
    let hit = null;
    for (const rec of refs.values()) {
      if (rec.kind !== "file") continue;
      const hint = [rec.label, rec.el.name, rec.el.id, rec.el.getAttribute("data-automation-id")].filter(Boolean).join(" ");
      if (!G.isResumeBox(hint)) continue;
      if (valueOf(rec.el, "file")) return null;   // already attached: leave it alone
      if (hit) return null;                        // two resume boxes is a question, not a rule
      hit = rec;
    }
    return hit;
  }

  // file: {name, type, b64} or null. Returns the human-readable list of what it filled.
  async function fastFill(facts, file) {
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
    const slot = file && file.b64 ? loneResumeField() : null;
    if (slot) {
      const r = await upload(slot, file);
      if (r.ok) { slot.el.setAttribute("data-is-filled", "1"); done.push(`${slot.label || "Resume"} = ${file.name}`); }
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
    const box = (el) => selectProxy(el) || el.closest('[data-automation-id^="formField-"], .select-shell, [class*="select__control"]') || el;
    deepQueryAll("[data-is-filled]").forEach((el) => box(el).classList.add("is-filled"));
    collect();
    let missing = 0;
    for (const rec of refs.values()) {
      const v = valueOf(rec.el, rec.kind);
      if (rec.required && (v === "" || v === false) && rec.kind !== "radio_group") { box(rec.el).classList.add("is-missing"); missing++; }
      if (rec.kind === "radio_group" && rec.required && !rec.els.some((r) => r.checked || r.getAttribute("aria-checked") === "true")) { box(rec.el).classList.add("is-missing"); missing++; }
    }
    const ctx = G.pageContext(document);
    let final = null;
    for (const el of deepQueryAll('button, input[type="submit"], [role="button"]')) {
      if (A.visible(el) && !G.allowClick(G.describe(el), ctx).allowed) { el.classList.add("is-final"); final = final || el; }
    }
    if (final) try { final.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    return { missing, final: !!final };
  }

  window.ISDom = { v: V, snapshot, act, fastFill, highlight, mark };
})();
