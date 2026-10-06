# Chrome Web Store listing for 0.5.5

Paste these into the Chrome Web Store developer dashboard (Store listing tab) when submitting 0.5.5.
Updating this file does **not** change the listing; after publishing, reopen the public page and check it.
Written 2026-10-06 from the live 0.5.4 listing. Four reasons to change it now:

1. **A privacy sentence is no longer true.** The live text says the profile is stored only in Chrome and
   that the only profile data on InternScout's server is the chosen states. Since Deep Dive account saving
   became the default, a signed-in student's profile is saved to their account (encrypted, can be turned
   off; `extension/lib/sync.js`, `docs/privacy.html#saved`). The new SAFE BY DESIGN paragraph says so.
2. **0.5.4 and 0.5.5 changed what students see:** Workday's dropdowns are filled by rules (Workday is about
   half of all open listings), setup is two steps (sign in, add a resume), and a run that stops making
   progress pauses instead of spending AI.
3. **Search terms.** Students look for "internship", "auto apply", "autofill job applications", "Workday".
   The listing used "internship" once and never said "autofill" or named the application systems. These are
   used where they describe the product, not repeated as a keyword list (the store's spam policy).
4. **The search site is the reason to install,** and the old text didn't name it or its size.

The name and summary come from `extension/manifest.json` ("name" and "description"), so they only change
with a release. They are left as they are in 0.5.5; the proposed versions are below for Bruce to decide.

## Name (manifest "name", max 75 characters)

Current: `InternScout Auto-Apply`
Proposed: `InternScout Auto-Apply: Internship Application Autofill` (55 characters)

## Summary (manifest "description", max 132 characters)

Current: Fills internship applications from your saved profile and stops at the submit button. It never
submits an application for you.
Proposed (129 characters): `Autofill internship applications on Workday, Greenhouse, Lever and more from your resume. Stops at Submit: you always send it.`

## Description

InternScout helps college students in every major apply to internships, co-ops and research roles faster. Find roles in a free search of 14,000+ internships at internscout.org, then let Auto-Apply fill each application from your resume. It never submits an application for you: it fills the form and stops at the submit button, and you decide whether to send it.

HOW IT WORKS
• Sign in free with Google or Microsoft and add your resume. That's all Auto-Apply needs to start; the Deep Dive interview and voice notes are optional and make answers better.
• Pick listings on the free InternScout dashboard, or paste any application link.
• The extension opens each posting and walks every step of the application: sign-up, uploads, questions and forms.
• Contact details, work authorization, demographic questions and Workday's dropdowns are filled by fixed rules from your profile; the AI handles only what's left.
• It stops at the submit button. You review every answer and press Submit yourself.
• If a page stops changing, it pauses and hands the step back to you instead of trying again and again.

WHERE IT WORKS
Workday, Greenhouse, Lever, Ashby, iCIMS, Oracle, SmartRecruiters, SuccessFactors, Taleo, Workable, Jobvite and more of the systems employers use for student hiring. Employer-run career sites may need more help from you.

WHAT IT DOES NOT DO
• It does not submit applications. You press Submit yourself, every time.
• It does not apply on your behalf while you're away, and it does not mass-apply.
• It does not write anything you haven't seen. Every answer is on screen before you send it.

SAFE BY DESIGN
• The submit guard is code, not an AI instruction: submit buttons are blocked, not merely discouraged.
• Your resume and other uploaded files stay in Chrome on your device; we keep no copy of them. When you sign in, an encrypted copy of your Deep Dive profile is saved to your InternScout account by default so you can restore it on another device. You can turn this off in the extension, which deletes the saved copy. Your demographic answers, saved application-site logins and your own AI keys are never saved to your account. Your chosen states help decide where we scan in more detail.
• Some AI features send the relevant parts of your resume or profile in the request that generates the result; the privacy policy lists exactly what each feature sends.
• Many application systems make you register before they will take an application. The extension can create that account for you: it signs up with your email, sets a password it generates (or the one password you choose during setup), and saves that email and password in the extension's storage on your device so it can sign you back in next time.
• Passwords for application sites are filled by the extension and never sent to the AI or to us.
• CAPTCHAs, email codes and two-step sign-in always go to you.

WHAT IT COSTS
• Searching and the InternScout dashboard are free and need no account at all.
• Auto-Apply needs a free sign-in with Google or Microsoft. Every account gets a free monthly allowance, and the extension shows what's left.
• A school .edu email gets about twice the free allowance: 25 applications filled and 10 tailored resumes a month, against 12 and 5 for any other email. Sign in with Google using that address. A personal Microsoft account cannot prove a school domain, so it stays on the smaller allowance even if the address ends in .edu.
• Microsoft sign-in currently accepts personal Microsoft accounts only. A school or work Microsoft account, such as an @umass.edu login, may be refused, so use Google for those.
• Optional paid plans raise the allowance: Supporter $4/month (2×), Pro $8/month (4×). You upgrade on the dashboard, not in the extension. Staying on the free allowance is a real option; nothing expires into a paywall.
• Or use your own AI key instead of a plan: the Deep Dive setup accepts an Anthropic (Claude) or Google (Gemini) API key, and then you pay that provider directly and our allowance no longer applies.
• We don't store your resume, prompts or AI replies.

Built by one student, made for all students. Made by a UMass Amherst student. Not affiliated with UMass Amherst, or with any employer or application system. Privacy: https://internscout.org/privacy

## Screenshots

The store takes 1280×800 or 640×400 images. `growth/internscout-comparison.png` is 1080×1350, so it
needs a landscape version before it can go in; ask for one if wanted.
