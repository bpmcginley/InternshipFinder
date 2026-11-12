// Shared dashboard form and account controls.

export function createControls(browser, {
    useState, useRef, useId, useEffect, useMemo, h, cx,
  }) {
  function MultiSelect({ placeholder, options, selected, onChange, label, wide, count }) {
    const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [act, setAct] = useState(0);
    const ref = useRef(), input = useRef(), drop = useRef(), id = useId();
    useEffect(() => {
      const hd = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      browser.document.addEventListener("mousedown", hd); return () => browser.document.removeEventListener("mousedown", hd);
    }, []);
    const byVal = useMemo(() => new Map(options.map(o => [o.value, o])), [options]);
    const avail = options.filter(o => !selected.includes(o.value));
    const ql = q.toLowerCase();
    const filtered = (q ? avail.filter(o => (o.label || o.value).toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql)) : avail).slice(0, 60);
    const active = Math.max(0, Math.min(act, filtered.length - 1));
    useEffect(() => {
      if (open && drop.current) { const option = drop.current.children[active]; if (option) option.scrollIntoView({ block: "nearest" }); }
    }, [open, active, q, selected.length]);
    const add = v => { onChange([...selected, v]); setQ(""); setAct(0); };
    const rm = v => onChange(selected.filter(x => x !== v));
    const onKey = e => {
      if (e.key === "Enter" && open && filtered[active]) { add(filtered[active].value); e.preventDefault(); }
      else if (e.key === "ArrowDown") { setAct(open ? Math.min(active + 1, Math.max(0, filtered.length - 1)) : 0); setOpen(true); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setAct(open ? Math.max(active - 1, 0) : Math.max(0, filtered.length - 1)); setOpen(true); e.preventDefault(); }
      // was: Escape always handled here. With the list already closed it now goes on to the setup card,
      // whose Escape closes it (D13).
      else if (e.key === "Escape" && open) { setOpen(false); e.preventDefault(); }
      // Tab moves on to the next control and closes the list. was: the list stayed open behind it.
      else if (e.key === "Tab") setOpen(false);
      else if (e.key === "Backspace" && !q && selected.length) rm(selected[selected.length - 1]);
    };
    const name = label || placeholder, set = count > 0;
    return h("div", { className: cx("field ms", wide && "wide", set && "set"), ref, onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); } },
      h("div", { className: "box", onClick: () => { setOpen(true); if (input.current) input.current.focus(); } },
        set && h("span", { className: "ms-count", "aria-hidden": true }, `${name} · ${count}`),
        // The shared cross icon (D15) in place of the "×" character; the button keeps its spoken name.
        selected.map(s => { const o = byVal.get(s); return h("span", { key: s, className: "chip" }, (o && (o.chip || o.label)) || s,
          h("button", { type: "button", "aria-label": "Remove " + ((o && o.label) || s), onClick: e => { e.stopPropagation(); rm(s); } }, h("span", { className: "i i-cross", "aria-hidden": true }))); }),
        // With no options left there is no list: aria-expanded stays false and the "No more matching
        // options" line is a plain status message. was: an empty listbox, which axe reports as critical
        // (aria-required-children: a listbox must own options).
        h("input", { ref: input, value: q, role: "combobox", "aria-autocomplete": "list", "aria-expanded": open && filtered.length > 0,
          "aria-controls": id + "-list", "aria-activedescendant": open && filtered.length ? id + "-option-" + active : undefined,
          "aria-label": set ? `${name}, ${count} picked` : name, placeholder: selected.length ? "" : placeholder,
          onChange: e => { setQ(e.target.value); setOpen(true); setAct(0); }, onFocus: () => setOpen(true), onKeyDown: onKey })),
      open && !filtered.length && h("div", { className: "drop", role: "status" }, h("div", { className: "opt muted" }, "No more matching options")),
      // tabIndex -1: a scrolling box is a Tab stop of its own in Chrome and Firefox, so Tab from the
      // input landed in the list. Arrow keys and Enter on the input still move through it and pick.
      open && filtered.length > 0 && h("div", { className: "drop", ref: drop, id: id + "-list", role: "listbox", "aria-label": label || placeholder, tabIndex: -1 },
        filtered.map((o, i) => h("div", { key: o.value, id: id + "-option-" + i, role: "option", "aria-selected": false, className: cx("opt", i === active && "act"),
          onMouseDown: e => { e.preventDefault(); add(o.value); }, onMouseEnter: () => setAct(i) },
          h("span", null, o.label || o.value), o.count != null ? h("span", { className: "c" }, o.count) : o.hint ? h("span", { className: "c" }, o.hint) : null))));
  }

  // Everything about the signed-in account in one place, behind one button: who is signed in, this
  // month's allowance, invites, plans and sign-out. It used to sit in the header as a dozen buttons and
  // labels in one row that wrapped into a long second line. A disclosure (a button that shows a panel),
  // closed by Escape, a click outside, or choosing an item.
  function AccountMenu({ email, planLabel, allowLines, resetDay, spendText, items, admin, purchased = 0, hasPurchased = purchased > 0 }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(), btn = useRef();
    useEffect(() => {
      if (!open) return;
      const down = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      const key = e => { if (e.key === "Escape") { setOpen(false); btn.current && btn.current.focus(); } };
      browser.document.addEventListener("mousedown", down); browser.document.addEventListener("keydown", key);
      return () => { browser.document.removeEventListener("mousedown", down); browser.document.removeEventListener("keydown", key); };
    }, [open]);
    const pick = fn => () => { setOpen(false); fn(); };
    const item = it => h("button", { key: it.key, type: "button", className: cx("acct-item", it.danger && "danger"), onClick: pick(it.onClick), disabled: it.disabled, title: it.title },
      h("span", { className: "t" }, it.label), it.desc && h("span", { className: "d" }, it.desc));
    const groups = [items.filter(i => i.group === "share"), items.filter(i => i.group === "plan"), items.filter(i => i.group === "session"), admin || []].filter(g => g.length);
    return h("div", { className: "acct", ref },
      h("button", { type: "button", className: "btn acct-btn", ref: btn, "aria-expanded": open, "aria-controls": "acct-panel", onClick: () => setOpen(o => !o) },
        "Account", h("span", { className: "chev", "aria-hidden": true })),
      open && h("div", { className: "acct-panel", id: "acct-panel" },
        h("div", { className: "acct-sec" },
          h("div", { className: "acct-k" }, email ? "Signed in as" : "Signed in"),
          email && h("div", { className: "acct-email" }, email),
          h("div", { className: "acct-plan" }, planLabel)),
        (allowLines.length > 0 || spendText) && h("div", { className: "acct-sec" },
          h("div", { className: "acct-k" }, hasPurchased ? "Allowance" : "This month"),
          allowLines.map((l, i) => h("div", { key: i, className: "acct-line" }, l)),
          spendText && h("div", { className: "acct-line muted" }, spendText),
          resetDay && h("div", { className: "acct-line muted" }, `${hasPurchased ? "Monthly allowance resets" : "Resets"} ${resetDay}.`)),
        purchased > 0 && h("div", { className: "acct-sec", role: "status", "aria-live": "polite" },
          h("div", { className: "acct-k" }, "Purchased Auto-Apply runs"),
          h("div", { className: "acct-line" }, `${purchased.toLocaleString()} remaining. Purchased runs do not expire.`),
          h("div", { className: "acct-line muted" }, "Service limits and temporary pauses still apply.")),
        groups.map((g, i) => h("div", { key: i, className: "acct-sec acct-list" }, g.map(item)))));
  }

  const Sel = ({ label, value, onChange, children }) => h("div", { className: "field sel" },
    h("select", { "aria-label": label, value, onChange: e => onChange(e.target.value) }, children));
  const opt = (v, l) => h("option", { key: v, value: v }, l);

  return {
    MultiSelect, AccountMenu, Sel, opt,
  };
}
