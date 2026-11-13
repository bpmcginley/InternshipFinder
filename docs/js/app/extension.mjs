// Extension queue and listing eligibility.

export function createExtension(browser, {
    IS, daysUntil, fmtDay, plural, useState, useCallback, useEffect,
  }) {
  function checks(r, p) {
    const x = r.insights || {}, out = [];
    if (x.grad_years) {
      const lo = Math.min(...x.grad_years), hi = Math.max(...x.grad_years), gy = p && p.grad_year, t = lo === hi ? `Graduating in ${lo}` : `Graduating ${lo}–${hi}`;
      out.push(gy ? (gy >= lo && gy <= hi ? ["good", t] : ["bad", `${t} (you: ${gy})`]) : ["", t]);
    }
    if (r.years && r.years.length) {
      const t = `For ${IS.yearsText(r.years)}`, cy = p && p.class_year;
      out.push(cy ? (r.years.includes(cy) ? ["good", t] : ["bad", `${t} (you: ${IS.YEAR_LABEL[cy] || cy})`]) : ["", t]);
    } else if (x.class_standing) out.push(["", `For ${x.class_standing.join(" or ")} students`]);
    const cit = IS.citizenRule(r);
    if (cit) {
      const t = cit === "citizen" ? "U.S. citizens only" : "U.S. citizens or permanent residents only", c = p && p.citizenship;
      // "U.S. permanent resident" and "needs a U.S. visa" both contain "U.S.", so rule those out first.
      const resident = /permanent|green card|lawful/i.test(c || "");
      const notCitizen = resident || /visa|\bf-?1\b|\bj-?1\b|\bh-?1b?\b|\bopt\b|\bcpt\b|international|non-?citizen|not a (u\.?\s?s\.? )?citizen/i.test(c || "");
      const citizen = !notCitizen && /\bu\.?\s?s\.?a?\b|united states|american/i.test(c || "");
      const ok = citizen || (cit !== "citizen" && resident);
      out.push(c ? [ok ? "good" : "bad", t] : ["warn", t]);
    }
    if (x.clearance || (r.restrictions || []).includes("clearance")) out.push(["warn", "Needs a security clearance"]);
    if (x.degree_only) {
      const t = x.degree_only === "phd" ? "PhD students only" : "Master's students only";
      out.push(p && p.degree ? [(x.degree_only === "phd" ? /ph\.?d|doctor/i : /master|m\.s\.|m\.eng|mba/i).test(p.degree) ? "good" : "bad", t] : ["warn", t]);
    }
    if (x.gpa_min) { const g = p && p.gpa; out.push(g ? [g >= x.gpa_min ? "good" : "bad", `Minimum GPA ${x.gpa_min} (you: ${g})`] : ["", `Minimum GPA ${x.gpa_min}`]); }
    if (IS.noSponsorship(r)) out.push([p && p.needs_sponsorship && p.needs_sponsorship !== "No" ? "bad" : "", "No visa sponsorship"]);
    // Every location in Canada: a US student generally needs a Canadian work permit to take it.
    if (IS.inCanadaOnly(r)) {
      const c = (p && p.citizenship) || "";
      out.push([/canad/i.test(c) ? "good" : /u\.?\s?s\.?|united states|student visa/i.test(c) ? "warn" : "", "In Canada: needs Canadian work authorization"]);
    }
    const pay = IS.payOf(r);
    if (pay === "unpaid") out.push(["warn", "Unpaid"]); else if (pay === "stipend") out.push(["", "Stipend"]);
    if (x.deadline) { const d = daysUntil(x.deadline); out.push(d < 0 ? ["bad", `Deadline passed (${fmtDay(x.deadline)})`] : [d <= 14 ? "warn" : "", `Apply by ${fmtDay(x.deadline)}${d <= 14 ? ` (${plural(d, "day")} left)` : ""}`]); }
    return out;
  }
  const blockers = (r, p) => checks(r, p).filter(c => c[0] === "bad").map(c => c[1]);

  // ---------- extension ----------
  const same = next => prev => { try { return JSON.stringify(prev) === JSON.stringify(next) ? prev : next; } catch (e) { return next; } };
  function useExtension() {
    const [info, setInfo] = useState({ checked: false, installed: false });
    const [queue, setQueue] = useState({ order: [], jobs: {} });
    const [profile, setProfile] = useState(null);
    // The ping repeats every 20 s and nearly always brings back what we already have. Keeping the old
    // object when nothing changed lets React skip the render; without it the whole page, table
    // included, was redrawn three times every 20 s.
    const ping = useCallback(async () => {
      const r = await IS.ext.call({ type: "ping" }, 1500);
      if (r && r.error === "reload_page") { setInfo(same({ checked: true, installed: false, stale: true })); return; }
      if (r && r.ok) {
        setInfo(same({ checked: true, installed: true, ...r }));
        const q = await IS.ext.call({ type: "get_queue" }); if (q && q.queue) setQueue(same(q.queue));
        if (r.onboarded) { const p = await IS.ext.call({ type: "get_profile_summary" }); if (p && !p.error) setProfile(same(p)); }
      } else setInfo(same({ checked: true, installed: false }));
    }, []);
    useEffect(() => {
      const off = IS.ext.on(d => {
        if (d.__internscout === "push" && d.queue) setQueue(same(d.queue));
        if (d.__internscout === "hello") ping();
        if (d.__internscout === "gone") setInfo({ checked: true, installed: false, stale: true });
      });
      ping();
      const t = browser.setInterval(() => { if (browser.document.visibilityState === "visible") ping(); }, 20000);
      return () => { off(); browser.clearInterval(t); };
    }, [ping]);
    return { info, queue, profile };
  }

  // ---------- small components ----------
  // `count` (D8, 2026-10-14): the filter bar's pickers say how many values are set ("Field · 2"), with the
  // accent-soft fill, so a filter that is on can be seen at a glance. The setup card's pickers pass none.
  // was: function MultiSelect({ placeholder, options, selected, onChange, label, wide }) {

  return {
    checks, blockers, useExtension,
  };
}
