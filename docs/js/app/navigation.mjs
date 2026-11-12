// Navigation, landing, digest and placement notice.

export function createNavigation(browser, {
    h, useMemo, useState, useEffect, useRef, installUrl, IS, prevent,
  }) {
  function PlaceNotice({ onHide }) {
    return h("div", { className: "notice place-notice" },
      h("button", { type: "button", className: "btn quiet small notice-hide", onClick: onHide, "aria-label": "Hide this notice" }, "Hide"),
      h("b", null, "New: paid listings. "),
      "When you search or pick a field, you may now see one listing an employer paid for, in its own box labelled Ad. Paying never changes your results, their order or any Match score, and it is never chosen from your profile. ",
      h("a", { href: "privacy.html#paid-listings", onClick: onHide }, "How paid listings work"));
  }

  // Whether the window is phone-width (the same 760px as the card layout in index.html).
  function useNarrow() {
    const mq = useMemo(() => browser.matchMedia ? browser.matchMedia("(max-width: 760px)") : null, []);
    const [on, setOn] = useState(() => !!(mq && mq.matches));
    useEffect(() => {
      if (!mq) return;
      const f = () => setOn(mq.matches);
      if (mq.addEventListener) mq.addEventListener("change", f); else if (mq.addListener) mq.addListener(f);
      return () => { if (mq.removeEventListener) mq.removeEventListener("change", f); else if (mq.removeListener) mq.removeListener(f); };
    }, [mq]);
    return on;
  }

  // Native disclosure also works in the static header without JavaScript.
  function SiteNav({ children }) {
    const root = useRef(null), lastFocus = useRef(null);
    useEffect(() => {
      const box = root.current, details = box.querySelector("details"), summary = box.querySelector("summary");
      const mq = browser.matchMedia("(max-width: 760px)");
      const resize = () => {
        const active = browser.document.activeElement === browser.document.body ? lastFocus.current : browser.document.activeElement;
        if (!mq.matches) {
          details.open = false;
          if (active === summary) box.querySelector("nav a").focus();
        } else if (!details.open && box.querySelector("nav").contains(active)) summary.focus();
      };
      const outside = event => {
        if (!box.contains(event.target)) lastFocus.current = null;
        if (!details.open || box.contains(event.target)) return;
        if (box.contains(browser.document.activeElement)) summary.focus({ preventScroll: true });
        details.open = false;
      };
      mq.addEventListener("change", resize);
      browser.document.addEventListener("pointerdown", outside);
      return () => { mq.removeEventListener("change", resize); browser.document.removeEventListener("pointerdown", outside); };
    }, []);
    return h("div", { className: "site-navigation", ref: root,
      onFocus: event => { lastFocus.current = event.target; },
      onKeyDown: event => {
        const details = root.current.querySelector("details");
        if (event.key === "Escape" && details.open) {
          details.open = false; root.current.querySelector("summary").focus(); event.stopPropagation();
        }
      },
      onBlur: event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          // A breakpoint can hide the focused control before its change event fires.
          if (event.relatedTarget || event.target.getClientRects().length) lastFocus.current = null;
          root.current.querySelector("details").open = false;
        }
      },
      onClick: event => {
        const link = event.target.closest("nav a");
        if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target === "_blank") return;
        root.current.querySelector("details").open = false;
        // Same-page links keep their destination focus instead of returning to Menu.
        const url = new browser.URL(link.href);
        if (url.origin === browser.location.origin && url.pathname === browser.location.pathname && url.search === browser.location.search && url.hash) {
          const target = browser.document.getElementById(decodeURIComponent(url.hash.slice(1)));
          if (target) target.focus();
        }
      }
    }, h("details", null, h("summary", { "aria-controls": "site-links" }, "Menu")), children);
  }

  // ---------- landing ----------
  // was: function Landing({ open, setOpen, onSetup, hasProfile, nationwide }) {
  // `plans` is the Worker's /config payments.plans, so the prices shown here are the ones Stripe is
  // actually configured with rather than a second copy that can drift.
  // When closed it renders nothing: the "About InternScout" link lives in the header tagline, so
  // the page no longer carries a second strip of small print under the header just to hold it.
  // was: function Landing({ open, setOpen, onSetup, hasProfile, nationwide, plans }) {
  // `installed` hides the Add Auto-Apply button once the extension is there.
  // was: function Landing({ open, setOpen, onSetup, hasProfile, nationwide, plans, installed }) {
  // `inviteOffer` and `inviteWords` are the dashboard's own (from /config invite), for the invite bullet.
  function Landing({ open, setOpen, onSetup, hasProfile, nationwide, plans, installed, inviteOffer, inviteWords }) {
    if (!open) return null;
    // was: "aria-label": "About InternScout" and h2 "Internships, co-ops and research for your major,
    // anywhere in the US and Canada": the header's h1 says that now (2026-10-05), so this strip is
    // what it does and how, under its own name.
    return h("section", { className: "landing", id: "about", tabIndex: -1, "aria-label": "How InternScout works" },
      h("div", { className: "landing-main" },
        h("h2", null, "What InternScout does"),
        h("p", null, "InternScout gathers student opportunities from employer career sites and public job boards",
          nationwide ? ` (${nationwide.toLocaleString()} open right now)` : "", " and ranks them for your major, class year and the states you pick."),
        // was: h("p", { className: "fine" }, "Free, made by a UMass student, not affiliated with UMass Amherst.")),
        // Paid plans went live on 2026-09-19 (worker/wrangler.toml PAYMENTS_ENABLED = "1"), so a flat
        // "Free" is no longer true of the whole product. Search and this dashboard still are. The
        // price text comes from /config, and when /config hasn't answered yet we name no figure
        // rather than hardcode one that could go stale against Stripe.
        // was: h("p", { className: "fine" }, "Search and this dashboard are free, with no sign-in. The AI extras (Auto-Apply, tailored resumes, the Deep Dive) come with a free monthly allowance",
        // was:   plans && plans.length ? `; ${plans.map(pl => pl.label + (pl.price ? " " + pl.price : "")).join(" and ")} raise it` : "; optional paid plans raise it",
        // was:   ". Made by a UMass student, not affiliated with UMass Amherst.")),
        // The Deep Dive is out of the capped list: worker/src/config.js gives it `allowance: null`,
        // which config.js:10 defines as "no monthly cap", and worker/src/limits.js:106 returns null
        // for it one line before the plan multiplier, so no paid plan raises it. The same page
        // already says so the other way round - core.js allowanceText renders "Deep Dives:
        // unlimited" in the tooltip on this dashboard. The allowance itself is per account
        // (worker/src/index.js GET /me) and every /ai call signs the user in, so "on a free account"
        // keeps the "no sign-in" clause from being read across the whole sentence.
        h("p", { className: "fine" }, "Search and this dashboard are free, with no sign-in. Auto-Apply and tailored resumes come with a free monthly allowance on a free account",
          plans && plans.length ? `; ${plans.map(pl => pl.label + (pl.price ? " " + pl.price : "")).join(" and ")} raise it` : "; optional paid plans raise it",
        // was: ". The Deep Dive is one-time, runs on the same free account, and has no monthly cap. ..."
        // Two over-claims. "No monthly cap" was true only of the unit allowance: worker/src/config.js
        // says USER_BUDGET_CENTS "is what bounds a task with no unit cap (the Deep Dive)", and records
        // honest use reaching it. And nothing enforces "one-time": onboarding.js clears the run id when
        // a Dive finishes ("the next Deep Dive is a new run") and this same file offers an onboarded
        // student the button again, so it is a habit, not a limit.
          ". The Deep Dive has no monthly run allowance of its own, though a per-account AI budget still applies, and it runs on the same free account. Made by a UMass student, not affiliated with UMass Amherst."),
        // Who it is not for, in so many words (2026-10-05 audit): the scope was only implied.
        h("p", { className: "fine" }, "Not for experienced job seekers: if you want full-time or senior roles, Simplify and Jobright cover every level. ",
          h("a", { href: "compare/" }, "See how they compare"), ".")),
      // The "Start in 3 steps" list that used to sit here repeated the setup card's own three
      // steps one screen higher. One copy, on the card, is enough.
      h("div", null, h("h3", null, "How it works"),
        h("ul", null,
          h("li", null, "A scanner checks employer career sites and public job boards several times a day and keeps only student roles."),
          h("li", null, "Your profile stays in this browser. Ranking happens on this page; nothing about you is uploaded."),
          h("li", null, "The optional extension fills in applications for you and always stops before Submit."),
          h("li", null, "Signing in with Google or Microsoft is optional. It lets your chosen states count toward where we scan in more detail."),
          // D1.3 (2026-10-05 audit): the invite mechanic was explained only after sign-in (the Account
          // menu and the nudge), nowhere a new visitor reads. The bonus and the cap come from /config;
          // until it answers, the sentence names no number rather than one that could drift.
          h("li", null, inviteOffer
            ? `Invite a classmate: when they join with a school (.edu) email, you each get ${inviteWords}${inviteOffer.max ? ` (for up to ${inviteOffer.max} classmates)` : ""}.`
            : "Invite a classmate: when they join with a school (.edu) email, you each get extra Auto-Apply runs.")),
        h("div", { className: "landing-actions" },
          h("button", { type: "button", className: "btn primary", onClick: onSetup }, hasProfile ? "Edit my profile" : "Set up your profile"),
          // Added 2026-10-04: until now the only way to the extension from here was the footer link.
          !installed && h("a", { className: "btn", href: installUrl("landing"), target: "_blank", rel: "noopener" }, "Add Auto-Apply to Chrome"),
          h("button", { type: "button", className: "btn quiet", onClick: () => setOpen(false) }, "Hide this"))));
  }

  // ---------- weekly email ----------
  // A plain HTML form that posts straight to the email provider (window.CONFIG.digest). Buttondown's
  // docs say not to send it with fetch: the subscriber may have to pass a CAPTCHA or fix a typo on
  // Buttondown's own page, so the browser has to follow the response. target="_blank" puts that page
  // in a new tab and leaves the student's search where it was. Nothing here touches the Worker, so
  // the address never reaches InternScout's servers.
  // `fields` are the profile's field tags (majors' tags plus hand-picked fields, as in scoring). Each
  // ticked box is one `tag` value. The value is the tag key ("swe"), not its label, because the key is
  // what listings carry in field_tags and it never changes wording. Buttondown adds tags on a repeat
  // sign-up rather than replacing them, so unticking a box later cannot remove a tag.
  // The past emails (2026-10-06): Buttondown's public web archive of the newsletter, worked out from the
  // form's address (IS.digestArchive), so a student can see what they'd get before giving an address.
  // js/count.js counts a submit of this form (class "digest") as "digest_signup", with nothing about who.
  function Digest({ cfg, fields = [], hasProfile, onSetup, placement = "footer", compact = false }) {
    const [sent, setSent] = useState(false);
    const prov = cfg.provider || "Buttondown";
    const archive = IS.digestArchive(cfg.formAction);
    const id = "digest-" + placement;
    // Only the form's status line changes on submit. The form and its inputs stay mounted, because
    // React can re-render before the browser has read the fields it is about to send.
    return h("form", { id: id + "-form", className: "notice quietnote digest" + (compact ? " digest-compact" : ""), action: cfg.formAction, method: "post", target: "_blank", rel: "noopener",
      "data-digest-placement": placement, "aria-labelledby": id + "-title", onSubmit: () => setSent(true) },
      h("b", { id: id + "-title" }, "New internships in your inbox every Monday. Free. "),
      compact
        ? "A few new roles and links to the rest. Everyone gets the same email. Confirm by email first; unsubscribe any time. "
        : "A weekly selection of new internships, co-ops and research roles, with links to explore the rest. Everyone gets the same email for now. Confirm by email first; unsubscribe any time. ",
      `Your address${!compact && fields.length ? " and the fields you tick go" : " goes"} to ${prov}, which sends the email. `,
      h("a", { href: "privacy.html#digest" }, "Details"),
      archive && " · ",
      archive && h("a", { href: archive, target: "_blank", rel: "noopener" }, "Browse past emails"),
      // The key remounts the boxes when the profile's fields change, so each new field starts ticked.
      !compact && (fields.length > 0
        // was: h("legend", null, "Fields from your profile")
        ? h("fieldset", { key: fields.join(","), id: id + "-fields" }, h("legend", null, "Optional: save fields from your profile for future email matching (not personalized yet)"),
          h("div", { className: "checks" }, fields.map(t => h("label", { key: t, className: "check" },
            h("input", { type: "checkbox", id: id + "-tag-" + t, name: "tag", value: t, defaultChecked: true }), IS.fieldLabel(t)))))
        // was: "With no fields picked, the email covers every field. ... to narrow it." For now every
        // subscriber gets the same email (growth/digest_send.py), so ticked fields only get saved.
        : h("div", { style: { marginTop: 8 } },
          h("a", { href: "#", onClick: prevent(onSetup) }, hasProfile ? "Add fields to your profile" : "Set up your profile"), " to improve your search results. You can subscribe without a profile.")),
      h("div", { className: "digest-row" },
        h("label", { htmlFor: id + "-email" }, "Email"),
        h("input", { id: id + "-email", type: "email", name: "email", required: true, autoComplete: "email", spellCheck: false }),
        h("button", { id: id + "-submit", type: "submit", className: "btn primary" }, "Email me new internships"),
        sent && h("span", { className: "muted", role: "status" }, `${prov} opened in a new tab. Finish there if it asks, then look for the confirmation email.`)),
      // In every one of Buttondown's sample forms; its docs don't say what it does, so it stays.
      h("input", { type: "hidden", name: "embed", value: "1" }));
  }

  // Quick choices patch the existing profile; the full editor remains available below.

  return {
    PlaceNotice, useNarrow, SiteNav, Landing, Digest,
  };
}

export function useDigestPrompt({ useRef, IS }) {
  const digestPrompt = useRef(null);
  if (!digestPrompt.current) digestPrompt.current = typeof IS.createDigestNudge === "function"
    ? IS.createDigestNudge() : { claim: () => false, shown() {}, finish() {} };
  return digestPrompt;
}
