# InternScout product and growth work: hand-off for a Codex session with many agents

Written 2026-11-10 by Claude for Bruce McGinley. Based on `main` at `0607a74` and the live site on 2026-11-10.

This session runs **at the same time as the refactor session** described in `notes/refactor/HANDOFF.md`. Section 3 says how the two share the repo. Read it before anything else.

## 0. How to use this file

You are the lead of the product session. You assign work packages (P-numbers) to worker agents, review their PRs, and keep `notes/product/STATUS.md` current (one row per package: owner, branch, PR, state, what is waiting on Bruce).

Your first PR adds `notes/product/STATUS.md`. It also adds the "Waiting for Bruce" list from section 9, which you keep up to date.

Lines marked **verify** were inferred from a quick read. Confirm them in the code before acting.

## 1. Goal

More students find a role, come back, reach their first Auto-Apply fill, and tell a classmate. Employers get a reason and a way to raise their hand. The product should feel cleaner and more trustworthy, most of all on a phone.

What the review behind this plan found, in words (Bruce has the numbers):

- Students use the search and open postings. That part works.
- Almost no visit leaves anything behind: very few accounts, almost no email sign-ups.
- Very few students reach the extension, and only some of those reach a first fill.
- A small group of heavy users keeps hitting the monthly limit. Nobody has ever made an invite link.
- No employer has really seen the employer offer.
- Bing, not Google, is the working search engine.
- The public GitHub list and the embeddable widget exist and are almost unseen.

## 2. Decisions and scope

Bruce asked for these five, plus whatever else helps, including a UI and UX pass:

1. Fix the first impression of the results list.
2. Offer an invite and a one-time top-up when a student runs out of Auto-Apply runs.
3. Link and announce the GitHub list and the widget.
4. Stop paid social (Bruce's own action, see section 9).
5. "Email me when [Company] posts an internship", and the same for a saved search.

**On the UI:** no rebrand. The look (serif wordmark, green, off-white) stays. The work is order, density and phone layout: what a new visitor sees first, how much each row asks of them, and whether pages fit a 375 px screen.

Out of scope for now: season pass, department licences, Firefox or Safari support, any new paid advertising.

## 3. Sharing the repo with the refactor session

The refactor session has right of way on structure. You adapt to it.

**Before each package:** `git fetch`, read `notes/refactor/STATUS.md`, run `gh pr list`. If a refactor PR is open on a file you need, take a different package.

**Claim by draft PR.** The refactor lead avoids files that have an open PR. When you start work on a hot file from the table below, open a draft PR at once, titled `product: P-x.y <name>`. Keep it open for hours, not days.

**Keep PRs small and short.** One feature each, under about 400 changed lines. Merge `main` into your branch often. Never force-push.

**Formatting window.** The refactor session will run one-time formatting PRs that touch most files, and it waits for a moment with no open PRs. Do not block it. If its status file says the formatting PRs are next, or you see open PRs titled as formatting, finish or close what you have open and open nothing new until they merge. Then merge `main` into your branches and re-run the formatter.

**Golden build test.** Once the refactor session adds it, any PR of yours that changes generated pages must update the manifest in the same PR and list which page families changed and why. Refactor PRs are not allowed to change it; yours are, on purpose.

**Hot files.**

| File or area | Refactor package | Your rule |
|---|---|---|
| `backend/internscout/seo_pages.py` | Phase 3 (split into `internscout/site/`) | Edit only before WP-3.1 starts or after WP-3.5 merges. While Phase 3 runs, queue those packages. Afterwards, edit the new modules |
| `docs/js/app.js`, `docs/js/core.js` | WP-5.1 (ES modules) | Land Stage 1 before WP-5.1 starts. If it has started, wait for it to merge and work in the new modules |
| Inline `<style>` blocks in `docs/*.html` | WP-2.2 (design tokens) | Small CSS edits are fine before it starts; never while its PR is open |
| `<script>` tags in `docs/*.html` | WP-1.5 (cache versions) | Do not hand-edit `?v=` strings once it merges |
| `extension/onboarding/onboarding.js`, `extension/background/agent.js` | WP-5.2 | Wait for it to merge. Other extension files are free |
| `extension/agent/guard.js` and its tests | none | Never change |
| `worker/src/index.js` | WP-4.3 (route table) | New routes: before it starts, add them the current way; after it merges, add them to the table |
| `worker/schema.sql` | WP-4.1 (migrations) | Before it merges, add tables to `schema.sql`. After, add a new migration file |
| `worker/src/orders.js` | WP-4.2 | You should not need it |
| `.github/workflows/` | WP-0.6 | Avoid. If you must, tiny PR, after WP-0.6 merges |

If both sessions need the same file in the same week, write the question in `notes/product/STATUS.md` and move to another package.

## 4. Rules

All rules in section 3 of `notes/refactor/HANDOFF.md` apply here too: never force-push, no history rewrites, no secrets or private service ids, no production deploys, no extension release, do not touch `MuseWork.md`, other checkouts, or anyone's uncommitted work.

Added for this session, because your work changes what users see:

- **Words users read:** plain English, no em dashes, no emoji, and only claims the data proves. List every new or changed user-visible string in the PR text.
- **Accessibility:** keep keyboard use, focus order, labels and the existing skip links working. The site has careful WCAG work in it; do not regress it.
- **No third-party requests** added to any page. No external images, fonts, scripts or trackers.
- **Counting:** new counters use the existing daily totals (`docs/js/count.js`, `worker/src/visits.js`), which record nothing about who. Do not add any per-person tracking.
- **Proof:** every UI PR includes before and after screenshots at 1280 px and 375 px wide, and in dark mode if the page has one.
- **Speed:** `scripts/startup_budget.py` must still pass.

**Who merges.**

- The lead may merge a **site-only** PR that implements a Stage 1 package as written here, once checks are green, a second agent has reviewed it, and the screenshots are in the PR. Merging publishes the site, so check the Pages run after each merge and revert with a new PR if it fails.
- **Bruce merges** anything that touches: the privacy policy, terms, prices or plan text, emails sent to people, payments, anything newly stored or counted about people or employers, the extension, or the worker. Label these `needs-bruce` and add them to the waiting list.
- Worker changes go live only when Bruce deploys. Extension changes go live only when Bruce releases.

## 5. Stage 0: set up

**P-0.1 Tracker.** Add `notes/product/STATUS.md` with the package table and the waiting list.

**P-0.2 Counter names.** The worker only records event names on its allow list (`EVENTS` in `worker/src/visits.js`), so new names do nothing until Bruce deploys. Put every name the later packages need in one worker PR so one deploy covers them: `group_expand`, `major_quick_set`, `save_role`, `mylist_open`, `share_click`, `list_link_click`, `widget_link_click`, `out_of_runs_view`, `out_of_runs_invite`, `out_of_runs_topup`, `out_of_runs_plan`, `follow_open`, `follow_submit`, `follow_confirm`, `demo_play`, `flyer_print`. **Verify** that the site sends an unknown name harmlessly before the deploy. **Verify** the privacy policy's wording on counts covers new names; if it lists names one by one, the policy change goes to Bruce. `needs-bruce`.

## 6. Stage 1: site only, live on merge

These need no worker deploy and no new stored data.

**P-1.1 Group results by company.**
- Problem: with the default "newest" sort, one employer posting a batch fills the first screen (nine rows from one company on 2026-11-10).
- Do: in `docs/js/app.js`, when the sort is newest and there is no search text, show at most two rows per run of the same company, then one line: "7 more from REGENT". Pressing it expands in place. Other sorts are unchanged. Keep the row count and screen reader announcements honest.
- Tests: `tests/site/` cases for runs of 1, 2, 3 and 10, and for a company that appears in two separate runs.

**P-1.2 First screen.**
- Move the plans sentence ("Plans: free with any email; Supporter ... raise the allowance", `app.js` near line 1622) out of the header area. It belongs next to sign-in and on the pricing section, not above the listings.
- Replace the "Rank these for your major. Three short steps." banner with one box: "I study ___", using the existing major typeahead (**verify**: near line 738). Choosing a major re-ranks at once. Class year and states are asked afterwards, in place, and can be skipped. The profile still stays in the browser.
- Before a profile exists, remove "Rank for my major" from every row. Say it once, at the top.

**P-1.3 Rows.**
- Location: show "North Kingstown, RI +1 more", not "North Kingstown, Rhode Island, USA, RI +1". Display only; do not change the data.
- Move the job-board name ("Ashby") into Details. Hide the field when it is "Other".
- Show posted time as "2 days ago" with the full date in a `title` and for screen readers.
- Show pay as a small badge when it is listed.
- Add a company initial tile, pure CSS, colour from a hash of the name. No images.
- "Auto-Apply" on a row should look like a feature (a labelled chip with a short tooltip), not grey text.

**P-1.4 Save and My list.**
- Replace the status menu on every row with a save toggle. Saved roles appear in a "My list" view with the existing statuses (Interested, Applied, Interviewing, Rejected, Offer) and a marker when a saved role has closed.
- Keep the existing stored statuses working: a student who set statuses before must find them in My list. Write a migration test for the stored shape.
- Keep the "did you apply?" prompt that appears when a student returns from a posting.
- Add "New since your last visit" on rows, from a timestamp kept in the browser.

**P-1.5 Phone layout.**
- (a) `docs/index.html` and `app.js`: seven nav links wrap over two rows above the headline on a phone. Collapse to a menu button, or keep three links and move the rest to the footer. Check tap target sizes.
- (b) Generated pages (`page()` and `table()` in `seo_pages.py`, hot file): same nav fix, and tables that run off a 375 px screen (the "who's open now" page loses its third column) become stacked rows on narrow screens. Separate PR, under the hot-file rule.

**P-1.6 "Checked open" line.** Only if the listing data carries a per-listing last-checked time (**verify**: scan evidence in the export). If it does, show "Checked open today" or "Checked open yesterday" in Details, and state the checking schedule once near the count at the top. If it does not, skip this package and say so in the status file. Never claim more than the data shows.

**P-1.7 Make the GitHub list and the widget visible.**
- Footer links on the dashboard, the install page and generated pages: "Internships for every major on GitHub" and "Put live internships on your club or department site".
- Field landing pages: a line linking to the widget page with that field preselected (**verify** the widget takes a field parameter; add one if not).
- `docs/widget/`: make the page a snippet builder (pick a field, copy the code) if it is not one already.
- `growth/every_major_list.py`: the README it generates gets a clear first screen, a link back to the matching field page per table, and a "Star this repository to follow updates" line.
- `growth/digest.py`: one footer line linking the GitHub list.
- A short guide page: "Post new internships for your field in a club Discord or Slack", using the existing feeds.

**P-1.8 Out-of-runs page.**
- The extension's limit card already opens `internscout.org/?upgrade=<plan>` (**verify**: `extension/sidepanel/sidepanel.js`). Make that arrival show one clear panel on the site, with no extension change:
  1. what the student used this month, from the allowance the site already reads;
  2. "Invite a classmate: you each get extra runs", with the existing invite link and a copy button;
  3. the plans;
  4. a top-up button, shown only when the worker says top-ups are on (P-2.2).
- Also show the invite block to signed-in students in their account panel, where it is today, but shorter.

**P-1.9 Employer entry on employer pages.** Employer pages already carry a link to the employer offer (**verify**: the "employer" placement). Reword it for a recruiter who has searched their own company: "Work at Bose? See how students find your roles, and feature them." It opens the employer page with the company prefilled, which already exists. Generated-page change, hot-file rule.

**P-1.10 Flyer page.** A page where a student types their campus and gets a printable flyer with a QR code for that campus, made in the browser. Reuse the layout and channel naming from `growth/flyers.py` (`flyer-<campus>`). No reward for now.

**P-1.11 Install page and offer bar.** Shorten the Auto-Apply offer bar (`docs/js/offer.js`) to one line plus the button, and move the Chrome permission explanation behind "What will Chrome ask?". On the install page, lead with what happens in the first minute. Leave a slot for a short demo clip (section 9).

## 7. Stage 2: needs Bruce to approve text, and a worker deploy

For each package: first a one-page design note in `notes/product/`, with the exact user-visible words, what is stored, for how long, and how it is deleted. Bruce approves the note. Then build. All are `needs-bruce`.

**P-2.1 Follow a company and saved-search emails.**
- Where: a "Email me when Bose posts an internship" control on employer pages and in a row's Details; "Email me new roles like these" on a filtered dashboard view.
- Flow: email address, then a confirmation email, then active. Every email has a one-press unsubscribe and a link to manage all follows. No account needed.
- Storage: new tables in the worker database for subscriptions (email, kind, key, created, confirmed, last sent, token hash) and an outbox, following the outbox pattern the orders code already uses. Deleting an account or pressing unsubscribe removes the rows. Unconfirmed rows expire after 7 days.
- Matching: the site build writes one small public file of roles first seen in the last few days, grouped by employer and by field and state (an export step, plus the golden manifest). A worker cron reads that file once a day, matches subscriptions, and queues at most one email per subscriber per day listing everything new for them.
- Sending: the worker's existing mail binding (`worker/src/mail.js`). **Verify** the sender address rules and daily sending limits on the Cloudflare plan before choosing volumes, and cap the cron's daily sends well under them.
- Each email: the new roles with direct posting links, two similar roles, a link to the matching page, and the share link.
- Needs from Bruce: the privacy policy section, the email wording, the postal address that marketing email must carry, and the deploy.
- Tests: worker unit tests and the Workers-runtime suite for confirm, unsubscribe, expiry, one-per-day cap, and delete-my-data.

**P-2.2 One-time top-up.**
- A single purchase that adds runs to the existing bonus balance (the same balance invites add to; **verify** in `worker/src/referral.js` and the `bonus` table).
- Checkout in payment mode beside the existing subscription checkout in `worker/src/billing.js`. The webhook grants the runs exactly once (reuse the stored-event idempotency the billing code has). Refund removes unused runs.
- Off unless a price id secret is set, like the plans.
- Needs from Bruce: the price and size (suggested: $3 for 25 runs), the Stripe price, plan and terms wording, and the deploy.
- Second-agent review is required to read the webhook path line by line.

**P-2.3 Posting clicks per employer.**
- Count posting clicks per employer per day as totals, nothing about who. This is the proof employers will ask for.
- Show the number nowhere public. It feeds the owner's analytics and, later, an employer report.
- Needs from Bruce: OK on the privacy wording, and the deploy.

**P-2.4 Keep My list across devices.** For signed-in students, store saved roles and statuses with the account so the list follows them. Offer sign-in after the second save with that reason. Needs a privacy section and the deploy. Do after P-1.4 has been live for two weeks.

## 8. Stage 3 and 4

**Stage 3: extension (ships only when Bruce releases).**
- **P-3.1 Limit card.** Add "Invite a classmate" beside the upgrade button in `extension/sidepanel/card.js`, and show the card to students already on the top plan too. Both open the out-of-runs page.
- **P-3.2 Review ask.** Ask for a store review after a student's third successful fill, once, never during a fill (**verify** what triggers it today).
- **P-3.3 Resume first.** After WP-5.2 merges: onboarding starts with the resume, builds the profile from it, and lets the student correct it. No new data leaves the browser beyond what onboarding sends today.
- **P-3.4 Practice form.** A sample application page the extension can fill right after setup. **Verify first** whether this needs a new host permission in `extension/manifest.json`. If it does, stop: a new permission can disable the extension for existing users until they accept it. Report to Bruce.

**Stage 4: pages and distribution (generated pages, so after refactor Phase 3 or under the hot-file rule).**
- **P-4.1 Pages that match what Bing sends.** Add a small, capped set (60 at most) of season by field, remote by field, and class year by city pages, each with at least 10 real listings and each passing the existing duplicate and noindex rules. Then stop and let four weeks of data come in. Do not reshuffle existing pages.
- **P-4.2 One quotable fact line** at the top of each field and employer page, built from real counts and dated, like the one on the "who's open now" page.
- **P-4.3 Share cards.** A share button on dashboard views that links to the matching landing page when one exists, and a preview image per field and season page made at build time with `scripts/make_og_image.py`. Watch build time.
- **P-4.4 Advisor edition.** A weekly page per major written to be forwarded, plus a way for an advisor to subscribe through the existing email provider with a tag. No outreach is sent by you.

## 9. Waiting for Bruce (keep this list in the status file)

Things only Bruce does. Add the date each was asked and done.

- Pause the paid Meta campaigns, and decide whether to keep the Zeely plan.
- Deploy the worker after P-0.2, and again after each Stage 2 package.
- Approve each Stage 2 design note: privacy text, email wording, prices.
- Create the Stripe price for the top-up and set its secret.
- Give the postal address that follow emails must carry.
- Rename the GitHub list repository to match what students search for (for example `Summer2027-Internships-Every-Major`), add topics, and post it where students share lists.
- Record or approve a short Auto-Apply demo clip for the install page.
- Release the extension after Stage 3 packages.
- Send a list of monthly tool costs, so the cost review can be finished.

## 10. Order and parallel work

| When | Packages | Notes |
|---|---|---|
| Day 1 | P-0.1, P-0.2 | P-0.2 then waits for a deploy; later packages work without it but are not counted until then |
| Wave A | P-1.1, P-1.2, P-1.3, P-1.4 | All in `app.js`: one agent at a time on that file, in this order, small PRs. Must finish before refactor WP-5.1 |
| Wave A, alongside | P-1.7 (non-generated parts), P-1.10, P-1.11, P-2.1 design note, P-2.2 design note | Different files |
| Wave B | P-1.5, P-1.6, P-1.8 | P-1.5b under the hot-file rule |
| Wave C | P-1.9, generated-page parts of P-1.7, P-2.3 | Generated pages: before refactor WP-3.1 or after WP-3.5 |
| Wave D | P-2.1, P-2.2 builds after Bruce approves the notes; P-3.1, P-3.2 | Worker and extension |
| Wave E | P-2.4, P-3.3, P-3.4, Stage 4 | After the matching refactor packages merge |

## 11. Measuring

Each package names its counter in P-0.2. After a package has been live for 14 days, write in the status file what moved, using the owner's analytics page or a read-only query Bruce runs. If a change makes its measure worse, say so and propose reverting. Small numbers swing a lot; do not call a result on a few days of data.

## 12. When to stop and ask

- Anything on the `needs-bruce` list without his approval.
- A change that would add a browser permission, a third-party request, or anything stored about a person beyond what an approved note says.
- A claim on a page that the data cannot back.
- A collision with the refactor session that section 3 does not settle.
- Tests failing on `main` before your change.

Stop that package, write the question in the status file, and carry on with the others.

## 13. Not checked when this was written

- The dashboard code was read for landmarks, not line by line. Line numbers are from `0607a74` and will drift.
- The extension's screens were not seen, only its code.
- Email sending limits, the widget's parameters, the per-listing checked time, and whether the practice form needs a new permission are all marked verify.
- Whether any of this works. Every package is a test.
