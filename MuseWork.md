# MuseWork.md

Work log for Muse (Bruce's AI agent). Read this when working in this repo.

## What Muse did (2026-10-08)

- Fixed a failing date test — commit `e8001db8` on main ("Install page: visible Updated date matches the HowTo's (Oct 7)", PR #79). The assertion was about the install page's visible "Updated" date.
- The automated `data: refresh listings` pipeline commits continued normally through the day (listings pipeline is healthy).

## What Claude did (2026-10-12 and 2026-10-13)

Merged on main, each after CI passed:
- **#81** Haiku 5.5 vs Flash 3.8 autofill benchmark (`scripts/eval/haiku-vs-flash.md`). Verdict: stay on Flash (flash-low). Haiku is cheaper but makes more sensitive-answer errors.
- **#83, #84** (the other Claude session): the under-18 autofill fix in `extension/agent/guard.js`, shipped as extension 0.5.6. It is in Chrome Web Store review; 0.5.5 is live.
- **#85** Auto-Apply offer bar after "Open posting" (`docs/js/offer.js`). Desktop Chromium only, at most once a session, hidden for 14 days after a dismiss or click. Events: `apply_offer_shown`, `apply_offer_click`.
- **#86** Search titles and descriptions written for clicks, e.g. "Under Armour Internships Summer 2027: 10+ Open". A page only says "links to <employer>'s own posting" when no role on it links to a job site (`JOB_SITE_HOSTS` in `seo_pages.py`).
- **#87** For employers page at https://internscout.org/employers/ (footer link on every page). Its form posts to the Worker's `/employer-interest`, which saves to the D1 table `employer_leads` and keeps a lead for one year. It has a hidden spam trap and rate limits. It sends no email, so leads must be read:
  `npx wrangler d1 execute internscout --remote --command "SELECT * FROM employer_leads ORDER BY created DESC"`
- **#88** Thin pages out of Google: a field x place page with fewer than 20 roles gets `noindex, follow` and leaves the sitemap (130 pages; the sitemap went from 1,557 to 1,428). Students can still reach those pages. A page Search Console shows a click or 5+ impressions for is never hidden (`backend/data/search_console_pages.json`, a snapshot that has to be refreshed by hand). Employer pages are never hidden. To undo: `INDEX_COMBO = 0` in `seo_pages.py`. The home page title is now "Summer 2027 Internships for College Students | InternScout"; change it when Summer 2028 recruiting opens (about August 2027).
- **#90** Weekly email prep: `python growth/digest_send.py --check` and the Email digest workflow's `check_key` input test the Buttondown key with one read and send nothing (checked 10-13: the key works). The cron comment now gives the real send time: 12:00 UTC is 8am Eastern in daylight time and 7am in winter.

## Weekly email: status (2026-10-13)

- **Buttondown is ready:**
  - sender InternScout <hello@internscout.org>, account confirmed, two-factor on
  - DKIM, bounce and DMARC records verified
  - click and open tracking off
  - subscription reminders off (they emailed people who hadn't confirmed, against the privacy page)
  - UTM tags off, so employer links go out unchanged
- **Postal address:** a private mailbox at 1550 Wilson Blvd, Ste 700 PMB638, Arlington, VA 22209. It is waiting on the mail center's approval, expected within 2 to 3 business days of Oct 13.
- **Nothing sends yet:** `DIGEST_ENABLED` and `DIGEST_POSTAL_ADDRESS` aren't set, the Monday schedule is commented out, and `CONFIG.digest.formAction` in `docs/index.html` is empty, so no page shows a sign-up form.
- **After approval, in order:**
  1. the address secret, and the same address in Buttondown
  2. one test copy to hello@internscout.org
  3. Bruce reviews it
  4. a double opt-in test, then the sign-up forms
  5. the Monday schedule
  The six-day duplicate-send guard stays.

## Outreach Bruce gave Muse (career-center links)

- **The ask:** career centers and department advisors add InternScout to their "job and internship search sites" page. Links from .edu sites help students find it and help Google index more of the site (about 640 of ~1,550 pages are indexed).
- **Rules:**
  - only true facts: 14,000+ listings, free, no account needed to search, links to employers' own postings
  - never say InternScout is affiliated with UMass Amherst or any school
  - no incentives
  - one follow-up at most, 7 to 10 days later
  - never email anyone again who says no
- **Link to share:** the field page that fits the office, e.g. https://internscout.org/internships/mechanical-engineering/. Open it first to check it exists.
- Don't promise the weekly email in outreach until sign-ups are open (see above).

## Dates Claude will check

- Oct 20: whether the offer bar (#85) leads to installs (`event_counts`: `posting_click` against `apply_offer_*` and `install_click`).
- Oct 21 to 27: Search Console. About 130 pages should show as "Excluded by noindex", and "Discovered, not indexed" should shrink.
- Oct 27: AI cost per autofill (`task_tokens`).
- Nov 3: click-through rate on the retitled pages (#86) and the home page (it was 7 clicks from 165 impressions).

## Suggestions for Muse (from Claude)

- **Leave the weekly email alone:** don't change Buttondown settings or send anything through it. The privacy page promises no tracking and double opt-in, and the first send to subscribers waits for Bruce's review.
- **Employer leads:** if an employer replies to outreach, point them to https://internscout.org/employers/. Leads land in `employer_leads`.
- **Hidden pages:** for a question about one of the 130 noindexed pages, the page is still live for students; it is only hidden from search engines until it reaches 20 roles.

## Current state / thoughts

- This is the InternScout.org codebase: free internship/co-op search for students (~14,000 listings, 1,200+ SEO landing pages), plus a Chrome autofill extension.
- `main` gets frequent automated `data: refresh listings` commits — that's the pipeline, not human edits. Don't be surprised by them.

## Suggestions for the Claude agent

- If listings go stale, check the GitHub Actions runs for the refresh workflow before touching code.
- The SEO landing pages are script-generated — never hand-edit generated pages; change the generator.
- Watch for time-dependent test assertions (the Oct 8 fix was a date-sensitive test). Prefer fixed clocks or relative dates in new tests.
- There's a weekly growth report (`growth/report.py`) and a Bluesky brand-post workflow — don't duplicate them.
