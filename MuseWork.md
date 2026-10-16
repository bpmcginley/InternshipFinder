# MuseWork.md

Work log for Muse (Bruce's AI agent). Read this when working in this repo.

## Current handoff (2026-10-16; supersedes historical status below)

- Chrome Web Store 0.5.7 is live, independently checked October 16. The public package predates
  PR #118's three extension follow-ups. A 0.5.8 candidate now includes those existing fixes and
  enables the optional weekly-email finish link. It is not store-published; exact-package real
  Google/Microsoft sign-in and normal-update preservation checks remain release gates. See
  `reviews/releases/extension-0.5.8.md`.
- PR #122 activated the approved weekly email; PR #123 signup improvements were merged and
  deployed October 15 (Worker before site). Do not repeat mailbox, provider or signup activation.
  The first scheduled subscriber send is October 19 at 12:00 UTC / 8 a.m. EDT. No catch-up send.
  New freshness refusal and weekly-aware health checks are prepared here; see `growth/EMAIL_RUNBOOK.md`.
- The private analytics page already labels form submissions separately from confirmed subscribers,
  verified October 16. The older request below to change that label is superseded. Buttondown's
  baseline was one active owner account, one unsubscribed owner test account, and zero non-test
  active subscribers; no addresses were exported.
- Heycatch already has posted and scheduled videos for YouTube, TikTok and Facebook. Six brand
  accounts are connected; Threads is absent. Preserve that queue and leave the native YouTube
  uploader disabled. Bluesky and Instagram use the existing native workflow. See
  `growth/PUBLISHING_OWNERSHIP.md`; a connection alone does not prove a post succeeded.
- Prepared fixes prevent stale carried listings from duplicating freshly fetched stable IDs,
  reduce the first-results preview from 60 to 12 rows, and repair Instagram Login Reel publishing
  through a bounded public video route. Deploy the Worker before the updated publishing workflow.
  The next normal ingest/export applies the listing correction; full shards were not regenerated here.
- Support guidance now has an `/install#troubleshooting` destination. Update the store support URL
  after the page is live. Security headers are a staged host-rule proposal, not a deployed change.
- Product validation uses synthetic offline ATS fixtures and owner QA. No employer application,
  student outreach, new social post, broadcast or account permission change was performed here.

Older sections are historical records, not instructions to reactivate services or duplicate publishers.

## What Muse did (2026-10-08)

- Fixed a failing date test — commit `e8001db8` on main ("Install page: visible Updated date matches the HowTo's (Oct 7)", PR #79). The assertion was about the install page's visible "Updated" date.
- The automated `data: refresh listings` pipeline commits continued normally through the day (listings pipeline is healthy).

## What Claude did (2026-10-12 and 2026-10-13)

Merged on main, each after CI passed:
- **#81** Haiku 5.5 vs Flash 3.8 autofill benchmark (`scripts/eval/haiku-vs-flash.md`). Verdict: stay on Flash (flash-low). Haiku is cheaper but makes more sensitive-answer errors.
- **#83, #84** (the other Claude session): the under-18 autofill fix in `extension/agent/guard.js`, shipped as extension 0.5.6. (Updated 10-14: 0.5.6 is live; 0.5.7 is in store review, see below.)
- **#85** Auto-Apply offer bar after "Open posting" (`docs/js/offer.js`). Desktop Chromium only, at most once a session, hidden for 14 days after a dismiss or click. Events: `apply_offer_shown`, `apply_offer_click`.
- **#86** Search titles and descriptions written for clicks, e.g. "Under Armour Internships Summer 2027: 10+ Open". A page only says "links to <employer>'s own posting" when no role on it links to a job site (`JOB_SITE_HOSTS` in `seo_pages.py`).
- **#87** For employers page at https://internscout.org/employers/ (footer link on every page). Its form posts to the Worker's `/employer-interest`, which saves to the D1 table `employer_leads` and keeps a lead for one year. It has a hidden spam trap and rate limits. It sends no email, so leads must be read:
  `npx wrangler d1 execute internscout --remote --command "SELECT * FROM employer_leads ORDER BY created DESC"`
- **#88** Thin pages out of Google: a field x place page with fewer than 20 roles gets `noindex, follow` and leaves the sitemap (130 pages; the sitemap went from 1,557 to 1,428). Students can still reach those pages. A page Search Console shows a click or 5+ impressions for is never hidden (`backend/data/search_console_pages.json`, a snapshot that has to be refreshed by hand). Employer pages are never hidden. To undo: `INDEX_COMBO = 0` in `seo_pages.py`. The home page title is now "Summer 2027 Internships for College Students | InternScout"; change it when Summer 2028 recruiting opens (about August 2027).
- **#90** Weekly email prep: `python growth/digest_send.py --check` and the Email digest workflow's `check_key` input test the Buttondown key with one read and send nothing (checked 10-13: the key works). The cron comment now gives the real send time: 12:00 UTC is 8am Eastern in daylight time and 7am in winter.

## What Claude did (2026-10-14)

Several Claude sessions merged #94 to #118 on main, each with Bruce's OK and after CI passed. Detail: `C:/Users/bruce/Documents/InternScout-ProductReview/CLAUDE-HANDOFF.md` (outside the repo).
- **Extension:** 0.5.6 is live. **0.5.7 is in Chrome Web Store review** (uploaded by Bruce 10-14; #116). It carries the PR #94 review fixes, the design pass (#110), the extension fixes (#112) and the separate extension sign-in (#115). Permissions are unchanged from 0.5.6.
- **Site:** search across every state with relevance ranking (#97), design tokens and self-hosted fonts (#106), new dashboard, landing page and extension designs (#108 to #110), filters in the address (#113), faster first paint on slow connections with `docs/data/first.json` (#114).
- **Paid listings for employers** (#103 to #105, #111): an employers page with planned prices, Worker admin routes (`worker/scripts/placement.mjs`), and a box labelled "Paid listing" and "Ad" on landing pages. Off until the repo variable `INTERNSCOUT_PLACEMENTS_URL` is set. Not launched: #117 (dashboard box) and #119 (launch text and counts, "do not merge until the first placement goes live") are open.
- **Analytics:** the hourly snapshot has Bing search numbers too (#101, secret `BING_WEBMASTER_KEY`).
- **#118:** review follow-ups. The listing pipeline now treats each of an employer's job boards separately (`export_static.board_of`), so one failed board no longer drops jobs from another.

## Weekly email: launch approved (2026-10-15)

Bruce asked Codex to finish the automated email after mailbox approval. This supersedes the earlier mailbox hold below.

- TKO Suites confirmed the mailbox is active. Its exact address is saved in Buttondown and the GitHub secret `DIGEST_POSTAL_ADDRESS`.
- The existing Buttondown key works. `DIGEST_TEST_TO=hello@internscout.org` and `DIGEST_ENABLED=1` are set. Three owner-only test copies were sent; no subscriber broadcast was sent.
- The final test from branch `codex/weekly-email` arrived at 16:15 Eastern on October 15. SPF, DKIM and DMARC passed. The postal footer and unsubscribe link resolve, and job links go directly to their destinations.
- Fixed Buttondown's cream accent color, which made job links invisible in Gmail, to `#1d5c46`. The main digest button pins its light text against the provider's global accent CSS. The delivered final copy was checked in Gmail.
- Click/open tracking, subscription reminders and provider-added UTM tags remain off. Public archives are enabled. A disposable owner alias was observed Unactivated before confirmation, confirmed through its emailed link, then unsubscribed successfully. No subscriber list was imported or copied into InternScout.
- PR #122 connects the verified signup form and the existing Monday schedule: 12:00 UTC, 8am Eastern during daylight time and 7am in winter. Manual runs still default to owner-only tests; the six-day duplicate guard remains.
- Bruce reviewed the final delivered test and explicitly approved public signup and weekly activation on October 15. PR #122 enables the forms and schedule when merged. The first planned weekly send is Monday, October 19 at 08:00 Eastern; no catch-up broadcast is requested. Preserve the manual owner-only default and duplicate guard.

## Weekly email signup improvements (2026-10-15, prepared for review)

Bruce asked for one agent per signup-growth task. Five separate agents covered visibility, benefit copy,
contextual invitations, promotion drafts, and measurement; their changes are consolidated on
`codex/digest-signup-growth`. These improvements have not been merged or deployed.

- Dashboard: Weekly email navigation link and a compact form after the first ten results (after the
  last result for shorter lists). Counts, status controls, selection and pagination still count jobs only.
- Copy: clear free/Monday benefit, explicit nonpersonalized roundup, standard Buttondown POST and
  email confirmation. `/digest/` generates three dated examples from current listing data rather than
  hardcoding roles. Archive links say "Browse past emails" until and after the first broadcast.
- Context: one dismissible invitation after a deliberate Interested selection or first manual profile
  save; the existing classmate invitation has priority. Background queue/profile updates do not trigger
  it. Only a local shown/opened/dismissed preference is stored; blocked storage suppresses the prompt.
- Measurement: finite anonymous placement exposure/click/submit counters; exposure requires at least
  25% visibility. `digest_signup` still means form submissions, not confirmed subscribers. Confirmed
  active counts remain a manual Buttondown aggregate excluding tests; see `growth/SIGNUP_MEASUREMENT.md`.
  Deploy the Worker whitelist before the site to accept new events. No schema migration or new key
  permissions are needed. The private analytics page outside this repo still needs its old signup
  label changed to "Weekly email form submissions."
- Browser verification caught mixed cached script versions breaking rendering. The new optional helper
  now fails closed with an older core script, and this release versions the affected script URLs.
  Desktop and 390x844 previews showed no horizontal overflow, distinct form labels/IDs, contextual
  invitation without focus theft, and persistent dismissal. No real signup or broadcast was performed.
- Promotion drafts and researched club contacts are prepared separately for owner review; nothing is
  posted, scheduled, or sent by this work. Existing brand automation settings are unchanged.

## Earlier weekly email status (2026-10-13, superseded above)

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
