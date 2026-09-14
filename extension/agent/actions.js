// Low-level page helpers (MAIN world, so React internals are reachable). Moved from the old
// content.js / workday.js and generalised: native setters, react-select via fiber
// selectOption, Workday listboxes, ARIA comboboxes, radios, files.
(function () {
  if (window.ISActions && window.ISActions.v >= 2) return; // bump with dom.js V when this file changes
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const low = (s) => norm(s).toLowerCase();

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  function setNative(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    el.focus && el.focus();
    desc.set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function blur(el) {
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }
  function mouseClick(el) {
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"])
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    el.click();
  }

  // ---- option matching ----
  const DECLINE = /prefer not|decline|don'?t wish|do not wish|choose not|not to (say|disclose|answer|self)|rather not/i;
  function scoreOption(text, want) {
    const t = low(text).replace(/[^\w\s'+#./-]/g, ""), w = low(want).replace(/[^\w\s'+#./-]/g, "");
    if (!t || !w) return 0;
    if (t === w) return 100;
    if (DECLINE.test(want) && DECLINE.test(text)) return 90;
    if (/^(yes|no)\b/.test(w) && t.startsWith(w.split(/\W/)[0] + "")) return 80 - t.length / 100;
    if (t.startsWith(w) || w.startsWith(t)) return 70 - Math.abs(t.length - w.length) / 10;
    if (t.includes(w) || w.includes(t)) return 55 - Math.abs(t.length - w.length) / 20;
    const tw = new Set(t.split(/\s+/)), ww = w.split(/\s+/).filter((x) => x.length > 2);
    const hit = ww.filter((x) => tw.has(x)).length;
    return ww.length ? (hit / ww.length) * 45 : 0;
  }
  function best(options, want, getText = (o) => o) {
    let top = null, topScore = 0;
    for (const o of options) {
      const s = scoreOption(getText(o), want);
      if (s > topScore) { top = o; topScore = s; }
    }
    return topScore >= 30 ? top : null;
  }

  // ---- React fiber (react-select exposes selectOption in props) ----
  function getFiber(el) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    return k ? el[k] : null;
  }
  function fiberProp(el, name, depth = 30) {
    let f = getFiber(el);
    for (let i = 0; i < depth && f; i++) {
      const p = f.memoizedProps;
      if (p && typeof p[name] !== "undefined") return p[name];
      f = f.return;
    }
    return undefined;
  }

  async function waitFor(fn, timeout = 1500, step = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v && (!Array.isArray(v) || v.length)) return v; await sleep(step); }
    return fn();
  }

  function reactSelectContainer(input) {
    return input.closest('.select-shell, [class*="select__container"], [class*="-container"]') ||
      input.closest('[class*="select__control"]')?.parentElement;
  }
  function isReactSelect(input) {
    return /^react-select/.test(input.id || "") || !!(input.classList && input.classList.contains("select__input")) ||
      !!(input.closest && input.closest('.select-shell, [class*="select__control"], [class*="Select-control"]'));
  }

  async function reactSelectPick(input, value) {
    const c = reactSelectContainer(input) || input.parentElement;
    const control = c.querySelector('[class*="select__control"], [class*="-control"]') || input;
    const selectOption = fiberProp(input, "selectOption");
    mouseClick(control); input.focus(); await sleep(80);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    let opts = await waitFor(() => [...c.querySelectorAll('[class*="select__option"], [class*="-option"], [role="option"]')], 800);
    let pick = best(opts, value, (o) => o.textContent);
    if (!pick) {
      setNative(input, value);
      opts = await waitFor(() => [...c.querySelectorAll('[class*="select__option"], [class*="-option"], [role="option"]')], 2000);
      pick = best(opts, value, (o) => o.textContent) || (opts.length === 1 ? opts[0] : null);
    }
    const available = opts.map((o) => norm(o.textContent)).slice(0, 40);
    if (!pick) { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return { ok: false, options: available }; }
    const data = fiberProp(pick, "data", 3);
    try { if (selectOption && data) selectOption(data); else mouseClick(pick); } catch (e) { mouseClick(pick); }
    await sleep(200);
    const shown = norm((c.querySelector('[class*="single-value"], [class*="multi-value"]') || {}).textContent);
    return { ok: !!shown, chosen: shown || norm(pick.textContent), options: shown ? undefined : available };
  }

  function listboxOptions() {
    return [...document.querySelectorAll('[data-automation-id="promptOption"], [role="option"], [data-automation-id="menuItem"]')].filter(visible);
  }
  // Workday: button[aria-haspopup=listbox] opens a popup; some popups have a search box and
  // nested levels ("How did you hear" -> "Job Board" -> "LinkedIn").
  async function workdayPick(btn, value) {
    mouseClick(btn); await sleep(350);
    const search = document.querySelector('input[data-automation-id="searchBox"], [data-automation-id="promptSearch"] input');
    if (search && visible(search)) { setNative(search, value); await sleep(500); }
    for (let level = 0; level < 3; level++) {
      const opts = await waitFor(listboxOptions, 1500);
      const pick = best(opts, value, (o) => o.textContent);
      if (!pick) {
        const available = opts.map((o) => norm(o.textContent)).slice(0, 40);
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return { ok: false, options: available };
      }
      mouseClick(pick); await sleep(400);
      const still = listboxOptions();
      if (!still.length || still.some((o) => o === pick)) break;
    }
    await sleep(150);
    return { ok: true, chosen: norm(btn.textContent) };
  }

  async function ariaComboPick(el, value) {
    const input = el.tagName === "INPUT" ? el : el.querySelector("input") || el;
    mouseClick(input);
    if (input.tagName === "INPUT") setNative(input, value);
    await sleep(300);
    const ctl = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
    const scope = (ctl && document.getElementById(ctl)) || document;
    const opts = await waitFor(() => [...scope.querySelectorAll('[role="option"], li[id*="option"]')].filter(visible), 2000);
    const pick = best(opts, value, (o) => o.textContent);
    if (!pick) return { ok: false, options: opts.map((o) => norm(o.textContent)).slice(0, 40) };
    mouseClick(pick); await sleep(200);
    return { ok: true, chosen: norm(pick.textContent) };
  }

  function nativeSelect(el, value) {
    const opt = best([...el.options].filter((o) => !o.disabled), value, (o) => o.text || o.value);
    if (!opt) return { ok: false, options: [...el.options].map((o) => norm(o.text)).filter(Boolean).slice(0, 60) };
    setNative(el, opt.value); blur(el);
    return { ok: el.value === opt.value, chosen: norm(opt.text) };
  }

  function radioPick(radios, labels, value) {
    const i = labels.indexOf(best(labels, value));
    if (i < 0) return { ok: false, options: labels };
    const r = radios[i];
    const lab = r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
    if (r.getAttribute("role") === "radio") mouseClick(r); else (lab || r).click();
    if (r.type === "radio" && !r.checked) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
    return { ok: r.type !== "radio" || r.checked, chosen: labels[i] };
  }

  function setChecked(el, on) {
    const cur = el.type === "checkbox" ? el.checked : el.getAttribute("aria-checked") === "true";
    if (cur !== !!on) {
      const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      (el.type === "checkbox" && lab) ? lab.click() : mouseClick(el);
    }
    const now = el.type === "checkbox" ? el.checked : el.getAttribute("aria-checked") === "true";
    if (now !== !!on && el.type === "checkbox") { el.checked = !!on; el.dispatchEvent(new Event("change", { bubbles: true })); }
    return { ok: (el.type === "checkbox" ? el.checked : el.getAttribute("aria-checked") === "true") === !!on };
  }

  function b64ToFile(f) {
    const bin = atob(String(f.b64 || "").split(",").pop());
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], f.name || "resume.pdf", { type: f.type || "application/pdf" });
  }
  function setFileInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files.length > 0;
  }
  function dropFile(zone, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const t of ["dragenter", "dragover", "drop"])
      zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  }

  window.ISActions = { v: 2, sleep, norm, low, visible, setNative, blur, mouseClick, best, scoreOption, getFiber, fiberProp,
    waitFor, isReactSelect, reactSelectPick, workdayPick, ariaComboPick, nativeSelect, radioPick, setChecked,
    b64ToFile, setFileInput, dropFile };
})();
