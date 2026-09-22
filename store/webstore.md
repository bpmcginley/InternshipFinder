# Chrome Web Store listing: InternScout Auto-Apply

Copy these into the Developer Dashboard. Bruce pays the $5 developer fee and submits.
Keep this file in step with `extension/manifest.json` and `docs/privacy.html`.

## Store listing

**Name:** InternScout Auto-Apply

"Auto-Apply" is the one phrase in this listing that could be read as "it applies for me". Every other
surface has to contradict that immediately, which is why the short description, the first line of the
long description and the manifest description all say it outright. Keep them saying it.

No other company's name goes in the item name, the icon or the promotional images — not Workday, not
Greenhouse, not LinkedIn, not a university. Using someone's trademark in the title or artwork implies
an affiliation InternScout does not have, and it is a common rejection reason. Naming those systems
inside the description as sites the extension works on is fine, with the non-affiliation line below.

**Short description** (max 132 characters):
> Fills internship applications from your saved profile and stops at the submit button. It never submits an application for you.

**Category:** Tools (alternative: Productivity)

**Long description:**
> InternScout helps college students apply to internships, co-ops, research programs and fellowships faster. It never submits an application for you: it fills the form and stops at the submit button, and you decide whether to send it.
>
> HOW IT WORKS
<!-- was: > • Do the Deep Dive once: add your resume and other files, basic facts, and a few short answers about your projects and goals. -->
<!-- The Deep Dive is the first step a reader sees, and it is an AI task, so signed out it 401s (see the
     reviewer-notes correction at the bottom of this file). Left as it was, the first bullet of HOW IT
     WORKS followed by "the free dashboard" reads as "start here, no account needed" — which is exactly
     the wrong impression to give a reviewer about the very first thing they will try. -->
> • Sign in free with Google or Microsoft, then do the Deep Dive once: add your resume and other files, basic facts, and a few short answers about your projects and goals.
> • Pick listings on the free InternScout dashboard, or paste any application link.
> • The extension opens each posting and walks every step of the application: sign-up, uploads, questions and forms.
> • It fills everything from your profile and stops at the submit button.
> • You review every answer and press Submit yourself.
>
> WHAT IT DOES NOT DO
> • It does not submit applications. You press Submit yourself, every time.
> • It does not apply on your behalf while you're away, and it does not mass-apply.
> • It does not write anything you haven't seen. Every answer is on screen before you send it.
>
> SAFE BY DESIGN
> • The submit guard is code, not an AI instruction: submit buttons are blocked, not merely discouraged.
<!-- was: > • Your profile and files stay in Chrome on your device. -->
<!-- "stay" promises two different things — stored here, and never sent — and only the storage half is
     true. extension/background/tailor.js line 185 sends the resume PDF whole as
     `{ type: "document", source: { type: "base64", media_type: "application/pdf", data: orig.b64 } }`,
     and extension/onboarding/onboarding.js line 68 docBlock() does the same for the Deep Dive. The
     privacy table further down this same file already ticks "Personally identifiable information: Yes",
     so the old bullet contradicted the listing it sits in, and `docs/privacy.html` (which line 4 says to
     keep this file in step with) carries the corrected wording. -->
<!-- Second pass, 2026-09-19: "we keep no copy of them" was a fresh absolute that the Location row
     of this file's own data table contradicts. docs/js/core.js postDemand() POSTs the states built
     from the saved profile, and the Worker keeps them against a hashed id to decide where to scan.
     Scoped to what really is never copied, with the one exception named. -->
<!-- was: > • Your profile and files are stored in Chrome on your device, and we keep no copy of them. Stored is not the same as never sent: the Deep Dive and resume tailoring send your resume to the AI as part of the request. -->
> • Your profile and files are stored in Chrome on your device. We keep no copy of your resume, your files or your answers. The one profile item that reaches our server is the list of states you pick for scanning, kept against a scrambled ID. Stored is not the same as never sent: the Deep Dive and resume tailoring send your resume to the AI as part of the request.
> • Many application systems make you register before they will take an application. The extension can create that account for you: it signs up with your email, sets a password it generates (or the one password you choose during setup), and saves that email and password in the extension's storage on your device so it can sign you back in on your next application there.
<!-- was: > • Passwords for application sites are filled by the extension and never sent to the AI. -->
> • Passwords for application sites are filled by the extension and never sent to the AI or to us.
> • CAPTCHAs, email codes and two-step sign-in always go to you.
>
<!-- was: > FREE FOR STUDENTS -->
<!-- was: > • Sign in with Google or Microsoft to use the AI features. There's nothing to set up. A school .edu email gets twice the monthly AI use. -->
<!-- was: > • Each student gets a free monthly allowance. The extension shows what's left. -->
<!-- The old block said the product is free, full stop. Paid plans went live in worker/wrangler.toml
     (PAYMENTS_ENABLED = "1", Supporter $5/month, Pro $12/month) and Bruce confirmed on 2026-09-19 that
     they stay on at launch, so "FREE FOR STUDENTS" is now a false pricing claim on a listing that has
     purchasable tiers behind it — the exact shape of "undisclosed paid feature" the store rejects for.
     Prices and plan labels below come from worker/src/config.js PLANS, not from memory. -->
> WHAT IT COSTS
> • Searching and the InternScout dashboard are free and need no account at all.
> • The AI features need a free sign-in with Google or Microsoft. There's nothing else to set up.
> • Microsoft sign-in currently accepts personal Microsoft accounts only. A school or work Microsoft account — an @umass.edu login, for example — may be refused, so use Google for those.
> • Every account gets a free monthly AI allowance. The extension shows what's left.
<!-- was: > • A school .edu email doubles that free allowance. -->
<!-- The doubled allowance is granted by worker/src/auth.js tierOf(), which for Microsoft returns "edu"
     only when `claims.tid !== MS_CONSUMER_TENANT && yes(claims.xms_edov)`. A personal Microsoft account
     IS that consumer tenant (auth.js line 9), so it always falls through to "general" —
     GENERAL_ALLOWANCE_PCT = "50" in worker/wrangler.toml — even when the address ends in .edu. Two
     bullets above, this block steers students to a personal Microsoft account, so as written the listing
     promised an allowance the code will not grant on the path it recommends. The extension already tells
     the student the whole rule at extension/onboarding/onboarding.js line 188. -->
> • A school .edu email doubles that free allowance — sign in with Google using that address. A personal Microsoft account cannot prove a school domain, so it stays on the smaller allowance even if the address ends in .edu.
> • Optional paid plans raise it further — Supporter $5/month, Pro $12/month — and you upgrade on the dashboard, not in the extension. Staying on the free allowance is a real option; nothing expires into a paywall.
<!-- Added, not replacing anything: the extension ships a bring-your-own-key path that this block never
     mentioned. extension/lib/store.js line 80 carries `ai: { provider: "internscout", apiKey: "",
     geminiKey: "" }`, the Deep Dive Setup step offers "Your own Anthropic (Claude) key" and "Your own
     Google (Gemini) key" (extension/onboarding/onboarding.js lines 108-110), and
     extension/background/gemini.js line 133 OWN_KEY_HINT points the student at it whenever an allowance,
     a run limit or the global budget is hit. A reviewer who finds that key field after reading a pricing
     block that says a plan is the only way past the allowance will ask why it was not disclosed. -->
> • Or use your own AI key instead of a plan: the extension's Deep Dive setup accepts an Anthropic (Claude) or Google (Gemini) API key, and then you pay that provider directly and our monthly allowance no longer applies.
> • We don't store your resume, prompts or AI replies.
>
> Works best on the big application systems — Workday, Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS and similar. Employer-run career sites may need more help from you.
>
> Made by a UMass Amherst student. Not affiliated with UMass Amherst, or with any of the application systems or employers named above; those names are used only to say where the extension works.
> Privacy: https://bpmcginley.github.io/InternshipFinder/privacy.html

**Screenshots to take (1280×800):** dashboard with listings ticked; Deep Dive files step; side panel
queue with "Ready to submit"; a filled form paused at Submit with the overlay.

Blur or crop the employer's logo and product chrome in the form screenshot, and don't caption a shot
with a system's name. The screenshot that carries the whole message is the one paused at Submit — caption
it "InternScout stops here. You press Submit." Keep the item icon and any promo tile to the InternScout
mark and plain text.

**Small promo tile (440×280):** `store/promo-tile-440x280.png`, built by `python scripts/make_promo_tile.py`
(needs Pillow). This folder sits outside `docs/`, so GitHub Pages does not publish these notes.

## Single purpose

> InternScout Auto-Apply helps a student fill out internship application forms from the profile they saved in the extension, and stops before submitting so the student reviews and submits each application.

<!-- Second pass, 2026-09-19, `storage` row: "never leave the device" was a second absolute where the
     first had just been removed. A generated password IS typed into the employer's page, so it leaves
     the device by design; what is true is that it never comes to us or to the model. Matches the
     Authentication row below and docs/privacy.html.
     was: The site passwords never leave the device: the extension types them into the page itself and the AI is never given one. -->

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Saves the student's profile, answers, settings and queue on the device in `chrome.storage`, along with the accounts the extension creates on employer application sites — the sign-up email and the password it generated for that site — so it can sign the student back in on a later application there. The site passwords are never sent to us or to the AI — the extension types them only into that site's own form, and the AI is never given one. The profile text, the saved files and the sign-up email do travel with an AI request; the data table below records that. |
| `unlimitedStorage` | Resumes, transcripts, cover letters and writing samples are stored locally as files. Together they can exceed the default storage quota. |
| `tabs` | Opens each queued application in its own new tab, in the foreground, and follows that tab through the steps of the application. The tab has to be the active one: Chrome throttles a backgrounded tab to about one timer per second and gives it no animation frames, and the form-filling agent cannot read or drive a page that barely redraws. The extension also brings that tab back to the front when a paused run resumes or the student needs to act (a question, CAPTCHA or Submit). |
| `tabGroups` | Groups the application tabs a run opens so they don't clutter the student's window, and lets the student close them together. |
| `scripting` | Injects the form-filling agent and the submit guard into the application page the student queued. That page is on the employer's application site, which is not known in advance. |
| `webNavigation` | Detects when a multi-step application moves to its next page or redirects (for example to a sign-in step), so the agent re-attaches and continues. |
| `sidePanel` | Shows the application queue: Needs you, Ready to submit, In progress and Done. The student answers questions there. |
| `notifications` | Tells the student when an application is ready to submit or needs their input. The application tab is in the foreground while the run works, but a run can wait a long time, and students switch to another window or another app meanwhile. The notification is what brings them back to the tab. |
| `identity` | Signs the student in with their Google or Microsoft account (`chrome.identity.launchWebAuthFlow`). The sign-in token lets our server work out which monthly AI allowance applies — free, the doubled .edu one, or a paid plan — and how much of it is left. We never receive passwords. |
| Host permissions: 19 applicant-tracking domains | The systems employers run their application forms on (`*.myworkdayjobs.com`, `*.greenhouse.io`, `*.lever.co`, `*.ashbyhq.com`, `*.icims.com`, `*.taleo.net` and 13 more, listed in `manifest.json`). These carry about 81% of the postings we index. The extension injects the form-filling agent and the submit guard into the application page the student queued, on a tab it opened for that application. |
| Optional host permission `<all_urls>` | Many employers run their application form on their own site instead (`careers.tesla.com`, `amazon.jobs`, `cityjobs.nyc.gov`, and a long tail that grows with every employer added), and a student can paste any application link. These can't be listed in advance, so the extension asks for one specific site at the moment it's needed: when a queued application is on a site it can't reach, the run pauses and the side panel shows an "Allow amazon.jobs" button. The student grants that one domain, or declines and the application stays paused. Nothing is granted at install. |
| Content script on `bpmcginley.github.io/InternshipFinder/*` | Lets the InternScout dashboard send listings the student picked to the extension, and show which ones were applied to. This is the only site the extension talks to that isn't an application form. |

<!-- ROW HISTORY for the table above. These notes sit below the table rather than above the rows they
     describe, and that placement is the point: GitHub Flavored Markdown ends a table body at the first
     line that is not a row, and an HTML comment is a block-level element, so a comment between rows cut
     this table off at the delimiter line — github.com showed a header with no rows and printed every row
     under it as literal pipe text. Nothing was deleted; each note names its row and quotes the replaced
     text verbatim. -->

<!-- `storage` row, first replacement.
     was: | `storage` | Saves the student's profile, answers, settings, queue and application-site accounts on the device in `chrome.storage`. |
     "application-site accounts" was true but too quiet about the part a reviewer cares about: the
     extension can register a new account on an employer's site with a password it generates. Spelled out
     in the row and in the long description so the listing matches docs/privacy.html rather than lagging it. -->

<!-- `storage` row, second replacement (the sentence about what leaves the device).
     was: | `storage` | Saves the student's profile, answers, settings and queue on the device in `chrome.storage`, along with the accounts the extension creates on employer application sites — the sign-up email and the password it generated for that site — so it can sign the student back in on a later application there. None of it leaves the device. |
     "None of it leaves the device" was false for three of the five things the row lists, and it
     contradicted this file's own data table 40 lines further down ("Personally identifiable information |
     Yes", "Website content | Yes"): the profile goes out as `CANDIDATE PROFILE (JSON)` at
     extension/background/agent.js line 616, the sign-up email of each site account goes out inside
     accountLine() at agent.js lines 365-369 and 608, and a PDF resume goes out whole as base64 at
     extension/background/tailor.js line 185. What does stay local is the site password: the fill_secret
     tool at agent.js line 720 passes it straight to the page and its tool schema at line 66 tells the
     model "The password is never shown to you", and profileForModel() at extension/lib/store.js line 172
     excludes files, passwords and keys. A reviewer who reads a permission justification that the item's
     own data disclosure contradicts has found the textbook deceptive-disclosure case. -->

<!-- `tabs` row.
     was: | `tabs` | Opens each application in a background tab, tracks its progress, and brings the tab forward when the student needs to act (a question, CAPTCHA or Submit). |
     extension/background/agent.js ensureTab() creates the tab with `active: true` and re-activates it on
     Resume; its comment records why (a backgrounded tab gets no requestAnimationFrame and one timer a
     second — five chained 100ms timers measured 6.8s on a real form). "Background tab" was never what the
     code did, and a reviewer who watches the extension run sees it take the foreground immediately. -->

<!-- `notifications` row.
     was: | `notifications` | Tells the student when an application is ready to submit or needs their input, since applications run in background tabs. |
     Same correction as the `tabs` row: the run holds the foreground tab, so "since applications run in
     background tabs" is not the reason notifications exist. The real reason is that a run can sit waiting
     for minutes and students switch to another window or another app while it works. -->

<!-- `identity` row, first replacement.
     was: | `identity` | Signs the student in with their Google or Microsoft account (`chrome.identity.launchWebAuthFlow`). The sign-in token lets our server check the student's monthly AI allowance. We never receive passwords. |
     The token now also decides which allowance applies, because `GET /me` returns the plan as well as the
     tier (worker/src/index.js). Saying only "allowance" understates what the sign-in is used for now that
     paid plans are live, and the data table below has to agree with this row. -->

<!-- `identity` row, second replacement: the trailing sentence "Microsoft sign-in presently accepts
     personal Microsoft accounts only." was dropped from the row. The Dashboard field answers one
     question — why this extension needs this permission — and which Azure tenants the app registration
     accepts does not justify `identity`; it only prompts the reviewer to ask why the item ships a
     provider it calls restricted. The fact itself is not lost: it is stated in the listing body under
     WHAT IT COSTS and again in the reviewer notes at the end of this file, which are the two places a
     reviewer and a student respectively need it. -->

<!-- Content script row.
     was: | Content script on `bpmcginley.github.io/InternshipFinder/*` and localhost | Lets the InternScout dashboard send listings the student picked to the extension, and show which ones were applied to. Localhost is for development. |
     "and localhost" and the "Localhost is for development" sentence are dropped because the uploaded
     package does not contain them: scripts/package_extension.py filters every content_scripts "matches"
     entry through LOCAL_RE for BOTH zips, so localhost is gone from the store build's manifest. Justifying
     a match the reviewer cannot find in the manifest invites a question we would then have to answer. -->

**Remote code:** No. All JavaScript ships inside the package (including the vendored `mammoth` library for reading DOCX files). The extension calls our server and AI APIs for data only; it doesn't download or run code.

## Privacy practices (data use)

<!-- Second pass, 2026-09-19, the paragraph below: "the saved resume or other file itself, sent whole"
     over-stated it. extension/onboarding/onboarding.js docBlock() sends base64 only for a PDF; anything
     else is read on the device (mammoth for DOCX) and sent as text, sliced at 60,000 characters.
     was: ...and — for a Deep Dive or a tailored resume — the saved resume or other file itself, sent whole. -->

**Privacy policy URL:** https://bpmcginley.github.io/InternshipFinder/privacy.html

<!-- was: Chrome counts data as "collected" when it leaves the device. Profile data stays local except for the text an AI task needs. That text passes through our Cloudflare Worker to Google's paid Gemini API and is not stored. Tick these categories: -->
<!-- "the text an AI task needs" undercounted what is sent, and this sentence introduces the table that a
     reviewer compares the permission justifications against — the `storage` row above now says the saved
     files travel with an AI request and points here for the record, so this line had to stop saying text
     only. A saved PDF is sent as a whole file, not as text: extension/background/tailor.js line 185 and
     extension/onboarding/onboarding.js line 68 both build
     `{ type: "document", source: { type: "base64", media_type: "application/pdf" } }`. Nothing is kept
     on the way through: worker/src/gemini.js line 2 records that request and reply text "pass through
     memory only; nothing here stores or logs them". -->
Chrome counts data as "collected" when it leaves the device. Profile data stays local except for what an AI task needs: the relevant profile text, and — for a Deep Dive or a tailored resume — the saved file itself when it is a PDF, sent whole; a Word or text file is read on the device and only its text is sent, up to 60,000 characters. That content passes through our Cloudflare Worker to Google's paid Gemini API and is not stored. Tick these categories:

| Category | Collected? | What and why |
|---|---|---|
| Personally identifiable information | Yes | Name, contact details and education from the student's profile or resume, sent for an AI task (tailoring a resume, answering a form question). Not stored by us. |
| Health information | Yes, only if entered | Optional disability status in EEO answers, if the student fills it in and an AI step reads that form. It defaults to "Decline". Not stored by us. |
| Financial and payment information | No | |
| Authentication information | Yes | The Google or Microsoft sign-in token is sent to our server to look up which plan and allowance the student has. It isn't stored. Passwords for application sites — the ones the student gave us and the ones the extension generated when it registered an account for them — stay on the device, are typed only into that site, and are never sent to us or the AI. |
| Personal communications | No | |
| Location | Yes | Address and preferred states from the profile. Chosen states are stored on our server, keyed to a hashed ID, to decide where to scan. |
| Web history | No | |
| User activity | Yes | Counts of AI tasks used per month, keyed to a hashed ID, to enforce caps. For a student on a paid plan, that hashed ID also carries which plan they are on and when it renews, so the right allowance is applied. What we send Stripe is the hashed ID and which plan was bought; the student's name, email and card never reach us — Stripe collects those itself, on its own checkout page. |
| Website content | Yes | The fields and questions on the application page the student queued, sent for an AI task. Not stored by us. |

<!-- ROW HISTORY for the table above, kept below the table for the same reason as the permissions table:
     in GitHub Flavored Markdown an HTML comment between two rows is a block-level element that ends the
     table body, so comments placed above their rows made github.com drop every row from that point on.
     Each note names its row and quotes the replaced text verbatim. -->

<!-- "Financial and payment information" row (unchanged, still "No").
     Checked rather than assumed on 2026-09-19, after payments went live: the extension has no billing
     code at all (nothing under extension/ calls /billing/checkout or /billing/portal; the only mention
     of paying is a message telling the student to press Upgrade on the dashboard, in
     extension/background/gemini.js). Stripe Checkout runs on Stripe's own pages, reached from the
     dashboard. No card or transaction data passes through the extension, so ticking this would claim a
     collection that does not happen. -->

<!-- "Authentication information" row.
     was: | Authentication information | Yes | The Google or Microsoft sign-in token is sent to our server to check the allowance. It isn't stored. Passwords for application sites stay on the device, are typed only into that site, and are never sent to us or the AI. |
     Extended to name the generated site passwords outright. The old wording covered them under
     "passwords for application sites", which reads as passwords the student supplied; the extension also
     makes its own (extension/lib/store.js genPassword(), saved by the fill_secret handler in
     extension/background/agent.js). It must not be a reviewer who first discovers that. -->

<!-- "User activity" row, first replacement.
     was: | User activity | Yes | Counts of AI tasks used per month, keyed to a hashed ID, to enforce caps. |
     Incomplete once payments went live: worker/src/billing.js now keeps a subscription row against the
     same hashed ID, so the monthly counts are no longer the only per-student thing on the server. The
     row has to list it, or the disclosure is narrower than what the Worker actually stores. -->

<!-- "User activity" row, second replacement (the Stripe sentence).
     was: | User activity | Yes | Counts of AI tasks used per month, keyed to a hashed ID, to enforce caps. For a student on a paid plan, that hashed ID also carries which plan they are on and when it renews, so the right allowance is applied. Stripe is told the hashed ID and nothing else about the student. |
     "nothing else about the student" was false as an absolute claim. The checkout session in
     worker/src/billing.js sends `client_reference_id: user` (line 121) plus
     `subscription_data[metadata][user_hash]` and `[plan]` (lines 124-125), so Stripe gets the plan too;
     and billing.js line 5 states plainly that "Stripe holds the card, the name and the email; they never
     reach this Worker or D1" — Stripe knows far more about the student than the hash, it just does not
     learn it from us. The true and useful claim is the directional one, which is what the row now says.
     This is the section a reviewer reads most literally, so an over-broad privacy claim costs more here
     than anywhere else in the listing. -->


**Certify all three:**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Limited Use statement** (also on the privacy page):
> The use of information received by InternScout Auto-Apply adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Before submitting
- `identity` must be in `manifest.json` `permissions` (the sign-in build adds it). Remove its row above if it isn't.
- Build the zips with `python scripts/package_extension.py` and upload `dist/internscout-extension-<version>-webstore.zip`
  (the same build without manifest `"key"`; the plain zip keeps it for GitHub Releases).
- Store ID: `jmjjgnckddhjbohfpbekodkpbpbmfjag`. `https://jmjjgnckddhjbohfpbekodkpbpbmfjag.chromiumapp.org/` must be a
  redirect URI with both sign-in providers.
<!-- was: - Test account for reviewers: none needed. Reviewers can sign in with any Google or Microsoft account (they get the smaller general allowance). Note in the reviewer notes that search and the Deep Dive also work without sign-in. -->
<!-- "the Deep Dive also works without sign-in" was wrong, and wrong in the worst direction: it is an
     instruction to the reviewer that fails when followed. Checked against the Worker on 2026-09-19 —
     deep_dive is an entry in worker/src/config.js TASKS, so it is served by `POST /ai` in
     worker/src/index.js, whose first line is `const user = await signIn()`; signed out there is no
     Authorization header and worker/src/auth.js authenticateUser throws 401 "Sign in first". A reviewer
     told to try it signed out hits that 401 and reads it as a broken item. -->
- Test account for reviewers: none needed. Reviewers can sign in with any Google account, or a **personal**
  Microsoft account — publisher verification is still deferred, so a school or work Microsoft account may be
  refused at the provider's own page before it ever reaches us. Either way the reviewer lands on the smaller
  general allowance, which is enough to exercise every feature.
- Reviewer notes must say: browsing, searching and the dashboard work fully signed out, but **every AI step
  needs sign-in, the Deep Dive included** — signed out it returns 401. Do not invite the reviewer to try an
  AI feature signed out.
- Reviewer notes must also disclose the paid plans, because they are live (`PAYMENTS_ENABLED = "1"` in
  `worker/wrangler.toml`): Supporter $5/month and Pro $12/month, both optional, both bought through Stripe
  Checkout on the dashboard and never inside the extension. Declare the item as offering in-app purchases /
  subscriptions in the Dashboard's pricing section so the listing and the code agree.
