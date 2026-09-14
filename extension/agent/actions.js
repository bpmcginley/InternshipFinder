// Low-level page helpers (MAIN world, so React internals are reachable). Moved from the old
// content.js / workday.js and generalised: native setters, react-select via fiber
// selectOption, Workday listboxes, ARIA comboboxes, radios, files.
(function () {
  if (window.ISActions && window.ISActions.v >= 3) return; // bump with dom.js V when this file changes
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
  const US = "AL Alabama,AK Alaska,AZ Arizona,AR Arkansas,CA California,CO Colorado,CT Connecticut,DE Delaware,DC District of Columbia,FL Florida,GA Georgia,HI Hawaii,ID Idaho,IL Illinois,IN Indiana,IA Iowa,KS Kansas,KY Kentucky,LA Louisiana,ME Maine,MD Maryland,MA Massachusetts,MI Michigan,MN Minnesota,MS Mississippi,MO Missouri,MT Montana,NE Nebraska,NV Nevada,NH New Hampshire,NJ New Jersey,NM New Mexico,NY New York,NC North Carolina,ND North Dakota,OH Ohio,OK Oklahoma,OR Oregon,PA Pennsylvania,RI Rhode Island,SC South Carolina,SD South Dakota,TN Tennessee,TX Texas,UT Utah,VT Vermont,VA Virginia,WA Washington,WV West Virginia,WI Wisconsin,WY Wyoming";
  const STATE = Object.fromEntries(US.split(",").map((s) => [s.slice(0, 2), s.slice(3)]));
  // "Amherst, MA" -> "amherst massachusetts"; "UMass - Amherst" -> "umass amherst"
  const clean = (s) => low(String(s || "").replace(/,\s*([A-Z]{2})\b/g, (m, ab) => (STATE[ab] ? " " + STATE[ab] : m)))
    .replace(/\s[-–—|]\s|[,;:()]/g, " ").replace(/[^\w\s'+#./-]/g, "").replace(/\s+/g, " ").trim();
  // "3.6" vs "3.5-3.9" / "below 3.0" / "4.0+": true/false when the option is a numeric bucket, else null
  function numberInRange(t, w) {
    const m = /^\$?(\d+(?:\.\d+)?)[a-z%]*$/.exec(w.replace(/[\s,]/g, ""));
    if (!m) return null;
    const n = parseFloat(m[1]), num = "\\$?(\\d+(?:\\.\\d+)?)";
    let r = new RegExp(`^${num}\\s*(?:-|to|–)\\s*${num}\\b`).exec(t);
    if (r) return n >= parseFloat(r[1]) && n <= parseFloat(r[2]);
    r = new RegExp(`^(?:below|under|less than)\\s+${num}\\b`).exec(t);
    if (r) return n < parseFloat(r[1]);
    r = new RegExp(`^(?:above|over|more than|at least)\\s+${num}\\b|^${num}\\s*(?:\\+|or (?:more|higher|above))`).exec(t);
    if (r) return n >= parseFloat(r[1] ?? r[2]);
    return null;
  }
  function scoreOption(text, want) {
    const t = clean(text), w = clean(want);
    if (!t || !w) return 0;
    if (t === w) return 100;
    if (DECLINE.test(want) && DECLINE.test(text)) return 90;
    const inRange = numberInRange(t, w);
    if (inRange !== null) return inRange ? 85 : 0;
    if (/^(yes|no)\b/.test(w) && t.startsWith(w.split(/\W/)[0] + "")) return 80 - t.length / 100;
    if (t.startsWith(w) || w.startsWith(t)) return 70 - Math.abs(t.length - w.length) / 10;
    if (t.includes(w) || w.includes(t)) return 55 - Math.abs(t.length - w.length) / 20;
    const tw = new Set(t.split(/\s+/)), ww = w.split(/\s+/).filter((x) => x.length > 2);
    const hit = ww.filter((x) => tw.has(x)).length;
    if (!ww.length || !hit) return 0;
    return (hit / ww.length) * 45 + (t.startsWith(ww[0]) ? 3 : 0) - Math.max(0, tw.size - hit) / 50;
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

  // ---- react-select (new Greenhouse boards, Ashby, many custom forms) ----
  // Synthetic mouse/key events don't open its menu, so drive it through its own props instead:
  // selectProps.options + selectOption for fixed lists; loadOptions (async-paginate, e.g. School)
  // or onInputChange (async search, e.g. Location) for type-ahead lists.
  function reactSelectContainer(input) {
    for (let p = input.parentElement; p && p !== document.body; p = p.parentElement) {
      const cls = typeof p.className === "string" ? p.className : "";
      if (/(^|\s)select-shell(\s|$)|select__container/.test(cls)) return p;
      // skip react-select's inner "…__input-container" / "…__value-container" wrappers
      if (/-container(\s|$)/.test(cls) && !/input-container|value-container|indicators?-container/.test(cls) &&
        p.querySelector('[class*="select__control"], [class*="-control"]')) return p;
    }
    const ctl = input.closest('[class*="select__control"], [class*="-control"]');
    return ctl ? ctl.parentElement : null;
  }
  function isReactSelect(input) {
    return /^react-select/.test(input.id || "") || !!(input.classList && input.classList.contains("select__input")) ||
      !!(input.closest && input.closest('.select-shell, [class*="select__control"], [class*="Select-control"]'));
  }
  function rsProps(input) {
    const sp = fiberProp(input, "selectProps", 40), so = fiberProp(input, "selectOption", 40);
    return sp && typeof so === "function" ? { sp, so } : null;
  }
  const rsFlat = (opts) => (Array.isArray(opts) ? opts : []).flatMap((o) => (o && Array.isArray(o.options) ? o.options : [o])).filter(Boolean);
  function rsLabel(sp, o) {
    try { const l = sp.getOptionLabel ? sp.getOptionLabel(o) : o.label; if (typeof l === "string" || typeof l === "number") return norm(l); } catch (e) {}
    return norm(o.label ?? o.name ?? o.value ?? "");
  }
  const rsSearchable = (sp) => typeof sp.loadOptions === "function" || !rsFlat(sp.options).length;
  function reactSelectOptions(input) {
    const h = rsProps(input);
    if (!h) return { options: [], searchable: false };
    return { options: rsFlat(h.sp.options).map((o) => rsLabel(h.sp, o)).filter(Boolean), searchable: rsSearchable(h.sp) };
  }
  function reactSelectValue(input) {
    const c = reactSelectContainer(input);
    if (c) {
      const multi = [...c.querySelectorAll('[class*="multi-value__label"], [class*="multiValue"] > div:first-child')].map((x) => norm(x.textContent)).filter(Boolean);
      if (multi.length) return multi.join(", ");
      const single = c.querySelector('[class*="single-value"], [class*="singleValue"]');
      if (single && norm(single.textContent)) return norm(single.textContent);
    }
    const h = rsProps(input), v = h && h.sp.value;
    return h ? rsFlat(Array.isArray(v) ? v : v ? [v] : []).map((o) => rsLabel(h.sp, o)).filter(Boolean).join(", ") : "";
  }
  // Search boxes often want a prefix: "University of Massachusetts Amherst" finds nothing,
  // "University of Massachusetts" finds "University of Massachusetts - Amherst".
  function searchTerms(value) {
    const cleaned = norm(String(value).replace(/\s[-–—|]\s/g, " ").replace(/[^\w\s'&.-]/g, " "));
    const words = cleaned.split(" ").filter(Boolean), out = [norm(value), cleaned];
    for (let n = words.length - 1; n >= 1; n--) out.push(words.slice(0, n).join(" "));
    words.filter((w) => w.length >= 4 && !/^(university|college|institute|school|state)$/i.test(w))
      .sort((a, b) => b.length - a.length).forEach((w) => out.push(w));
    return [...new Set(out.filter((q) => q.length >= 2))].slice(0, 7);
  }
  async function rsSearch(input, h, q) {
    if (typeof h.sp.loadOptions === "function") {
      try {
        const r = await Promise.race([Promise.resolve(h.sp.loadOptions(q, [], h.sp.additional)), sleep(6000).then(() => null)]);
        return rsFlat(Array.isArray(r) ? r : r && r.options);
      } catch (e) { return []; }
    }
    if (typeof h.sp.onInputChange !== "function") return [];
    const before = (fiberProp(input, "selectProps", 40) || h.sp).options;
    try { h.sp.onInputChange(q, { action: "input-change", prevInputValue: "" }); } catch (e) { return []; }
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      await sleep(250);
      const sp = fiberProp(input, "selectProps", 40);
      if (sp && sp.options !== before && !sp.isLoading && rsFlat(sp.options).length) return rsFlat(sp.options);
    }
    return rsFlat((fiberProp(input, "selectProps", 40) || {}).options);
  }

  async function reactSelectPick(input, value) {
    const h = rsProps(input);
    if (!h) return reactSelectDomPick(input, value);
    let pick = null, score = 0;
    const seen = [];
    const consider = (list) => {
      for (const o of list) {
        const l = rsLabel(h.sp, o), s = scoreOption(l, value);
        seen.push(l);
        if (s > score) { score = s; pick = o; }
      }
    };
    const searchable = rsSearchable(h.sp);
    if (!searchable) consider(rsFlat(h.sp.options));
    else for (const q of searchTerms(value)) { consider(await rsSearch(input, h, q)); if (score >= 60) break; }
    const options = [...new Set(seen)].slice(0, 40);
    if (!pick || score < 30) {
      if (searchable && typeof h.sp.onInputChange === "function") try { h.sp.onInputChange("", { action: "input-blur", prevInputValue: "" }); } catch (e) {}
      return { ok: false, options, note: searchable ? "Searchable list with no close match. Retry with one of these options or a shorter name." : undefined };
    }
    (fiberProp(input, "selectOption", 40) || h.so)(pick);
    await sleep(250);
    const shown = reactSelectValue(input);
    return { ok: !!shown, chosen: shown || rsLabel(h.sp, pick), options: shown ? undefined : options };
  }

  // Fallback when React internals aren't reachable: open the menu and click an option.
  async function reactSelectDomPick(input, value) {
    const c = reactSelectContainer(input) || input.parentElement;
    const control = c.querySelector('[class*="select__control"], [class*="-control"]') || input;
    const optionsNow = () => [...c.querySelectorAll('[class*="select__option"], [class*="-option"], [role="option"]'),
      ...document.querySelectorAll('[class*="select__menu-portal"] [class*="option"]')].filter(visible);
    mouseClick(control); input.focus(); await sleep(80);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    let opts = await waitFor(optionsNow, 800);
    let pick = best(opts, value, (o) => o.textContent);
    if (!pick) {
      setNative(input, value);
      opts = await waitFor(optionsNow, 2000);
      pick = best(opts, value, (o) => o.textContent) || (opts.length === 1 ? opts[0] : null);
    }
    const available = opts.map((o) => norm(o.textContent)).slice(0, 40);
    if (!pick) { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return { ok: false, options: available }; }
    mouseClick(pick);
    await sleep(200);
    const shown = reactSelectValue(input);
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

  window.ISActions = { v: 3, sleep, norm, low, visible, setNative, blur, mouseClick, best, scoreOption, getFiber, fiberProp,
    waitFor, isReactSelect, reactSelectPick, reactSelectContainer, reactSelectOptions, reactSelectValue, workdayPick, ariaComboPick, nativeSelect, radioPick, setChecked,
    b64ToFile, setFileInput, dropFile };
})();
