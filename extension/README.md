# InternScout Autofill (browser extension, v1)

A Chrome/Edge extension that autofills **Greenhouse** and **Lever** job applications from a
profile you save once — plus an optional **AI button** that drafts answers to open-ended
questions ("Why do you want to work here?") using the job description on the page and your
background. It **never submits** a form; it fills, you review.

## Install (unpacked, for personal use)
1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the extension → **Edit profile & AI settings**, fill in your details, Save.

## Use
- Open any application page on `job-boards.greenhouse.io`, `boards.greenhouse.io`, or
  `jobs.lever.co`.
- A small **InternScout** panel appears bottom-right → **Autofill this page** fills the
  structured fields (name, email, school, work authorization, etc.).
- Open-ended text boxes get a **✨ button**:
  - With an API key set → **Draft answer** (tailored, editable draft via Anthropic).
  - Without a key → **Insert template** (your saved canned text, with `{{company}}` filled in).
- Review everything, attach your resume manually, then submit yourself.

## AI answers (optional)
Add an Anthropic API key in Options (stored only in your browser). Calls go directly from the
extension to `api.anthropic.com` with your key — nothing passes through any InternScout server.
Default model `claude-haiku-4-5-20251001` (fast/cheap); change it in Options.

## What v1 does / doesn't
- ✅ Greenhouse + Lever structured autofill · ✅ AI or template answers · ✅ label-based
  matching (resilient to minor DOM changes) · ✅ never auto-submits.
- ⛔ No resume auto-upload (file inputs need manual selection) · ⛔ Workday/Ashby (v2) ·
  ⛔ no auto-navigation between multi-step pages.

## Files
`manifest.json` · `src/profile.js` (schema+storage) · `src/matcher.js` (label→field rules) ·
`src/content.js` (fill + AI buttons + panel) · `src/background.js` (Anthropic call) ·
`options/` (profile & key) · `popup/` (quick fill).

## Notes
Personal-use tool. Respect each site's terms; keep a human in the loop. Selectors may need
occasional updates as ATS UIs change — rules live in `src/matcher.js`.
