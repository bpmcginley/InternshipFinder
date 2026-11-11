// Profile setup and share controls.

export function createSetup(browser, {
    IS, useMemo, h, MultiSelect, Sel, opt, useState, useRef, useEffect, scrollBehavior, cx, F,
  }) {
  const quickProfile = (profile, patch) => ({ ...IS.emptyProfile(), ...(profile || {}), ...patch });
  function QuickProfile({ profile, majors, majorsReady, onChange, onDone, onSetup, message }) {
    const majorOpts = useMemo(() => ((majors && majors.majors) || []).map(m => ({ value: m.name, label: m.name, hint: m.level === "grad" ? "graduate" : "" })), [majors]);
    const stateOpts = useMemo(() => Object.entries({ ...IS.US_STATES, ...IS.CA_PROVINCES }).map(([value, label]) => ({ value, label, chip: value })).sort((a, b) => a.label.localeCompare(b.label)), []);
    const picked = !!(profile && profile.majors.length);
    return h("section", { className: "notice quick-profile", "aria-label": "Rank for your major" },
      h("div", { className: "quick-major" }, h("span", { className: "lbl" }, "I study"),
        majors ? h(MultiSelect, { label: "I study", placeholder: "Start typing your major", wide: true, options: majorOpts, selected: profile ? profile.majors : [], onChange: majors => onChange({ majors }) })
          : h("span", { role: "status" }, majorsReady ? "The major list didn't load. Open profile setup to choose fields instead." : "Loading the list of majors…")),
      h("p", { className: "meta" }, "Choose a major to rank these listings. Your choices stay in this browser."),
      picked && h("div", { className: "quick-details" },
        h("label", { className: "lbl" }, "Class year (optional)",
          h(Sel, { label: "Class year (optional)", value: profile.class_year, onChange: class_year => onChange({ class_year }) }, opt("", "Skip for now"), IS.YEARS.map(([k, l]) => opt(k, l)))),
        h("div", { className: "lbl" }, "Preferred states or provinces (optional)",
          h(MultiSelect, { label: "Preferred states or provinces (optional)", placeholder: "Anywhere", wide: true, options: stateOpts, selected: profile.states, onChange: states => onChange({ states }) }))),
      h("div", { className: "quick-actions" },
        h("button", { type: "button", className: "btn quiet", onClick: onSetup }, "Open profile setup"),
        h("button", { type: "button", className: "btn", onClick: onDone }, picked ? "Done" : "Not now")),
      h("div", { className: "meta", role: "status", "aria-live": "polite" }, message));
  }

  // ---------- setup (3 steps) ----------
  const SEASONS = ["Spring", "Summer", "Fall", "Winter"];
  const GRAD_YEARS = Array.from({ length: 9 }, (_, i) => 2026 + i);

  // was: function Setup({ initial, majors, index, stats, firstTime, onSave, onClose, onDelete, signedIn }) {
  // statsReady says the stats.json fetch has settled. stats === null alone cannot tell "still
  // downloading" from "failed", and coverage() below words those two cases differently.
  // was: function Setup({ initial, majors, index, stats, statsReady, firstTime, onSave, onClose, onDelete, signedIn }) {
  // majorsReady does for majors.json what statsReady does for stats.json: majors === null alone is
  // both "still downloading" and "failed", and step 1 used to say "didn't load" for the first.
  function Setup({ initial, majors, majorsReady, index, stats, statsReady, firstTime, onSave, onClose, onDelete, signedIn }) {
    const [d, setD] = useState(() => ({ ...IS.emptyProfile(), ...(initial || {}) }));
    const [step, setStepRaw] = useState(1);
    // "fwd" or "back" once the student has moved between steps; "" on first open, so the card doesn't
    // slide in on page load. The step body is keyed by step, so each change replays the CSS animation.
    const [dir, setDir] = useState("");
    const setStep = n => { setDir(n > step ? "fwd" : "back"); setStepRaw(n); };
    const [stagesTouched, setStagesTouched] = useState(!!(initial && initial.stages && initial.stages.length));
    const ref = useRef(), stepRef = useRef(), mounted = useRef(false);
    // was: scrollIntoView on every run, the first included, so a first visit opened scrolled 600 px
    // down the page with the headline gone. On opening, the card scrolls only when it is out of
    // sight (opened from a link under the list); a step change still brings its top into view.
    useEffect(() => {
      const el = ref.current, box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const away = box && (box.top < 0 || box.top > (browser.innerHeight || 800) - 120);
      if (el && (mounted.current || away)) el.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      mounted.current = true;
      if (stepRef.current) stepRef.current.focus({ preventScroll: true });
    }, [step]);
    const set = (k, v) => setD(s => ({ ...s, [k]: v }));
    const toggle = (k, v) => setD(s => ({ ...s, [k]: s[k].includes(v) ? s[k].filter(x => x !== v) : [...s[k], v] }));

    const majorOpts = useMemo(() => ((majors && majors.majors) || []).map(m => ({ value: m.name, label: m.name, hint: m.level === "grad" ? "graduate" : "" })), [majors]);
    const minorOpts = useMemo(() => majorOpts.filter(o => !o.hint && !/Undeclared|BDIC/.test(o.value)), [majorOpts]);
    const fieldOpts = useMemo(() => {
      const fromMajors = majors && majors.fields ? majors.fields : null;
      const counts = (stats && stats.by_field) || {};
      const list = fromMajors || Object.keys(counts);
      return list.filter(t => t !== "other").map(t => ({ value: t, label: IS.fieldLabel(t), count: counts[t] != null ? counts[t] : undefined }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }, [majors, stats]);

    // What the numbers beside a field actually are. stats.json's by_field is built in
    // backend/internscout/export_static.py from rows where status == "open", one tally per field tag
    // on the listing, so it counts OPEN listings nationwide in the last scan, not everything ever
    // seen. A listing tagged both "swe" and "ml" is tallied under each, so adding a major's tags
    // together inflates the figure: in the export now in docs/data/stats.json (generated_at 2026-09-18)
    // swe 2,097 + ml 776 is not 2,873 distinct roles, and the export carries no way to take the union.
    // was: ...so the headline is the largest single tag and says so, rather than a sum that would
    // flatter us.  -- no longer what the code does. coverage() below heads on the student's OWN primary
    // tag when the export has it, and names the widest sibling beside it, because heading on the widest
    // tag showed a Nursing student "98 open listings tagged Health" and never the 16 tagged Nursing.
    // Still one tag's count, never a sum.
    const byField = (stats && stats.by_field) || null;
    const biggest = tags => { let best = null; for (const t of tags) { const n = byField && byField[t]; if (typeof n === "number" && (!best || n > best.n)) best = { tag: t, n }; } return best; };
    const nOpen = n => `${n.toLocaleString()} open listing${n === 1 ? "" : "s"}`;
    const mineFields = useMemo(() => IS.profileFields(d, majors), [d.majors, d.minors, d.fields, majors]);
    // The student's own tag (majors.json tags[0] of their first major, or the first field they picked
    // if their major carries no tags). mineFields.direct is a Set, so it can only be maximised, and
    // the maximum is a sibling tag: a Nursing student's direct set holds both nursing (16 open in
    // docs/data/stats.json, generated_at 2026-09-18) and health (98), and health is what a maximum
    // returns. See IS.primaryField in core.js.
    const primary = useMemo(() => IS.primaryField(d, majors), [d.majors, d.fields, majors]);
    // InternScout promises every major and keeps that promise, but the coverage behind it is lopsided:
    // was: // in the 2026-09-19 export swe has 2,097 open while nursing, museums, music and theater are in
    // in the export now in docs/data/stats.json (generated_at 2026-09-18) swe has 2,097 open while
    // nursing (16), museums (5), music (3) and theater (2) are in
    // single or double digits. Showing the student their own number in step 1, before they spend
    // three steps on a profile, means nobody is ambushed, and the figure rights itself as the
    // scanner's coverage grows. Below this many a bare number reads like a promise, so under it we
    // say plainly that the list is thin instead of leaving the student to discover it.
    const THIN = 25;
    function coverage() {
      const direct = [...mineFields.direct].filter(t => t !== "other");
      if (!direct.length) return h("div", { className: "meta" },
        "Pick a major or a field and we'll show how many open listings we have for it right now. Open the field picker to see counts.");
      // was: if (!byField) return h("div", { className: "meta" }, "Today's listing counts didn't load, so we can't show how deep your field is right now.");
      // stats is null both before IS.loadStats() settles and after it fails (core.js loadStats
      // returns null when every base URL throws), so the old line told a student on a slow
      // connection that the counts had failed while stats.json was still downloading. statsReady is
      // set in the .then, which runs on success and on failure alike.
      if (!byField) return h("div", { className: "meta" }, statsReady
        ? "Today's listing counts didn't load, so we can't show how deep your field is right now."
        : "Checking today's listing counts…");
      const best = biggest(direct), rel = biggest([...mineFields.related].filter(t => t !== "other"));
      // was: const name = IS.fieldLabel(best ? best.tag : direct[0]);
      // The headline and the THIN test run on the student's own tag, not on the biggest of their
      // tags. A primary tag absent from by_field counts as 0 instead of falling back to the maximum:
      // backend/internscout/export_static.py:397 builds by_field with Counter over open listings
      // only, so a missing key means nothing open carries that tag, which is the case this line
      // exists to report.
      const head = primary && direct.includes(primary)
        ? { tag: primary, n: typeof byField[primary] === "number" ? byField[primary] : 0 }
        : best;
      const name = IS.fieldLabel(head ? head.tag : direct[0]);
      const nat = stats && stats.open ? ` of ${stats.open.toLocaleString()} open nationwide` : "";
      // was: const many = best && direct.length > 1 ? " That's the largest of your field tags, not a total: one listing can carry several." : "";
      // When the student's own tag is not their biggest, both numbers are named: dropping the bigger
      // one would undersell the list, and dropping the smaller one is the ambush this line exists to
      // prevent. `many` only claims "the largest" in the case where the headline really is.
      const wider = best && head && best.tag !== head.tag && best.n > head.n
        ? ` Your widest field tag, ${IS.fieldLabel(best.tag)}, has ${nOpen(best.n)}; one listing can carry several tags, so the two don't add up.` : "";
      const many = !wider && head && direct.length > 1 ? " That's the largest of your field tags, not a total: one listing can carry several." : "";
      const also = rel && rel.n > (best ? best.n : 0) ? ` The related field ${IS.fieldLabel(rel.tag)} has ${nOpen(rel.n)}.` : "";
      // was: if (!best || !best.n) return h("div", { className: "meta" },
      // was:   `Nothing open tagged ${name} in today's scan${nat}. The scanner runs daily and this number moves with it, so the profile is still worth setting up, but we won't pretend the list is there yet.` + also);
      if (!head || !head.n) return h("div", { className: "meta" },
        `Nothing open tagged ${name} in today's scan${nat}. The scanner runs daily and this number moves with it, so the profile is still worth setting up, but we won't pretend the list is there yet.` + wider + also);
      // was: if (best.n < THIN) return h("div", { className: "meta" },
      // was:   `We have very few right now: ${nOpen(best.n)} tagged ${name}${nat}.` + many + also);
      if (head.n < THIN) return h("div", { className: "meta" },
        `We have very few right now: ${nOpen(head.n)} tagged ${name}${nat}.` + wider + many + also);
      // was: return h("div", { className: "meta" }, `${nOpen(best.n)} tagged ${name} right now${nat}.` + many + also);
      return h("div", { className: "meta" }, `${nOpen(head.n)} tagged ${name} right now${nat}.` + wider + many + also);
    }

    const undeclared = !d.majors.length || d.majors.some(n => /Undeclared|BDIC/.test(n));
    const [season, gyear] = (d.grad_term || "").split(" ");
    const setGrad = (s, y) => set("grad_term", s && y ? `${s} ${y}` : s || y ? `${s || "Spring"} ${y || ""}`.trim() : "");
    const setYear = y => setD(s => ({ ...s, class_year: y, stages: stagesTouched || !y ? s.stages : IS.STAGE_DEFAULTS[y].slice() }));

    const files = (index && index.files) || {};
    const count = k => files[k] ? files[k].open : null;
    const stateList = useMemo(() => Object.entries(IS.US_STATES).sort((a, b) => a[1].localeCompare(b[1])), []);
    // Provinces in the order most roles are in (the big metros' provinces first), then "no province".
    const provinceList = useMemo(() => [...Object.entries(IS.CA_PROVINCES), ["Canada", "Canada, no province listed"]], []);
    const shortcut = codes => setD(s => { const all = codes.every(c => s.states.includes(c)); return { ...s, states: all ? s.states.filter(c => !codes.includes(c)) : [...new Set([...s.states, ...codes])] }; });

    const dots = h("div", { className: "steps", "aria-label": `Step ${step} of 3` }, [1, 2, 3].map(i => h("span", { key: i, className: cx("dot", i === step && "on", i < step && "done") }, i)));

    let body;
    if (step === 1) body = h(F, null,
      h("h3", null, "About you"),
      // was: !majors && h("div", { className: "meta" }, "The major list didn't load. Pick the fields you're interested in below instead."),
      !majors && h("div", { className: "meta", role: "status" }, IS.majorsNote(majors, majorsReady)),
      majors && h("div", { className: "lbl" }, "Major(s)", h(MultiSelect, { wide: true, label: "Majors", placeholder: "Start typing, e.g. Nursing", options: majorOpts, selected: d.majors, onChange: v => set("majors", v) })),
      majors && h("div", { className: "lbl" }, "Minor(s) ", h("span", { className: "muted" }, "optional"), h(MultiSelect, { wide: true, label: "Minors", placeholder: "Start typing", options: minorOpts, selected: d.minors, onChange: v => set("minors", v) })),
      h("div", { className: "lbl" }, undeclared ? "Fields you're interested in" : h(F, null, "Other fields you're interested in ", h("span", { className: "muted" }, "optional")),
        h(MultiSelect, { wide: true, label: "Fields", placeholder: undeclared ? "e.g. Health, Museums, Data" : "Add a field", options: fieldOpts, selected: d.fields, onChange: v => set("fields", v) })),
      coverage(),
      h("div", { className: "row2" },
        h("label", { className: "lbl" }, "Class year",
          h(Sel, { label: "Class year", value: d.class_year, onChange: setYear }, opt("", "Choose…"), IS.YEARS.map(([k, l]) => opt(k, l)))),
        h("label", { className: "lbl" }, "Graduation term",
          h("div", { className: "row2 tight" },
            h(Sel, { label: "Graduation season", value: season || "", onChange: v => setGrad(v, gyear) }, opt("", "Season"), SEASONS.map(s => opt(s, s))),
            h(Sel, { label: "Graduation year", value: gyear || "", onChange: v => setGrad(season, v) }, opt("", "Year"), GRAD_YEARS.map(y => opt(String(y), String(y))))))));
    else if (step === 2) body = h(F, null,
      h("h3", null, "What you want"),
      h("fieldset", null, h("legend", null, "Kinds of roles", d.class_year && !stagesTouched ? h("span", { className: "muted" }, ` (suggested for ${IS.YEAR_PLURAL[d.class_year]})`) : null),
        h("div", { className: "checks" }, IS.STAGES.map(([k, l]) => h("label", { key: k, className: "check" },
          h("input", { type: "checkbox", checked: d.stages.includes(k), onChange: () => { setStagesTouched(true); toggle("stages", k); } }), " ", l)))),
      h("fieldset", null, h("legend", null, "Terms"),
        h("div", { className: "checks" }, [...IS.TERMS, ...d.terms.filter(t => !IS.TERMS.includes(t))].map(t => h("label", { key: t, className: "check" },
          h("input", { type: "checkbox", checked: d.terms.includes(t), onChange: () => toggle("terms", t) }), " ", t)))),
      h("label", { className: "check" }, h("input", { type: "checkbox", checked: !!d.paid_only, onChange: e => set("paid_only", e.target.checked) }),
        " Paid roles only ", h("span", { className: "muted" }, "(hides roles marked unpaid; many postings don't say)")));
    else body = h(F, null,
      h("h3", null, "Where"),
      h("div", { className: "shortcuts" },
        // was: the regions, then a quiet "Clear". No state picked means every state (2026-10-14), so
        // that choice has its name and comes first.
        h("button", { type: "button", className: cx("btn small", !d.states.length && "on"), "aria-pressed": !d.states.length, onClick: () => set("states", []) }, "Everywhere"),
        IS.REGION_SHORTCUTS.map(([name, codes]) => h("button", { type: "button", key: name, className: cx("btn small", codes.every(c => d.states.includes(c)) && "on"), onClick: () => shortcut(codes) }, name))),
      h("label", { className: "check remote" }, h("input", { type: "checkbox", checked: !!d.remote, onChange: e => set("remote", e.target.checked) }),
        " U.S. remote", count("remote") != null ? h("span", { className: "c" }, count("remote")) : null),
      h("div", { className: "stategrid" }, stateList.map(([k, n]) => h("label", { key: k, className: cx("check", d.states.includes(k) && "on") },
        h("input", { type: "checkbox", checked: d.states.includes(k), onChange: () => toggle("states", k) }), " ", n,
        count(k) != null ? h("span", { className: "c" }, count(k)) : null))),
      h("fieldset", null, h("legend", null, "Canada"),
        h("div", { className: "stategrid" }, provinceList.map(([k, n]) => h("label", { key: k, className: cx("check", d.states.includes(k) && "on") },
          h("input", { type: "checkbox", checked: d.states.includes(k), onChange: () => toggle("states", k) }), " ", n,
          count(k) != null ? h("span", { className: "c" }, count(k)) : null))),
        h("div", { className: "meta" }, "Most roles in Canada need Canadian work authorization (citizenship, permanent residence or a work permit).")),
      // was: `No states picked: you'll see the baseline area (${IS.BASELINE.join(", ")}).`
      !d.states.length && h("div", { className: "meta" }, "No states picked, so your matches come from every state. That is a larger download (about 3 MB); picking states makes the list load faster."),
      h("fieldset", null, h("legend", null, "Work authorization"),
        h("div", { className: "checks" }, IS.WORK_AUTH.map(([k, l]) => h("label", { key: k, className: "check" },
          h("input", { type: "radio", name: "work_auth", checked: d.work_auth === k, onChange: () => set("work_auth", k) }), " ", l))),
        h("div", { className: "meta" }, "Used only on this page: it hides roles open to U.S. citizens only and flags roles that don't sponsor visas.")),
      signedIn && h("div", { className: "meta" }, "You're signed in, so your chosen states count toward where we scan in more detail."));

    // Escape closes the card (D13, 2026-10-14), as Cancel or "Skip for now" does, and the App puts focus back on
    // what opened it. A picker with its list open takes the Escape for itself first (it calls preventDefault).
    // On a phone the footer with Back, Next and Save sticks to the bottom of the screen (index.html .setup-foot):
    // step 3's Save used to be about 1,350 px below the step's top.
    // was: h("section", { className: "setup sheet", ref, "aria-label": "My profile" },
    return h("section", { className: "setup sheet", ref, "aria-label": "My profile",
      onKeyDown: e => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } } },
      h("div", { className: "setup-head" }, h("h2", null, firstTime ? "Set up InternScout" : "My profile"), dots),
      h("div", { key: step, ref: stepRef, tabIndex: -1, role: "group", "aria-label": `Profile step ${step} of 3: ${["About you", "What you want", "Where"][step - 1]}`, className: cx("step-body", dir) }, body),
      h("div", { className: "setup-foot" },
        step > 1 && h("button", { type: "button", className: "btn", onClick: () => setStep(step - 1) }, "Back"),
        step < 3 && h("button", { type: "button", className: "btn primary", onClick: () => setStep(step + 1) }, "Next"),
        step === 3 && h("button", { type: "button", className: "btn primary", onClick: () => onSave(d) }, "Save and show matches"),
        h("span", { className: "spacer" }),
        step < 3 && !firstTime && h("button", { type: "button", className: "btn quiet", onClick: () => onSave(d) }, "Save"),
        h("button", { type: "button", className: "btn quiet", onClick: onClose }, firstTime ? "Skip for now" : "Cancel")),
      !firstTime && h("div", { className: "setup-danger" },
        h("span", { className: "meta" }, "Your profile lives in this browser", signedIn ? "; the server keeps only a hashed ID, usage counts and your chosen states." : "."),
        h("button", { type: "button", className: "btn small danger", onClick: onDelete }, "Delete my data")));
  }

  // ---------- app ----------
  function ShareSearch({ url }) {
    const [result, setResult] = useState(null);
    const current = result?.url === url ? result : null;
    async function share() {
      if (typeof browser.navigator.share === "function") {
        try {
          await browser.navigator.share({ url });
          return;
        } catch (error) {
          if (error?.name === "AbortError") return;
        }
      }
      try {
        await browser.navigator.clipboard.writeText(url);
        setResult({ url, message: "Link copied." });
      } catch {
        setResult({ url, manual: true });
      }
    }
    return h(F, null,
      h("button", { type: "button", className: "btn quiet", onClick: share }, "Share search"),
      h("span", { className: current?.message ? "muted" : "sr", role: "status" }, current?.message || ""),
      current?.manual && h("label", { className: "field" }, "Copy this link",
        h("input", { type: "url", readOnly: true, value: url, autoFocus: true,
          onFocus: event => event.currentTarget.select() })));
  }

  return {
    quickProfile, QuickProfile, Setup, ShareSearch,
  };
}

export function saveProfileAction({
  p, quickFirstSave, IS, offerNudge, offerDigestNudge, profileRef, setP, setSetupOpen,
  setQuickOpen, setLimit, PAGE, setF, initF, setNote, browser, scrollBehavior,
}, d) {
    // was: if (!p) IS.count("profile");   // the first profile on this device, not every edit
    if (!p || quickFirstSave.current) { if (!p) IS.count("profile"); quickFirstSave.current = false; if (!offerNudge()) offerDigestNudge("profile"); } // manual first save; extension sync never prompts
    const s = IS.saveProfile(d);
    profileRef.current = s; setP(s); setSetupOpen(false); setQuickOpen(false); setLimit(PAGE);
    setF(x => ({ ...x, states: [], ...initF(s) }));
    setNote(`Profile saved. Ranking for ${s.majors.length ? s.majors.join(", ") : s.fields.length ? s.fields.map(IS.fieldLabel).join(", ") : "all fields"}.`);
    browser.setTimeout(() => setNote(""), 6000);
    // was: focus the search box and centre it, which put the filters mid-screen and, on a phone, the
    // keyboard over the matches. "Save and show matches" lands on the matches now: the top of the
    // list, with focus on its heading (2026-10-14).
    browser.setTimeout(() => browser.requestAnimationFrame(() => { const el = browser.document.getElementById("listings"); if (el) { el.scrollIntoView({ block: "start", behavior: scrollBehavior() }); el.focus({ preventScroll: true }); } }), 0);
  }

export function saveQuickProfileAction({
  profileRef, IS, quickProfile, prefill, setP, setF, setLimit, PAGE, quickFirstSave,
  setQuickMessage,
}, patch) {
    const previous = profileRef.current;
    if (!previous && (!patch.majors || !patch.majors.length)) return;
    const s = IS.saveProfile(quickProfile(previous || prefill, patch));
    profileRef.current = s; setP(s); setF(f => ({ ...f, sort: "score" })); setLimit(PAGE);
    if (!previous) { IS.count("profile"); quickFirstSave.current = true; }
    if (patch.majors) IS.count("major_quick_set");
    setQuickMessage((patch.majors ? patch.majors.length ? `Ranking for ${patch.majors.join(", ")}.` : "No major selected." : "Preferences updated.") + " Your current search filters still apply.");
  }

export function finishQuickProfileAction({
  setQuickOpen, quickFirstSave, offerNudge, offerDigestNudge, profileRef, IS, SKIP_KEY,
  setSkipped, browser,
}) {
    setQuickOpen(false);
    // Preserve the existing first-profile nudge after the optional questions, without interrupting typing.
    if (quickFirstSave.current) { quickFirstSave.current = false; if (!offerNudge()) offerDigestNudge("profile"); }
    if (!profileRef.current) { IS.ls.set(SKIP_KEY, true); setSkipped(true); }
    browser.setTimeout(() => { const el = browser.document.getElementById(profileRef.current ? "listings" : "q"); if (el) el.focus({ preventScroll: true }); }, 0);
  }
