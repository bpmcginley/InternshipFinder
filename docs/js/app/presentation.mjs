// Listing labels, dates and browser presentation.

export function createPresentation(browser, {
    IS, h, C,
  }) {
  const STATE_LABEL = { none: "Not started", interested: "Interested", applied: "Applied", interviewing: "Interviewing", rejected: "Rejected", offer: "Offer" };
  const JOB_LABEL = { queued: "Queued", working: "Agent working", needs_you: "Needs you", ready_to_submit: "Ready to submit", submitted: "Submitted", failed: "Failed" };
  const ATS = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday", smartrecruiters: "SmartRecruiters", icims: "iCIMS", icims_site: "iCIMS", oracle: "Oracle", bamboohr: "BambooHR", workable: "Workable", taleo: "Taleo" };
  // Application sites the extension can fill in out of the box: the `ats` values whose apply hosts are
  // in extension/manifest.json host_permissions (jazzhr is applytojob.com). Not "other" or "icims_site",
  // whose custom domains are only optional permissions. The SEO pages (seo_pages.py) use the same list.
  const SUPPORTED_ATS = new Set(["workday", "greenhouse", "oracle", "icims", "ashby", "lever", "eightfold", "smartrecruiters",
    "successfactors", "taleo", "bamboohr", "rippling", "jazzhr", "workable", "jobvite", "recruitee", "adp", "paylocity"]);
  const ACTIVE = ["queued", "working", "needs_you", "ready_to_submit"];
  const PAGE = 150;
  // Descriptions run about 1 KB per open listing. Up to this many open listings they are downloaded
  // without asking (the eight default states and remote are about 3,200).
  const DESC_AUTO = 5000;

  const DAY = IS.DAY;
  const daysAgo = iso => { if (!iso) return null; const t = new browser.Date(iso).getTime(); return isNaN(t) ? null : Math.max(0, Math.floor((browser.Date.now() - t) / DAY)); };
  const ago = n => n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
  // One formatter each, made once: toLocaleDateString builds a new one on every call, and the list
  // calls these for every row it draws. Same text (toLocaleDateString(undefined, o) is
  // new Intl.DateTimeFormat(undefined, o).format).
  const DAY_FMT = new browser.Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  const fmtDay = d => { const t = new browser.Date(d + "T12:00:00"); return isNaN(t) ? "Invalid Date" : DAY_FMT.format(t); };
  const daysUntil = d => Math.ceil((new browser.Date(d + "T23:59:59").getTime() - browser.Date.now()) / DAY);
  function postedTime(value, today = new browser.Date()) {
    if (!value) return null;
    // A date-only posting is a calendar date, not midnight UTC on the previous local day.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value), d = new browser.Date(dateOnly ? value + "T12:00:00" : value);
    if (isNaN(d) || (dateOnly && (d.getFullYear() !== +value.slice(0, 4) || d.getMonth() + 1 !== +value.slice(5, 7) || d.getDate() !== +value.slice(8)))) return null;
    const full = DAY_FMT.format(d), day = x => browser.Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
    const age = Math.round((day(today) - day(d)) / DAY);
    return h("time", { dateTime: value, title: full },
      h("span", { "aria-hidden": true }, "Posted " + (age < 0 ? full : ago(age))),
      h("span", { className: "sr" }, "Posted " + full));
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const cx = (...a) => a.filter(Boolean).join(" ");
  const prevent = fn => e => { e.preventDefault(); fn(e); };
  // Smooth scrolling is motion too, so it follows the same prefers-reduced-motion switch as the CSS.
  const scrollBehavior = () => browser.matchMedia && browser.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  // Where "install the extension" goes: the Chrome Web Store listing on a laptop or desktop, and the
  // install page on a phone or tablet, which can't add extensions (same media query as install.html's
  // phone banner). `from` is the listing's utm_source, so the store counts installs per link.
  const touchOnly = () => !!(browser.matchMedia && browser.matchMedia("(pointer:coarse) and (hover:none)").matches);
  const installUrl = from => C.extensionStoreUrl && !touchOnly()
    ? C.extensionStoreUrl + "?utm_source=" + encodeURIComponent(from)
    : C.extensionInstallUrl || "install.html";

  // ---------- search ----------
  // was: parseQuery, PLACES, splitPlaces, NOT_PLACE and the substring "hay" here. The search moved to
  // core.js (IS.compileQuery, IS.matchScore) on 2026-10-14, where it is tested, and ranks by relevance.

  // ---------- eligibility and deadline: [level, text], level bad | warn | good | "" ----------

  return {
    STATE_LABEL, JOB_LABEL, ATS, SUPPORTED_ATS, ACTIVE, PAGE, DESC_AUTO, daysAgo, ago, fmtDay,
    daysUntil, postedTime, plural, cx, prevent, scrollBehavior, touchOnly, installUrl,
  };
}
