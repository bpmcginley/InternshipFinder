# InternScout Autofill (browser extension)

Chrome/Edge extension that fills **Greenhouse** and **Lever** internship applications from a
profile you save once, and drafts answers to open-ended questions with the Anthropic API.
It **never submits** — it fills, highlights what's left, and you review.

The fill logic was built and tested against **live application forms on both platforms** —
Greenhouse (Anduril's 2027 SWE Intern posting, including its react-select dropdowns) and Lever
(standard named inputs + native selects, which fill reliably).

## Install (unpacked)
1. `chrome://extensions` (or `edge://extensions`) → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the extension → **Edit profile & AI settings** → fill in details (and paste your
   resume text + Anthropic API key for AI answers) → Save.

## Use
Open an application on `job-boards.greenhouse.io`, `boards.greenhouse.io`, or
`jobs.lever.co`. A bottom-right **InternScout** panel appears → **Autofill**:

- **Filled automatically** (verified reliable): first/last name, email, phone, LinkedIn,
  GitHub, website, GPA, and other plain text/number fields.
- **Highlighted for you** (dashed amber outline): resume/cover-letter file uploads (browsers
  block scripted file selection) and searchable dropdowns like school, country, and location
  preference — one click each.
- **Yes/No dropdowns** (e.g. work authorization, sponsorship): attempted automatically, but
  only kept if the committed value verifies. If a synthetic selection doesn't register, the
  field is highlighted instead of left wrong — deliberately, so a critical answer like work
  authorization is never mis-set.

### AI answers
Open-ended boxes ("Why do you want to work here?", cover letter) get a **✨ Draft answer**
button. It sends the question + the job description on the page + your resume/background to
Anthropic (your key, stored only in your browser) and inserts an editable draft. **↻ Regenerate**
gets a fresh take; answers are cached per question so you're not billed twice. Without a key,
the button inserts your saved template with `{{company}}` filled in.

## Design choices / honest limits
- **Never auto-submits**, never uploads files, never overrides a verified-wrong dropdown.
- react-select automation is timing-sensitive; the verify-or-highlight approach means the
  worst case is "you pick a couple dropdowns yourself," never a wrong answer.
- Covers Greenhouse + Lever. **Workday/Ashby are not yet supported** (v2) — several large
  employers host on Workday.
- Selector rules live in `src/matcher.js`; the react-select handling in `src/content.js`.

## Files
`manifest.json` · `src/profile.js` · `src/matcher.js` · `src/content.js` (fill + AI + panel) ·
`src/background.js` (Anthropic call) · `options/` (profile, resume, key) · `popup/`.

## Privacy
Everything is stored locally in your browser. The only network calls are the AI drafts you
trigger, sent directly to `api.anthropic.com` with your key — nothing passes through any server.
