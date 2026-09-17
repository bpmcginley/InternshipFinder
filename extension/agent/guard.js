// Submit guard. The agent may fill fields and move between steps, but it can never press a
// final "submit" button: that click is reserved for the human. Enforced in code, not left to
// the model. Pure core (node-testable) + small DOM helpers. Loaded in MAIN and ISOLATED worlds.
(function (root) {
  if (root.ISGuard) return;

  // "Confirm and send" / "I agree and apply" are the same button as "Confirm and submit"; without them
  // the label has no word FINAL_RE knows and it falls through to AMBIGUOUS_RE, which is anchored and so
  // only matches a bare "Confirm".
  const FINAL_RE = /\b(submit|send\s+(my\s+|your\s+|the\s+)?application|finish\s+(my\s+|your\s+|the\s+)?application|complete\s+(my\s+|your\s+|the\s+)?application|confirm\s+(my\s+|your\s+|the\s+)?application|(confirm|agree)\s+(and|&)\s+(submit|apply|send))\b/i;
  // Buttons that are final on some sites and harmless on others ("Apply" on a job page opens
  // the form; "Apply" under a filled form sends it). Refused once the page has filled fields.
  const AMBIGUOUS_RE = /^\s*(apply|apply\s+now|apply\s+for\s+this\s+(job|position|role|opportunity)|apply\s+to\s+this\s+(job|position|role)|send|send\s+now|finish|done|complete|confirm|i'?m\s+done|i\s+am\s+done)\s*[.!]?\s*$/i;
  // Only rescues a button whose id says "submit" (line in classify). Anchored at the start of the label:
  // unanchored, any label merely *containing* a safe word -- "Agree & Continue" on the last page of a
  // Workday flow whose button id is submitApplication -- was rescued to "ok" and clickable. A label that
  // starts with the safe word ("Next: Work experience", "Create Account") is still a navigation button.
  const SAFE_RE = /^\s*(save\s+(and|&)\s+continue|next|continue|back|previous|add(\s+another)?|upload|sign\s*(in|up)|create\s+(an\s+)?account|log\s*in|register|verify|search|autofill|apply\s+manually|use\s+my\s+last\s+application)\b/i;

  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  // ---- gates the human has to clear themselves ----
  // A code sent to the student's inbox is theirs to read: the agent cannot reach it, and guessing
  // only burns steps. Detected here rather than left to the model, for the same reason the submit
  // guard is. Sign-up and sign-in pages are deliberately NOT gates — the agent handles those
  // itself (see the ACCOUNTS rules and fill_secret in background/agent.js).
  const VERIFY_RE = /verif(y|ication)|one[-\s]?time\s*(code|password|pin)|security\s+code|confirmation\s+code|enter\s+the\s+code|we\s+(sent|emailed)\s+you|check\s+your\s+(email|inbox)|\d\s*-?\s*digit/i;
  // A bare "Code", or an explicitly named verification code — never a postal/country/promo code.
  const CODE_FIELD_RE = /\b(verification|confirmation|security|access|activation|one[-\s]?time)\s*(code|pin)\b|\b(otp|passcode)\b|^\s*(code|pin)\s*\*?\s*$/i;
  const NOT_CODE_RE = /postal|zip|country|area|promo|discount|referral|coupon|province|dial|sort/i;
  // Anti-bot interstitials (Cloudflare, DataDome, PerimeterX, Imperva, Akamai) that replace the page.
  const BOTWALL_RE = /just a moment|checking (if the site connection is secure|your browser)|verify(ing)? (that )?you are (a )?human|are you a robot|press (&|and) hold|unusual (traffic|activity) from your|pardon our interruption|request unsuccessful\. incapsula|access to this page has been denied/i;

  // page: {headings:[], step, buttons:[{text}], text, elements:[{kind,label,question}], captcha}
  // -> {kind: "email_verification" | "captcha", reason} or null
  function detectGate(page) {
    if (!page) return null;
    const els = page.elements || [];
    const heads = norm([...(page.headings || []), page.step || ""].join(" "));
    const wide = norm([heads, (page.buttons || []).map((b) => b.text).join(" "), page.text || ""].join(" "));
    const hasCode = els.some((e) => {
      const l = norm([e.label, e.question].filter(Boolean).join(" "));
      return CODE_FIELD_RE.test(l) && !NOT_CODE_RE.test(l);
    });

    if (hasCode && VERIFY_RE.test(wide)) return { kind: "email_verification", reason: "this page wants a verification code sent to your email" };
    // "We emailed you a code" interstitial with nothing to fill in yet.
    if (!els.length && VERIFY_RE.test(heads)) return { kind: "email_verification", reason: "this page is waiting on an email verification step" };
    // A CAPTCHA beside a filled form is left for the human at submit time; one that IS the page blocks everything.
    const actionable = (page.buttons || []).some((b) => !b.blocked);
    if (!els.length && ((page.captcha && !actionable) || (BOTWALL_RE.test(norm([page.title || "", wide].join(" "))) && norm(page.text).length < 1500)))
      return { kind: "captcha", reason: "the site is showing a CAPTCHA / \"are you human\" check" };
    return null;
  }

  // d: {text, value, ariaLabel, title, type, automationId}
  function classify(d) {
    const text = norm([d.text, d.value, d.ariaLabel, d.title].filter(Boolean).join(" "));
    if (FINAL_RE.test(text)) return "final";
    if (/submit/i.test(d.automationId || "") && !SAFE_RE.test(text)) return "final";
    if (AMBIGUOUS_RE.test(norm(d.text || d.value || d.ariaLabel))) return "ambiguous";
    if (!text && d.type === "submit") return "ambiguous";   // unlabeled submit-type button
    return "ok";
  }

  // ctx: {filledFields}
  function allowClick(d, ctx) {
    const c = classify(d);
    if (c === "final") return { allowed: false, reason: "final submit button (reserved for you)" };
    if (c === "ambiguous" && (ctx && ctx.filledFields > 0))
      return { allowed: false, reason: "this looks like the final send button on a filled form" };
    return { allowed: true };
  }

  // ---- DOM helpers (browser only) ----
  function describe(el) {
    const tag = (el.tagName || "").toLowerCase();
    let type = (el.getAttribute && el.getAttribute("type")) || "";
    if (tag === "button" && !type && el.form) type = "submit";
    return {
      text: norm(el.innerText || el.textContent).slice(0, 160),
      value: tag === "input" ? el.value : "",
      ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : "",
      title: el.getAttribute ? el.getAttribute("title") : "",
      type: type.toLowerCase(),
      automationId: el.getAttribute ? [el.getAttribute("data-automation-id"), el.id, el.getAttribute("name")].filter(Boolean).join(" ") : "",
    };
  }

  // Some ATS platforms (SmartRecruiters oneclick-ui, Oracle JET) render real fields inside shadow
  // roots, invisible to plain querySelectorAll. Without this, filledFields can undercount on
  // those pages, which weakens the "block ambiguous Apply/Send once the form is filled" check below.
  function deepQueryAll(selector, root) {
    root = root || document;
    const out = [...root.querySelectorAll(selector)];
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) out.push(...deepQueryAll(selector, el.shadowRoot)); });
    return out;
  }

  // Widgets that sit on job pages with values already set but are not the application: cookie managers
  // (OneTrust ships pre-checked hidden switches), site search, and job-alert sign-ups (SuccessFactors'
  // "every 7 days" box). Counting them blocked "Apply" on the job page before anything was filled.
  const NOT_APPLICATION_SEL = '#onetrust-consent-sdk, #CybotCookiebotDialog, #usercentrics-root, .truste_box_overlay, [id*="cookie" i], [class*="cookie" i], ' +
    '[role="search"], [class*="subscribe" i], [id*="subscribe" i], [class*="job-alert" i], [class*="jobalert" i], [id*="jobalert" i], [id*="job-alert" i], [class*="newsletter" i], [id*="newsletter" i]';

  // Site chrome outside any form: Workday's header language picker, TikTok's top-bar <menu> select,
  // Rippling's footer "Search" locale combobox. The model was offered these as application questions.
  const CHROME_SEL = 'header, nav, footer, menu, [role="banner"], [role="navigation"], [role="contentinfo"], [role="menubar"]';
  // A form whose only action is one of these is a talent-community / alert sign-up beside the real
  // application (Waymo's "Departments / Locations / Notify me" sidebar), not the application itself.
  const SIGNUP_BTN_RE = /^\s*(notify me|subscribe|get (job )?alerts|create (a )?(job )?alert|sign up for (job )?alerts|join (our )?(talent (community|network|pool)|mailing list)|keep me (posted|updated))\b/i;
  const LOCALE_RE = /^\s*(español|deutsch|français|italiano|português|nederlands|polski|türkçe|русский|日本語|中文|简体中文|繁體中文|한국어|bahasa|tiếng việt)/i;
  function notApplication(el) {
    if (!el || !el.closest) return false;
    if (el.closest(NOT_APPLICATION_SEL)) return true;
    const form = el.closest("form");
    if (!form) {
      if (el.closest(CHROME_SEL)) return true;
      const a = norm((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder"))) || "");
      if (/^search\b/i.test(a)) return true;
      // A job-board search box: "Enter Title, Skill, or Location" (TikTok). A form field asks one thing ("Job title").
      const asks = new Set((a.toLowerCase().match(/\b(title|skill|keyword|location|job|city|zip|department)s?\b/g) || []).map((w) => w.replace(/s$/, "")));
      if (asks.size >= 2 && /,|\bor\b/i.test(a)) return true;
      // Locale pickers list languages by their own names; an application question would say "Spanish".
      if (el.tagName === "SELECT") {
        const texts = [...el.options].map((o) => o.text);
        const native = texts.filter((t) => LOCALE_RE.test(t)).length;
        if (native >= 2 || (native >= 1 && texts.some((t) => /^\s*english\b/i.test(t)))) return true;
      }
      return false;
    }
    if (form.getAttribute("role") === "search") return true;
    const acts = [...form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')].map((b) => norm(b.innerText || b.value || b.textContent)).filter(Boolean);
    return acts.length > 0 && acts.every((t) => SIGNUP_BTN_RE.test(t)) && !form.querySelector('input[type="file"], textarea');
  }

  function pageContext(doc) {
    let filled = 0;
    deepQueryAll("input, textarea, select", doc).forEach((el) => {
      const t = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "search", "image", "reset", "range", "color"].includes(t)) return;
      if (/search/i.test(el.name || el.id || "")) return;
      if (notApplication(el)) return;
      if (t === "checkbox" || t === "radio") {
        // Styled checkboxes hide the input itself, so accept a rendered label or parent instead.
        const shown = (n) => n && n.getClientRects && n.getClientRects().length;
        if (el.checked && (!el.getClientRects || shown(el) || shown(el.parentElement) || (el.labels && [...el.labels].some(shown)))) filled++;
        return;
      }
      if (t === "file") { if (el.files && el.files.length) filled++; return; }
      // Read-only, disabled or unrendered boxes (e.g. Oracle's hidden "Copy Link" input) are not answers.
      if (el.readOnly || el.disabled) return;
      if (el.getClientRects && !el.getClientRects().length) return;
      if (el.tagName === "SELECT") { if (el.selectedIndex > 0) filled++; return; }
      if (norm(el.value)) filled++;
    });
    return { filledFields: filled };
  }

  function clickTarget(el) {
    return el && el.closest ? el.closest('button, input[type="submit"], input[type="button"], a, [role="button"]') : null;
  }

  function isFinalElement(el, doc) {
    const t = clickTarget(el);
    if (!t) return false;
    return !allowClick(describe(t), pageContext(doc || document)).allowed;
  }

  // Defense in depth: while the agent drives a tab, synthetic (untrusted) clicks on final
  // buttons are swallowed. Real clicks from the human always go through.
  function installClickBlock(doc) {
    if (doc.__isClickBlock) return;
    const h = (e) => {
      if (e.isTrusted) return;
      if (isFinalElement(e.target, doc)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    doc.addEventListener("click", h, true);
    doc.__isClickBlock = h;
  }
  function removeClickBlock(doc) {
    if (doc.__isClickBlock) { doc.removeEventListener("click", doc.__isClickBlock, true); delete doc.__isClickBlock; }
  }

  const api = { classify, allowClick, describe, pageContext, clickTarget, isFinalElement, installClickBlock, removeClickBlock, detectGate, notApplication, FINAL_RE, AMBIGUOUS_RE };
  root.ISGuard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
