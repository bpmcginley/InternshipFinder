# Chrome Web Store listing: InternScout Auto-Apply

Copy these into the Developer Dashboard. Bruce pays the $5 developer fee and submits.
Keep this file in step with `extension/manifest.json` and `docs/privacy.html`.

## Store listing

**Name:** InternScout Auto-Apply

**Short description** (max 132 characters):
> Fills out internship applications from your saved profile, then stops at the submit button so you review and submit yourself.

**Category:** Tools (alternative: Productivity)

**Long description:**
> InternScout helps college students apply to internships, co-ops, research programs and fellowships faster, without letting a bot apply for them.
>
> HOW IT WORKS
> • Do the Deep Dive once: add your resume and other files, basic facts, and a few short answers about your projects and goals.
> • Pick listings on the free InternScout dashboard, or paste any application link.
> • The extension opens each posting and walks every step of the application: sign-up, uploads, questions and forms.
> • It fills everything from your profile and stops at the submit button.
> • You review every answer and press Submit yourself.
>
> SAFE BY DESIGN
> • It never submits for you. The submit guard is code, not an AI instruction.
> • Your profile and files stay in Chrome on your device.
> • Passwords for application sites are filled by the extension and never sent to the AI.
> • CAPTCHAs, email codes and two-step sign-in always go to you.
>
> FREE FOR STUDENTS
> • Sign in with Google or Microsoft to use the AI features. There's nothing to set up. A school .edu email gets twice the monthly AI use.
> • Each student gets a free monthly allowance. The extension shows what's left.
> • We don't store your resume, prompts or AI replies.
>
> Works best on Workday, Greenhouse, Lever and Ashby. Other sites may need more help from you.
>
> Made by a UMass Amherst student. Not affiliated with UMass Amherst.
> Privacy: https://bpmcginley.github.io/InternshipFinder/privacy.html

**Screenshots to take (1280×800):** dashboard with listings ticked; Deep Dive files step; side panel queue with "Ready to submit"; a filled form paused at Submit with the overlay.

## Single purpose

> InternScout Auto-Apply helps a student fill out internship application forms from the profile they saved in the extension, and stops before submitting so the student reviews and submits each application.

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Saves the student's profile, answers, settings, queue and application-site accounts on the device in `chrome.storage`. |
| `unlimitedStorage` | Resumes, transcripts, cover letters and writing samples are stored locally as files. Together they can exceed the default storage quota. |
| `tabs` | Opens each application in a background tab, tracks its progress, and brings the tab forward when the student needs to act (a question, CAPTCHA or Submit). |
| `tabGroups` | Groups the application tabs a run opens so they don't clutter the student's window, and lets the student close them together. |
| `scripting` | Injects the form-filling agent and the submit guard into the application page the student queued. That page is on the employer's application site, which is not known in advance. |
| `webNavigation` | Detects when a multi-step application moves to its next page or redirects (for example to a sign-in step), so the agent re-attaches and continues. |
| `sidePanel` | Shows the application queue: Needs you, Ready to submit, In progress and Done. The student answers questions there. |
| `notifications` | Tells the student when an application is ready to submit or needs their input, since applications run in background tabs. |
| `identity` | Signs the student in with their Google or Microsoft account (`chrome.identity.launchWebAuthFlow`). The sign-in token lets our server check the student's monthly AI allowance. We never receive passwords. |
| Host permissions: 18 applicant-tracking domains | The systems employers run their application forms on (`*.myworkdayjobs.com`, `*.greenhouse.io`, `*.lever.co`, `*.ashbyhq.com`, `*.icims.com`, `*.taleo.net` and 12 more, listed in `manifest.json`). These carry about 87% of the postings we index. The extension injects the form-filling agent and the submit guard into the application page the student queued, on a tab it opened for that application. |
| Optional host permission `<all_urls>` | Many employers run their application form on their own site instead (`careers.tesla.com`, `amazon.jobs`, `cityjobs.nyc.gov`, and a long tail that grows with every employer added), and a student can paste any application link. These can't be listed in advance, so the extension asks for one specific site at the moment it's needed: when a queued application is on a site it can't reach, the run pauses and the side panel shows an "Allow amazon.jobs" button. The student grants that one domain, or declines and the application stays paused. Nothing is granted at install. |
| Content script on `bpmcginley.github.io/InternshipFinder/*` and localhost | Lets the InternScout dashboard send listings the student picked to the extension, and show which ones were applied to. Localhost is for development. |

**Remote code:** No. All JavaScript ships inside the package (including the vendored `mammoth` library for reading DOCX files). The extension calls our server and AI APIs for data only; it doesn't download or run code.

## Privacy practices (data use)

**Privacy policy URL:** https://bpmcginley.github.io/InternshipFinder/privacy.html

Chrome counts data as "collected" when it leaves the device. Profile data stays local except for the text an AI task needs. That text passes through our Cloudflare Worker to Google's paid Gemini API and is not stored. Tick these categories:

| Category | Collected? | What and why |
|---|---|---|
| Personally identifiable information | Yes | Name, contact details and education from the student's profile or resume, sent for an AI task (tailoring a resume, answering a form question). Not stored by us. |
| Health information | Yes, only if entered | Optional disability status in EEO answers, if the student fills it in and an AI step reads that form. It defaults to "Decline". Not stored by us. |
| Financial and payment information | No | |
| Authentication information | Yes | The Google or Microsoft sign-in token is sent to our server to check the allowance. It isn't stored. Passwords for application sites stay on the device, are typed only into that site, and are never sent to us or the AI. |
| Personal communications | No | |
| Location | Yes | Address and preferred states from the profile. Chosen states are stored on our server, keyed to a hashed ID, to decide where to scan. |
| Web history | No | |
| User activity | Yes | Counts of AI tasks used per month, keyed to a hashed ID, to enforce caps. |
| Website content | Yes | The fields and questions on the application page the student queued, sent for an AI task. Not stored by us. |

**Certify all three:**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Limited Use statement** (also on the privacy page):
> The use of information received by InternScout Auto-Apply adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Before submitting
- `identity` must be in `manifest.json` `permissions` (the sign-in build adds it). Remove its row above if it isn't.
- Build the zip with `python scripts/package_extension.py` and upload `dist/internscout-extension-<version>.zip`.
- After the first upload, register `https://<store-extension-id>.chromiumapp.org/` as a redirect URI with the sign-in provider.
- Test account for reviewers: none needed. Reviewers can sign in with any Google or Microsoft account (they get the smaller general allowance). Note in the reviewer notes that search and the Deep Dive also work without sign-in.
