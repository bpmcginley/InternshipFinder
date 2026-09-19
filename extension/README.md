# InternScout Auto-Apply (Chrome extension)

Queue internships from the InternScout dashboard. For each one, the agent opens the posting,
walks every step of the application (sign-up, uploads, questions, EEO), fills it all from
your Deep Dive profile, and **stops at the submit button**. You review and press Submit.

## Install (unpacked)
1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `extension/` folder.
3. The **Deep Dive** opens on its own. You can redo it any time from the popup, the side
   panel or the dashboard.

## Deep Dive
Six steps. Everything stays in `chrome.storage.local`.
<!-- was: "1. **Setup:** AI provider (Anthropic Claude or Google Gemini 3.8 Flash) and its API key, model, ..."
     Corrected in the September 2026 audit: the default needs no key. This file ships inside the zips. -->
1. **Setup:** sign in (the default: InternScout's own AI, free, with a monthly allowance and no key to
   set up), your sign-up email, and the account password mode (a unique password per site, or one
   master password). Under Advanced you can use your own Anthropic or Google Gemini API key instead.
2. **Files:** resume (required), CV, transcript, cover letter, writing samples. PDF, DOCX
   and text work. "Read my resume" pre-fills your profile.
3. **Facts:** contact, work authorization, availability, EEO (defaults to "Decline").
4. **Interview:** a short chat about projects, challenges, goals. It is saved as stories.
5. **Voice:** reads your writing so generated answers sound like you.
6. **Review:** edit anything.

## Auto-Apply
- On the dashboard, tick listings and press **Auto-Apply (N)**, or use a row's button.
- Or paste any application link under **Apply to any posting** in the side panel.
- Jobs run in background tabs (1 to 4 at once, set in Setup).
- The **side panel** shows the queue: *Needs you* (a question, CAPTCHA, email verification),
  *Ready to submit*, *In progress*, *Done*. Answer questions there or in the card on the tab.
- New facts you give are saved, so you are not asked twice.
- After you submit, the job is marked **Submitted** and the dashboard marks it Applied.

## Safety
<!-- was: "Clicks on submit-like buttons are refused, and Enter, `form.submit()` and `requestSubmit()`
     are never used." The audit found that sentence untrue as written: two widgets are sent an Enter key. -->
- The submit guard is code, not a prompt. Clicks on submit-like buttons are refused, and
  `form.submit()` and `requestSubmit()` are never used. Two kinds of widget are sent a scripted key
  press to open or pick from a list (Workday search boxes get Enter; dropdown buttons get Arrow Down,
  Enter or Space). A scripted key press does not make the browser submit a form.
- Passwords are filled by the extension and are never sent to the model. A stored password is typed
  only into a password box, and a box it was typed into is never read back.
- Passwords in Chrome storage are not encrypted at rest. See them under **Accounts**.
<!-- was: "Each application costs several AI calls, billed to your API key. With Gemini, your resume,
     files and answers go to Google instead of Anthropic." -->
- Each application costs several AI calls. Signed in, they count against your monthly allowance and
  pass through InternScout's server to Google's paid Gemini API; nothing in them is stored. With your
  own key they are billed to that key and go straight to Anthropic or Google.

## Limits
CAPTCHAs, email codes and 2FA always need you. Greenhouse, Lever, Ashby and Workday work
best. iCIMS, Taleo and custom sites are less reliable; stuck jobs go to *Needs you*.

## Layout
```
background/  index.js (router, scheduler), agent.js (loop), queue.js, claude.js
agent/       dom.js (snapshot), actions.js (fill helpers), guard.js, overlay.js
bridge/      bridge.js (dashboard <-> extension messages)
onboarding/  Deep Dive
sidepanel/   queue, answers, accounts
popup/       status + shortcuts
lib/store.js storage schema
test/        guard.test.mjs, fixtures/
```

## Tests
```bash
node --test extension/test/guard.test.mjs
```
Fixture forms: serve the repo root (`python -m http.server 8000`) and queue
`http://localhost:8000/extension/test/fixtures/workday-like.html` from the side panel.
It should end at *Ready to submit*. The page log must never say `FAIL`.
